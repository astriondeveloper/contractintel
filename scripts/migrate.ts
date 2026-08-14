/**
 * Forward-only migration runner. Spec section 16: migrations are versioned,
 * forward only, and checked into the repository.
 *
 * Each .sql file in migrations/ runs once, inside a transaction, in filename
 * order. The applied set and each file's checksum live in schema_migration.
 * A change to an already-applied file is an error, not a silent no-op.
 *
 *   npm run migrate           apply everything outstanding
 *   npm run migrate:status    report without changing anything
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closePool } from '../src/db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '..', 'migrations');

const BOOTSTRAP = `
create table if not exists schema_migration (
  filename    text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  duration_ms integer
);
`;

function checksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');

  await pool.query(BOOTSTRAP);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }

  const applied = new Map<string, string>();
  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    'select filename, checksum from schema_migration',
  );
  for (const row of rows) applied.set(row.filename, row.checksum);

  let outstanding = 0;

  for (const filename of files) {
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    const sum = checksum(sql);
    const previous = applied.get(filename);

    if (previous !== undefined) {
      if (previous !== sum) {
        throw new Error(
          `${filename} has changed since it was applied (${previous} -> ${sum}). ` +
            'Migrations are forward only. Add a new migration instead of editing this one.',
        );
      }
      if (statusOnly) console.log(`  applied   ${filename}`);
      continue;
    }

    outstanding += 1;

    if (statusOnly) {
      console.log(`  PENDING   ${filename}`);
      continue;
    }

    const client = await pool.connect();
    const started = Date.now();
    try {
      await client.query('begin');
      await client.query(sql);
      const duration = Date.now() - started;
      await client.query(
        'insert into schema_migration (filename, checksum, duration_ms) values ($1, $2, $3)',
        [filename, sum, duration],
      );
      await client.query('commit');
      console.log(`  applied   ${filename}  (${duration} ms)`);
    } catch (error) {
      await client.query('rollback');
      console.error(`  FAILED    ${filename}`);
      throw error;
    } finally {
      client.release();
    }
  }

  if (statusOnly) {
    console.log(`\n${files.length} migration files, ${outstanding} pending.`);
  } else if (outstanding === 0) {
    console.log('Schema is up to date. Nothing to apply.');
  } else {
    console.log(`\nApplied ${outstanding} migration(s).`);
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
