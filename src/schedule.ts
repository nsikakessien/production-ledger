/** Annuity (equal instalment, reducing balance) schedule for Product B. */
import { addMonths } from './dates';
import { Rational, roundHalfUp } from './money';

export interface ScheduleRow {
  number: number;
  dueDate: string;
  openingBalance: bigint;
  payment: bigint;
  interest: bigint;
  principal: bigint;
  closingBalance: bigint;
}

export interface Schedule {
  instalment: bigint;
  totalInterest: bigint;
  rows: ScheduleRow[];
}

/**
 * Instalment = P·i / (1 − (1+i)^−n), rounded half-up once, computed exactly.
 * With i = a/b (a = annual-rate numerator, b = 12 × annual-rate denominator):
 *   (1+i)^n = (b+a)^n / b^n  =>  instalment = P·a·(b+a)^n / (b·((b+a)^n − b^n)).
 * Interest each period = opening × i, rounded half-up. The final instalment's
 * principal is the remaining balance, so it may differ by a few kobo.
 */
export function buildSchedule(principal: bigint, annualRate: Rational, termMonths: number, disbursementDate: string): Schedule {
  if (principal <= 0n) throw new Error('principal must be positive');
  if (!Number.isInteger(termMonths) || termMonths < 1) throw new Error('term must be a positive integer');
  const a = annualRate.n;
  const b = annualRate.d * 12n;
  const n = BigInt(termMonths);

  let instalment: bigint;
  if (a === 0n) {
    instalment = roundHalfUp(principal, n);
  } else {
    const x = (b + a) ** n;
    const y = b ** n;
    instalment = roundHalfUp(principal * a * x, b * (x - y));
  }

  const rows: ScheduleRow[] = [];
  let balance = principal;
  let totalInterest = 0n;
  for (let k = 1; k <= termMonths; k++) {
    const interest = roundHalfUp(balance * a, b);
    let p = k === termMonths ? balance : instalment - interest;
    if (p > balance) p = balance; // defensive: never amortise past zero
    if (p <= 0n) throw new Error(`instalment ${k} does not amortise any principal`);
    rows.push({
      number: k,
      dueDate: addMonths(disbursementDate, k),
      openingBalance: balance,
      payment: p + interest,
      interest,
      principal: p,
      closingBalance: balance - p,
    });
    totalInterest += interest;
    balance -= p;
    if (balance === 0n && k < termMonths) throw new Error('schedule amortised early');
  }
  return { instalment, totalInterest, rows };
}
