/** Minimal forward-only migration runner (runs as the schema owner). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');

export async function migrate(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Serialise concurrent migrators.
    await client.query('SELECT pg_advisory_lock(7349000)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7349000)').catch(() => undefined);
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ledger';
  migrate(url).then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
