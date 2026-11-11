/** General ledger: posting, reading, reversing and the trial balance. */
import { Db, Tx } from './db';
import { badRequest, conflict, notFound, unprocessable } from './errors';
import { maxDate, parseDate, todayUtc } from './dates';
import { parseKobo } from './money';

export type Side = 'D' | 'C';

export interface LineSpec {
  account: string; // account code
  side: Side;
  amount: bigint; // may be <= 0 internally: zero lines are dropped, negatives flip side
  loanId?: string | null;
  invoiceId?: string | null;
}

export interface EntrySpec {
  effectiveDate: string;
  kind: string;
  description: string;
  loanId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  reversesEntryId?: string | null;
  correctsEntryId?: string | null;
  /**
   * true (default, system events and corrections): if the effective date's period
   * is closed, post on the first day of the next open period.
   * false (manual entries): post on the effective date; a closed period rejects it.
   */
  rollForward?: boolean;
  lines: LineSpec[];
}

export interface PostedLine {
  lineNo: number;
  account: string;
  side: Side;
  amount: bigint;
  loanId: string | null;
}

export interface PostedEntry {
  id: string;
  entryDate: string;
  effectiveDate: string;
  kind: string;
  description: string;
  loanId: string | null;
  invoiceId: string | null;
  paymentId: string | null;
  reversesEntryId: string | null;
  correctsEntryId: string | null;
  lines: PostedLine[];
}

let accountCache: Map<string, { id: number; code: string; name: string; type: string }> | undefined;

export async function accounts(db: Db | Tx) {
  if (!accountCache) {
    const { rows } = await db.query('SELECT id, code, name, type FROM accounts ORDER BY id');
    accountCache = new Map(rows.map((r) => [r.code, r]));
  }
  return accountCache;
}

/** Resolve an account by code ("LOANS_RECEIVABLE") or name ("Loans Receivable"). */
export async function resolveAccount(db: Db | Tx, ref: unknown): Promise<string> {
  if (typeof ref !== 'string') throw badRequest('INVALID_ACCOUNT', 'account must be a string');
  const norm = ref.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const accts = await accounts(db);
  if (accts.has(norm)) return norm;
  throw badRequest('INVALID_ACCOUNT', `unknown account ${ref}`);
}

/**
 * Normalise lines: drop zero amounts, flip negative amounts to the other side,
 * then require >= 2 lines and debits = credits. The database re-checks all of
 * this at COMMIT; checking here gives a clean 422 instead of a failed commit.
 */
function normaliseLines(lines: LineSpec[]): LineSpec[] {
  const out: LineSpec[] = [];
  for (const l of lines) {
    if (l.amount === 0n) continue;
    if (l.amount < 0n) out.push({ ...l, side: l.side === 'D' ? 'C' : 'D', amount: -l.amount });
    else out.push(l);
  }
  const dr = out.filter((l) => l.side === 'D').reduce((s, l) => s + l.amount, 0n);
  const cr = out.filter((l) => l.side === 'C').reduce((s, l) => s + l.amount, 0n);
  if (out.length < 2) throw unprocessable('UNBALANCED_ENTRY', 'a journal entry needs at least two non-zero lines');
  if (dr !== cr) throw unprocessable('UNBALANCED_ENTRY', `debits ${dr} != credits ${cr}`);
  return out;
}

export async function postEntry(tx: Tx, spec: EntrySpec): Promise<PostedEntry> {
  const lines = normaliseLines(spec.lines);
  const accts = await accounts(tx);
  const { rows } = await tx.query(
    `INSERT INTO journal_entries
       (entry_date, effective_date, kind, description, loan_id, invoice_id, payment_id, reverses_entry_id, corrects_entry_id)
     VALUES (CASE WHEN $9::boolean THEN ledger_posting_date($1::date) ELSE $1::date END, $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, entry_date, effective_date`,
    [
      spec.effectiveDate,
      spec.kind,
      spec.description,
      spec.loanId ?? null,
      spec.invoiceId ?? null,
      spec.paymentId ?? null,
      spec.reversesEntryId ?? null,
      spec.correctsEntryId ?? null,
      spec.rollForward ?? true,
    ],
  );
  const entryId = String(rows[0].id);
  const values: unknown[] = [];
  const tuples = lines.map((l, i) => {
    const acct = accts.get(l.account);
    if (!acct) throw new Error(`unknown account ${l.account}`);
    values.push(entryId, i + 1, acct.id, l.side, l.amount.toString(), l.loanId ?? spec.loanId ?? null, l.invoiceId ?? spec.invoiceId ?? null);
    const b = i * 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
  });
  await tx.query(
    `INSERT INTO journal_lines (entry_id, line_no, account_id, side, amount, loan_id, invoice_id) VALUES ${tuples.join(', ')}`,
    values,
  );
  return {
    id: entryId,
    entryDate: rows[0].entry_date,
    effectiveDate: rows[0].effective_date,
    kind: spec.kind,
    description: spec.description,
    loanId: spec.loanId ?? null,
    invoiceId: spec.invoiceId ?? null,
    paymentId: spec.paymentId ?? null,
    reversesEntryId: spec.reversesEntryId ?? null,
    correctsEntryId: spec.correctsEntryId ?? null,
    lines: lines.map((l, i) => ({ lineNo: i + 1, account: l.account, side: l.side, amount: l.amount, loanId: l.loanId ?? spec.loanId ?? null })),
  };
}

export async function getEntry(db: Db | Tx, id: string): Promise<PostedEntry | undefined> {
  if (!/^\d+$/.test(id)) return undefined;
  const { rows } = await db.query(
    `SELECT e.*, (SELECT id FROM journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by_entry_id
       FROM journal_entries e WHERE e.id = $1`,
    [id],
  );
  if (!rows[0]) return undefined;
  const e = rows[0];
  const lines = await db.query(
    `SELECT l.line_no, a.code, l.side, l.amount, l.loan_id
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [id],
  );
  return {
    id: String(e.id),
    entryDate: e.entry_date,
    effectiveDate: e.effective_date,
    kind: e.kind,
    description: e.description,
    loanId: e.loan_id?.toString() ?? null,
    invoiceId: e.invoice_id?.toString() ?? null,
    paymentId: e.payment_id?.toString() ?? null,
    reversesEntryId: e.reverses_entry_id?.toString() ?? null,
    correctsEntryId: e.corrects_entry_id?.toString() ?? null,
    reversedByEntryId: e.reversed_by_entry_id?.toString() ?? null,
    lines: lines.rows.map((l) => ({
      lineNo: l.line_no,
      account: l.code,
      side: l.side,
      amount: l.amount,
      loanId: l.loan_id?.toString() ?? null,
    })),
  } as PostedEntry;
}

/** Present an entry for the API with explicit debit/credit columns. */
export function presentEntry(e: PostedEntry) {
  return {
    ...e,
    lines: e.lines.map((l) => ({
      lineNo: l.lineNo,
      account: l.account,
      debit: l.side === 'D' ? l.amount : 0n,
      credit: l.side === 'C' ? l.amount : 0n,
      loanId: l.loanId,
    })),
  };
}

/**
 * Effective date of a correction: the requested date, or by default the later of
 * the original entry's date and today. A correction is never dated before what it
 * corrects; if its period is closed it rolls into the next open period.
 */
export function correctionDate(originalDate: string, requested: unknown): string {
  if (requested === undefined || requested === null) return maxDate(originalDate, todayUtc());
  const d = parseDate(requested, 'date');
  if (d < originalDate) throw unprocessable('INVALID_DATE', `a correction cannot be dated before the original (${originalDate})`);
  return d;
}

/** Mirror-image reversal of a stand-alone entry (MANUAL or REVERSAL kinds). */
export async function reverseEntry(tx: Tx, original: PostedEntry, opts: { date?: unknown; reason?: string }) {
  const effectiveDate = correctionDate(original.entryDate, opts.date);
  return postEntry(tx, {
    effectiveDate,
    kind: 'REVERSAL',
    description: opts.reason ? `Reversal of entry ${original.id}: ${opts.reason}` : `Reversal of entry ${original.id}`,
    loanId: original.loanId,
    invoiceId: original.invoiceId,
    reversesEntryId: original.id,
    correctsEntryId: original.id,
    lines: original.lines.map((l) => ({
      account: l.account,
      side: l.side === 'D' ? 'C' : 'D',
      amount: l.amount,
      loanId: l.loanId,
    })),
  });
}

/** POST /ledger/entries: a manually keyed, balanced entry. */
export async function createManualEntry(tx: Tx, body: any) {
  if (!body || typeof body !== 'object') throw badRequest('INVALID_BODY', 'body must be an object');
  const date = parseDate(body.date ?? body.entryDate, 'date');
  if (!Array.isArray(body.lines)) throw badRequest('INVALID_LINES', 'lines must be an array');
  const lines: LineSpec[] = [];
  for (const [i, l] of body.lines.entries()) {
    const account = await resolveAccount(tx, l?.account);
    let side: Side;
    let amount: bigint;
    if (l?.side !== undefined) {
      if (l.side !== 'D' && l.side !== 'C' && l.side !== 'DEBIT' && l.side !== 'CREDIT') {
        throw badRequest('INVALID_LINES', `line ${i + 1}: side must be D or C`);
      }
      side = l.side[0] as Side;
      amount = parseKobo(l.amount, `lines[${i}].amount`);
    } else if ((l?.debit !== undefined) !== (l?.credit !== undefined)) {
      side = l.debit !== undefined ? 'D' : 'C';
      amount = parseKobo(l.debit ?? l.credit, `lines[${i}].${side === 'D' ? 'debit' : 'credit'}`);
    } else {
      throw badRequest('INVALID_LINES', `line ${i + 1}: give exactly one of debit/credit, or side + amount`);
    }
    const loanId = l.loanId === undefined || l.loanId === null ? null : String(l.loanId);
    lines.push({ account, side, amount, loanId });
  }
  return postEntry(tx, {
    effectiveDate: date,
    kind: 'MANUAL',
    rollForward: false,
    description: typeof body.description === 'string' && body.description ? body.description : 'Manual journal entry',
    lines,
  });
}

export async function trialBalance(db: Db, opts: { asOf?: string } = {}) {
  const { rows } = await db.query(
    `SELECT a.code, a.name, a.type,
            coalesce(sum(l.amount) FILTER (WHERE l.side = 'D'), 0)::bigint AS debits,
            coalesce(sum(l.amount) FILTER (WHERE l.side = 'C'), 0)::bigint AS credits
       FROM accounts a
       LEFT JOIN (journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                  AND ($1::date IS NULL OR e.entry_date <= $1::date))
         ON l.account_id = a.id
      GROUP BY a.id ORDER BY a.id`,
    [opts.asOf ?? null],
  );
  let totalDebits = 0n;
  let totalCredits = 0n;
  const accts = rows.map((r) => {
    totalDebits += r.debits;
    totalCredits += r.credits;
    const net = r.debits - r.credits; // debit-positive
    const debitNormal = r.type === 'ASSET' || r.type === 'EXPENSE';
    return {
      account: r.code,
      name: r.name,
      type: r.type,
      debits: r.debits,
      credits: r.credits,
      net,
      balance: debitNormal ? net : -net, // in the account's normal direction
    };
  });
  return { asOf: opts.asOf ?? null, accounts: accts, totalDebits, totalCredits, balanced: totalDebits === totalCredits };
}

export async function requireEntry(db: Db | Tx, id: string) {
  const e = await getEntry(db, id);
  if (!e) throw notFound(`journal entry ${id}`);
  return e;
}

export function assertReversible(e: PostedEntry & { reversedByEntryId?: string | null }) {
  if (e.reversedByEntryId) throw conflict('ALREADY_REVERSED', `entry ${e.id} was already reversed by entry ${e.reversedByEntryId}`);
}
