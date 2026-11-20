import pg from 'pg';
import { config } from '../config.js';

// int8 (counts, bigint ids) and numeric → JS numbers. Safe: ids stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  application_name: 'cityfix-api',
});

export type Role = 'citizen' | 'officer' | 'admin';
export interface Actor {
  userId: string;
  role: Role;
}
export type Db = pg.PoolClient;

/**
 * Runs `fn` in one transaction with the acting user set for triggers and
 * row-level security (app.user_id / app.role). Pass `null` for system work
 * (sign-up, login, background jobs).
 */
export async function withTx<T>(
  actor: Actor | null,
  fn: (db: Db) => Promise<T>,
  opts: { statusNote?: string } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true),
              set_config('app.status_note', $3, true)`,
      [actor?.userId ?? '', actor?.role ?? '', opts.statusNote ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Sets the status note picked up by the status-history trigger. */
export async function setStatusNote(db: Db, note: string | null | undefined) {
  await db.query(`SELECT set_config('app.status_note', $1, true)`, [note ?? '']);
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
