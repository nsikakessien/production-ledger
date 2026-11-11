# Design note: production ledger

## Shape of the system

Two layers that must always agree:

- **General ledger**: `journal_entries` and `journal_lines`. Integer kobo only, at least 2 lines per entry, debits = credits, append-only.
- **Loan sub-ledger**: `loans` and `instalments` (immutable schedule), `payments`, `payment_reversals`, and `allocation_events` + `payment_allocations`. Allocations are stored as **signed deltas**: the current allocation of a payment is `SUM(amount)` per (instalment, component). Nothing is updated in place, so the audit trail *is* the data. Each event records what changed, the trigger (payment received / reversed / charge assessed), a reason, and the journal entry that carried it.

Every write to a loan follows one algorithm: **replay the live payment history through the pure waterfall, diff it against what is currently booked, and post only the difference.** A new payment gets its PAYMENT entry. Any other payment whose allocation moved gets a REALLOCATION entry: net per account, never touching Cash, and pointing at the original with `corrects_entry_id`. A reversal posts the mirror of the payment's *current* allocation (`reverses_entry_id`, UNIQUE), then replays. Reversals, out-of-order webhooks and back-dated charges are therefore the same code path, and the path is deterministic.

## Where each invariant is enforced (DB first, app second)

| Invariant | Database | App |
|---|---|---|
| Balanced, ≥2 lines | deferred constraint triggers on entries + lines (checked at COMMIT) | pre-check for a clean 422 |
| Immutable history | `BEFORE UPDATE/DELETE/TRUNCATE` triggers on 15 tables; app role has only SELECT/INSERT and doesn't own the tables (can't disable triggers) | no update paths exist |
| No lines added to a committed entry | `created_txid = txid_current()` check on line insert | n/a |
| Reverse at most once | `UNIQUE(reverses_entry_id)`, `payment_reversals` PK | 409 pre-check |
| Closed period | insert trigger rejects; close/post serialised by an advisory lock (exclusive vs shared) | roll-forward for corrections |
| Allocation integrity | deferred triggers: a payment's allocations = its amount (0 once reversed); no instalment component over-collected | waterfall |
| Money is integer kobo | `BIGINT` + `CHECK (amount > 0)` and friends | BigInt everywhere; floats rejected at the API |

**Concurrency mechanism: a per-loan transaction-scoped advisory lock** (`pg_advisory_xact_lock(1, loan_id)`), taken before reading loan state. All writers to a loan run one at a time, in lock order = commit order. The payment id (the tiebreak in the waterfall) is assigned after the lock, so "as if applied one at a time in commit order" holds by construction. Other loans are unaffected. I chose it over the alternatives because:
- `SELECT … FOR UPDATE` needs UPDATE privilege on the immutable `loans` table, which the app role deliberately lacks.
- SERIALIZABLE with retry would thrash under the 50-way hot-loan test: every payment conflicts with every other.
- Optimistic versioning needs a mutable version column.

The deferred allocation triggers are the backstop. With the lock removed, the concurrency test fails loudly rather than corrupting data.

## Failure modes

**Handled.**
- Duplicate webhooks with the same key: the key row is claimed with `INSERT … ON CONFLICT DO NOTHING`. A concurrent duplicate blocks on the uncommitted row, then replays the stored response. The response is written in the same transaction, so a committed key is always complete.
- Same key with a different body or loan: 422.
- The same bank `reference` under a new key: 409.
- A crash mid-request: the whole transaction rolls back and the key is not burned.
- Out-of-order and late webhooks: replay by value date. A value date in a closed period posts to the next open period and keeps its effective date.
- Concurrent double reversal: exactly one wins.
- Concurrent accrual jobs: PK on `(loan, instalment)`.
- Period close racing posts: exclusive vs shared advisory lock.
- Deadlock or serialization errors: retried.
- Drift introduced by hand: reported per loan by `/reconciliation`.

**Not handled.**
- Partial invoice settlements, and reversing invoice postings.
- Multi-currency.
- Reopening a period (deliberately impossible).
- The cost of the full replay grows with payments per loan. That's fine for a few hundred; see the 100x section below.
- An actor/identity on audit rows.
- A superuser can still `ALTER TABLE … DISABLE TRIGGER`. Mitigation: separate the owner role, use pgaudit, and run drift detection.

## Duplicate and out-of-order bank webhooks

1. **Duplicate, same Idempotency-Key** (the normal retry): the stored response is returned byte-for-byte with `Idempotent-Replayed: true`, and nothing is posted. This holds even with 50 at once.
2. **Duplicate, new key, same bank reference**: `UNIQUE(loan_id, reference)` gives 409 `DUPLICATE_REFERENCE`. The bank's own transaction id should always be sent as `reference`. In production I'd make it mandatory and derive the idempotency key from it.
3. **Out of order**: a webhook whose value date precedes already-booked payments is inserted at its true position. The replay then moves the later payments' allocations with REALLOCATION entries, so the final state equals in-order delivery (there's a test for this). Accrual is idempotent, so a webhook can't double-post interest either.

## Detecting ledger drift in production

- Run `/reconciliation` on a schedule (and after every period close). It compares, **per loan**, the sub-ledger (scheduled principal − allocated principal; accrued interest − allocated interest; unapplied allocations) with the control-account lines carrying that `loan_id`. It also reports control-account lines with no loan attached. Any non-zero difference pages someone; the difference itself is the size of the problem.
- Trial-balance check (`totalDebits = totalCredits`) and per-entry balance at commit.
- Cash reconciliation against bank statements: match `payments.reference` to statement lines. Anything unmatched in either direction is drift that the internal checks can't see.
- Optional hash chain over journal lines per period, sealed at close, to detect tampering by a privileged user.

## At 100x the volume

- **Hot loans.** The advisory lock is per loan, so throughput scales with the number of loans, not payments. Contention only matters for one very busy loan, which is unusual for a lending book.
- **Replay cost.** Replay only from the earliest affected value date, using a per-loan allocation snapshot at the last fully settled instalment. Older history becomes immutable once its period closes, so snapshots are safe.
- **Ingestion.** Accept webhooks into an append-only inbox table (dedup on bank reference), then process asynchronously per loan through a partitioned queue keyed by loan id. That keeps webhook latency low and preserves per-loan ordering without locks on the request path.
- **Reads.** Maintain `account_balances(account, loan, period)` rollups, written in the same transaction or rebuilt from lines, so the trial balance and reconciliation don't scan all lines. Partition `journal_lines` by period; closed partitions become read-only.
- **Jobs.** Run the accrual job in batches with `SKIP LOCKED`, one transaction per loan as now. Replace the deferred per-row triggers with per-statement transition-table triggers to cut COMMIT cost on large entries.
- **Ops.** Read replicas for reporting, PITR backups, and reconciliation run against a replica.
