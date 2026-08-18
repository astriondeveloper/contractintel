/**
 * Contract actions from GovCon API.
 *
 *   npm run load:contracts                          since the stored cursor, profile NAICS codes
 *   npm run load:contracts -- --dry-run             pull and classify, write nothing
 *   npm run load:contracts -- --from 2025-01-01 --to 2025-06-30
 *   npm run load:contracts -- --uei ZQF7MRQR4KL5    that company's full history (Pro tier)
 *   npm run load:contracts -- --cursor              where the last pull got to. No request.
 *   npm run load:contracts -- --sample              also print the first record's field names
 *
 * Needs `GOVCON_API_KEY` and a profile: run `npm run profile` first.
 *
 * **This does not replace the corpus.** Coverage is comprehensive from October 2024 onward and sparse
 * before it, so it supplies recency and breadth while the bulk FPDS extract supplies depth. Recompete
 * cadence and the forecast backtest both need multiple award cycles per office and cannot be learned
 * from a two-year window — `npm run readiness` reports which of the two your corpus actually has.
 */
import { withTransaction, closePool, pool } from '../../db/index.js';
import {
  pullContracts,
  readCursor,
  COVERAGE_STARTS,
  SEARCH_ENDPOINT,
  type PullResult,
} from './contracts.js';

function usage(): void {
  console.log(`
Contract actions from GovCon API. FPDS data, refreshed daily.

  npm run load:contracts -- [options]

  --dry-run              Pull and classify. Writes nothing and does not move the cursor.
  --from <yyyy-mm-dd>    Actions signed from. Defaults to the stored cursor.
  --to <yyyy-mm-dd>      Actions signed to. Default: now.
  --first-pull-days <n>  How far back a first pull reaches with no cursor. Default: 90.
  --uei <list>           Comma-separated UEIs. Pulls each company's full history instead of a
                         date-filtered search. Not gated by the plan window; Pro tier.
  --cursor               Print the stored cursor and stop. No request.
  --page-size <n>        Records per request, up to 100. Default: 100.
  --max-requests <n>     Stop after n requests this run.
  --sample               Print the field names of the first record, to confirm the mapping.
  --help                 This.

What this is and is not for.

  Recency and breadth. A contract awarded last week without waiting for the next extract, and a
  company the extract never covered.

  Not history. Coverage is comprehensive from ${COVERAGE_STARTS} and sparse before it. Recompete
  cadence needs three follow-on chains per office with intervals over a year, which a two-year window
  cannot contain, and the forecast backtest needs history before its as-of date. Both come from the
  bulk extract: npm run load:fpds.

  --uei is the exception. companies/<uei>/awards is ungated, so it gives real depth — per company
  rather than per office. Enough to complete Astrion's own incumbency and a named competitor set.

Transactions arriving here and from the bulk extract converge on one contract_action row, keyed on
spec 7.2's composite, so running both never double-counts an obligation.
`);
}

function parseDay(value: string | undefined, flag: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) throw new Error(`${flag} takes a date as yyyy-mm-dd.`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function report(result: PullResult): void {
  console.log('');
  console.log(`  mode                      ${result.mode.padStart(6)}`);
  console.log(`  requests                  ${String(result.requests).padStart(6)}`);
  console.log(`  transactions returned     ${String(result.fetched).padStart(6)}`);
  console.log(`  written                   ${String(result.written).padStart(6)}`);
  if (result.unchanged > 0) {
    console.log(`  unchanged                 ${String(result.unchanged).padStart(6)}`);
  }
  if (result.classificationsWritten > 0) {
    console.log(`  classifications           ${String(result.classificationsWritten).padStart(6)}`);
  }
  if (result.labelsWritten > 0) {
    console.log(`  code labels               ${String(result.labelsWritten).padStart(6)}`);
  }

  if (result.skippedRollup > 0) {
    console.log(`  skipped, rollup           ${String(result.skippedRollup).padStart(6)}`);
    console.log('    A record summing every transaction on a PIID rather than describing one action.');
    console.log('    Writing it would put a whole contract\'s obligation on a single row and every');
    console.log('    downstream sum would be wrong without anything failing. Refused on purpose.');
  }
  if (result.skippedUnkeyable > 0) {
    console.log(`  skipped, no key           ${String(result.skippedUnkeyable).padStart(6)}`);
    console.log('    No PIID or no awarding agency, so spec 7.2\'s natural key cannot be formed.');
  }

  if (result.unresolvedVendors > 0) {
    console.log(`  vendors unresolved        ${String(result.unresolvedVendors).padStart(6)}`);
    console.log('    Queued for review. Until resolved these actions cannot say whether Astrion');
    console.log('    holds the work, which is the field the feed filters on.');
  }

  const methods = Object.entries(result.resolvedByMethod).sort();
  if (methods.length > 0) {
    console.log('');
    for (const [method, n] of methods) {
      console.log(`    ${method.padEnd(22)} ${String(n).padStart(6)}`);
    }
  }

  if (result.rateLimitRemaining !== null) {
    console.log('');
    console.log(`  hourly requests left      ${String(result.rateLimitRemaining).padStart(6)}`);
  }

  if (result.sampleKeys !== null) {
    console.log('');
    console.log('  Fields on the first record returned:');
    console.log(`    ${result.sampleKeys.join(', ')}`);
    console.log('    Compare against GovconContract in src/loaders/govcon/contracts.ts. A field this');
    console.log('    build does not read is a field not reaching the corpus.');
  }

  console.log('');
  if (result.cursorAdvancedTo === null) {
    console.log('  The cursor was not moved.');
    if (result.stoppedEarly !== null) console.log(`  ${result.stoppedEarly}`);
    else if (result.mode === 'company') {
      console.log('  A company pull covers that company\'s history rather than a window ending now,');
      console.log('  so it deliberately leaves the cursor alone.');
    } else {
      console.log('  This was a dry run, which leaves it alone deliberately.');
    }
  } else {
    console.log(`  Cursor now ${result.cursorAdvancedTo.toISOString().slice(0, 19)}Z.`);
  }

  if (result.reachedBeforeCoverage) {
    console.log('');
    console.log(`  ! This run reached before ${COVERAGE_STARTS}, where GovCon API's coverage is a`);
    console.log(`    sparse backfill rather than complete. ${result.skippedBeforeCoverage} of the`);
    console.log('    transactions returned were signed before it. Do not read this as a full picture');
    console.log('    of that period; the bulk extract is what covers it.');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const numeric = (flag: string): number | undefined => {
    const raw = value(flag);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} takes a positive number.`);
    return parsed;
  };

  if (argv.includes('--cursor')) {
    const client = await pool.connect();
    try {
      const cursor = await readCursor(client);
      console.log('');
      if (cursor === null) {
        console.log(`  No cursor for ${SEARCH_ENDPOINT}. The next pull is a first pull.`);
      } else {
        console.log(`  ${SEARCH_ENDPOINT}`);
        console.log(`    cursor  ${cursor.cursor_at.toISOString().slice(0, 19)}Z`);
      }
      console.log('');
    } finally {
      client.release();
    }
    return;
  }

  const ueiRaw = value('--uei');
  const ueis =
    ueiRaw === undefined
      ? undefined
      : ueiRaw.split(',').map((u) => u.trim()).filter(Boolean);
  if (ueis !== undefined && ueis.length === 0) {
    throw new Error('--uei takes a comma-separated list of UEIs.');
  }

  const from = value('--from');
  const to = value('--to');

  const result = await withTransaction((client) =>
    pullContracts(client, {
      signedFrom: from === undefined ? undefined : parseDay(from, '--from'),
      signedTo: to === undefined ? undefined : parseDay(to, '--to'),
      firstPullDays: numeric('--first-pull-days'),
      pageSize: numeric('--page-size'),
      maxRequests: numeric('--max-requests'),
      dryRun: argv.includes('--dry-run'),
      sample: argv.includes('--sample'),
      ueis,
      onProgress: (message) => console.log(message),
    }),
  );

  report(result);
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
