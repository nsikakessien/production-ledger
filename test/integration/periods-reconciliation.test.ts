import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, api, createTestEnv, createWE1Loan, loanRecon, pay } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const manual = (date: string, lines: any[]) => api(env.app, 'POST', '/ledger/entries', { date, description: 't', lines });

describe('period close', () => {
  it('closes a period permanently and rejects entries dated inside it', async () => {
    const res = await api(env.app, 'POST', '/periods/2022-05/close');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ period: '2022-05', status: 'CLOSED', alreadyClosed: false });
    expect((await api(env.app, 'POST', '/periods/2022-05/close')).body.alreadyClosed).toBe(true);
    expect((await api(env.app, 'POST', '/periods/2022-13/close')).status).toBe(400);

    const rejected = await manual('2022-05-31', [
      { account: 'CASH', debit: 1 },
      { account: 'FEE_INCOME', credit: 1 },
    ]);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('PERIOD_CLOSED');
    expect((await manual('2022-06-01', [{ account: 'CASH', debit: 1 }, { account: 'FEE_INCOME', credit: 1 }])).status).toBe(201);
  });

  it('accepts Content-Type: application/json with an empty body on bodiless POSTs', async () => {
    const empty = (url: string) => env.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '' });
    const close = await empty('/periods/2022-01/close');
    expect(close.statusCode).toBe(200);
    expect(close.json()).toMatchObject({ period: '2022-01', status: 'CLOSED' });

    const m = await manual('2022-02-10', [{ account: 'CASH', debit: 3 }, { account: 'FEE_INCOME', credit: 3 }]);
    expect((await empty(`/ledger/entries/${m.body.id}/reverse`)).statusCode).toBe(201);

    const loan = await createWE1Loan(env.app, { disbursementDate: '2022-02-01' });
    const p = await pay(env.app, loan.id, 1_000, '2022-03-01');
    expect((await empty(`/loans/${loan.id}/payments/${p.body.payment.id}/reverse`)).statusCode).toBe(200);

    // Malformed JSON is still a 400.
    const bad = await env.app.inject({ method: 'POST', url: '/ledger/entries', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(bad.statusCode).toBe(400);
  });

  it('a late bank webhook for a closed period is booked in the next open period with its value date kept', async () => {
    const loan = await createWE1Loan(env.app, { disbursementDate: '2022-07-10' });
    await api(env.app, 'POST', '/periods/2022-08/close');
    await api(env.app, 'POST', '/periods/2022-09/close');
    const res = await pay(env.app, loan.id, 21_063_026, '2022-08-10');
    expect(res.status).toBe(201);
    expect(res.body.journalEntry.effectiveDate).toBe('2022-08-10');
    expect(res.body.journalEntry.entryDate).toBe('2022-10-01');
    // the interest accrual it triggered also rolled forward, and allocation still used the value date
    expect(res.body.accrualsPosted[0].entryDate).toBe('2022-10-01');
    expect(res.body.allocation.map((l: any) => l.instalmentNumber)).toEqual([1, 1]);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('close racing with posts never lets an entry into the closed period', async () => {
    const loan = await createWE1Loan(env.app, { disbursementDate: '2021-01-01' });
    const posts = Array.from({ length: 30 }, (_, i) => pay(env.app, loan.id, 100_000, '2021-02-10', `race-${i}`));
    const close = new Promise((r) => setTimeout(r, 5)).then(() => api(env.app, 'POST', '/periods/2021-02/close'));
    const [results, closed] = await Promise.all([Promise.all(posts), close]);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(closed.status).toBe(200);
    const { rows } = await env.owner.query(
      `SELECT e.entry_date, e.created_at, p.closed_at FROM journal_entries e, closed_periods p
        WHERE p.period = '2021-02' AND e.loan_id = $1 AND e.kind = 'PAYMENT'`,
      [loan.id],
    );
    for (const r of rows) {
      expect(['2021-02-10', '2021-03-01']).toContain(r.entry_date);
    }
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });
});

describe('reconciliation', () => {
  it('ties loan-level balances to the control accounts', async () => {
    const loan = await createWE1Loan(env.app, { disbursementDate: '2024-01-15' });
    await api(env.app, 'POST', '/jobs/accrue?asOf=2024-03-15');
    await pay(env.app, loan.id, 30_000_000, '2024-02-15');
    const { all, loan: r } = await loanRecon(env.app, loan.id);
    expect(r.reconciled).toBe(true);
    expect(r.loansReceivable.ledger).toBe(100_736_974);
    expect(r.interestReceivable.ledger).toBe(1_511_055);
    expect(r.unappliedCredit.ledger).toBe(30_000_000 - 21_063_026);
    expect(all.reconciled).toBe(true);
    for (const c of Object.values(all.controlAccounts) as any[]) expect(c.difference).toBe(0);
  });

  it('reports a difference per loan when the ledger drifts from the sub-ledger', async () => {
    const loan = await createWE1Loan(env.app, { disbursementDate: '2024-01-15' });
    // A manual entry hits Loans Receivable for this loan without going through the sub-ledger.
    await manual('2024-04-01', [
      { account: 'LOANS_RECEIVABLE', debit: 500, loanId: loan.id },
      { account: 'CASH', credit: 500 },
    ]);
    // ...and one hits Unapplied Credit with no loan at all.
    await manual('2024-04-01', [
      { account: 'CASH', debit: 70 },
      { account: 'UNAPPLIED_CREDIT', credit: 70 },
    ]);
    const { all, loan: r } = await loanRecon(env.app, loan.id);
    expect(all.reconciled).toBe(false);
    expect(r.reconciled).toBe(false);
    expect(r.loansReceivable.difference).toBe(500);
    expect(all.differences.map((d: any) => d.loanId)).toEqual([loan.id]);
    expect(all.unattributed.unappliedCredit.difference).toBe(70);
    expect(all.controlAccounts.LOANS_RECEIVABLE.difference).toBe(500);
    expect(all.controlAccounts.UNAPPLIED_CREDIT.difference).toBe(70);
  });
});
