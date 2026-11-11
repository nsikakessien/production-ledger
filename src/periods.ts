/** Accounting period close. Closing is permanent. */
import { Db } from './db';
import { badRequest } from './errors';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function closePeriod(pool: Db, period: string) {
  if (!PERIOD_RE.test(period)) throw badRequest('INVALID_PERIOD', 'period must be YYYY-MM');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Exclusive: waits for every in-flight posting transaction (they hold it shared)
    // and blocks new ones until this commits, so nothing slips into the period.
    await client.query('SELECT pg_advisory_xact_lock(period_lock_key())');
    const { rows } = await client.query(
      'INSERT INTO closed_periods (period) VALUES ($1) ON CONFLICT (period) DO NOTHING RETURNING closed_at',
      [period],
    );
    const existing = rows[0] ? rows[0] : (await client.query('SELECT closed_at FROM closed_periods WHERE period = $1', [period])).rows[0];
    await client.query('COMMIT');
    return { period, status: 'CLOSED', closedAt: existing.closed_at, alreadyClosed: rows.length === 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function listClosedPeriods(db: Db) {
  const { rows } = await db.query('SELECT period, closed_at FROM closed_periods ORDER BY period');
  return rows.map((r) => ({ period: r.period, status: 'CLOSED', closedAt: r.closed_at }));
}
