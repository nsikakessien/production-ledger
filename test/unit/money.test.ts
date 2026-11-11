import { describe, expect, it } from 'vitest';
import { parseKobo, parseRate, roundHalfUp } from '../../src/money';
import { buildSchedule } from '../../src/schedule';
import { quoteInvoice } from '../../src/invoice-math';
import { addMonths, daysBetween } from '../../src/dates';

describe('roundHalfUp', () => {
  it('rounds exact halves up and everything else to nearest', () => {
    expect(roundHalfUp(5n, 2n)).toBe(3n); // 2.5
    expect(roundHalfUp(7n, 2n)).toBe(4n); // 3.5
    expect(roundHalfUp(249n, 100n)).toBe(2n); // 2.49
    expect(roundHalfUp(250n, 100n)).toBe(3n); // 2.50
    expect(roundHalfUp(2499999n, 1000000n)).toBe(2n);
    expect(roundHalfUp(0n, 7n)).toBe(0n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n); // ties away from zero
  });
});

describe('parsing', () => {
  it('reads rates exactly, without float error', () => {
    expect(parseRate('0.18', 'r')).toEqual({ n: 18n, d: 100n });
    expect(parseRate(0.18, 'r')).toEqual({ n: 18n, d: 100n });
    expect(parseRate(18, 'r')).toEqual({ n: 18n, d: 100n }); // >= 1 => percent
    expect(parseRate('36%', 'r')).toEqual({ n: 36n, d: 100n });
  });

  it('applies one percent rule: below 1 is a fraction, 1 or more is a percentage', () => {
    expect(parseRate(0.99, 'r')).toEqual({ n: 99n, d: 100n });
    expect(parseRate(1, 'r')).toEqual({ n: 1n, d: 100n }); // 1%, not 100%
    expect(parseRate('1', 'r')).toEqual({ n: 1n, d: 100n });
    expect(parseRate(1.5, 'r')).toEqual({ n: 15n, d: 1000n }); // 1.5%, consistent with 1 => 1%
    expect(parseRate('150%', 'r')).toEqual({ n: 150n, d: 100n }); // >= 100% needs an explicit "%"
  });

  it('rejects non-rates', () => {
    expect(() => parseRate('abc', 'r')).toThrow();
    expect(() => parseRate(-0.1, 'r')).toThrow();
  });

  it('accepts only positive integer kobo', () => {
    expect(parseKobo(100, 'a')).toBe(100n);
    expect(parseKobo('120000000', 'a')).toBe(120000000n);
    expect(() => parseKobo(100.5, 'a')).toThrow(/integer/);
    expect(() => parseKobo('100.5', 'a')).toThrow(/integer/);
    expect(() => parseKobo(0, 'a')).toThrow(/positive/);
    expect(() => parseKobo(-1, 'a')).toThrow(/positive/);
    expect(() => parseKobo(2 ** 60, 'a')).toThrow(/integer/);
    expect(() => parseKobo(null, 'a')).toThrow();
  });
});

describe('term loan schedule (Worked Example 1)', () => {
  const s = buildSchedule(120_000_000n, { n: 18n, d: 100n }, 6, '2025-01-15');

  it('matches the instalment and every row to the kobo', () => {
    expect(s.instalment).toBe(21_063_026n);
    const rows = s.rows.map((r) => [r.payment, r.interest, r.principal, r.closingBalance]);
    expect(rows).toEqual([
      [21_063_026n, 1_800_000n, 19_263_026n, 100_736_974n],
      [21_063_026n, 1_511_055n, 19_551_971n, 81_185_003n],
      [21_063_026n, 1_217_775n, 19_845_251n, 61_339_752n],
      [21_063_026n, 920_096n, 20_142_930n, 41_196_822n],
      [21_063_026n, 617_952n, 20_445_074n, 20_751_748n],
      [21_063_024n, 311_276n, 20_751_748n, 0n],
    ]);
    expect(s.totalInterest).toBe(6_378_154n);
  });

  it('principal sums to the loan and every row is internally consistent', () => {
    for (const [P, rate, n] of [
      [120_000_000n, 18n, 6],
      [1n, 18n, 1],
      [99_999_999n, 7n, 36],
      [5_000_000_00n, 35n, 24],
      [1_000_000n, 0n, 12],
      [333_333_333n, 1n, 120],
    ] as const) {
      const sch = buildSchedule(P, { n: rate, d: 100n }, n, '2024-01-31');
      expect(sch.rows.reduce((t, r) => t + r.principal, 0n)).toBe(P);
      for (const r of sch.rows) {
        expect(r.payment).toBe(r.interest + r.principal);
        expect(r.closingBalance).toBe(r.openingBalance - r.principal);
      }
      expect(sch.rows.at(-1)!.closingBalance).toBe(0n);
    }
  });

  it('due dates clamp to month end', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2025-12-15', 1)).toBe('2026-01-15');
    expect(buildSchedule(1000n, { n: 1n, d: 10n }, 3, '2025-01-31').rows.map((r) => r.dueDate)).toEqual([
      '2025-02-28',
      '2025-03-31',
      '2025-04-30',
    ]);
  });

  it('rounds the instalment half-up exactly once (no float drift at a .5 boundary)', () => {
    // 0% over 2 months: 101 / 2 = 50.5 -> 51; final instalment takes the remaining 50.
    const sch = buildSchedule(101n, { n: 0n, d: 1n }, 2, '2025-01-01');
    expect(sch.instalment).toBe(51n);
    expect(sch.rows.map((r) => r.payment)).toEqual([51n, 50n]);
  });
});

describe('invoice financing (Worked Example 2)', () => {
  const base = { faceValue: 1_000_000_000n, tenorDays: 60 };

  it('quotes advance, reserve and discount fee', () => {
    const q = quoteInvoice(base, 0);
    expect(q.advance).toBe(800_000_000n);
    expect(q.reserve).toBe(200_000_000n);
    expect(q.discountFee).toBe(47_342_466n); // 47,342,465.75 rounded half-up
    expect(q.clientPayable).toBe(152_657_534n);
    expect(q.clientShortfall).toBe(0n);
  });

  it('adds the late penalty when paid 10 days late', () => {
    const q = quoteInvoice(base, 10);
    expect(q.latePenalty).toBe(16_000_000n);
    expect(q.clientPayable).toBe(136_657_534n);
    expect(q.discountFee + q.latePenalty + q.clientPayable + q.advance).toBe(1_000_000_000n);
  });

  it('reports a shortfall when charges exceed the reserve', () => {
    // 60-day fee 47,342,466 + penalty 1.6m/day; reserve 200m is exhausted after 95.41 days.
    const q = quoteInvoice(base, 96);
    expect(q.latePenalty).toBe(153_600_000n);
    expect(q.clientPayable).toBe(0n);
    expect(q.clientShortfall).toBe(47_342_466n + 153_600_000n - 200_000_000n);
    const exact = quoteInvoice(base, 95);
    expect(exact.clientShortfall).toBe(0n);
    expect(exact.clientPayable).toBe(200_000_000n - 47_342_466n - 152_000_000n);
  });

  it('rounds the fee and advance half-up at the kobo boundary', () => {
    // advance: 3 x 0.8 = 2.4 -> 2 ; 7 x 0.8 = 5.6 -> 6
    expect(quoteInvoice({ faceValue: 3n, tenorDays: 1 }, 0).advance).toBe(2n);
    expect(quoteInvoice({ faceValue: 7n, tenorDays: 1 }, 0).advance).toBe(6n);
    // fee: advance 1,000,000 x 0.36 x 1/365 = 986.30 -> 986
    expect(quoteInvoice({ faceValue: 1_250_000n, tenorDays: 1 }, 0).discountFee).toBe(986n);
    // fee: advance 7,300 x 0.36 x 1/365 = 7.2 -> 7
    expect(quoteInvoice({ faceValue: 9125n, tenorDays: 1 }, 0).discountFee).toBe(7n);
    // penalty exactly on .5: advance 125 x 0.002 x 2 days = 0.5 -> 1 (half-up)
    expect(quoteInvoice({ faceValue: 15625n, tenorDays: 1, advanceRate: { n: 1n, d: 125n } }, 2).latePenalty).toBe(1n);
  });

  it('counts days as later date minus earlier date', () => {
    expect(daysBetween('2025-01-01', '2025-03-02')).toBe(60);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // leap year
  });
});
