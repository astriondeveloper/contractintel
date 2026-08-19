/**
 * Load a GovWin opportunity search export.
 *
 *   npm run load:govwin -- --file <export.xlsx>
 *   npm run load:govwin -- --file <export.xlsx> --dry-run
 *   npm run load:govwin -- --file <export.xlsx> --headers      columns only, no writes
 *   npm run load:govwin -- --file <export.xlsx> --limit 50
 *
 * GovWin is the only source here that knows about a requirement before anything about it is published.
 * Run it weekly against a fresh export; it is idempotent, so a re-import of an unchanged export writes
 * nothing and only moves `last_seen_at`.
 *
 * **The export is licensed Deltek content and must never be committed.** Keep it outside the repository
 * or in `data/`, which is gitignored. The loader stores the structured fields and links out to GovWin
 * for the written analysis rather than copying it; decision D32 has the reasoning.
 */
import { withTransaction, closePool } from '../db/index.js';
import { loadGovwinExport, type LoadGovwinResult } from './govwin.js';

function usage(): void {
  console.log(`
GovWin opportunity search export.

  npm run load:govwin -- --file <path to .xlsx> [options]

  --file <path>   The export. Required.
  --dry-run       Parse and report. Writes nothing.
  --headers       Print the column names and stop. Use this first on a new export.
  --limit <n>     Only the first n rows.
  --help          This.

What it is for. Every other source describes something that already happened: FPDS an award, SAM.gov a
published notice. GovWin describes a requirement an analyst is tracking, often years early, with an
estimate of the month it will solicit. That estimate is also the first outside check this system's own
forecast has ever had -- see govwin_forecast_check.

The export is licensed Deltek data. Do not commit it, and note that the written Summary and Latest News
are deliberately not stored: the row links back to GovWin instead.
`);
}

function report(result: LoadGovwinResult): void {
  console.log('');
  console.log(`  rows read                 ${String(result.rows).padStart(6)}`);
  console.log(`  written                   ${String(result.written).padStart(6)}`);
  if (result.unchanged > 0) {
    console.log(`  unchanged                 ${String(result.unchanged).padStart(6)}`);
    console.log('    Already stored with the same values. last_seen_at moved; nothing else did.');
  }
  if (result.skippedNoId > 0) {
    console.log(`  skipped, no Opp ID        ${String(result.skippedNoId).padStart(6)}`);
  }
  if (result.naicsWritten > 0) {
    console.log(`  NAICS codes               ${String(result.naicsWritten).padStart(6)}`);
  }
  if (result.contractsWritten > 0) {
    console.log(`  contract numbers          ${String(result.contractsWritten).padStart(6)}`);
  }
  if (result.contractsCapped > 0) {
    console.log(`  rows over the cap         ${String(result.contractsCapped).padStart(6)}`);
    console.log('    More contract numbers than are stored per row. An umbrella with hundreds of task');
    console.log('    orders is not a recompete, so the join is capped rather than exhaustive.');
  }

  console.log('');
  console.log('  by type');
  for (const [type, n] of Object.entries(result.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(28)} ${String(n).padStart(6)}`);
  }

  console.log('');
  console.log('  by status');
  for (const [status, n] of Object.entries(result.byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(28)} ${String(n).padStart(6)}`);
  }

  console.log('');
  console.log(`  solicitation dates: ${result.actualDates} actual, ${result.estimatedDates} estimated`);
  console.log('    An estimate is a month, never a day. Stored on the first of that month with its');
  console.log('    precision beside it, so nothing downstream reads it as a claim about the first.');

  const agencyTotal = result.agencyResolved + result.agencyUnresolved;
  if (agencyTotal > 0) {
    const share = ((result.agencyResolved / agencyTotal) * 100).toFixed(1);
    console.log('');
    console.log(`  agency resolved           ${String(result.agencyResolved).padStart(6)}  (${share}%)`);
    if (result.agencyUnresolved > 0) {
      console.log(`  agency unresolved         ${String(result.agencyUnresolved).padStart(6)}`);
      console.log('    GovWin names agencies rather than coding them, and these names are not in the');
      console.log('    labels the corpus has observed. Left blank: a wrong code puts a requirement in');
      console.log('    the wrong feed. Loading more FPDS history resolves more of them.');
    }
  }

  if (result.run !== null) {
    console.log('');
    console.log(
      `  ${result.run.inserted} new, ${result.run.updated} changed, ${result.run.unchanged} unchanged.`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };

  const file = value('--file');
  if (file === undefined) throw new Error('--file <path to .xlsx> is required.');

  const limitRaw = value('--limit');
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit takes a positive whole number of rows.');
  }

  const result = await withTransaction((client) =>
    loadGovwinExport(client, file, {
      dryRun: argv.includes('--dry-run'),
      headersOnly: argv.includes('--headers'),
      limit,
      onProgress: (message) => console.log(message),
    }),
  );

  if (!argv.includes('--headers')) report(result);
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
