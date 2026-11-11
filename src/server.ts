import { buildApp } from './app';
import { createPool } from './db';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://ledger_app:ledger_app@localhost:5433/ledger');
const app = buildApp(pool, { logger: true });

app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
