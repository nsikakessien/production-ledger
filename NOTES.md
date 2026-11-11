# NOTES

## Assumptions (hiring contact not reachable; these are my readings)

- **Payment order is value date, then commit order.** A late webhook with an earlier value date is replayed into its true position; later payments get re-allocation deltas, so out-of-order delivery ends in the in-order state.
- **"Due" means `due_date <= value date`.** Money arriving before anything is due is unapplied credit, a liability, and is never auto-applied later.
- **Interest is accrued inside the payment transaction** for instalments due by the value date, so Interest Receivable never goes negative. The accrual job stays idempotent (PK on loan + instalment).
- **Closed periods.** Manual entries dated in a closed period get 409. System events and corrections (late webhooks, accruals, reversals, re-allocations) post on the first day of the next open period, keep their effective date, and reference the original.
- **A reversal is never dated before what it reverses.** Default date: the later of the original's date and today.
- **Rounding.** Advance, fee and penalty are each rounded half-up once from exact rationals. Fee and penalty use the rounded advance, since the advance is a posted amount.
- **Rates.** Decimal strings or numbers, parsed exactly. Below 1 is a fraction (`0.18`); 1 or more is a percentage (`18` = 18%, `1` = 1%). For 100% or more, write `"150%"`.
- **Term-loan penalties and fees** are assessed via `POST /loans/:id/charges` and become income only when collected.
- **Invoice settlement** must be the full face value (partials: 422).
- **`/ledger/entries/:id/reverse`** mirrors MANUAL entries (and reversals of them). PAYMENT entries go through payment reversal. Other system entries return 422, since reversing them would desync the sub-ledger.
- **Idempotency keys are global.** Same key with a different body or loan: 422. A failed request does not consume its key. A bank `reference` is unique per loan (409 on a duplicate sent under a new key).

## Verified by hand

- Worked Examples 1 and 2 to the kobo, in unit tests and over HTTP.
- The task-4 scenario over HTTP against `docker compose up`: reversal lines, Y's 288,945 delta, PAID/UNPAID, Loans Receivable 100,736,974, Interest Receivable 1,511,055, reconciled, trial balance balanced.
- Concurrency over real HTTP: 50 parallel payments, and 50 requests sharing one key (byte-identical replays).
- **Mutation checks:** removing the per-loan lock fails both concurrency tests; every DB guard has a raw-SQL test that bypasses the app.
- `docker compose --profile test run --rm --build test`: 79/79 passing.

## Did not get to

- A webhook inbox table storing the raw bank payload before processing.
- Pagination, auth, and recording *who* reversed or closed.
- A DB check that a reversal exactly mirrors its original.
- Invoice partial payments, invoice reversal, Invoice Receivables reconciliation.
- Concurrency tests against a separate server process (they use Fastify `inject` with a real 30-connection pool).
