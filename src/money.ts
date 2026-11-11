/**
 * Exact money arithmetic. All money is BigInt kobo; rates are exact rationals.
 * No floating point is ever used for money or rates.
 */
import { badRequest } from './errors';

export interface Rational {
  n: bigint; // numerator (>= 0)
  d: bigint; // denominator (> 0)
}

export const rat = (n: bigint, d: bigint = 1n): Rational => ({ n, d });

/** Half-up rounding of n/d to an integer (ties away from zero; money values here are >= 0). */
export function roundHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n < 0n) return -roundHalfUp(-n, d);
  return (2n * n + d) / (2n * d);
}

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Parse a non-negative decimal string ("0.18", "18", "36.5") into an exact rational. */
export function parseDecimal(s: string): Rational {
  const m = DECIMAL_RE.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = m[2] ?? '';
  return { n: BigInt(m[1] + frac), d: 10n ** BigInt(frac.length) };
}

/** Render a rational as a decimal string with up to `scale` places. */
export function rationalToDecimal(r: Rational, scale = 12): string {
  const q = roundHalfUp(r.n * 10n ** BigInt(scale), r.d);
  const s = q.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/**
 * Parse a rate from an API payload. Accepts a decimal string or a JS number,
 * using the number's shortest decimal representation (0.18 -> "0.18") so no
 * binary-float error leaks in.
 *
 * One rule, no ambiguous middle ground:
 *   - a trailing "%" is always a percentage ("18%" -> 0.18, "150%" -> 1.5);
 *   - otherwise a value below 1 is a fraction (0.18 -> 18%),
 *     and a value of 1 or more is a percentage (18 -> 18%, 1 -> 1%, 1.5 -> 1.5%).
 * Rates of 100% or more must therefore be written with "%".
 *
 * Only for API input. Rates read back from the database are exact fractions;
 * parse those with parseDecimal.
 */
export function parseRate(value: unknown, field: string): Rational {
  let s: string;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) s = String(value);
  else if (typeof value === 'string') s = value.trim().replace(/%$/, '');
  else throw badRequest('INVALID_RATE', `${field} must be a non-negative decimal`);
  if (!DECIMAL_RE.test(s)) throw badRequest('INVALID_RATE', `${field} must be a plain decimal like "0.18"`);
  let r = parseDecimal(s);
  const isPercent = (typeof value === 'string' && value.trim().endsWith('%')) || r.n >= r.d;
  if (isPercent) r = { n: r.n, d: r.d * 100n };
  return r;
}

/**
 * Parse an integer kobo amount. Accepts JSON integers (safe range) or digit
 * strings. Rejects floats, negatives and zero (unless allowZero).
 */
export function parseKobo(value: unknown, field: string, opts: { allowZero?: boolean } = {}): bigint {
  let v: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw badRequest('INVALID_AMOUNT', `${field} must be an integer number of kobo`);
    v = BigInt(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    v = BigInt(value.trim());
  } else {
    throw badRequest('INVALID_AMOUNT', `${field} must be an integer number of kobo`);
  }
  if (v < 0n || (v === 0n && !opts.allowZero)) {
    throw badRequest('INVALID_AMOUNT', `${field} must be ${opts.allowZero ? 'non-negative' : 'positive'}`);
  }
  if (v > 9_000_000_000_000_000n) throw badRequest('INVALID_AMOUNT', `${field} is out of range`);
  return v;
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
