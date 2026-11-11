import Fastify, { FastifyInstance } from 'fastify';
import { Db, withTx } from './db';
import { AppError, badRequest, fromPgError, unprocessable } from './errors';
import { parseDate } from './dates';
import { stringify } from './json';
import { assertReversible, createManualEntry, presentEntry, requireEntry, reverseEntry, trialBalance } from './ledger';
import {
  addCharge,
  createLoan,
  getLoan,
  listPayments,
  loanAudit,
  receivePayment,
  reconciliation,
  reversePayment,
  reversePaymentTx,
  runAccrualJob,
} from './loans';
import { createInvoice, getInvoice, quote, settleInvoice } from './invoices';
import { closePeriod, listClosedPeriods } from './periods';

export function buildApp(pool: Db, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setReplySerializer((payload) => stringify(payload));

  // Many clients send `Content-Type: application/json` with no body on POSTs
  // like /periods/:p/close or /reverse. Fastify's default parser rejects that
  // with 400; treat an empty body as "no body" and keep the default parser
  // (with its prototype-poisoning protection) for everything else.
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8'); // parseAs 'string' always gives a string
    if (text.trim() === '') return done(null, undefined);
    return defaultJsonParser(req, text, done);
  });

  app.setErrorHandler((err: any, _req, reply) => {
    const e: AppError | undefined = err instanceof AppError ? err : fromPgError(err);
    if (e) {
      return reply.status(e.status).send({ error: { code: e.code, message: e.message, details: e.details } });
    }
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
  });

  app.get('/health', async () => ({ ok: true }));

  // ---- Term loans -----------------------------------------------------------
  app.post('/loans', async (req, reply) => reply.status(201).send(await createLoan(pool, req.body)));
  app.get<{ Params: { id: string } }>('/loans/:id', async (req) => getLoan(pool, req.params.id));
  app.get<{ Params: { id: string } }>('/loans/:id/payments', async (req) => {
    await getLoan(pool, req.params.id); // 404 if missing
    return listPayments(pool, req.params.id);
  });
  app.get<{ Params: { id: string } }>('/loans/:id/audit', async (req) => {
    await getLoan(pool, req.params.id);
    return loanAudit(pool, req.params.id);
  });

  app.post<{ Params: { id: string } }>('/loans/:id/payments', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    const result = await receivePayment(pool, req.params.id, req.body, Array.isArray(key) ? key[0] : key);
    if (result.replayed) reply.header('Idempotent-Replayed', 'true');
    return reply.status(result.status).send(result.body);
  });

  app.post<{ Params: { id: string; paymentId: string } }>('/loans/:id/payments/:paymentId/reverse', async (req) =>
    reversePayment(pool, req.params.id, req.params.paymentId, req.body),
  );

  app.post<{ Params: { id: string } }>('/loans/:id/charges', async (req, reply) =>
    reply.status(201).send(await addCharge(pool, req.params.id, req.body)),
  );

  // ---- Invoice financing ----------------------------------------------------
  app.post('/invoices/quote', async (req) => quote(req.body));
  app.post('/invoices', async (req, reply) => reply.status(201).send(await createInvoice(pool, req.body)));
  app.get<{ Params: { id: string } }>('/invoices/:id', async (req) => getInvoice(pool, req.params.id));
  app.post<{ Params: { id: string } }>('/invoices/:id/settle', async (req, reply) =>
    reply.status(201).send(await settleInvoice(pool, req.params.id, req.body)),
  );

  // ---- Ledger ---------------------------------------------------------------
  app.post('/ledger/entries', async (req, reply) => {
    const entry = await withTx(pool, (tx) => createManualEntry(tx, req.body));
    return reply.status(201).send(presentEntry(entry));
  });
  app.get<{ Params: { id: string } }>('/ledger/entries/:id', async (req) => presentEntry(await requireEntry(pool, req.params.id)));

  /**
   * Reverse an entry. Manual entries (and reversals of them) get a mirror-image
   * entry. A PAYMENT entry is routed to the payment reversal so the sub-ledger
   * and later allocations stay consistent. Other system entries are owned by
   * their domain process and are rejected here.
   */
  app.post<{ Params: { id: string } }>('/ledger/entries/:id/reverse', async (req, reply) => {
    const body: any = req.body ?? {};
    const result = await withTx(pool, async (tx) => {
      const entry = await requireEntry(tx, req.params.id);
      assertReversible(entry);
      if (entry.kind === 'PAYMENT') {
        return reversePaymentTx(tx, entry.loanId!, entry.paymentId!, { date: body.date, reason: body.reason });
      }
      if (entry.kind !== 'MANUAL' && entry.kind !== 'REVERSAL') {
        throw unprocessable(
          'ENTRY_NOT_REVERSIBLE',
          `${entry.kind} entries are managed by the loan/invoice sub-ledger and cannot be reversed directly` +
            (entry.kind === 'REALLOCATION' || entry.kind === 'PAYMENT_REVERSAL' ? '; reverse the payment instead' : ''),
        );
      }
      return presentEntry(await reverseEntry(tx, entry, { date: body.date, reason: body.reason }));
    });
    return reply.status(201).send(result);
  });

  app.get<{ Querystring: { asOf?: string } }>('/ledger/trial-balance', async (req) =>
    trialBalance(pool, { asOf: req.query.asOf === undefined ? undefined : parseDate(req.query.asOf, 'asOf') }),
  );

  // ---- Jobs, periods, reconciliation ----------------------------------------
  app.post<{ Querystring: { asOf?: string } }>('/jobs/accrue', async (req) => {
    if (req.query.asOf === undefined) throw badRequest('INVALID_DATE', 'asOf=YYYY-MM-DD is required');
    return runAccrualJob(pool, req.query.asOf);
  });

  app.post<{ Params: { period: string } }>('/periods/:period/close', async (req) => closePeriod(pool, req.params.period));
  app.get('/periods', async () => listClosedPeriods(pool));

  app.get('/reconciliation', async () => reconciliation(pool));

  return app;
}
