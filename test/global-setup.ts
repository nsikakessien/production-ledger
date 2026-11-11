import { Client } from 'pg';
import { migrate } from '../src/migrate';
import { ADMIN_URL, TEMPLATE_DB, dbUrl } from './config';

/** Build a migrated template database once; every test file clones it. */
export default async function setup() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  await migrate(dbUrl(ADMIN_URL, TEMPLATE_DB));
}
