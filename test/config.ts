export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
export const TEMPLATE_DB = 'ledger_test_template';

export function dbUrl(base: string, database: string, user?: { name: string; password: string }) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}
