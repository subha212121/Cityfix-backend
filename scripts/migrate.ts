/**
 * Applies db/*.sql files in order, once each, tracked in schema_migrations.
 * Usage: DATABASE_ADMIN_URL=postgres://postgres:...@host/cityfix npm run db:migrate
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  console.error('Set DATABASE_ADMIN_URL (an owner/superuser connection).');
  process.exit(1);
}

const dir = [path.join(process.cwd(), 'db'), path.join(import.meta.dirname, '..', '..', 'db')].find((d) => fs.existsSync(d))!;
const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (file text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await client.query('SELECT file FROM schema_migrations')).rows.map((r) => r.file));

for (const f of files) {
  if (done.has(f)) continue;
  process.stdout.write(`applying ${f} ... `);
  await client.query(fs.readFileSync(path.join(dir, f), 'utf8')); // each file has its own BEGIN/COMMIT
  await client.query('INSERT INTO schema_migrations (file) VALUES ($1)', [f]);
  console.log('ok');
}
console.log(`database is up to date (${files.length} migration files)`);
await client.end();
