/** Product A: invoice financing calculations. */
import { Rational, maxBig, rat, roundHalfUp } from './money';

export const DEFAULT_ADVANCE_RATE = rat(80n, 100n); // 80%
export const DEFAULT_DISCOUNT_RATE = rat(36n, 100n); // 36% p.a., actual/365
export const DEFAULT_PENALTY_RATE_PER_DAY = rat(2n, 1000n); // 0.2% of advance per day overdue

export interface InvoiceTerms {
  faceValue: bigint;
  tenorDays: number;
  advanceRate?: Rational;
  annualRate?: Rational;
  penaltyRatePerDay?: Rational;
}

export interface InvoiceQuote {
  faceValue: bigint;
  advance: bigint;
  reserve: bigint;
  tenorDays: number;
  discountFee: bigint;
  daysOverdue: number;
  latePenalty: bigint;
  totalCharges: bigint;
  clientPayable: bigint;
  clientShortfall: bigint;
}

/**
 * Each posted amount is rounded half-up exactly once from exact inputs:
 *   advance  = face × advanceRate
 *   fee      = advance × annualRate × tenorDays / 365
 *   penalty  = advance × penaltyRate × daysOverdue
 * (advance is itself a posted amount, so fee and penalty are computed from it.)
 */
export function quoteInvoice(t: InvoiceTerms, daysOverdue: number): InvoiceQuote {
  const ar = t.advanceRate ?? DEFAULT_ADVANCE_RATE;
  const r = t.annualRate ?? DEFAULT_DISCOUNT_RATE;
  const pr = t.penaltyRatePerDay ?? DEFAULT_PENALTY_RATE_PER_DAY;
  const advance = roundHalfUp(t.faceValue * ar.n, ar.d);
  const reserve = t.faceValue - advance;
  const discountFee = roundHalfUp(advance * r.n * BigInt(t.tenorDays), r.d * 365n);
  const od = Math.max(0, daysOverdue);
  const latePenalty = roundHalfUp(advance * pr.n * BigInt(od), pr.d);
  const totalCharges = discountFee + latePenalty;
  return {
    faceValue: t.faceValue,
    advance,
    reserve,
    tenorDays: t.tenorDays,
    discountFee,
    daysOverdue: od,
    latePenalty,
    totalCharges,
    clientPayable: maxBig(0n, reserve - totalCharges),
    clientShortfall: maxBig(0n, totalCharges - reserve),
  };
}
