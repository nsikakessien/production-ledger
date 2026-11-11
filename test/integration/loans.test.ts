import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, WE1, api, createTestEnv, createWE1Loan, loanRecon, pay, trialBalance } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

describe('POST /loans', () => {
  it('returns the Worked Example 1 schedule to the kobo and posts the disbursement', async () => {
    const res = await api(env.app, 'POST', '/loans', WE1);
    expect(res.status).toBe(201);
    const loan = res.body;
    expect(loan.instalment).toBe(21_063_026);
    expect(loan.totalInterest).toBe(6_378_154);
    expect(loan.schedule.map((r: any) => [r.number, r.payment, r.interest, r.principal, r.closingBalance])).toEqual([
      [1, 21_063_026, 1_800_000, 19_263_026, 100_736_974],
      [2, 21_063_026, 1_511_055, 19_551_971, 81_185_003],
      [3, 21_063_026, 1_217_775, 19_845_251, 61_339_752],
      [4, 21_063_026, 920_096, 20_142_930, 41_196_822],
      [5, 21_063_026, 617_952, 20_445_074, 20_751_748],
      [6, 21_063_024, 311_276, 20_751_748, 0],
    ]);
    expect(loan.schedule[0].dueDate).toBe('2025-02-15');
    expect(loan.disbursementEntry.lines).toEqual([
      expect.objectContaining({ account: 'LOANS_RECEIVABLE', debit: 120_000_000, credit: 0 }),
      expect.objectContaining({ account: 'CASH', debit: 0, credit: 120_000_000 }),
    ]);
  });

  it('accepts the rate as a number or percentage and rejects float money', async () => {
    expect((await api(env.app, 'POST', '/loans', { ...WE1, annualRate: 0.18 })).body.instalment).toBe(21_063_026);
    expect((await api(env.app, 'POST', '/loans', { ...WE1, annualRate: 18 })).body.instalment).toBe(21_063_026);
    expect((await api(env.app, 'POST', '/loans', { ...WE1, principal: 1200000.5 })).status).toBe(400);
    expect((await api(env.app, 'POST', '/loans', { ...WE1, principal: -1 })).status).toBe(400);
    expect((await api(env.app, 'POST', '/loans', { ...WE1, termMonths: 0 })).status).toBe(400);
    expect((await api(env.app, 'POST', '/loans', { ...WE1, disbursementDate: '2025-02-30' })).status).toBe(400);
  });
});

describe('accrual job', () => {
  it('posts interest for each due instalment exactly once', async () => {
    const loan = await createWE1Loan(env.app);
    const r1 = await api(env.app, 'POST', '/jobs/accrue?asOf=2025-03-15');
    const mine = r1.body.entries.filter((e: any) => e.loanId === loan.id);
    expect(mine.map((e: any) => e.lines.map((l: any) => [l.account, l.debit, l.credit]))).toEqual([
      [
        ['INTEREST_RECEIVABLE', 1_800_000, 0],
        ['INTEREST_INCOME', 0, 1_800_000],
      ],
      [
        ['INTEREST_RECEIVABLE', 1_511_055, 0],
        ['INTEREST_INCOME', 0, 1_511_055],
      ],
    ]);
    expect(mine.map((e: any) => e.entryDate)).toEqual(['2025-02-15', '2025-03-15']);

    const again = await api(env.app, 'POST', '/jobs/accrue?asOf=2025-03-15');
    expect(again.body.entries.filter((e: any) => e.loanId === loan.id)).toHaveLength(0);

    // concurrent job runs do not double-accrue
    await Promise.all(Array.from({ length: 5 }, () => api(env.app, 'POST', '/jobs/accrue?asOf=2025-04-15')));
    const view = await api(env.app, 'GET', `/loans/${loan.id}`);
    expect(view.body.balances.interestReceivable).toBe(1_800_000 + 1_511_055 + 1_217_775);
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
  });

  it('requires asOf', async () => {
    expect((await api(env.app, 'POST', '/jobs/accrue')).status).toBe(400);
  });
});

describe('payments', () => {
  it('posts one entry following the waterfall, with excess as unapplied credit', async () => {
    const loan = await createWE1Loan(env.app);
    const res = await pay(env.app, loan.id, 25_000_000, '2025-02-20');
    expect(res.status).toBe(201);
    expect(res.body.allocation).toEqual([
      { instalmentNumber: 1, component: 'INTEREST', amount: 1_800_000 },
      { instalmentNumber: 1, component: 'PRINCIPAL', amount: 19_263_026 },
      { instalmentNumber: null, component: 'UNAPPLIED', amount: 3_936_974 },
    ]);
    expect(res.body.journalEntry.lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['CASH', 25_000_000, 0],
      ['INTEREST_RECEIVABLE', 0, 1_800_000],
      ['LOANS_RECEIVABLE', 0, 19_263_026],
      ['UNAPPLIED_CREDIT', 0, 3_936_974],
    ]);
    // interest for instalment 1 was accrued inside the payment transaction
    expect(res.body.accrualsPosted).toHaveLength(1);

    const view = await api(env.app, 'GET', `/loans/${loan.id}`);
    expect(view.body.instalments[0].status).toBe('PAID');
    expect(view.body.instalments[1].status).toBe('UNPAID');
    expect(view.body.balances).toEqual({ principalOutstanding: 100_736_974, interestReceivable: 0, unappliedCredit: 3_936_974 });
    expect((await loanRecon(env.app, loan.id)).loan.reconciled).toBe(true);
    expect((await trialBalance(env.app)).balanced).toBe(true);
  });

  it('collects penalty and fee before interest and recognises them as income', async () => {
    const loan = await createWE1Loan(env.app);
    expect((await api(env.app, 'POST', `/loans/${loan.id}/charges`, { instalmentNumber: 1, type: 'PENALTY', amount: 50_000, date: '2025-02-20' })).status).toBe(201);
    await api(env.app, 'POST', `/loans/${loan.id}/charges`, { instalmentNumber: 1, type: 'FEE', amount: 10_000, date: '2025-02-20' });
    const res = await pay(env.app, loan.id, 1_000_000, '2025-02-21');
    expect(res.body.journalEntry.lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['CASH', 1_000_000, 0],
      ['PENALTY_INCOME', 0, 50_000],
      ['FEE_INCOME', 0, 10_000],
      ['INTEREST_RECEIVABLE', 0, 940_000],
    ]);
    const view = await api(env.app, 'GET', `/loans/${loan.id}`);
    expect(view.body.instalments[0].status).toBe('PARTIAL');
  });

  it('a payment before anything is due is held entirely as unapplied credit', async () => {
    const loan = await createWE1Loan(env.app);
    const res = await pay(env.app, loan.id, 500, '2025-01-20');
    expect(res.body.journalEntry.lines.map((l: any) => l.account)).toEqual(['CASH', 'UNAPPLIED_CREDIT']);
  });

  it('validates input', async () => {
    const loan = await createWE1Loan(env.app);
    expect((await pay(env.app, loan.id, 100.5, '2025-02-20')).status).toBe(400);
    expect((await pay(env.app, loan.id, 0, '2025-02-20')).status).toBe(400);
    expect((await pay(env.app, loan.id, 100, '2024-12-31')).status).toBe(422); // before disbursement
    expect((await pay(env.app, '999999', 100, '2025-02-20')).status).toBe(404);
    expect((await api(env.app, 'POST', `/loans/${loan.id}/payments`, { amount: 1, date: '2025-02-20' })).status).toBe(400); // no key
  });

  it('rejects a duplicate bank reference sent under a different idempotency key', async () => {
    const loan = await createWE1Loan(env.app);
    const body = { amount: 1000, date: '2025-02-20', reference: 'BANK-123' };
    expect((await api(env.app, 'POST', `/loans/${loan.id}/payments`, body, { 'idempotency-key': 'a1' })).status).toBe(201);
    const dup = await api(env.app, 'POST', `/loans/${loan.id}/payments`, body, { 'idempotency-key': 'a2' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_REFERENCE');
  });
});

describe('manual ledger entries and trial balance', () => {
  it('posts balanced entries and rejects unbalanced or invalid ones', async () => {
    const ok = await api(env.app, 'POST', '/ledger/entries', {
      date: '2025-05-01',
      description: 'capital',
      lines: [
        { account: 'Cash', debit: 500 },
        { account: 'FEE_INCOME', credit: 500 },
      ],
    });
    expect(ok.status).toBe(201);
    const unbalanced = await api(env.app, 'POST', '/ledger/entries', {
      date: '2025-05-01',
      lines: [
        { account: 'CASH', debit: 500 },
        { account: 'FEE_INCOME', credit: 499 },
      ],
    });
    expect(unbalanced.status).toBe(422);
    const one = await api(env.app, 'POST', '/ledger/entries', { date: '2025-05-01', lines: [{ account: 'CASH', debit: 5 }] });
    expect(one.status).toBe(422);
    const float = await api(env.app, 'POST', '/ledger/entries', {
      date: '2025-05-01',
      lines: [
        { account: 'CASH', debit: 5.5 },
        { account: 'FEE_INCOME', credit: 5.5 },
      ],
    });
    expect(float.status).toBe(400);
    const tb = await trialBalance(env.app);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebits).toBe(tb.totalCredits);
    expect(tb.by.CASH.net).toBe(tb.by.CASH.debits - tb.by.CASH.credits);
  });

  it('reverses once and rejects a second reversal; reversal chains are allowed', async () => {
    const e = await api(env.app, 'POST', '/ledger/entries', {
      date: '2025-05-02',
      lines: [
        { account: 'CASH', debit: 700 },
        { account: 'FEE_INCOME', credit: 700 },
      ],
    });
    const r1 = await api(env.app, 'POST', `/ledger/entries/${e.body.id}/reverse`, { reason: 'typo' });
    expect(r1.status).toBe(201);
    expect(r1.body.reversesEntryId).toBe(e.body.id);
    expect(r1.body.lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['CASH', 0, 700],
      ['FEE_INCOME', 700, 0],
    ]);
    const r2 = await api(env.app, 'POST', `/ledger/entries/${e.body.id}/reverse`);
    expect(r2.status).toBe(409);
    // concurrent double reversal: exactly one wins
    const e2 = await api(env.app, 'POST', '/ledger/entries', {
      date: '2025-05-02',
      lines: [
        { account: 'CASH', debit: 1 },
        { account: 'FEE_INCOME', credit: 1 },
      ],
    });
    const races = await Promise.all(Array.from({ length: 10 }, () => api(env.app, 'POST', `/ledger/entries/${e2.body.id}/reverse`)));
    expect(races.filter((r) => r.status === 201)).toHaveLength(1);
    expect(races.filter((r) => r.status === 409)).toHaveLength(9);
    // reversal of the reversal re-instates the original
    const r3 = await api(env.app, 'POST', `/ledger/entries/${r1.body.id}/reverse`);
    expect(r3.status).toBe(201);
    expect(r3.body.lines.map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['CASH', 700, 0],
      ['FEE_INCOME', 0, 700],
    ]);
  });

  it('refuses to reverse sub-ledger-managed entries directly', async () => {
    const loan = await createWE1Loan(env.app);
    const res = await api(env.app, 'POST', `/ledger/entries/${loan.disbursementEntry.id}/reverse`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ENTRY_NOT_REVERSIBLE');
  });
});
