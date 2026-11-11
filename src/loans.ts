/** Term loans: origination, accrual, payments, reversals, charges, reconciliation. */
import { createHash } from 'node:crypto';
import { AllocLine, COMPONENT_ACCOUNT, Component, allocate, bucketKey, comparePayments } from './allocation';
import { Db, Tx, withTx } from './db';
import { badRequest, conflict, notFound, unprocessable } from './errors';
import { maxDate, parseDate } from './dates';
import { LineSpec, PostedEntry, correctionDate, getEntry, postEntry, presentEntry } from './ledger';
import { parseKobo, parseRate, rationalToDecimal } from './money';
import { buildSchedule } from './schedule';
import { toJsonSafe } from './json';

const LOAN_LOCK_CLASS = 1; // advisory-lock namespace for loans

/**
 * Serialise all writes to one loan. Transaction-scoped advisory lock keyed by
 * loan id: released automatically on COMMIT/ROLLBACK, needs no UPDATE privilege
 * on the (immutable) loans table, and leaves other loans fully parallel.
 * Lock acquisition order == commit order for a loan, which is what makes
 * allocation behave as if payments were applied one at a time.
 */
async function lockLoan(tx: Tx, loanId: string) {
  if (!/^\d+$/.test(loanId) || BigInt(loanId) > 2_147_483_647n) throw notFound(`loan ${loanId}`);
  await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [LOAN_LOCK_CLASS, Number(loanId)]);
  const { rows } = await tx.query('SELECT * FROM loans WHERE id = $1', [loanId]);
  if (!rows[0]) throw notFound(`loan ${loanId}`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Origination
// ---------------------------------------------------------------------------

export async function createLoan(pool: Db, body: any) {
  const principal = parseKobo(body?.principal, 'principal');
  const rate = parseRate(body?.annualRate ?? body?.annual_rate, 'annualRate');
  const termMonths = body?.termMonths ?? body?.term_months ?? body?.term;
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || termMonths > 600) {
    throw badRequest('INVALID_TERM', 'termMonths must be an integer between 1 and 600');
  }
  const disbursementDate = parseDate(body?.disbursementDate ?? body?.disbursement_date, 'disbursementDate');
  if (rate.n * 10n >= rate.d * 100n) throw badRequest('INVALID_RATE', 'annualRate must be below 1000%');

  let schedule;
  try {
    schedule = buildSchedule(principal, rate, termMonths, disbursementDate);
  } catch (e: any) {
    throw unprocessable('INVALID_SCHEDULE', e.message);
  }

  return withTx(pool, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO loans (principal, annual_rate, term_months, disbursement_date, instalment_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [principal.toString(), rationalToDecimal(rate), termMonths, disbursementDate, schedule.instalment.toString()],
    );
    const loanId = String(rows[0].id);
    const vals: unknown[] = [];
    const tuples = schedule.rows.map((r, i) => {
      vals.push(loanId, r.number, r.dueDate, r.openingBalance.toString(), r.payment.toString(), r.interest.toString(), r.principal.toString(), r.closingBalance.toString());
      const b = i * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    });
    await tx.query(
      `INSERT INTO instalments (loan_id, number, due_date, opening_balance, payment, interest, principal, closing_balance)
       VALUES ${tuples.join(',')}`,
      vals,
    );
    const entry = await postEntry(tx, {
      effectiveDate: disbursementDate,
      kind: 'DISBURSEMENT',
      description: `Disbursement of loan ${loanId}`,
      loanId,
      lines: [
        { account: 'LOANS_RECEIVABLE', side: 'D', amount: principal },
        { account: 'CASH', side: 'C', amount: principal },
      ],
    });
    return {
      id: loanId,
      principal,
      annualRate: rationalToDecimal(rate),
      monthlyRate: rationalToDecimal({ n: rate.n, d: rate.d * 12n }),
      termMonths,
      disbursementDate,
      instalment: schedule.instalment,
      totalInterest: schedule.totalInterest,
      schedule: schedule.rows,
      disbursementEntry: presentEntry(entry),
    };
  });
}

// ---------------------------------------------------------------------------
// Loan state
// ---------------------------------------------------------------------------

interface LoanState {
  instalments: { number: number; dueDate: string; interest: bigint; principal: bigint }[];
  charges: { id: string; instalmentNumber: number; type: 'PENALTY' | 'FEE'; amount: bigint; assessedOn: string }[];
  payments: { id: string; amount: bigint; valueDate: string; reversed: boolean; reference: string | null }[];
  current: Map<string, Map<string, AllocLine>>; // paymentId -> bucketKey -> current (net) allocation
}

async function loadState(db: Db | Tx, loanId: string): Promise<LoanState> {
  // Sequential on purpose: db may be a single transaction client.
  const inst = await db.query('SELECT number, due_date, interest, principal FROM instalments WHERE loan_id = $1 ORDER BY number', [loanId]);
  const charges = await db.query(
    'SELECT id, instalment_number, type, amount, assessed_on FROM loan_charges WHERE loan_id = $1 ORDER BY id',
    [loanId],
  );
  const pays = await db.query(
    `SELECT p.id, p.amount, p.value_date, p.reference, r.payment_id IS NOT NULL AS reversed
       FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id
      WHERE p.loan_id = $1 ORDER BY p.value_date, p.id`,
    [loanId],
  );
  const allocs = await db.query(
    `SELECT payment_id, instalment_number, component, sum(amount)::bigint AS amount
       FROM payment_allocations WHERE loan_id = $1
      GROUP BY payment_id, instalment_number, component`,
    [loanId],
  );
  const current = new Map<string, Map<string, AllocLine>>();
  for (const a of allocs.rows) {
    if (a.amount === 0n) continue;
    const pid = String(a.payment_id);
    if (!current.has(pid)) current.set(pid, new Map());
    current.get(pid)!.set(bucketKey(a.instalment_number, a.component), {
      instalmentNumber: a.instalment_number,
      component: a.component,
      amount: a.amount,
    });
  }
  return {
    instalments: inst.rows.map((r) => ({ number: r.number, dueDate: r.due_date, interest: r.interest, principal: r.principal })),
    charges: charges.rows.map((r) => ({
      id: String(r.id),
      instalmentNumber: r.instalment_number,
      type: r.type,
      amount: r.amount,
      assessedOn: r.assessed_on,
    })),
    payments: pays.rows.map((r) => ({
      id: String(r.id),
      amount: r.amount,
      valueDate: r.value_date,
      reversed: r.reversed,
      reference: r.reference,
    })),
    current,
  };
}

/** Sum allocation lines into net credit per GL account. */
function netByAccount(lines: Iterable<AllocLine>): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const l of lines) {
    const acct = COMPONENT_ACCOUNT[l.component];
    m.set(acct, (m.get(acct) ?? 0n) + l.amount);
  }
  return m;
}

async function insertAllocationEvent(
  tx: Tx,
  loanId: string,
  paymentId: string,
  kind: 'ALLOCATE' | 'REVERSE' | 'REALLOCATE',
  trigger: Trigger,
  reason: string,
  entryId: string | null,
  lines: AllocLine[],
) {
  const { rows } = await tx.query(
    `INSERT INTO allocation_events (loan_id, payment_id, kind, trigger_kind, trigger_ref, reason, entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [loanId, paymentId, kind, trigger.kind, trigger.ref, reason, entryId],
  );
  const eventId = String(rows[0].id);
  const vals: unknown[] = [];
  const tuples = lines.map((l, i) => {
    vals.push(eventId, loanId, paymentId, l.instalmentNumber, l.component, l.amount.toString());
    const b = i * 6;
    return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
  });
  if (tuples.length) {
    await tx.query(
      `INSERT INTO payment_allocations (event_id, loan_id, payment_id, instalment_number, component, amount) VALUES ${tuples.join(',')}`,
      vals,
    );
  }
  return eventId;
}

async function paymentEntryId(tx: Tx, paymentId: string): Promise<string> {
  const { rows } = await tx.query(`SELECT id FROM journal_entries WHERE payment_id = $1 AND kind = 'PAYMENT'`, [paymentId]);
  return String(rows[0].id);
}

interface Trigger {
  kind: 'PAYMENT_RECEIVED' | 'PAYMENT_REVERSED' | 'CHARGE_ASSESSED';
  ref: string;
  date: string; // effective date of the triggering event
  reason: string;
}

const sortLines = (lines: AllocLine[]) =>
  lines.sort((a, b) => (a.instalmentNumber ?? 1e9) - (b.instalmentNumber ?? 1e9) || order(a.component) - order(b.component));
const order = (c: Component) => ['PENALTY', 'FEE', 'INTEREST', 'PRINCIPAL', 'UNAPPLIED'].indexOf(c);

/**
 * Replay the live payment history through the waterfall and book the
 * difference against what is currently allocated. A brand-new payment gets its
 * PAYMENT entry; every other payment whose allocation moved gets a REALLOCATION
 * entry carrying only the per-account delta (Cash never moves on a
 * re-allocation). Nothing already booked is edited.
 */
async function reconcileAllocations(tx: Tx, loanId: string, trigger: Trigger, newPaymentId?: string) {
  const state = await loadState(tx, loanId);
  const live = state.payments.filter((p) => !p.reversed);
  const target = allocate(state.instalments, state.charges, live);
  const changes: any[] = [];

  for (const p of [...live].sort(comparePayments)) {
    const cur = state.current.get(p.id) ?? new Map<string, AllocLine>();
    const tgt = new Map(target.get(p.id)!.map((l) => [bucketKey(l.instalmentNumber, l.component), l]));
    const deltas: AllocLine[] = [];
    for (const key of new Set([...cur.keys(), ...tgt.keys()])) {
      const c = cur.get(key);
      const t = tgt.get(key);
      const amount = (t?.amount ?? 0n) - (c?.amount ?? 0n);
      if (amount !== 0n) deltas.push({ instalmentNumber: (t ?? c)!.instalmentNumber, component: (t ?? c)!.component, amount });
    }
    if (deltas.length === 0) continue;
    sortLines(deltas);

    if (p.id === newPaymentId) {
      const lines: LineSpec[] = [{ account: 'CASH', side: 'D', amount: p.amount }];
      for (const [acct, amt] of netByAccount(deltas)) lines.push({ account: acct, side: 'C', amount: amt });
      const entry = await postEntry(tx, {
        effectiveDate: p.valueDate,
        kind: 'PAYMENT',
        description: `Payment ${p.id} on loan ${loanId}`,
        loanId,
        paymentId: p.id,
        lines,
      });
      await insertAllocationEvent(tx, loanId, p.id, 'ALLOCATE', trigger, 'payment received', entry.id, deltas);
      changes.push({ paymentId: p.id, kind: 'ALLOCATE', allocation: deltas, entry });
    } else {
      const lines: LineSpec[] = [];
      for (const [acct, amt] of netByAccount(deltas)) lines.push({ account: acct, side: 'C', amount: amt });
      const hasEntry = lines.some((l) => l.amount !== 0n);
      const reason = `re-allocated after ${trigger.reason}`;
      const entry = hasEntry
        ? await postEntry(tx, {
            effectiveDate: maxDate(trigger.date, p.valueDate),
            kind: 'REALLOCATION',
            description: `Re-allocation of payment ${p.id} on loan ${loanId} (${trigger.reason})`,
            loanId,
            paymentId: p.id,
            correctsEntryId: await paymentEntryId(tx, p.id),
            lines,
          })
        : null;
      await insertAllocationEvent(tx, loanId, p.id, 'REALLOCATE', trigger, reason, entry?.id ?? null, deltas);
      changes.push({
        paymentId: p.id,
        kind: 'REALLOCATE',
        before: sortLines([...cur.values()]),
        after: sortLines([...tgt.values()]),
        delta: deltas,
        entry,
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/** Post interest for each instalment due on or before asOf that is not yet accrued. Caller holds the loan lock. */
async function accrueLoan(tx: Tx, loanId: string, asOf: string) {
  const { rows } = await tx.query(
    `SELECT i.number, i.due_date, i.interest FROM instalments i
       LEFT JOIN interest_accruals a ON a.loan_id = i.loan_id AND a.instalment_number = i.number
      WHERE i.loan_id = $1 AND i.due_date <= $2 AND i.interest > 0 AND a.loan_id IS NULL
      ORDER BY i.number`,
    [loanId, asOf],
  );
  const posted: PostedEntry[] = [];
  for (const r of rows) {
    const entry = await postEntry(tx, {
      effectiveDate: r.due_date,
      kind: 'ACCRUAL',
      description: `Interest due on loan ${loanId} instalment ${r.number}`,
      loanId,
      lines: [
        { account: 'INTEREST_RECEIVABLE', side: 'D', amount: r.interest },
        { account: 'INTEREST_INCOME', side: 'C', amount: r.interest },
      ],
    });
    await tx.query('INSERT INTO interest_accruals (loan_id, instalment_number, entry_id) VALUES ($1, $2, $3)', [loanId, r.number, entry.id]);
    posted.push(entry);
  }
  return posted;
}

export async function runAccrualJob(pool: Db, asOfRaw: unknown) {
  const asOf = parseDate(asOfRaw, 'asOf');
  const { rows } = await pool.query(
    `SELECT DISTINCT i.loan_id FROM instalments i
       LEFT JOIN interest_accruals a ON a.loan_id = i.loan_id AND a.instalment_number = i.number
      WHERE i.due_date <= $1 AND i.interest > 0 AND a.loan_id IS NULL ORDER BY i.loan_id`,
    [asOf],
  );
  const entries: any[] = [];
  for (const r of rows) {
    // One transaction per loan: a failure on one loan does not block the rest,
    // and re-running the job is a no-op for what already committed.
    const posted = await withTx(pool, async (tx) => {
      await lockLoan(tx, String(r.loan_id));
      return accrueLoan(tx, String(r.loan_id), asOf);
    });
    entries.push(...posted.map(presentEntry));
  }
  return { asOf, entriesPosted: entries.length, entries };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function canonicalPaymentRequest(loanId: string, body: any) {
  const amount = parseKobo(body?.amount ?? body?.amountKobo, 'amount');
  const valueDate = parseDate(body?.date ?? body?.valueDate ?? body?.paymentDate ?? body?.receivedOn, 'date');
  const reference = body?.reference === undefined || body?.reference === null ? null : String(body.reference);
  const hash = createHash('sha256')
    .update(JSON.stringify({ loanId, amount: amount.toString(), valueDate, reference }))
    .digest('hex');
  return { amount, valueDate, reference, hash };
}

export interface IdempotentResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

export async function receivePayment(pool: Db, loanId: string, body: any, idempotencyKey: string | undefined): Promise<IdempotentResult> {
  if (!idempotencyKey || !idempotencyKey.trim()) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required');
  if (idempotencyKey.length > 255) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key is too long');
  const req = canonicalPaymentRequest(loanId, body);

  return withTx(pool, async (tx) => {
    // Claim the key. If another transaction holds it uncommitted, this INSERT
    // blocks until that transaction ends; if it committed, we fall through and
    // replay its stored response.
    const claim = await tx.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash) VALUES ($1, 'loan-payment', $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [idempotencyKey, req.hash],
    );
    if (claim.rowCount === 0) {
      const { rows } = await tx.query('SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
      if (rows[0].request_hash !== req.hash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body');
      }
      return { status: rows[0].response_status, body: rows[0].response_body, replayed: true };
    }

    const loan = await lockLoan(tx, loanId);
    if (req.valueDate < loan.disbursement_date) {
      throw unprocessable('INVALID_DATE', `payment date ${req.valueDate} is before disbursement ${loan.disbursement_date}`);
    }
    if (req.reference !== null) {
      const dup = await tx.query('SELECT id FROM payments WHERE loan_id = $1 AND reference = $2', [loanId, req.reference]);
      if (dup.rows[0]) {
        throw conflict('DUPLICATE_REFERENCE', `payment with reference ${req.reference} already recorded as payment ${dup.rows[0].id}`);
      }
    }

    const accruals = await accrueLoan(tx, loanId, req.valueDate);
    const { rows } = await tx.query(
      'INSERT INTO payments (loan_id, amount, value_date, reference, idempotency_key) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [loanId, req.amount.toString(), req.valueDate, req.reference, idempotencyKey],
    );
    const paymentId = String(rows[0].id);
    const changes = await reconcileAllocations(
      tx,
      loanId,
      { kind: 'PAYMENT_RECEIVED', ref: paymentId, date: req.valueDate, reason: `payment ${paymentId} received (value date ${req.valueDate})` },
      paymentId,
    );
    const own = changes.find((c) => c.paymentId === paymentId);
    const response = toJsonSafe({
      payment: { id: paymentId, loanId, amount: req.amount, valueDate: req.valueDate, reference: req.reference, status: 'APPLIED' },
      allocation: own.allocation,
      unapplied: own.allocation.filter((l: AllocLine) => l.component === 'UNAPPLIED').reduce((s: bigint, l: AllocLine) => s + l.amount, 0n),
      journalEntry: presentEntry(own.entry),
      accrualsPosted: accruals.map(presentEntry),
      reallocations: changes.filter((c) => c.paymentId !== paymentId).map(presentChange),
    });
    await tx.query('UPDATE idempotency_keys SET response_status = $2, response_body = $3 WHERE key = $1', [idempotencyKey, 201, JSON.stringify(response)]);
    return { status: 201, body: response, replayed: false };
  });
}

function presentChange(c: any) {
  return { ...c, entry: c.entry ? presentEntry(c.entry) : null };
}

/**
 * Reverse a payment (bounced cheque, wrong loan). Posts the mirror of its
 * current allocation, marks it reversed (once only, enforced by PK), then
 * replays the remaining history and books re-allocation deltas.
 */
export async function reversePaymentTx(tx: Tx, loanId: string, paymentId: string, opts: { date?: unknown; reason?: unknown }) {
  await lockLoan(tx, loanId);
  if (!/^\d+$/.test(paymentId)) throw notFound(`payment ${paymentId}`);
  const { rows } = await tx.query(
    `SELECT p.*, r.payment_id IS NOT NULL AS reversed FROM payments p
       LEFT JOIN payment_reversals r ON r.payment_id = p.id WHERE p.id = $1 AND p.loan_id = $2`,
    [paymentId, loanId],
  );
  const p = rows[0];
  if (!p) throw notFound(`payment ${paymentId} on loan ${loanId}`);
  if (p.reversed) throw conflict('ALREADY_REVERSED', `payment ${paymentId} is already reversed`);

  const originalEntryId = await paymentEntryId(tx, paymentId);
  const original = (await getEntry(tx, originalEntryId))!;
  const effectiveDate = correctionDate(original.entryDate, opts.date);
  const reason = typeof opts.reason === 'string' && opts.reason ? opts.reason : 'payment reversed';

  const state = await loadState(tx, loanId);
  const current = [...(state.current.get(paymentId)?.values() ?? [])];
  sortLines(current);
  const lines: LineSpec[] = [{ account: 'CASH', side: 'C', amount: p.amount }];
  for (const [acct, amt] of netByAccount(current)) lines.push({ account: acct, side: 'D', amount: amt });
  const entry = await postEntry(tx, {
    effectiveDate,
    kind: 'PAYMENT_REVERSAL',
    description: `Reversal of payment ${paymentId} on loan ${loanId}: ${reason}`,
    loanId,
    paymentId,
    reversesEntryId: originalEntryId,
    correctsEntryId: originalEntryId,
    lines,
  });
  await tx.query('INSERT INTO payment_reversals (payment_id, reason, effective_date, entry_id) VALUES ($1, $2, $3, $4)', [
    paymentId,
    reason,
    effectiveDate,
    entry.id,
  ]);
  const trigger: Trigger = { kind: 'PAYMENT_REVERSED', ref: paymentId, date: effectiveDate, reason: `reversal of payment ${paymentId} (${reason})` };
  const negated = current.map((l) => ({ ...l, amount: -l.amount }));
  await insertAllocationEvent(tx, loanId, paymentId, 'REVERSE', trigger, reason, entry.id, negated);
  const reallocations = await reconcileAllocations(tx, loanId, trigger);
  return {
    payment: { id: paymentId, loanId, amount: p.amount, valueDate: p.value_date, status: 'REVERSED', reason },
    reversalEntry: presentEntry(entry),
    reversedAllocation: current,
    reallocations: reallocations.map(presentChange),
  };
}

export async function reversePayment(pool: Db, loanId: string, paymentId: string, body: any) {
  return withTx(pool, (tx) => reversePaymentTx(tx, loanId, paymentId, { date: body?.date, reason: body?.reason }));
}

export async function addCharge(pool: Db, loanId: string, body: any) {
  const type = String(body?.type ?? '').toUpperCase();
  if (type !== 'PENALTY' && type !== 'FEE') throw badRequest('INVALID_CHARGE', 'type must be PENALTY or FEE');
  const amount = parseKobo(body?.amount, 'amount');
  const assessedOn = parseDate(body?.date ?? body?.assessedOn, 'date');
  const instalmentNumber = body?.instalmentNumber;
  if (!Number.isSafeInteger(instalmentNumber)) throw badRequest('INVALID_CHARGE', 'instalmentNumber must be an integer');
  return withTx(pool, async (tx) => {
    await lockLoan(tx, loanId);
    const inst = await tx.query('SELECT due_date FROM instalments WHERE loan_id = $1 AND number = $2', [loanId, instalmentNumber]);
    if (!inst.rows[0]) throw notFound(`instalment ${instalmentNumber} of loan ${loanId}`);
    const { rows } = await tx.query(
      `INSERT INTO loan_charges (loan_id, instalment_number, type, amount, assessed_on, reason) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [loanId, instalmentNumber, type, amount.toString(), assessedOn, typeof body?.reason === 'string' ? body.reason : null],
    );
    const chargeId = String(rows[0].id);
    const reallocations = await reconcileAllocations(tx, loanId, {
      kind: 'CHARGE_ASSESSED',
      ref: chargeId,
      date: assessedOn,
      reason: `${type.toLowerCase()} ${chargeId} assessed on instalment ${instalmentNumber}`,
    });
    return { charge: { id: chargeId, loanId, instalmentNumber, type, amount, assessedOn }, reallocations: reallocations.map(presentChange) };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLoan(db: Db, loanId: string) {
  if (!/^\d+$/.test(loanId)) throw notFound(`loan ${loanId}`);
  const { rows } = await db.query('SELECT * FROM loans WHERE id = $1', [loanId]);
  const loan = rows[0];
  if (!loan) throw notFound(`loan ${loanId}`);
  const inst = await db.query(
    `SELECT i.*, a.entry_id IS NOT NULL AS accrued FROM instalments i
       LEFT JOIN interest_accruals a ON a.loan_id = i.loan_id AND a.instalment_number = i.number
      WHERE i.loan_id = $1 ORDER BY i.number`,
    [loanId],
  );
  const state = await loadState(db, loanId);
  const collected = new Map<string, bigint>();
  for (const per of state.current.values()) {
    for (const l of per.values()) {
      const k = bucketKey(l.instalmentNumber, l.component);
      collected.set(k, (collected.get(k) ?? 0n) + l.amount);
    }
  }
  const chargeTotal = (n: number, t: string) =>
    state.charges.filter((c) => c.instalmentNumber === n && c.type === t).reduce((s, c) => s + c.amount, 0n);

  let principalOutstanding = 0n;
  let interestReceivable = 0n;
  const instalments = inst.rows.map((i) => {
    const owed = { PENALTY: chargeTotal(i.number, 'PENALTY'), FEE: chargeTotal(i.number, 'FEE'), INTEREST: i.interest, PRINCIPAL: i.principal };
    const paid = {
      PENALTY: collected.get(bucketKey(i.number, 'PENALTY')) ?? 0n,
      FEE: collected.get(bucketKey(i.number, 'FEE')) ?? 0n,
      INTEREST: collected.get(bucketKey(i.number, 'INTEREST')) ?? 0n,
      PRINCIPAL: collected.get(bucketKey(i.number, 'PRINCIPAL')) ?? 0n,
    };
    const totalOwed = owed.PENALTY + owed.FEE + owed.INTEREST + owed.PRINCIPAL;
    const totalPaid = paid.PENALTY + paid.FEE + paid.INTEREST + paid.PRINCIPAL;
    principalOutstanding += owed.PRINCIPAL - paid.PRINCIPAL;
    if (i.accrued) interestReceivable += owed.INTEREST - paid.INTEREST;
    return {
      number: i.number,
      dueDate: i.due_date,
      openingBalance: i.opening_balance,
      payment: i.payment,
      interest: i.interest,
      principal: i.principal,
      closingBalance: i.closing_balance,
      penaltiesAssessed: owed.PENALTY,
      feesAssessed: owed.FEE,
      paid: { penalty: paid.PENALTY, fee: paid.FEE, interest: paid.INTEREST, principal: paid.PRINCIPAL, total: totalPaid },
      outstanding: totalOwed - totalPaid,
      interestAccrued: i.accrued,
      status: totalPaid === 0n ? 'UNPAID' : totalPaid >= totalOwed ? 'PAID' : 'PARTIAL',
    };
  });
  const unappliedCredit = [...collected.entries()].filter(([k]) => k.endsWith(':UNAPPLIED')).reduce((s, [, v]) => s + v, 0n);
  return {
    id: String(loan.id),
    principal: loan.principal,
    annualRate: loan.annual_rate,
    termMonths: loan.term_months,
    disbursementDate: loan.disbursement_date,
    instalment: loan.instalment_amount,
    balances: { principalOutstanding, interestReceivable, unappliedCredit },
    instalments,
  };
}

export async function listPayments(db: Db, loanId: string) {
  const state = await loadState(db, loanId);
  return state.payments.map((p) => ({
    id: p.id,
    amount: p.amount,
    valueDate: p.valueDate,
    reference: p.reference,
    status: p.reversed ? 'REVERSED' : 'APPLIED',
    allocation: sortLines([...(state.current.get(p.id)?.values() ?? [])]),
  }));
}

/** Audit trail: every allocation event (what changed, why, which entry carried it). */
export async function loanAudit(db: Db, loanId: string) {
  const { rows } = await db.query(
    `SELECT e.id, e.payment_id, e.kind, e.trigger_kind, e.trigger_ref, e.reason, e.entry_id, e.created_at,
            coalesce(json_agg(json_build_object('instalmentNumber', a.instalment_number, 'component', a.component,
                                                'amount', a.amount) ORDER BY a.id)
                     FILTER (WHERE a.id IS NOT NULL), '[]') AS changes
       FROM allocation_events e LEFT JOIN payment_allocations a ON a.event_id = e.id
      WHERE e.loan_id = $1 GROUP BY e.id ORDER BY e.id`,
    [loanId],
  );
  return rows.map((r) => ({
    eventId: String(r.id),
    paymentId: String(r.payment_id),
    kind: r.kind,
    trigger: { kind: r.trigger_kind, ref: String(r.trigger_ref) },
    reason: r.reason,
    journalEntryId: r.entry_id?.toString() ?? null,
    at: r.created_at,
    changes: r.changes,
  }));
}

// ---------------------------------------------------------------------------
// Reconciliation: sub-ledger (loan-level) vs control accounts
// ---------------------------------------------------------------------------

const diff = (a: bigint, b: bigint): bigint => a - b;

export async function reconciliation(db: Db) {
  const { rows } = await db.query(`
    WITH sub AS (
      SELECT l.id AS loan_id,
             (SELECT sum(principal) FROM instalments WHERE loan_id = l.id)
               - coalesce((SELECT sum(amount) FROM payment_allocations WHERE loan_id = l.id AND component = 'PRINCIPAL'), 0)
               AS loans_receivable,
             coalesce((SELECT sum(i.interest) FROM instalments i JOIN interest_accruals a
                         ON a.loan_id = i.loan_id AND a.instalment_number = i.number WHERE i.loan_id = l.id), 0)
               - coalesce((SELECT sum(amount) FROM payment_allocations WHERE loan_id = l.id AND component = 'INTEREST'), 0)
               AS interest_receivable,
             coalesce((SELECT sum(amount) FROM payment_allocations WHERE loan_id = l.id AND component = 'UNAPPLIED'), 0)
               AS unapplied_credit
        FROM loans l
    ),
    gl AS (
      SELECT jl.loan_id,
             coalesce(sum(CASE WHEN a.code = 'LOANS_RECEIVABLE' THEN CASE jl.side WHEN 'D' THEN jl.amount ELSE -jl.amount END END), 0) AS loans_receivable,
             coalesce(sum(CASE WHEN a.code = 'INTEREST_RECEIVABLE' THEN CASE jl.side WHEN 'D' THEN jl.amount ELSE -jl.amount END END), 0) AS interest_receivable,
             coalesce(sum(CASE WHEN a.code = 'UNAPPLIED_CREDIT' THEN CASE jl.side WHEN 'C' THEN jl.amount ELSE -jl.amount END END), 0) AS unapplied_credit
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code IN ('LOANS_RECEIVABLE', 'INTEREST_RECEIVABLE', 'UNAPPLIED_CREDIT')
       GROUP BY jl.loan_id
    )
    SELECT coalesce(sub.loan_id, gl.loan_id) AS loan_id,
           coalesce(sub.loans_receivable, 0)::bigint AS sub_lr, coalesce(gl.loans_receivable, 0)::bigint AS gl_lr,
           coalesce(sub.interest_receivable, 0)::bigint AS sub_ir, coalesce(gl.interest_receivable, 0)::bigint AS gl_ir,
           coalesce(sub.unapplied_credit, 0)::bigint AS sub_uc, coalesce(gl.unapplied_credit, 0)::bigint AS gl_uc
      FROM sub FULL OUTER JOIN gl ON gl.loan_id = sub.loan_id
     ORDER BY 1 NULLS LAST`);

  const totals = {
    LOANS_RECEIVABLE: { ledger: 0n, subledger: 0n },
    INTEREST_RECEIVABLE: { ledger: 0n, subledger: 0n },
    UNAPPLIED_CREDIT: { ledger: 0n, subledger: 0n },
  };
  const loans: any[] = [];
  let unattributed: any = null;
  for (const r of rows) {
    const line = {
      loansReceivable: { subledger: r.sub_lr, ledger: r.gl_lr, difference: diff(r.gl_lr, r.sub_lr) },
      interestReceivable: { subledger: r.sub_ir, ledger: r.gl_ir, difference: diff(r.gl_ir, r.sub_ir) },
      unappliedCredit: { subledger: r.sub_uc, ledger: r.gl_uc, difference: diff(r.gl_uc, r.sub_uc) },
    };
    totals.LOANS_RECEIVABLE.ledger += r.gl_lr;
    totals.LOANS_RECEIVABLE.subledger += r.sub_lr;
    totals.INTEREST_RECEIVABLE.ledger += r.gl_ir;
    totals.INTEREST_RECEIVABLE.subledger += r.sub_ir;
    totals.UNAPPLIED_CREDIT.ledger += r.gl_uc;
    totals.UNAPPLIED_CREDIT.subledger += r.sub_uc;
    const reconciled = line.loansReceivable.difference === 0n && line.interestReceivable.difference === 0n && line.unappliedCredit.difference === 0n;
    if (r.loan_id === null) unattributed = { ...line, reconciled, note: 'control-account lines with no loan attribution' };
    else loans.push({ loanId: String(r.loan_id), ...line, reconciled });
  }
  const controlAccounts = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [k, { ...v, difference: v.ledger - v.subledger }]),
  );
  const differences = loans.filter((l) => !l.reconciled);
  return {
    reconciled: differences.length === 0 && (unattributed === null || unattributed.reconciled),
    controlAccounts,
    differences,
    unattributed,
    loans,
  };
}
