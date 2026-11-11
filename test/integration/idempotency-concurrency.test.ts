import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, api, createTestEnv, createWE1Loan, loanRecon, pay, trialBalance } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const paymentEntries = async (loanId: string) =>
  (await env.pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE loan_id = $1 AND kind = 'PAYMENT'`, [loanId])).rows[0].n;

describe('idempotent payments', () => {
  it('same key + same body returns the original response and posts nothing new', async () => {
    const loan = await createWE1Loan(env.app);
    const first = await pay(env.app, loan.id, 1_000_000, '2025-02-15', 'idem-1');
    const second = await pay(env.app, loan.id, 1_000_000, '2025-02-15', 'idem-1');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await paymentEntries(loan.id)).toBe(1);
  });

  it('a replay is byte-identical to the original response', async () => {
    const loan = await createWE1Loan(env.app);
    const send = () =>
      env.app.inject({
        method: 'POST',
        url: `/loans/${loan.id}/payments`,
        payload: { amount: 25_000_000, date: '2025-02-15' },
        headers: { 'idempotency-key': 'idem-bytes' },
      });
    const first = await send();
    const replay = await send();
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.statusCode).toBe(first.statusCode);
    expect(replay.body).toBe(first.body); // raw string, not deep-equal: key order must survive storage
  });

  it('same key + different body is rejected with 422', async () => {
    const loan = await createWE1Loan(env.app);
    await pay(env.app, loan.id, 1_000_000, '2025-02-15', 'idem-2');
    const diffAmount = await pay(env.app, loan.id, 1_000_001, '2025-02-15', 'idem-2');
    expect(diffAmount.status).toBe(422);
    expect(diffAmount.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const other = await createWE1Loan(env.app);
    expect((await pay(env.app, other.id, 1_000_000, '2025-02-15', 'idem-2')).status).toBe(422); // same key, other loan
    expect(await paymentEntries(loan.id)).toBe(1);
  });

  it('50 simultaneous requests with the same key produce exactly one journal entry', async () => {
    const loan = await createWE1Loan(env.app);
    const results = await Promise.all(Array.from({ length: 50 }, () => pay(env.app, loan.id, 2_500_000, '2025-02-15', 'idem-storm')));
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(201));
    const ids = new Set(results.map((r) => r.body.payment.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(49);
    expect(await paymentEntries(loan.id)).toBe(1);
    const { rows } = await env.pool.query('SELECT count(*)::int AS n FROM payments WHERE loan_id = $1', [loan.id]);
    expect(rows[0].n).toBe(1);
  });

  it('a failed request does not burn the key', async () => {
    const loan = await createWE1Loan(env.app);
    expect((await pay(env.app, loan.id, 100, '2024-01-01', 'idem-3')).status).toBe(422);
    expect((await pay(env.app, loan.id, 100, '2025-02-15', 'idem-3')).status).toBe(201);
  });
});

describe('concurrent payments on one loan', () => {
  it('50 parallel payments of 1,000,000 apply exactly 21,063,026 to instalment 1 and leave 28,936,974 unapplied', async () => {
    const loan = await createWE1Loan(env.app);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => pay(env.app, loan.id, 1_000_000, '2025-02-15', `par-${i}`)));
    expect(results.map((r) => r.status)).toEqual(Array(50).fill(201));

    const view = await api(env.app, 'GET', `/loans/${loan.id}`);
    const i1 = view.body.instalments[0];
    expect(i1.paid).toEqual({ penalty: 0, fee: 0, interest: 1_800_000, principal: 19_263_026, total: 21_063_026 });
    expect(i1.status).toBe('PAID');
    expect(view.body.instalments.slice(1).every((i: any) => i.paid.total === 0)).toBe(true);
    expect(view.body.balances.unappliedCredit).toBe(28_936_974);

    // Applied in commit order: the first ~21 payments fill instalment 1, exactly one is split, the rest are unapplied.
    const payments = (await api(env.app, 'GET', `/loans/${loan.id}/payments`)).body;
    const unappliedOnly = payments.filter((p: any) => p.allocation.length === 1 && p.allocation[0].component === 'UNAPPLIED');
    const split = payments.filter((p: any) => p.allocation.some((l: any) => l.component === 'UNAPPLIED') && p.allocation.length > 1);
    expect(unappliedOnly).toHaveLength(28);
    expect(split).toHaveLength(1);
    // No payment ever re-allocated: each was applied once, against a consistent view.
    const audit = (await api(env.app, 'GET', `/loans/${loan.id}/audit`)).body;
    expect(audit.filter((e: any) => e.kind === 'REALLOCATE')).toHaveLength(0);

    const tb = await trialBalance(env.app);
    expect(tb.balanced).toBe(true);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
    expect(await paymentEntries(loan.id)).toBe(50);
  });

  it('payments on different loans proceed in parallel and each loan stays reconciled', async () => {
    const loans = await Promise.all(Array.from({ length: 5 }, () => createWE1Loan(env.app)));
    await Promise.all(loans.flatMap((l) => Array.from({ length: 10 }, (_, i) => pay(env.app, l.id, 5_000_000, '2025-03-15', `multi-${l.id}-${i}`))));
    const recon = (await api(env.app, 'GET', '/reconciliation')).body;
    expect(recon.reconciled).toBe(true);
    for (const l of loans) {
      const v = (await api(env.app, 'GET', `/loans/${l.id}`)).body;
      expect(v.instalments[0].status).toBe('PAID');
      expect(v.instalments[1].status).toBe('PAID');
      expect(v.balances.unappliedCredit).toBe(50_000_000 - 21_063_026 * 2);
    }
  });
});
