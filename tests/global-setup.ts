import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

/** Recreates the test database from the migration files before the run. */
export default async function setup() {
  // The global setup runs outside the test workers, so it does not get test.env:
  // read the TEST_* variables directly (same defaults as vitest.config.ts).
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
  const testDb = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/cityfix_test').pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(testDb)) throw new Error(`Unsafe test database name: ${testDb}`);
  if (!/test/.test(testDb)) throw new Error(`Refusing to recreate "${testDb}": the test database name must contain "test"`);

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDb}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${testDb}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  for (const file of ['001_schema.sql', '002_seed.sql']) {
    await db.query(fs.readFileSync(path.join(import.meta.dirname, '..', 'db', file), 'utf8'));
  }
  await db.end();
}
