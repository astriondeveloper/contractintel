/**
 * Runs all three seed loaders in one transaction.
 *
 * Spec section 20.1, the first task for the builder:
 *   'Load the three seed files. Load the FPDS exports. Run acceptance test 1 and
 *    acceptance test 3. Show the result before you build anything else.'
 *
 *   npm run seed
 *
 * The loaders are idempotent. Running this twice changes no counts. That property
 * is acceptance test 2 and scripts/acceptance.ts asserts it.
 */
import path from 'node:path';
import { withTransaction, closePool } from '../db/index.js';
import { loadEntityMap } from './seed-entity-map.js';
import { loadTaxonomy } from './seed-taxonomy.js';
import { loadWatchlist } from './seed-watchlist.js';

async function main(): Promise<void> {
  const seedDir = path.resolve(process.env.CIE_SEED_DIR ?? './data/seed');
  console.log(`Seed directory: ${seedDir}\n`);
  console.log(
    'loader'.padEnd(28) + '     records     new  changed    unchanged',
  );
  console.log('-'.repeat(80));

  await withTransaction(async (client) => {
    await loadEntityMap(client, seedDir);
    await loadTaxonomy(client, seedDir);
    await loadWatchlist(client, seedDir);
  });

  console.log('-'.repeat(80));
  console.log(
    '\nEvery seed row landed with confirmed_at null. The seed files ship with',
  );
  console.log('confirmed_by_bd_ops = NO on every row. Spec section 20. BD Ops confirms');
  console.log('each row through the admin screen before the system trusts it.');
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(`\nSeed load failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
