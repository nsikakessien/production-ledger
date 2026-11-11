import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, api, createTestEnv, trialBalance } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

const lines = (entry: any) => entry.lines.map((l: any) => [l.account, l.debit, l.credit]);
const FACE = 1_000_000_000;

describe('stored rates', () => {
  it('a 100% advance rate survives the DB round trip into settlement', async () => {
    // Stored as 1.000000000000; re-reading it through the API's percent rule would give 1%.
    const inv = await api(env.app, 'POST', '/invoices', { faceValue: 1_000_000, advanceRate: '100%', advanceDate: '2025-01-01', tenorDays: 30 });
    expect(inv.status).toBe(201);
    expect(inv.body.advance).toBe(1_000_000);
    const st = await api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-01-31' });
    expect(st.status).toBe(201);
    expect(st.body.advance).toBe(1_000_000);
    expect(st.body.discountFee).toBe(inv.body.discountFee);
  });
});

describe('POST /invoices/quote (Worked Example 2)', () => {
  it('quotes on-time settlement', async () => {
    const res = await api(env.app, 'POST', '/invoices/quote', { faceValue: FACE, tenorDays: 60 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      advance: 800_000_000,
      reserve: 200_000_000,
      discountFee: 47_342_466,
      latePenalty: 0,
      clientPayable: 152_657_534,
      clientShortfall: 0,
    });
  });

  it('quotes 10 days late, by days or by dates', async () => {
    const byDays = await api(env.app, 'POST', '/invoices/quote', { faceValue: FACE, tenorDays: 60, daysOverdue: 10 });
    const byDates = await api(env.app, 'POST', '/invoices/quote', {
      faceValue: FACE,
      advanceDate: '2025-01-01',
      dueDate: '2025-03-02',
      settlementDate: '2025-03-12',
    });
    for (const r of [byDays, byDates]) {
      expect(r.body).toMatchObject({ tenorDays: 60, daysOverdue: 10, latePenalty: 16_000_000, clientPayable: 136_657_534 });
    }
    // Paying on (or before) the due date is not overdue.
    const onDue = await api(env.app, 'POST', '/invoices/quote', { faceValue: FACE, advanceDate: '2025-01-01', dueDate: '2025-03-02', settlementDate: '2025-03-02' });
    expect(onDue.body.daysOverdue).toBe(0);
  });

  it('rejects float money', async () => {
    expect((await api(env.app, 'POST', '/invoices/quote', { faceValue: 100.5, tenorDays: 60 })).status).toBe(400);
  });
});

describe('invoice advance and settlement postings', () => {
  const create = () => api(env.app, 'POST', '/invoices', { faceValue: FACE, advanceDate: '2025-01-01', tenorDays: 60 });

  it('posts the advance and an on-time settlement exactly as in the brief', async () => {
    const inv = await create();
    expect(inv.status).toBe(201);
    expect(lines(inv.body.advanceEntry)).toEqual([
      ['INVOICE_RECEIVABLES', 800_000_000, 0],
      ['CASH', 0, 800_000_000],
    ]);
    const s = await api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-03-02' });
    expect(s.status).toBe(201);
    expect(lines(s.body.settlementEntry)).toEqual([
      ['CASH', FACE, 0],
      ['INVOICE_RECEIVABLES', 0, 800_000_000],
      ['FEE_INCOME', 0, 47_342_466],
      ['CLIENT_PAYABLE', 0, 152_657_534],
    ]);
    expect((await api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-03-02' })).status).toBe(409);
  });

  it('adds penalty income when settled 10 days late', async () => {
    const inv = await create();
    const s = await api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-03-12' });
    expect(lines(s.body.settlementEntry)).toEqual([
      ['CASH', FACE, 0],
      ['INVOICE_RECEIVABLES', 0, 800_000_000],
      ['FEE_INCOME', 0, 47_342_466],
      ['PENALTY_INCOME', 0, 16_000_000],
      ['CLIENT_PAYABLE', 0, 136_657_534],
    ]);
  });

  it('debits Client Receivable for a shortfall when charges exceed the reserve', async () => {
    const inv = await create();
    const s = await api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-06-06' }); // 96 days late
    expect(lines(s.body.settlementEntry)).toEqual([
      ['CASH', FACE, 0],
      ['INVOICE_RECEIVABLES', 0, 800_000_000],
      ['FEE_INCOME', 0, 47_342_466],
      ['PENALTY_INCOME', 0, 153_600_000],
      ['CLIENT_RECEIVABLE', 942_466, 0],
    ]);
    expect((await trialBalance(env.app)).balanced).toBe(true);
    const tb = await trialBalance(env.app);
    expect(tb.by.INVOICE_RECEIVABLES.balance).toBe(0);
  });

  it('concurrent settlements of the same invoice: exactly one succeeds', async () => {
    const inv = await create();
    const rs = await Promise.all(Array.from({ length: 8 }, () => api(env.app, 'POST', `/invoices/${inv.body.id}/settle`, { date: '2025-03-02' })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
  });
});
