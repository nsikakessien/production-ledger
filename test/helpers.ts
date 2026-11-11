import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createPool } from '../src/db';
import { ADMIN_URL, TEMPLATE_DB, dbUrl } from './config';

export interface TestEnv {
  app: FastifyInstance;
  pool: Pool; // connects as the restricted ledger_app role (what the API uses)
  owner: Pool; // connects as the schema owner (to prove triggers stop even the owner)
  close(): Promise<void>;
}

/** A fresh database cloned from the migrated template, plus an app bound to it. */
export async function createTestEnv(): Promise<TestEnv> {
  const name = `ledger_t_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  await admin.end();

  const pool = createPool(dbUrl(ADMIN_URL, name, { name: 'ledger_app', password: 'ledger_app' }), 30);
  const owner = createPool(dbUrl(ADMIN_URL, name), 5);
  const app = buildApp(pool);
  await app.ready();
  return {
    app,
    pool,
    owner,
    async close() {
      await app.close();
      await pool.end();
      await owner.end();
      const a = new Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function api(app: FastifyInstance, method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: body as any, headers });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
}

/** The Worked Example 1 loan. Instalment n falls due on 2025-(1+n)-15. */
export const WE1 = { principal: 120_000_000, annualRate: '0.18', termMonths: 6, disbursementDate: '2025-01-15' };

export async function createWE1Loan(app: FastifyInstance, overrides: Partial<typeof WE1> = {}) {
  const res = await api(app, 'POST', '/loans', { ...WE1, ...overrides });
  if (res.status !== 201) throw new Error(`create loan failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

let keySeq = 0;
export async function pay(app: FastifyInstance, loanId: string, amount: number, date: string, key = `k-${Date.now()}-${++keySeq}-${Math.random()}`) {
  return api(app, 'POST', `/loans/${loanId}/payments`, { amount, date }, { 'idempotency-key': key });
}

export async function trialBalance(app: FastifyInstance) {
  const res = await api(app, 'GET', '/ledger/trial-balance');
  const by = Object.fromEntries(res.body.accounts.map((a: any) => [a.account, a]));
  return { ...res.body, by };
}

export async function loanRecon(app: FastifyInstance, loanId: string) {
  const res = await api(app, 'GET', '/reconciliation');
  return { all: res.body, loan: res.body.loans.find((l: any) => l.loanId === loanId) };
}
