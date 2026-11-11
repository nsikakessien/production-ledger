/** Calendar dates (no time zone) as 'YYYY-MM-DD' strings. */
import { badRequest } from './errors';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseDate(s: unknown, field: string): string {
  if (!isValidDate(s)) throw badRequest('INVALID_DATE', `${field} must be a calendar date YYYY-MM-DD`);
  return s;
}

export function toEpochDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

export function fromEpochDay(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** later - earlier, in days. */
export const daysBetween = (earlier: string, later: string) => toEpochDay(later) - toEpochDay(earlier);

export const addDays = (s: string, days: number) => fromEpochDay(toEpochDay(s) + days);

/** Add calendar months, clamping to month end (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: string, months: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export const maxDate = (a: string, b: string) => (a > b ? a : b);

export const todayUtc = () => new Date().toISOString().slice(0, 10);
