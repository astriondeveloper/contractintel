/**
 * FPDS load entry point.
 *
 *   npm run load:fpds -- --report-headers <file>   inspect headers, write nothing
 *   npm run load:fpds -- <file> [<file> ...]       load specific files
 *   npm run load:fpds -- --dir <directory>         load every .csv in a directory
 *   npm run load:fpds -- --limit 1000 <file>       load the first 1000 rows
 *   npm run load:fpds -- --spec-transaction-key <file>
 *                                                  key exactly as spec 7.2 is
 *                                                  written, letting rows with a blank
 *                                                  'Transaction #' collapse onto one
 *                                                  key. Diagnostic only: it drops
 *                                                  18.6 percent of obligated dollars
 *                                                  from contract_action. The default
 *                                                  substitutes a content hash
 *                                                  instead. See LoadFpdsOptions and
 *                                                  migration 0015.
 *
 * Spec decision D8: scheduled file drops are permitted, manual ad hoc uploads are
 * not. This script is the scheduled path. It takes a directory that a scheduled
 * job writes into, and it is safe to run repeatedly on the same directory because
 * the loader is idempotent.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { withTransaction, closePool } from '../db/index.js';
import { EntityResolver } from '../resolve/entity-resolver.js';
import { loadFpdsFile } from './fpds.js';

interface Args {
  files: string[];
  reportHeadersOnly: boolean;
  syntheticTransactionNumber: boolean;
  limit?: number;
}

async function parseArgs(): Promise<Args> {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let reportHeadersOnly = false;
  // Gavin Taylor's decision, 14 August 2026: keep every transaction. --spec-transaction-key
  // restores the literal 7.2 reading for comparison.
  let syntheticTransactionNumber = true;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--report-headers') {
      reportHeadersOnly = true;
    } else if (arg === '--spec-transaction-key') {
      syntheticTransactionNumber = false;
    } else if (arg === '--synthetic-transaction-number') {
      // Accepted so the flag that appeared in the previous status doc still works.
      syntheticTransactionNumber = true;
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
        // The drop directory does not exist yet. Handled by the check below.
      }
    }
  }

  return { files, reportHeadersOnly, syntheticTransactionNumber, limit };
}

async function main(): Promise<void> {
  const args = await parseArgs();

  if (args.files.length === 0) {
    console.error(
      'No files to load.\n\n' +
        'Usage:\n' +
        '  npm run load:fpds -- --report-headers <file>\n' +
        '  npm run load:fpds -- <file> [<file> ...]\n' +
        '  npm run load:fpds -- --dir <directory>\n\n' +
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
    unresolved: 0,
    skipped: 0,
    parentNamed: 0,
    blankTransaction: 0,
    surrogates: 0,
    collapsed: 0,
    collapsedObligation: 0,
  };
  const parentNames = new Map<string, number>();

  for (const file of args.files) {
    // One transaction per file, so a bad file rolls back on its own and the files
    // that already succeeded stay loaded.
    const result = await withTransaction(async (client) => {
      // The resolver is rebuilt per file, so an alias that BD Ops confirmed between
      // files is picked up without a restart.
      const resolver = await EntityResolver.load(client);
      return loadFpdsFile(client, file, resolver, {
        reportHeadersOnly: args.reportHeadersOnly,
        syntheticTransactionNumber: args.syntheticTransactionNumber,
        limit: args.limit,
        progressEvery: 10_000,
      });
    });

    if (result === null) continue;
    totals.records += result.run.records;
    totals.inserted += result.run.inserted;
    totals.unchanged += result.run.unchanged;
    totals.unresolved += result.unresolvedRows;
    totals.skipped += result.skippedUnkeyable;
    totals.parentNamed += result.unresolvedButParentNamed;
    totals.blankTransaction += result.blankTransactionNumbers;
    totals.surrogates += result.surrogateKeysIssued;
    totals.collapsed += result.collapsedTransactions;
    totals.collapsedObligation += result.collapsedObligation;
    for (const [name, count] of result.unresolvedParentNames) {
      parentNames.set(name, (parentNames.get(name) ?? 0) + count);
    }
  }

  if (args.reportHeadersOnly) return;

  console.log('-'.repeat(80));
  console.log(
    `${'total'.padEnd(28)} ${String(totals.records).padStart(6)} records  ` +
      `${String(totals.inserted).padStart(5)} new  ${String(totals.unchanged).padStart(15)} unchanged`,
  );

  if (totals.skipped > 0) {
    console.log(
      `\n${totals.skipped} row(s) had no PIID or no awarding agency code and could not be keyed. ` +
        'These were skipped, not guessed.',
    );
  }
  if (totals.blankTransaction > 0) {
    const money = (n: number): string =>
      (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

    console.log(
      `\n${totals.blankTransaction} of ${totals.records} row(s) had a blank 'Transaction #'. ` +
        'Spec 7.2 uses it as the fourth part of the natural key.',
    );
    if (args.syntheticTransactionNumber) {
      console.log(
        `  ${totals.surrogates} row(s) were keyed on a content hash instead, so every ` +
          'transaction is kept. This is the default.\n' +
          '  Once the export populates the column, real numbers take over on their own.\n' +
          '  Correcting a mapped field upstream arrives as a new action, not an update.\n' +
          '  Compare against the literal spec 7.2 key with --spec-transaction-key.',
      );
    } else {
      console.log(
        `  ${totals.collapsed} row(s) overwrote a different transaction on the same key, ` +
          `carrying ${money(totals.collapsedObligation)} of Action Obligation.\n` +
          '  This is --spec-transaction-key, kept for comparison. It is not the default.\n' +
          '  Every payload is still in source_version. For the corpus wide figure:\n' +
          '    select * from fpds_collapse_summary;',
      );
    }
  }

  if (totals.unresolved > 0) {
    console.log(
      `\n${totals.unresolved} row(s) could not be resolved to an entity and went to ` +
        'vendor_review_queue for BD Ops. Work that queue by occurrence_count descending:' +
        '\n  select vendor_name_raw, occurrence_count, furthest_step from vendor_review_queue' +
        "\n   where state = 'open' order by occurrence_count desc limit 20;",
    );
  }

  // Spec 8.2 does not list 'Contractor: DACIS: Parent Name' as a match step. This
  // reports what listing it would buy, so the decision has a number behind it.
  if (totals.parentNamed > 0) {
    console.log(
      `\nOf those, ${totals.parentNamed} row(s) carried a DACIS parent name that ` +
        'already normalises onto an entity in the authored map. Adding the column as a ' +
        'fourth step in spec 8.2 would resolve them. Not done: 8.2 does not list it.',
    );
    const top = [...parentNames].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log('\n  parent name on unresolved rows                          rows');
    for (const [name, count] of top) {
      console.log(`  ${name.slice(0, 52).padEnd(54)}${String(count).padStart(6)}`);
    }
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(`\nLoad failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
