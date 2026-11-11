# Production Ledger

A double-entry lending ledger in Node.js (TypeScript), Fastify and Postgres 16. It covers term loans (annuity), invoice financing, idempotent and concurrent payments, reversal with re-allocation, period close, and reconciliation.

- Design note: [docs/DESIGN.md](docs/DESIGN.md)
- Assumptions, what was verified by hand, and what's missing: [NOTES.md](NOTES.md)
- Schema and every DB-level invariant: [db/migrations/001_schema.sql](db/migrations/001_schema.sql)

## Run

```bash
docker compose up --build app          # API on http://localhost:3000 (Postgres on localhost:5433)
```

## Test: one command, includes the concurrency tests

```bash
docker compose --profile test run --rm --build test     # or: npm run test:docker
```

To run locally against the compose database: `docker compose up -d db && npm install && npm test`.
Each test file runs in its own database, cloned from a migrated template, so files run in parallel.

## API (all money is integer kobo; dates are `YYYY-MM-DD`)

| Method & path | Body / notes |
|---|---|
| `POST /loans` | `{ principal, annualRate: "0.18", termMonths, disbursementDate }`, which returns the schedule and posts the disbursement |
| `GET /loans/:id` | schedule with per-instalment paid amounts and status (PAID / PARTIAL / UNPAID), plus balances |
| `POST /loans/:id/payments` | header `Idempotency-Key` (required); `{ amount, date, reference? }` |
| `GET /loans/:id/payments` | payments with their current allocation and status |
| `POST /loans/:id/payments/:paymentId/reverse` | `{ reason?, date? }`: reversal plus re-allocation of later payments |
| `GET /loans/:id/audit` | allocation audit trail: what changed, why, and which entry carried it |
| `POST /loans/:id/charges` | `{ instalmentNumber, type: PENALTY\|FEE, amount, date }` |
| `POST /jobs/accrue?asOf=` | accrues interest on due instalments (idempotent) |
| `POST /invoices/quote` | `{ faceValue, tenorDays \| advanceDate+dueDate, daysOverdue? \| settlementDate? }` |
| `POST /invoices`, `POST /invoices/:id/settle` | advance posting, then settlement posting (`{ date }`) |
| `POST /ledger/entries` | `{ date, description, lines: [{ account, debit \| credit, loanId? }] }` |
| `POST /ledger/entries/:id/reverse` | `{ reason?, date? }`; a second reversal returns 409 |
| `GET /ledger/trial-balance?asOf=` | per-account debits, credits, net, and the balance on the account's normal side |
| `POST /periods/:yyyy-mm/close`, `GET /periods` | close is permanent |
| `GET /reconciliation` | sub-ledger vs Loans Receivable, Interest Receivable and Unapplied Credit, per loan |

Errors are returned as `{ error: { code, message } }`, e.g. `PERIOD_CLOSED` (409), `ALREADY_REVERSED` (409), `IDEMPOTENCY_KEY_REUSED` (422), `UNBALANCED_ENTRY` (422).

## Layout

```
src/money.ts, schedule.ts, invoice-math.ts, allocation.ts   pure, exact domain logic (BigInt/rationals)
src/ledger.ts                                               posting, reversal, trial balance
src/loans.ts                                                loan lock, accrual, payments, replay/re-allocation, reconciliation
src/invoices.ts, periods.ts, app.ts                         invoice postings, period close, HTTP routes
test/unit                                                   worked examples, rounding boundaries, waterfall
test/integration                                            DB guards via raw SQL, idempotency, concurrency, reversals, close
```
