/**
 * Database-level guards. These bypass the application entirely and talk SQL,
 * so they fail if a trigger/constraint/grant is removed even when the app code
 * still validates correctly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { TestEnv, api, createTestEnv, createWE1Loan, pay } from '../helpers';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env?.close());

/** Run statements in one transaction as the given role; resolve to the error (or undefined). */
async function txError(pool: Pool, statements: string[]): Promise<any> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of statements) await c.query(s);
    await c.query('COMMIT');
    return undefined;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return e;
  } finally {
    c.release();
  }
}

const entry = (date = '2025-06-01') =>
  `INSERT INTO journal_entries (entry_date, effective_date, kind, description) VALUES ('${date}', '${date}', 'MANUAL', 't')`;
const line = (side: 'D' | 'C', amount: number, account = 1, entryId = "currval('journal_entries_id_seq')") =>
  `INSERT INTO journal_lines (entry_id, line_no, account_id, side, amount) VALUES (${entryId}, (SELECT coalesce(max(line_no),0)+1 FROM journal_lines WHERE entry_id = ${entryId}), ${account}, '${side}', ${amount})`;

describe('balanced entries are enforced by the database', () => {
  it('accepts a balanced entry', async () => {
    expect(await txError(env.pool, [entry(), line('D', 100, 1), line('C', 100, 6)])).toBeUndefined();
  });

  it('rejects an unbalanced entry at COMMIT (deferred constraint trigger)', async () => {
    const e = await txError(env.pool, [entry(), line('D', 100, 1), line('C', 99, 6)]);
    expect(e?.code).toBe('LG002');
  });

  it('rejects a one-line entry and an entry with no lines', async () => {
    expect((await txError(env.pool, [entry(), line('D', 100)]))?.code).toBe('LG002');
    expect((await txError(env.pool, [entry()]))?.code).toBe('LG002');
  });

  it('rejects zero, negative and fractional amounts', async () => {
    expect((await txError(env.pool, [entry(), line('D', 0), line('C', 0, 6)]))?.code).toBe('23514');
    expect((await txError(env.pool, [entry(), line('D', -5), line('C', -5, 6)]))?.code).toBe('23514');
    // BIGINT column: a fractional text value cannot be stored at all.
    expect((await txError(env.pool, [entry(), line('D', "'1.5'" as any), line('C', "'1.5'" as any, 6)]))?.code).toBe('22P02');
  });

  it('rejects adding lines (even balanced ones) to an already committed entry', async () => {
    await txError(env.pool, [entry(), line('D', 100, 1), line('C', 100, 6)]);
    const { rows } = await env.pool.query('SELECT max(id) AS id FROM journal_entries');
    const e = await txError(env.pool, [line('D', 5, 1, rows[0].id), line('C', 5, 6, rows[0].id)]);
    expect(e?.code).toBe('LG005');
  });
});

describe('journal and sub-ledger tables are append-only', () => {
  const tables = ['journal_entries', 'journal_lines', 'payments', 'payment_allocations', 'allocation_events', 'instalments', 'loans'];

  beforeAll(async () => {
    const loan = await createWE1Loan(env.app);
    await pay(env.app, loan.id, 1_000, '2025-02-15');
  });

  for (const t of tables) {
    it(`UPDATE / DELETE / TRUNCATE on ${t} fail even for the table owner`, async () => {
      const col = t === 'journal_lines' || t === 'payments' || t === 'payment_allocations' || t === 'loans' ? 'id' : t === 'instalments' ? 'number' : 'id';
      expect((await txError(env.owner, [`UPDATE ${t} SET ${col} = ${col}`]))?.code).toBe('LG003');
      expect((await txError(env.owner, [`DELETE FROM ${t}`]))?.code).toBe('LG003');
      expect((await txError(env.owner, [`TRUNCATE ${t} CASCADE`]))?.code).toBe('LG003');
    });
  }

  it('the application role has no UPDATE/DELETE privilege at all', async () => {
    expect((await txError(env.pool, ['UPDATE journal_lines SET amount = amount + 1']))?.code).toBe('42501');
    expect((await txError(env.pool, ['DELETE FROM journal_entries']))?.code).toBe('42501');
    expect((await txError(env.pool, ['ALTER TABLE journal_lines DISABLE TRIGGER USER']))?.code).toBe('42501');
  });
});

describe('reversal and period rules in the database', () => {
  it('an entry can be referenced as reversed only once (UNIQUE)', async () => {
    await txError(env.pool, [entry(), line('D', 7, 1), line('C', 7, 6)]);
    const { rows } = await env.pool.query('SELECT max(id) AS id FROM journal_entries');
    const rev = (id: string) =>
      `INSERT INTO journal_entries (entry_date, effective_date, kind, description, reverses_entry_id) VALUES ('2025-06-02','2025-06-02','REVERSAL','r', ${id})`;
    expect(await txError(env.pool, [rev(rows[0].id), line('C', 7, 1), line('D', 7, 6)])).toBeUndefined();
    expect((await txError(env.pool, [rev(rows[0].id), line('C', 7, 1), line('D', 7, 6)]))?.code).toBe('23505');
  });

  it('rejects entries dated in a closed period', async () => {
    const res = await api(env.app, 'POST', '/periods/2024-03/close');
    expect(res.status).toBe(200);
    expect((await txError(env.pool, [entry('2024-03-31'), line('D', 1), line('C', 1, 6)]))?.code).toBe('LG001');
    expect(await txError(env.pool, [entry('2024-04-01'), line('D', 1), line('C', 1, 6)])).toBeUndefined();
    // and the period cannot be reopened
    expect((await txError(env.owner, ["DELETE FROM closed_periods WHERE period = '2024-03'"]))?.code).toBe('LG003');
  });

  it('refuses allocations that over-collect an instalment, even if written directly', async () => {
    const loan = await createWE1Loan(env.app);
    const p = await pay(env.app, loan.id, 21_063_026, '2025-02-15');
    const pid = p.body.payment.id;
    // Move 1 kobo from principal to interest on instalment 1: totals still match the payment,
    // but interest would be over-collected.
    const e = await txError(env.pool, [
      `INSERT INTO allocation_events (loan_id, payment_id, kind, trigger_kind, trigger_ref, reason) VALUES (${loan.id}, ${pid}, 'REALLOCATE', 'PAYMENT_RECEIVED', ${pid}, 'tamper')`,
      `INSERT INTO payment_allocations (event_id, loan_id, payment_id, instalment_number, component, amount) VALUES (currval('allocation_events_id_seq'), ${loan.id}, ${pid}, 1, 'INTEREST', 1)`,
      `INSERT INTO payment_allocations (event_id, loan_id, payment_id, instalment_number, component, amount) VALUES (currval('allocation_events_id_seq'), ${loan.id}, ${pid}, 1, 'PRINCIPAL', -1)`,
    ]);
    expect(e?.code).toBe('LG004');
    // and allocations that do not sum to the payment amount
    const e2 = await txError(env.pool, [
      `INSERT INTO allocation_events (loan_id, payment_id, kind, trigger_kind, trigger_ref, reason) VALUES (${loan.id}, ${pid}, 'REALLOCATE', 'PAYMENT_RECEIVED', ${pid}, 'tamper')`,
      `INSERT INTO payment_allocations (event_id, loan_id, payment_id, instalment_number, component, amount) VALUES (currval('allocation_events_id_seq'), ${loan.id}, ${pid}, NULL, 'UNAPPLIED', 5)`,
    ]);
    expect(e2?.code).toBe('LG004');
  });
});
