import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, api, createTestEnv, createWE1Loan, loanRecon, pay, trialBalance } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const INST = 21_063_026;
const D = ['2025-02-15', '2025-03-15', '2025-04-15', '2025-05-15', '2025-06-15', '2025-07-15'];
const lines = (entry: any) =>
  entry.lines.map((l: any) => [l.account, l.debit, l.credit]).sort((a: any, b: any) => (a[0] < b[0] ? -1 : 1));
const loanView = async (id: string) => (await api(env.app, 'GET', `/loans/${id}`)).body;
const statuses = async (id: string) => (await loanView(id)).instalments.map((i: any) => i.status);
const reverse = (loanId: string, paymentId: string, body: any = { reason: 'bounced cheque' }) =>
  api(env.app, 'POST', `/loans/${loanId}/payments/${paymentId}/reverse`, body);

describe('visible scenario: bounced cheque X, later payment Y re-allocated', () => {
  it('produces exactly the expected end state', async () => {
    const loan = await createWE1Loan(env.app);
    await api(env.app, 'POST', `/jobs/accrue?asOf=${D[1]}`);
    const x = await pay(env.app, loan.id, INST, D[0]);
    const y = await pay(env.app, loan.id, INST, D[1]);
    expect(y.body.allocation).toEqual([
      { instalmentNumber: 2, component: 'INTEREST', amount: 1_511_055 },
      { instalmentNumber: 2, component: 'PRINCIPAL', amount: 19_551_971 },
    ]);

    const res = await reverse(loan.id, x.body.payment.id);
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('REVERSED');

    // Full reversal of X
    expect(res.body.reversalEntry.reversesEntryId).toBe(x.body.journalEntry.id);
    expect(lines(res.body.reversalEntry)).toEqual([
      ['CASH', 0, INST],
      ['INTEREST_RECEIVABLE', 1_800_000, 0],
      ['LOANS_RECEIVABLE', 19_263_026, 0],
    ]);

    // Re-allocation delta for Y
    expect(res.body.reallocations).toHaveLength(1);
    const ry = res.body.reallocations[0];
    expect(ry.paymentId).toBe(y.body.payment.id);
    expect(ry.before).toEqual(y.body.allocation);
    expect(ry.after).toEqual([
      { instalmentNumber: 1, component: 'INTEREST', amount: 1_800_000 },
      { instalmentNumber: 1, component: 'PRINCIPAL', amount: 19_263_026 },
    ]);
    expect(lines(ry.entry)).toEqual([
      ['INTEREST_RECEIVABLE', 0, 288_945],
      ['LOANS_RECEIVABLE', 288_945, 0],
    ]);
    expect(ry.entry.correctsEntryId).toBe(y.body.journalEntry.id);

    expect(await statuses(loan.id)).toEqual(['PAID', 'UNPAID', 'UNPAID', 'UNPAID', 'UNPAID', 'UNPAID']);
    const payments = (await api(env.app, 'GET', `/loans/${loan.id}/payments`)).body;
    expect(payments.map((p: any) => p.status)).toEqual(['REVERSED', 'APPLIED']);
    expect(payments[0].allocation).toEqual([]);

    const { loan: r } = await loanRecon(env.app, loan.id);
    expect(r.loansReceivable).toEqual({ subledger: 100_736_974, ledger: 100_736_974, difference: 0 });
    expect(r.interestReceivable).toEqual({ subledger: 1_511_055, ledger: 1_511_055, difference: 0 });
    expect((await trialBalance(env.app)).balanced).toBe(true);

    // Audit trail: what changed and why
    const audit = (await api(env.app, 'GET', `/loans/${loan.id}/audit`)).body;
    expect(audit.map((e: any) => [e.paymentId, e.kind, e.trigger.kind])).toEqual([
      [x.body.payment.id, 'ALLOCATE', 'PAYMENT_RECEIVED'],
      [y.body.payment.id, 'ALLOCATE', 'PAYMENT_RECEIVED'],
      [x.body.payment.id, 'REVERSE', 'PAYMENT_REVERSED'],
      [y.body.payment.id, 'REALLOCATE', 'PAYMENT_REVERSED'],
    ]);
    expect(audit[3].reason).toMatch(/reversal of payment/);
    expect(audit[3].journalEntryId).toBe(ry.entry.id);
  });
});

describe('hidden-test categories', () => {
  it('reversing the middle payment in a chain of five shifts the later ones back', async () => {
    const loan = await createWE1Loan(env.app);
    const ps = [];
    for (let i = 0; i < 5; i++) ps.push(await pay(env.app, loan.id, INST, D[i]));
    expect(await statuses(loan.id)).toEqual(['PAID', 'PAID', 'PAID', 'PAID', 'PAID', 'UNPAID']);

    const res = await reverse(loan.id, ps[2].body.payment.id);
    expect(res.status).toBe(200);
    expect(res.body.reallocations.map((r: any) => r.paymentId)).toEqual([ps[3].body.payment.id, ps[4].body.payment.id]);
    expect(lines(res.body.reallocations[0].entry)).toEqual([
      ['INTEREST_RECEIVABLE', 0, 1_217_775 - 920_096],
      ['LOANS_RECEIVABLE', 1_217_775 - 920_096, 0],
    ]);
    expect(lines(res.body.reallocations[1].entry)).toEqual([
      ['INTEREST_RECEIVABLE', 0, 920_096 - 617_952],
      ['LOANS_RECEIVABLE', 920_096 - 617_952, 0],
    ]);
    expect(await statuses(loan.id)).toEqual(['PAID', 'PAID', 'PAID', 'PAID', 'UNPAID', 'UNPAID']);
    const v = await loanView(loan.id);
    expect(v.balances.principalOutstanding).toBe(20_751_748 + 20_445_074);
    expect(v.balances.interestReceivable).toBe(617_952);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
    expect((await trialBalance(env.app)).balanced).toBe(true);
  });

  it('reversing a payment that created unapplied credit unwinds the credit too', async () => {
    const loan = await createWE1Loan(env.app);
    const x = await pay(env.app, loan.id, 25_000_000, D[0]);
    const y = await pay(env.app, loan.id, INST, D[1]);
    const res = await reverse(loan.id, x.body.payment.id);
    expect(lines(res.body.reversalEntry)).toEqual([
      ['CASH', 0, 25_000_000],
      ['INTEREST_RECEIVABLE', 1_800_000, 0],
      ['LOANS_RECEIVABLE', 19_263_026, 0],
      ['UNAPPLIED_CREDIT', 3_936_974, 0],
    ]);
    expect(res.body.reallocations.map((r: any) => r.paymentId)).toEqual([y.body.payment.id]);
    const v = await loanView(loan.id);
    expect(v.balances.unappliedCredit).toBe(0);
    expect(v.instalments.map((i: any) => i.status).slice(0, 2)).toEqual(['PAID', 'UNPAID']);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('reversing a purely unapplied payment needs no re-allocation', async () => {
    const loan = await createWE1Loan(env.app);
    await pay(env.app, loan.id, INST, D[0]);
    const q = await pay(env.app, loan.id, 5_000_000, D[0]);
    const res = await reverse(loan.id, q.body.payment.id);
    expect(lines(res.body.reversalEntry)).toEqual([
      ['CASH', 0, 5_000_000],
      ['UNAPPLIED_CREDIT', 5_000_000, 0],
    ]);
    expect(res.body.reallocations).toEqual([]);
  });

  it('a later payment that was partly unapplied absorbs the gap left by a reversal', async () => {
    const loan = await createWE1Loan(env.app);
    const x = await pay(env.app, loan.id, 10_000_000, D[0]);
    const y = await pay(env.app, loan.id, 30_000_000, D[0]); // 11,063,026 to inst 1, rest unapplied
    const res = await reverse(loan.id, x.body.payment.id);
    const ry = res.body.reallocations[0];
    expect(ry.paymentId).toBe(y.body.payment.id);
    expect(lines(ry.entry)).toEqual([
      ['INTEREST_RECEIVABLE', 0, 1_800_000],
      ['LOANS_RECEIVABLE', 0, 8_200_000],
      ['UNAPPLIED_CREDIT', 10_000_000, 0],
    ]);
    const v = await loanView(loan.id);
    expect(v.instalments[0].status).toBe('PAID');
    expect(v.balances.unappliedCredit).toBe(30_000_000 - INST);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('double reversal is rejected, including when concurrent', async () => {
    const loan = await createWE1Loan(env.app);
    const x = await pay(env.app, loan.id, INST, D[0]);
    expect((await reverse(loan.id, x.body.payment.id)).status).toBe(200);
    const again = await reverse(loan.id, x.body.payment.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REVERSED');
    // through the ledger endpoint as well
    expect((await api(env.app, 'POST', `/ledger/entries/${x.body.journalEntry.id}/reverse`)).status).toBe(409);

    const z = await pay(env.app, loan.id, INST, D[1]);
    const races = await Promise.all(Array.from({ length: 10 }, () => reverse(loan.id, z.body.payment.id)));
    expect(races.filter((r) => r.status === 200)).toHaveLength(1);
    expect(races.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('reversal after period close posts in the next open period, referencing the original', async () => {
    const loan = await createWE1Loan(env.app, { disbursementDate: '2023-01-15' });
    const x = await pay(env.app, loan.id, INST, '2023-02-15');
    const y = await pay(env.app, loan.id, INST, '2023-03-15');
    await api(env.app, 'POST', '/periods/2023-02/close');
    await api(env.app, 'POST', '/periods/2023-03/close');

    const res = await reverse(loan.id, x.body.payment.id, { reason: 'bounced', date: '2023-03-20' });
    expect(res.status).toBe(200);
    expect(res.body.reversalEntry.effectiveDate).toBe('2023-03-20');
    expect(res.body.reversalEntry.entryDate).toBe('2023-04-01');
    expect(res.body.reversalEntry.reversesEntryId).toBe(x.body.journalEntry.id);
    const ry = res.body.reallocations[0];
    expect(ry.entry.entryDate).toBe('2023-04-01');
    expect(ry.entry.correctsEntryId).toBe(y.body.journalEntry.id);

    // nothing new was dated inside the closed periods
    const { rows } = await env.pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE loan_id = $1 AND entry_date BETWEEN '2023-02-01' AND '2023-03-31' AND id > $2`,
      [loan.id, y.body.journalEntry.id],
    );
    expect(rows[0].n).toBe(0);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('out-of-order delivery ends in the same state as in-order delivery', async () => {
    const inOrder = await createWE1Loan(env.app);
    await pay(env.app, inOrder.id, INST, D[0]);
    await pay(env.app, inOrder.id, INST, D[1]);

    const outOfOrder = await createWE1Loan(env.app);
    const y = await pay(env.app, outOfOrder.id, INST, D[1]); // the D2 webhook arrives first...
    expect(y.body.allocation.map((l: any) => l.instalmentNumber)).toEqual([1, 1]);
    const x = await pay(env.app, outOfOrder.id, INST, D[0]); // ...then the D1 one
    expect(x.body.allocation.map((l: any) => l.instalmentNumber)).toEqual([1, 1]);
    expect(x.body.reallocations.map((r: any) => r.paymentId)).toEqual([y.body.payment.id]);
    // Y moves from instalment 1 to instalment 2: less interest, more principal.
    expect(lines(x.body.reallocations[0].entry)).toEqual([
      ['INTEREST_RECEIVABLE', 288_945, 0],
      ['LOANS_RECEIVABLE', 0, 288_945],
    ]);

    const a = await loanView(inOrder.id);
    const b = await loanView(outOfOrder.id);
    expect(b.instalments.map((i: any) => i.paid)).toEqual(a.instalments.map((i: any) => i.paid));
    expect(b.balances).toEqual(a.balances);
    expect((await loanRecon(env.app, outOfOrder.id)).loan.reconciled).toBe(true);
    expect((await trialBalance(env.app)).balanced).toBe(true);
  });

  it('reversing through the ledger endpoint uses the same payment-reversal path', async () => {
    const loan = await createWE1Loan(env.app);
    const x = await pay(env.app, loan.id, INST, D[0]);
    const y = await pay(env.app, loan.id, INST, D[1]);
    const res = await api(env.app, 'POST', `/ledger/entries/${x.body.journalEntry.id}/reverse`, { reason: 'wrong loan' });
    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe('REVERSED');
    expect(res.body.reallocations.map((r: any) => r.paymentId)).toEqual([y.body.payment.id]);
    // re-allocation entries cannot be reversed directly
    const re = await api(env.app, 'POST', `/ledger/entries/${res.body.reallocations[0].entry.id}/reverse`);
    expect(re.status).toBe(422);
  });

  it('reversal then new payment then reversal again stays consistent (reversal chain)', async () => {
    const loan = await createWE1Loan(env.app);
    const ps = [];
    for (let i = 0; i < 4; i++) ps.push(await pay(env.app, loan.id, 15_000_000, D[i]));
    await reverse(loan.id, ps[1].body.payment.id);
    await pay(env.app, loan.id, 12_345_678, D[1]);
    await reverse(loan.id, ps[0].body.payment.id);
    await reverse(loan.id, ps[3].body.payment.id);
    const v = await loanView(loan.id);
    // Live: 15,000,000 (D3) + 12,345,678 (D2) = 27,345,678 applied in value-date order.
    const totalPaid = v.instalments.reduce((s: number, i: any) => s + i.paid.total, 0) + v.balances.unappliedCredit;
    expect(totalPaid).toBe(27_345_678);
    expect(v.instalments[0].status).toBe('PAID');
    expect(v.instalments[1].status).toBe('PARTIAL');
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
    expect((await trialBalance(env.app)).balanced).toBe(true);
  });
});
