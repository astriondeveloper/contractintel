/**
 * Test database setup.
 *
 * Builds a real PostgreSQL 16 database by running the same migration runner and
 * the same seed loaders that production uses. Nothing here is a mock, so a test
 * that passes proves the shipped code path works.
 *
 * The database name comes from TEST_DATABASE_URL, or defaults to cie_test beside
 * the development database.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { config as loadEnv } from 'dotenv';

loadEnv();

function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL or TEST_DATABASE_URL before running tests.');
  return base.replace(/\/[^/?]+(\?|$)/, '/cie_test$1');
}

async function recreateDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName) throw new Error(`Cannot read a database name from ${url}`);

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    // Drop and rebuild, so a test run never inherits state from the last one.
    await admin.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`drop database if exists ${JSON.stringify(dbName).replace(/"/g, '"')}`);
    await admin.query(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Where the seed loaders read from during a test run.
 *
 * Gate A came back no: DACIS-derived data may not live in this repository, so the real
 * seed files are not here. `tests/seed/` holds a synthetic set that reproduces every
 * structural property the tests depend on -- the four shared UEIs, the punctuation
 * variants, the near neighbour that must stay separate -- with invented companies and
 * identifiers that cannot be mistaken for real ones. `tests/seed/README.md` lists them.
 *
 * CIE_TEST_SEED_DIR overrides it. Pointing it at the real files will fail most
 * assertions, because they are written against the synthetic values, which is correct:
 * the tests assert behaviour and the values are fixture detail.
 */
function testSeedDir(): string {
  return process.env.CIE_TEST_SEED_DIR ?? path.join(process.cwd(), 'tests', 'seed');
}

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;

  await recreateDatabase(url);

  const env = { ...process.env, DATABASE_URL: url, CIE_SEED_DIR: testSeedDir() };
  const run = (args: string[]) =>
    execFileSync('npx', ['tsx', ...args], { env, stdio: 'pipe', encoding: 'utf8' });

  run(['scripts/migrate.ts']);
  run(['src/loaders/run-seeds.ts']);
}
