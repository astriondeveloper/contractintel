/**
 * Subcontract load entry point.
 *
 *   npm run load:subs -- --report-headers <file>   inspect headers, write nothing
 *   npm run load:subs -- <file> [<file> ...]       load specific files
 *   npm run load:subs -- --dir <directory>         load every .csv in a directory
 *   npm run load:subs -- --limit 500 <file>        load the first 500 rows
 *
 * Only the companies_fpds-subcontracts-in and -out shape is read here. The
 * companies_contracts-prime, companies_contracts-out and companies_subcontracts
 * exports are DACIS *contract* records with a different twenty column shape and no
 * prime-and-sub pair on a row; they need their own loader and are not edges. Pointing
 * this one at a directory containing them reports the mismatch per file and loads
 * nothing from them, which is why --dir is safe to aim at the whole drop folder.
 *
 * Spec decision D8: scheduled file drops, not ad hoc upload. Idempotent, so re-running
 * on the same directory changes nothing.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { withTransaction, closePool, query } from '../db/index.js';
import { EntityResolver } from '../resolve/entity-resolver.js';
import { loadSubcontractFile } from './subcontract.js';

interface Args {
  files: string[];
  reportHeadersOnly: boolean;
  limit?: number;
}

async function parseArgs(): Promise<Args> {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let reportHeadersOnly = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--report-headers') {
      reportHeadersOnly = true;
    } else if (arg === '--limit') {
      limit = Number(argv[++i]);
      if (!Number.isFinite(limit)) throw new Error('--limit needs a number');
    } else if (arg === '--dir') {
      const dir = argv[++i];
      if (!dir) throw new Error('--dir needs a directory');
      const entries = await readdir(dir);
      for (const entry of entries.sort()) {
        if (entry.toLowerCase().endsWith('.csv')) files.push(path.join(dir, entry));
      }
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    const dropDir = process.env.CIE_DROP_DIR;
    if (dropDir) {
      try {
        const entries = await readdir(dropDir);
        for (const entry of entries.sort()) {
          if (entry.toLowerCase().endsWith('.csv')) files.push(path.join(dropDir, entry));
        }
      } catch {
        // Handled by the check below.
      }
    }
  }

  return { files, reportHeadersOnly, limit };
}

const money = (n: number): string =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

async function main(): Promise<void> {
  const args = await parseArgs();

  if (args.files.length === 0) {
    console.error(
      'No files to load.\n\n' +
        'Usage:\n' +
        '  npm run load:subs -- --report-headers <file>\n' +
        '  npm run load:subs -- <file> [<file> ...]\n' +
        '  npm run load:subs -- --dir <directory>\n\n' +
        `CIE_DROP_DIR is ${process.env.CIE_DROP_DIR ?? 'not set'}.`,
    );
    process.exit(1);
  }

  console.log(`${args.files.length} file(s) to process.\n`);
  if (!args.reportHeadersOnly) {
    console.log('file'.padEnd(28) + '     records     new  changed    unchanged');
    console.log('-'.repeat(80));
  }

  const totals = {
    records: 0,
    inserted: 0,
    unchanged: 0,
    astrionIsPrime: 0,
    astrionIsSub: 0,
    bothAstrion: 0,
    oneSideResolved: 0,
    neitherSideResolved: 0,
    skipped: 0,
    withoutRecordId: 0,
    blankValues: 0,
    negativeValues: 0,
  };
  const wrongShape: string[] = [];

  for (const file of args.files) {
    try {
      const result = await withTransaction(async (client) => {
        const resolver = await EntityResolver.load(client);
        return loadSubcontractFile(client, file, resolver, {
          reportHeadersOnly: args.reportHeadersOnly,
          limit: args.limit,
          progressEvery: 5_000,
        });
      });

      if (result === null) continue;
      totals.records += result.run.records;
      totals.inserted += result.run.inserted;
      totals.unchanged += result.run.unchanged;
      totals.astrionIsPrime += result.astrionIsPrime;
      totals.astrionIsSub += result.astrionIsSub;
      totals.bothAstrion += result.bothAstrion;
      totals.oneSideResolved += result.oneSideResolved;
      totals.neitherSideResolved += result.neitherSideResolved;
      totals.skipped += result.skippedUnkeyable;
      totals.withoutRecordId += result.rowsWithoutRecordId;
      totals.blankValues += result.blankValues;
      totals.negativeValues += result.negativeValues;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A file of a different shape is skipped, named, and does not stop the run. Each
      // file loads in its own transaction, so nothing it touched is left behind.
      if (message.includes('no edge without both sides')) {
        wrongShape.push(path.basename(file));
        continue;
      }
      throw error;
    }
  }

  if (args.reportHeadersOnly) return;

  console.log('-'.repeat(80));
  console.log(
    `${'total'.padEnd(28)} ${String(totals.records).padStart(6)} records  ` +
      `${String(totals.inserted).padStart(5)} new  ${String(totals.unchanged).padStart(15)} unchanged`,
  );

  if (wrongShape.length > 0) {
    console.log(
      `\n${wrongShape.length} file(s) are not subcontract edge exports and were skipped, ` +
        'not partially loaded:',
    );
    for (const name of wrongShape) console.log(`  ${name}`);
    console.log(
      '  These are DACIS contract records. They have no prime and sub pair on a row and\n' +
        '  need their own loader. Run with --report-headers to see their shape.',
    );
  }

  console.log('\nDirection, derived from the data rather than from the file name:');
  console.log(`  Astrion is the prime          ${String(totals.astrionIsPrime).padStart(6)}`);
  console.log(`  Astrion is the sub            ${String(totals.astrionIsSub).padStart(6)}`);
  console.log(`  both sides Astrion            ${String(totals.bothAstrion).padStart(6)}`);

  console.log('\nCounterparty resolution:');
  console.log(`  one side resolved             ${String(totals.oneSideResolved).padStart(6)}  usable, the normal case`);
  console.log(`  neither side resolved         ${String(totals.neitherSideResolved).padStart(6)}  cannot be placed, sent to review`);

  if (totals.blankValues > 0 || totals.negativeValues > 0) {
    console.log('\nValue column:');
    if (totals.blankValues > 0) {
      console.log(`  ${totals.blankValues} row(s) had a blank Value, stored as null rather than as zero.`);
    }
    if (totals.negativeValues > 0) {
      console.log(`  ${totals.negativeValues} row(s) had a negative Value. Deobligations, kept. Spec 7.2.`);
    }
  }
  if (totals.withoutRecordId > 0) {
    console.log(
      `\n${totals.withoutRecordId} row(s) had no ID and were keyed on their own content instead.`,
    );
  }
  if (totals.skipped > 0) {
    console.log(`\n${totals.skipped} row(s) had no prime or no sub name and were skipped, not guessed.`);
  }

  // The point of the whole exercise: observed teaming direction, replacing the seed
  // watchlist counts with something derived from records.
  const competimates = await query<{ n: string }>(
    `select count(*)::text as n from teaming_direction
      where times_astrion_subbed_to_them > 0 and times_they_subbed_to_astrion > 0`,
  );
  const totalValue = await query<{ v: string | null }>(
    'select sum(value_usd)::text as v from subcontract_edge',
  );
  console.log(
    `\nteaming_direction is now live: ${competimates[0]!.n} observed competimate(s), ` +
      `${money(Number(totalValue[0]!.v ?? 0))} across all edges.`,
  );
  console.log(
    '  select * from teaming_direction order by times_astrion_subbed_to_them desc;\n' +
      '  select * from subcontract_counterparty_offwatchlist\n' +
      '   where directions = 2 order by edges desc;   -- unlisted competimates',
  );
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(`\nLoad failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
