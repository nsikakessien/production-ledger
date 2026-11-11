/** Product A: invoice financing (quote, advance, settlement). */
import { Db, withTx } from './db';
import { badRequest, conflict, notFound, unprocessable } from './errors';
import { daysBetween, addDays, parseDate } from './dates';
import { InvoiceTerms, quoteInvoice } from './invoice-math';
import { LineSpec, postEntry, presentEntry } from './ledger';
import { Rational, parseDecimal, parseKobo, parseRate, rationalToDecimal } from './money';

function optionalRate(v: unknown, field: string): Rational | undefined {
  return v === undefined || v === null ? undefined : parseRate(v, field);
}

/** Tenor from tenorDays, or from advanceDate + dueDate. */
function parseTerms(body: any): InvoiceTerms & { advanceDate?: string; dueDate?: string } {
  const faceValue = parseKobo(body?.faceValue ?? body?.face_value, 'faceValue');
  let tenorDays: number;
  let advanceDate: string | undefined;
  let dueDate: string | undefined;
  if (body?.advanceDate !== undefined && body?.dueDate !== undefined) {
    advanceDate = parseDate(body.advanceDate, 'advanceDate');
    dueDate = parseDate(body.dueDate, 'dueDate');
    tenorDays = daysBetween(advanceDate, dueDate);
    if (body.tenorDays !== undefined && body.tenorDays !== tenorDays) {
      throw badRequest('INVALID_TENOR', `tenorDays ${body.tenorDays} does not match dates (${tenorDays})`);
    }
  } else {
    tenorDays = body?.tenorDays;
    if (body?.advanceDate !== undefined) {
      advanceDate = parseDate(body.advanceDate, 'advanceDate');
      if (Number.isSafeInteger(tenorDays)) dueDate = addDays(advanceDate, tenorDays);
    }
  }
  if (!Number.isSafeInteger(tenorDays) || tenorDays <= 0) {
    throw badRequest('INVALID_TENOR', 'tenorDays (or advanceDate + dueDate) must give a positive whole number of days');
  }
  const advanceRate = optionalRate(body?.advanceRate, 'advanceRate');
  if (advanceRate && (advanceRate.n === 0n || advanceRate.n > advanceRate.d)) {
    throw badRequest('INVALID_RATE', 'advanceRate must be in (0, 1]');
  }
  return {
    faceValue,
    tenorDays,
    advanceRate,
    annualRate: optionalRate(body?.annualRate, 'annualRate'),
    penaltyRatePerDay: optionalRate(body?.penaltyRatePerDay, 'penaltyRatePerDay'),
    advanceDate,
    dueDate,
  };
}

/** Days overdue: settlement date − due date (overdue days start the day after the due date). */
function overdueDays(body: any, dueDate?: string): number {
  if (body?.daysOverdue !== undefined) {
    if (!Number.isSafeInteger(body.daysOverdue) || body.daysOverdue < 0) {
      throw badRequest('INVALID_DAYS', 'daysOverdue must be a non-negative integer');
    }
    return body.daysOverdue;
  }
  const settlement = body?.settlementDate ?? body?.paidDate ?? body?.paymentDate;
  if (settlement === undefined) return 0;
  const s = parseDate(settlement, 'settlementDate');
  if (!dueDate) throw badRequest('INVALID_DATES', 'settlementDate requires advanceDate + dueDate (or advanceDate + tenorDays)');
  return Math.max(0, daysBetween(dueDate, s));
}

export function quote(body: any) {
  const terms = parseTerms(body);
  const q = quoteInvoice(terms, overdueDays(body, terms.dueDate));
  return {
    ...q,
    dueDate: terms.dueDate ?? null,
    payableToClient: q.clientPayable,
    shortfallOwedByClient: q.clientShortfall,
  };
}

export async function createInvoice(pool: Db, body: any) {
  const terms = parseTerms(body);
  if (!terms.advanceDate || !terms.dueDate) throw badRequest('INVALID_DATES', 'advanceDate and dueDate (or tenorDays) are required');
  const q = quoteInvoice(terms, 0);
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO invoices (face_value, advance_rate, annual_rate, penalty_rate_per_day, advance, reserve, discount_fee,
                             advance_date, due_date, tenor_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        terms.faceValue.toString(),
        rationalToDecimal(terms.advanceRate ?? { n: 8n, d: 10n }),
        rationalToDecimal(terms.annualRate ?? { n: 36n, d: 100n }),
        rationalToDecimal(terms.penaltyRatePerDay ?? { n: 2n, d: 1000n }),
        q.advance.toString(),
        q.reserve.toString(),
        q.discountFee.toString(),
        terms.advanceDate,
        terms.dueDate,
        terms.tenorDays,
      ],
    );
    const invoiceId = String(rows[0].id);
    const entry = await postEntry(tx, {
      effectiveDate: terms.advanceDate!,
      kind: 'INVOICE_ADVANCE',
      description: `Advance on invoice ${invoiceId}`,
      invoiceId,
      lines: [
        { account: 'INVOICE_RECEIVABLES', side: 'D', amount: q.advance },
        { account: 'CASH', side: 'C', amount: q.advance },
      ],
    });
    await tx.query('INSERT INTO invoice_advances (invoice_id, entry_id) VALUES ($1, $2)', [invoiceId, entry.id]);
    return { id: invoiceId, advanceDate: terms.advanceDate, dueDate: terms.dueDate, ...q, advanceEntry: presentEntry(entry) };
  });
}

export async function settleInvoice(pool: Db, invoiceId: string, body: any) {
  if (!/^\d+$/.test(invoiceId)) throw notFound(`invoice ${invoiceId}`);
  const settledOn = parseDate(body?.date ?? body?.settlementDate, 'date');
  return withTx(pool, async (tx) => {
    // Row lock on the invoice is not available to the app role (no UPDATE grant);
    // the invoice_settlements PK makes a concurrent double settlement fail instead.
    const { rows } = await tx.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    const inv = rows[0];
    if (!inv) throw notFound(`invoice ${invoiceId}`);
    const done = await tx.query('SELECT 1 FROM invoice_settlements WHERE invoice_id = $1', [invoiceId]);
    if (done.rows[0]) throw conflict('ALREADY_SETTLED', `invoice ${invoiceId} is already settled`);
    const amount = body?.amount === undefined ? inv.face_value : parseKobo(body.amount, 'amount');
    if (amount !== inv.face_value) {
      throw unprocessable('PARTIAL_SETTLEMENT_UNSUPPORTED', `settlement must equal the face value ${inv.face_value}`);
    }
    if (settledOn < inv.advance_date) throw unprocessable('INVALID_DATE', 'settlement before advance date');
    const days = Math.max(0, daysBetween(inv.due_date, settledOn));
    const q = quoteInvoice(
      {
        faceValue: inv.face_value,
        tenorDays: inv.tenor_days,
        // Stored rates are exact fractions: parse them literally, never through
        // the API's percent heuristic (a stored 1.0 means 100%, not 1%).
        advanceRate: parseDecimal(inv.advance_rate),
        annualRate: parseDecimal(inv.annual_rate),
        penaltyRatePerDay: parseDecimal(inv.penalty_rate_per_day),
      },
      days,
    );
    const lines: LineSpec[] = [
      { account: 'CASH', side: 'D', amount: inv.face_value },
      { account: 'INVOICE_RECEIVABLES', side: 'C', amount: q.advance },
      { account: 'FEE_INCOME', side: 'C', amount: q.discountFee },
      { account: 'PENALTY_INCOME', side: 'C', amount: q.latePenalty },
      { account: 'CLIENT_PAYABLE', side: 'C', amount: q.clientPayable },
      { account: 'CLIENT_RECEIVABLE', side: 'D', amount: q.clientShortfall },
    ];
    const entry = await postEntry(tx, {
      effectiveDate: settledOn,
      kind: 'INVOICE_SETTLEMENT',
      description: `Settlement of invoice ${invoiceId} (${days} day(s) overdue)`,
      invoiceId,
      lines,
    });
    await tx.query(
      `INSERT INTO invoice_settlements (invoice_id, settled_on, amount_received, days_overdue, discount_fee, late_penalty,
                                        client_payable, client_shortfall, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [invoiceId, settledOn, amount.toString(), days, q.discountFee.toString(), q.latePenalty.toString(), q.clientPayable.toString(), q.clientShortfall.toString(), entry.id],
    );
    return { invoiceId, settledOn, ...q, settlementEntry: presentEntry(entry) };
  });
}

export async function getInvoice(db: Db, invoiceId: string) {
  if (!/^\d+$/.test(invoiceId)) throw notFound(`invoice ${invoiceId}`);
  const { rows } = await db.query(
    `SELECT i.*, s.settled_on, s.days_overdue, s.late_penalty, s.client_payable, s.client_shortfall
       FROM invoices i LEFT JOIN invoice_settlements s ON s.invoice_id = i.id WHERE i.id = $1`,
    [invoiceId],
  );
  if (!rows[0]) throw notFound(`invoice ${invoiceId}`);
  const r = rows[0];
  return {
    id: String(r.id),
    faceValue: r.face_value,
    advance: r.advance,
    reserve: r.reserve,
    discountFee: r.discount_fee,
    advanceDate: r.advance_date,
    dueDate: r.due_date,
    tenorDays: r.tenor_days,
    status: r.settled_on ? 'SETTLED' : 'OUTSTANDING',
    settlement: r.settled_on
      ? { settledOn: r.settled_on, daysOverdue: r.days_overdue, latePenalty: r.late_penalty, clientPayable: r.client_payable, clientShortfall: r.client_shortfall }
      : null,
  };
}
