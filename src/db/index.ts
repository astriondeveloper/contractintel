import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config as loadEnv } from 'dotenv';

loadEnv();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill it in. Spec section 16: configuration comes from environment variables.',
  );
}

// PGSSLMODE=require against Azure Database for PostgreSQL Flexible Server.
// Empty against a local container. This is the only difference between the two.
const ssl = process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({
  connectionString,
  ...(ssl ? { ssl } : {}),
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await query<T>(sql, params);
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one row, got ${rows.length}. SQL: ${sql.slice(0, 120)}`);
  }
  return rows[0]!;
}

export async function maybeOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  if (rows.length > 1) {
    throw new Error(`Expected at most one row, got ${rows.length}. SQL: ${sql.slice(0, 120)}`);
  }
  return rows[0] ?? null;
}

/** Run a function inside a transaction. Rolls back on any throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
