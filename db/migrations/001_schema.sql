-- Production ledger schema.
--
-- Design rules enforced HERE (not only in application code):
--   * every money column is BIGINT kobo with CHECKs;
--   * journal entries balance (deferred constraint trigger, checked at COMMIT);
--   * ledger + sub-ledger history tables are append-only (UPDATE/DELETE/TRUNCATE raise);
--   * lines can only be added to an entry inside the transaction that created it;
--   * an entry can be reversed at most once (UNIQUE reverses_entry_id);
--   * entries cannot be dated inside a closed period;
--   * payment allocations never exceed what is owed and always sum to the payment amount.
--
-- Custom SQLSTATEs (mapped to HTTP errors by the app):
--   LG001 period closed        LG002 unbalanced entry      LG003 immutable row
--   LG004 allocation invariant LG005 line added to committed entry

------------------------------------------------------------------------------
-- Restricted application role. The app connects as ledger_app, which has no
-- UPDATE/DELETE/TRUNCATE privilege on ledger tables and cannot disable triggers
-- (it does not own the tables). Triggers are the second line of defence and also
-- stop the owner.
------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    CREATE ROLE ledger_app LOGIN PASSWORD 'ledger_app';
  END IF;
END $$;

------------------------------------------------------------------------------
-- Generic guards
------------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'LG003',
    MESSAGE = format('%s on %s is not allowed: rows are append-only; post a reversing/correcting entry instead',
                     TG_OP, TG_TABLE_NAME);
END $$;

-- Attach UPDATE/DELETE/TRUNCATE guards to a table.
CREATE FUNCTION make_append_only(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION forbid_mutation()',
                 'append_only_row', tbl);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()',
                 'append_only_truncate', tbl);
END $$;

------------------------------------------------------------------------------
-- Chart of accounts
------------------------------------------------------------------------------
CREATE TABLE accounts (
  id    smallint PRIMARY KEY,
  code  text NOT NULL UNIQUE,
  name  text NOT NULL UNIQUE,
  type  text NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'))
);

INSERT INTO accounts (id, code, name, type) VALUES
  (1,  'CASH',                'Cash',                'ASSET'),
  (2,  'LOANS_RECEIVABLE',    'Loans Receivable',    'ASSET'),
  (3,  'INTEREST_RECEIVABLE', 'Interest Receivable', 'ASSET'),
  (4,  'INVOICE_RECEIVABLES', 'Invoice Receivables', 'ASSET'),
  (5,  'CLIENT_RECEIVABLE',   'Client Receivable',   'ASSET'),
  (6,  'INTEREST_INCOME',     'Interest Income',     'INCOME'),
  (7,  'FEE_INCOME',          'Fee Income',          'INCOME'),
  (8,  'PENALTY_INCOME',      'Penalty Income',      'INCOME'),
  (9,  'CLIENT_PAYABLE',      'Client Payable',      'LIABILITY'),
  (10, 'UNAPPLIED_CREDIT',    'Unapplied Credit',    'LIABILITY');

------------------------------------------------------------------------------
-- Accounting periods. A row exists only once the period is closed; closing is
-- permanent (no reopen), so the table is append-only.
------------------------------------------------------------------------------
CREATE TABLE closed_periods (
  period     char(7) PRIMARY KEY CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  closed_at  timestamptz NOT NULL DEFAULT now()
);

-- Advisory lock key shared by every posting transaction (shared mode) and by
-- period close (exclusive mode), so a close cannot interleave with an in-flight post.
CREATE FUNCTION period_lock_key() RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 7349001::bigint $$;

CREATE FUNCTION period_of(d date) RETURNS char(7) LANGUAGE sql STABLE AS $$ SELECT to_char(d, 'YYYY-MM')::char(7) $$;

CREATE FUNCTION is_period_closed(d date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM closed_periods WHERE period = period_of(d))
$$;

-- Date an event effective on d is posted on: d itself if its period is open,
-- otherwise the first day of the next open period ("current open period").
CREATE FUNCTION ledger_posting_date(d date) RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE
  p date;
BEGIN
  IF NOT is_period_closed(d) THEN
    RETURN d;
  END IF;
  p := date_trunc('month', d)::date;
  LOOP
    p := (p + interval '1 month')::date;
    EXIT WHEN NOT is_period_closed(p);
  END LOOP;
  RETURN p;
END $$;

------------------------------------------------------------------------------
-- Term loans and their (immutable) schedules
------------------------------------------------------------------------------
CREATE TABLE loans (
  id                 bigserial PRIMARY KEY,
  principal          bigint  NOT NULL CHECK (principal > 0),
  annual_rate        numeric(20, 12) NOT NULL CHECK (annual_rate >= 0 AND annual_rate < 10),
  term_months        integer NOT NULL CHECK (term_months BETWEEN 1 AND 600),
  disbursement_date  date    NOT NULL,
  instalment_amount  bigint  NOT NULL CHECK (instalment_amount > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE instalments (
  loan_id          bigint  NOT NULL REFERENCES loans(id),
  number           integer NOT NULL CHECK (number >= 1),
  due_date         date    NOT NULL,
  opening_balance  bigint  NOT NULL CHECK (opening_balance > 0),
  payment          bigint  NOT NULL CHECK (payment > 0),
  interest         bigint  NOT NULL CHECK (interest >= 0),
  principal        bigint  NOT NULL CHECK (principal > 0),
  closing_balance  bigint  NOT NULL CHECK (closing_balance >= 0),
  PRIMARY KEY (loan_id, number),
  CHECK (payment = interest + principal),
  CHECK (closing_balance = opening_balance - principal)
);

-- Penalties / fees assessed against an instalment. Recognised as income only
-- when collected (no journal entry at assessment).
CREATE TABLE loan_charges (
  id                 bigserial PRIMARY KEY,
  loan_id            bigint  NOT NULL,
  instalment_number  integer NOT NULL,
  type               text    NOT NULL CHECK (type IN ('PENALTY', 'FEE')),
  amount             bigint  NOT NULL CHECK (amount > 0),
  assessed_on        date    NOT NULL,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (loan_id, instalment_number) REFERENCES instalments(loan_id, number)
);

------------------------------------------------------------------------------
-- Invoice financing
------------------------------------------------------------------------------
CREATE TABLE invoices (
  id                    bigserial PRIMARY KEY,
  face_value            bigint  NOT NULL CHECK (face_value > 0),
  advance_rate          numeric(20, 12) NOT NULL CHECK (advance_rate > 0 AND advance_rate <= 1),
  annual_rate           numeric(20, 12) NOT NULL CHECK (annual_rate >= 0),
  penalty_rate_per_day  numeric(20, 12) NOT NULL CHECK (penalty_rate_per_day >= 0),
  advance               bigint  NOT NULL CHECK (advance > 0),
  reserve               bigint  NOT NULL CHECK (reserve >= 0),
  discount_fee          bigint  NOT NULL CHECK (discount_fee >= 0),
  advance_date          date    NOT NULL,
  due_date              date    NOT NULL,
  tenor_days            integer NOT NULL CHECK (tenor_days > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (advance + reserve = face_value),
  CHECK (due_date - advance_date = tenor_days)
);

------------------------------------------------------------------------------
-- Payments (sub-ledger). Status is derived: a payment is reversed iff a row
-- exists in payment_reversals (PK => at most once).
------------------------------------------------------------------------------
CREATE TABLE payments (
  id               bigserial PRIMARY KEY,         -- also the commit-order sequence (assigned under the loan lock)
  loan_id          bigint NOT NULL REFERENCES loans(id),
  amount           bigint NOT NULL CHECK (amount > 0),
  value_date       date   NOT NULL,
  reference        text,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, reference)
);
CREATE INDEX ON payments (loan_id, value_date, id);

------------------------------------------------------------------------------
-- Journal
------------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                 bigserial PRIMARY KEY,
  entry_date         date NOT NULL,    -- posting date; governs the accounting period
  effective_date     date NOT NULL,    -- economic date of the underlying event
  kind               text NOT NULL CHECK (kind IN (
                       'DISBURSEMENT', 'ACCRUAL', 'PAYMENT', 'PAYMENT_REVERSAL', 'REALLOCATION',
                       'INVOICE_ADVANCE', 'INVOICE_SETTLEMENT', 'MANUAL', 'REVERSAL')),
  description        text NOT NULL,
  loan_id            bigint REFERENCES loans(id),
  invoice_id         bigint REFERENCES invoices(id),
  payment_id         bigint REFERENCES payments(id),
  reverses_entry_id  bigint UNIQUE REFERENCES journal_entries(id),  -- a second reversal violates UNIQUE
  corrects_entry_id  bigint REFERENCES journal_entries(id),         -- reference to the original for corrections
  created_txid       bigint NOT NULL DEFAULT txid_current(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id),
  CHECK (entry_date >= effective_date)   -- corrections only ever roll forward
);
CREATE INDEX ON journal_entries (loan_id);
CREATE INDEX ON journal_entries (payment_id);
CREATE INDEX ON journal_entries (entry_date);

CREATE TABLE journal_lines (
  id          bigserial PRIMARY KEY,
  entry_id    bigint   NOT NULL REFERENCES journal_entries(id),
  line_no     smallint NOT NULL CHECK (line_no >= 1),
  account_id  smallint NOT NULL REFERENCES accounts(id),
  side        char(1)  NOT NULL CHECK (side IN ('D', 'C')),
  amount      bigint   NOT NULL CHECK (amount > 0),   -- positive integer kobo; zero lines are never posted
  loan_id     bigint   REFERENCES loans(id),          -- sub-ledger attribution for reconciliation
  invoice_id  bigint   REFERENCES invoices(id),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX ON journal_lines (entry_id);
CREATE INDEX ON journal_lines (account_id, loan_id);

-- Entries may not be dated in a closed period. Takes the period lock in shared
-- mode so that it serialises against POST /periods/:p/close.
CREATE FUNCTION journal_entries_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(period_lock_key());
  IF is_period_closed(NEW.entry_date) THEN
    RAISE EXCEPTION USING ERRCODE = 'LG001',
      MESSAGE = format('period %s is closed; entry dated %s rejected', period_of(NEW.entry_date), NEW.entry_date);
  END IF;
  NEW.created_txid := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER journal_entries_before_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_before_insert();

-- Lines can only be added by the transaction that created the entry: once an
-- entry is committed it is closed for good, even to balanced additions.
CREATE FUNCTION journal_lines_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  owner_txid bigint;
BEGIN
  SELECT created_txid INTO owner_txid FROM journal_entries WHERE id = NEW.entry_id;
  IF owner_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION USING ERRCODE = 'LG005',
      MESSAGE = format('journal entry %s is already committed; lines cannot be added', NEW.entry_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_before_insert BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_before_insert();

-- Balance check, run at COMMIT (deferred) so lines can be inserted one by one.
CREATE FUNCTION assert_entry_balanced(p_entry_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  n int; dr bigint; cr bigint;
BEGIN
  SELECT count(*),
         coalesce(sum(amount) FILTER (WHERE side = 'D'), 0),
         coalesce(sum(amount) FILTER (WHERE side = 'C'), 0)
    INTO n, dr, cr
    FROM journal_lines WHERE entry_id = p_entry_id;
  IF n < 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG002',
      MESSAGE = format('journal entry %s has %s line(s); at least 2 required', p_entry_id, n);
  END IF;
  IF dr <> cr THEN
    RAISE EXCEPTION USING ERRCODE = 'LG002',
      MESSAGE = format('journal entry %s is unbalanced: debits %s, credits %s', p_entry_id, dr, cr);
  END IF;
END $$;

CREATE FUNCTION journal_entries_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_entry_balanced(NEW.id); RETURN NULL; END $$;
CREATE FUNCTION journal_lines_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_entry_balanced(NEW.entry_id); RETURN NULL; END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entries_check_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_lines_check_balanced();

------------------------------------------------------------------------------
-- Interest accrual: at most one per instalment (PK), so the job is idempotent
-- even if two runs race.
------------------------------------------------------------------------------
CREATE TABLE interest_accruals (
  loan_id            bigint  NOT NULL,
  instalment_number  integer NOT NULL,
  entry_id           bigint  NOT NULL REFERENCES journal_entries(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (loan_id, instalment_number),
  FOREIGN KEY (loan_id, instalment_number) REFERENCES instalments(loan_id, number)
);

------------------------------------------------------------------------------
-- Payment reversals and the allocation audit trail.
--
-- Allocations are stored as append-only DELTAS grouped into allocation events.
-- The current allocation of a payment = SUM(amount) per (instalment, component).
-- Every event says what changed, why, and which journal entry carried it.
------------------------------------------------------------------------------
CREATE TABLE payment_reversals (
  payment_id      bigint PRIMARY KEY REFERENCES payments(id),   -- PK => reversed at most once
  reason          text   NOT NULL,
  effective_date  date   NOT NULL,
  entry_id        bigint NOT NULL REFERENCES journal_entries(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE allocation_events (
  id                 bigserial PRIMARY KEY,
  loan_id            bigint NOT NULL REFERENCES loans(id),
  payment_id         bigint NOT NULL REFERENCES payments(id),
  kind               text   NOT NULL CHECK (kind IN ('ALLOCATE', 'REVERSE', 'REALLOCATE')),
  trigger_kind       text   NOT NULL CHECK (trigger_kind IN ('PAYMENT_RECEIVED', 'PAYMENT_REVERSED', 'CHARGE_ASSESSED')),
  trigger_ref        bigint NOT NULL,      -- id of the payment / charge that caused this event
  reason             text   NOT NULL,
  entry_id           bigint REFERENCES journal_entries(id),  -- NULL when the delta nets to zero per account
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON allocation_events (loan_id, id);

CREATE TABLE payment_allocations (
  id                 bigserial PRIMARY KEY,
  event_id           bigint  NOT NULL REFERENCES allocation_events(id),
  loan_id            bigint  NOT NULL REFERENCES loans(id),
  payment_id         bigint  NOT NULL REFERENCES payments(id),
  instalment_number  integer,
  component          text    NOT NULL CHECK (component IN ('PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL', 'UNAPPLIED')),
  amount             bigint  NOT NULL CHECK (amount <> 0),     -- signed delta in kobo
  CHECK ((component = 'UNAPPLIED') = (instalment_number IS NULL)),
  FOREIGN KEY (loan_id, instalment_number) REFERENCES instalments(loan_id, number)
);
CREATE INDEX ON payment_allocations (payment_id);
CREATE INDEX ON payment_allocations (loan_id, instalment_number, component);

-- Invariant 1: a live payment's allocations sum to its amount; a reversed
-- payment's sum to zero; no (instalment, component) bucket of a payment is negative.
CREATE FUNCTION assert_payment_allocated(p_payment_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected bigint; total bigint; neg int;
BEGIN
  SELECT CASE WHEN r.payment_id IS NULL THEN p.amount ELSE 0 END INTO expected
    FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id
   WHERE p.id = p_payment_id;
  SELECT coalesce(sum(amount), 0) INTO total FROM payment_allocations WHERE payment_id = p_payment_id;
  IF total <> expected THEN
    RAISE EXCEPTION USING ERRCODE = 'LG004',
      MESSAGE = format('payment %s allocations total %s, expected %s', p_payment_id, total, expected);
  END IF;
  SELECT count(*) INTO neg FROM (
    SELECT 1 FROM payment_allocations WHERE payment_id = p_payment_id
     GROUP BY instalment_number, component HAVING sum(amount) < 0) s;
  IF neg > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG004',
      MESSAGE = format('payment %s has a negative allocation bucket', p_payment_id);
  END IF;
END $$;

-- Invariant 2: across all payments, no instalment component is over-collected.
CREATE FUNCTION assert_instalment_not_overallocated(p_loan_id bigint, p_number integer, p_component text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  owed bigint; collected bigint;
BEGIN
  IF p_component = 'UNAPPLIED' THEN RETURN; END IF;
  SELECT CASE p_component
           WHEN 'INTEREST'  THEN i.interest
           WHEN 'PRINCIPAL' THEN i.principal
           ELSE (SELECT coalesce(sum(c.amount), 0) FROM loan_charges c
                  WHERE c.loan_id = i.loan_id AND c.instalment_number = i.number AND c.type = p_component)
         END INTO owed
    FROM instalments i WHERE i.loan_id = p_loan_id AND i.number = p_number;
  SELECT coalesce(sum(amount), 0) INTO collected FROM payment_allocations
   WHERE loan_id = p_loan_id AND instalment_number = p_number AND component = p_component;
  IF collected > owed OR collected < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'LG004',
      MESSAGE = format('instalment %s/%s %s collected %s but only %s is owed', p_loan_id, p_number, p_component, collected, owed);
  END IF;
END $$;

CREATE FUNCTION payment_allocations_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_payment_allocated(NEW.payment_id);
  PERFORM assert_instalment_not_overallocated(NEW.loan_id, NEW.instalment_number, NEW.component);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_allocations_invariants AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payment_allocations_check();

CREATE FUNCTION payments_check_allocated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_payment_allocated(NEW.payment_id); RETURN NULL; END $$;
CREATE FUNCTION payments_check_allocated_new() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_payment_allocated(NEW.id); RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER payments_allocated AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments_check_allocated_new();
CREATE CONSTRAINT TRIGGER payment_reversals_allocated AFTER INSERT ON payment_reversals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payments_check_allocated();

------------------------------------------------------------------------------
-- Invoice settlement (at most one per invoice)
------------------------------------------------------------------------------
CREATE TABLE invoice_advances (
  invoice_id  bigint PRIMARY KEY REFERENCES invoices(id),
  entry_id    bigint NOT NULL REFERENCES journal_entries(id)
);

CREATE TABLE invoice_settlements (
  invoice_id        bigint PRIMARY KEY REFERENCES invoices(id),
  settled_on        date   NOT NULL,
  amount_received   bigint NOT NULL CHECK (amount_received > 0),
  days_overdue      integer NOT NULL CHECK (days_overdue >= 0),
  discount_fee      bigint NOT NULL CHECK (discount_fee >= 0),
  late_penalty      bigint NOT NULL CHECK (late_penalty >= 0),
  client_payable    bigint NOT NULL CHECK (client_payable >= 0),
  client_shortfall  bigint NOT NULL CHECK (client_shortfall >= 0),
  entry_id          bigint NOT NULL REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (client_payable = 0 OR client_shortfall = 0)
);

------------------------------------------------------------------------------
-- Idempotency keys (the only mutable table: the response is recorded in the
-- same transaction that claimed the key, so a committed row is always complete).
------------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key              text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 255),
  scope            text NOT NULL,
  request_hash     text NOT NULL,
  response_status  integer,
  response_body    json,   -- json, not jsonb: keeps the exact text, so a replay is byte-identical
  created_at       timestamptz NOT NULL DEFAULT now()
);

------------------------------------------------------------------------------
-- Append-only enforcement on every history table
------------------------------------------------------------------------------
SELECT make_append_only(t) FROM unnest(ARRAY[
  'accounts', 'closed_periods', 'loans', 'instalments', 'loan_charges', 'invoices',
  'payments', 'journal_entries', 'journal_lines', 'interest_accruals',
  'payment_reversals', 'allocation_events', 'payment_allocations',
  'invoice_advances', 'invoice_settlements'
]::regclass[]) AS t;

-- idempotency_keys: allow UPDATE (to record the response) but never DELETE.
CREATE TRIGGER no_delete BEFORE DELETE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON idempotency_keys FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

------------------------------------------------------------------------------
-- Privileges for the application role
------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO ledger_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ledger_app;
GRANT UPDATE (response_status, response_body) ON idempotency_keys TO ledger_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ledger_app;
