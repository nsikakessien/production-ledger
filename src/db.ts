import { Pool, PoolClient, types } from 'pg';

// int8 -> BigInt (never Number: money must not lose precision); date -> 'YYYY-MM-DD' string.
types.setTypeParser(20, (v) => BigInt(v));
types.setTypeParser(1082, (v) => v);

export type Db = Pool;
export type Tx = PoolClient;

export function createPool(connectionString: string, max = 20): Pool {
  return new Pool({ connectionString, max });
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * Run fn inside a READ COMMITTED transaction.
 *
 * Every write transaction first takes the period-close advisory lock in SHARED
 * mode. Period close takes it EXCLUSIVE, so a close waits for in-flight posts
 * to finish and later posts see the closed period. Serialization failures and
 * deadlocks are retried.
 */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(period_lock_key())');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (RETRYABLE.has(err?.code) && attempt < attempts) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
