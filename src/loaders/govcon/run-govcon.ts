/**
 * GovCon API entry point.
 *
 *   npm run load:govcon -- --probe            one request: key, plan, rate limit, search window
 *   npm run load:govcon                       changes since the stored cursor
 *   npm run load:govcon -- --dry-run          pull and classify, write nothing, leave the cursor
 *   npm run load:govcon -- --unfiltered       whole delta, filtered locally against the profile
 *   npm run load:govcon -- --since 2026-08-01T00:00:00Z
 *   npm run load:govcon -- --backfill --from 2026-01-01 --to 2026-06-30
 *   npm run load:govcon -- --cursor           print the cursor and stop
 *   npm run load:govcon -- --sample           also print the field names of the first record
 *
 * Needs `GOVCON_API_KEY` and a profile to search with: run `npm run profile` first.
 *
 * Safe to run repeatedly and designed to run hourly. The cursor makes a second run inside the same
 * hour cheap rather than wasteful: it asks for changes since the last run, not for the window again.
 */
import { withTransaction, closePool, pool } from '../../db/index.js';
import { probeGovcon } from './client.js';
import {
  syncOpportunities,
  backfillOpportunities,
  readCursor,
  sinceParam,
  DELTA_ENDPOINT,
  DELTA_MAX_DAYS,
  type SyncResult,
} from './opportunities.js';

function usage(): void {
  console.log(`
GovCon API opportunities. Incremental, targeted by the opportunity profile.

  npm run load:govcon -- [options]

  --probe                One request to /me. Key, plan, rate limit, search window. Writes nothing.
  --cursor               Print the stored delta cursor and stop. No request.
  --dry-run              Pull and classify. Writes nothing and does not move the cursor.
  --since <iso>          Pull changes since this instant instead of the cursor.
  --unfiltered           Pull the whole delta and filter locally instead of asking per code.
  --backfill             Use /opportunities/search over a date range. Needs --from.
  --from <yyyy-mm-dd>    Backfill from.
  --to <yyyy-mm-dd>      Backfill to. Default: today.
  --first-sync-days <n>  How far back a first sync reaches when there is no cursor. Default: 30.
  --page-size <n>        Records per request, up to 100. Default: 100.
  --max-requests <n>     Stop after n requests this run.
  --sample               Print the field names of the first record, to confirm the mapping.
  --help                 This.

Why this exists alongside npm run load:sam: api.sam.gov cannot answer "what changed", so a run
there re-searches every profile code against a daily quota. This uses /opportunities/delta against
an hourly one, which is what makes an hourly sync affordable. Both write the same pursuit rows under
the same signal_key, so running both does not duplicate anything.

The delta window is capped at ${DELTA_MAX_DAYS} days regardless of plan. A gap wider than that needs
--backfill, and this reports a clamp rather than letting a run look complete when it was not.
`);
}

function parseDay(value: string | undefined, flag: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) throw new Error(`${flag} takes a date as yyyy-mm-dd.`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function report(result: SyncResult): void {
  console.log('');
  console.log(`  mode                      ${result.mode.padStart(6)}`);
  console.log(`  requests                  ${String(result.requests).padStart(6)}`);
  console.log(`  records returned          ${String(result.fetched).padStart(6)}`);
  console.log(`  distinct notices          ${String(result.matched).padStart(6)}`);
  console.log(`  written                   ${String(result.written).padStart(6)}`);

  for (const [signalClass, n] of Object.entries(result.byClass).sort()) {
    console.log(`    ${signalClass.padEnd(22)} ${String(n).padStart(6)}`);
  }

  if (result.skippedOffProfile > 0) {
    console.log(`  skipped, off profile      ${String(result.skippedOffProfile).padStart(6)}`);
    console.log('    Matched no code on the opportunity profile. Expected in --unfiltered mode.');
  }
  if (result.skippedUnknownType > 0) {
    console.log(`  skipped, unknown type     ${String(result.skippedUnknownType).padStart(6)}`);
    console.log('    A notice type this build does not recognise. Worth a look rather than a guess.');
  }
  if (result.skippedNoNoticeId > 0) {
    console.log(`  skipped, no notice id     ${String(result.skippedNoNoticeId).padStart(6)}`);
  }

  if (result.rateLimitRemaining !== null) {
    console.log(`  hourly requests left      ${String(result.rateLimitRemaining).padStart(6)}`);
  }

  if (result.sampleKeys !== null) {
    console.log('');
    console.log('  Fields on the first record returned:');
    console.log(`    ${result.sampleKeys.join(', ')}`);
    console.log('    Compare against src/loaders/govcon/opportunities.ts:GovconOpportunity. A field');
    console.log('    this build does not read is a field not reaching the feed.');
  }

  console.log('');
  if (result.cursorAdvancedTo === null) {
    console.log('  The cursor was not moved.');
    if (result.stoppedEarly !== null) console.log(`  ${result.stoppedEarly}`);
    else console.log('  This was a dry run or a backfill, both of which leave it alone deliberately.');
  } else {
    console.log(`  Cursor now ${sinceParam(result.cursorAdvancedTo)}. The next run asks for changes since then.`);
  }

  if (result.clamped) {
    console.log('');
    console.log('  ! This run had a gap.');
    console.log(`    ${result.clampNote}`);
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

  // The probe runs before any database connection, because it is what somebody reaches for when
  // nothing works and it should not be able to fail for a second reason.
  if (argv.includes('--probe')) {
    const probe = await probeGovcon();
    console.log('');
    console.log(`  ${probe.ok ? 'reachable' : 'NOT REACHABLE'}   ${probe.host}`);
    console.log('');
    console.log(`  ${probe.detail}`);
    console.log('');
    if (!probe.ok) process.exitCode = 1;
    return;
  }

  if (argv.includes('--cursor')) {
    const client = await pool.connect();
    try {
      const cursor = await readCursor(client);
      console.log('');
      if (cursor === null) {
        console.log(`  No cursor for ${DELTA_ENDPOINT}. The next sync is a first sync.`);
      } else {
        console.log(`  ${DELTA_ENDPOINT}`);
        console.log(`    cursor      ${sinceParam(cursor.cursor_at)}`);
        console.log(`    last since  ${cursor.last_since === null ? 'not recorded' : sinceParam(cursor.last_since)}`);
        console.log(`    records     ${cursor.records_seen}`);
        console.log(`    updated     ${sinceParam(cursor.updated_at)}`);
        if (cursor.last_clamped) {
          console.log('    ! the last run was clamped and has a gap');
          console.log(`      ${cursor.last_clamp_note}`);
        }
      }
      console.log('');
    } finally {
      client.release();
    }
    return;
  }

  const shared = {
    maxRequests: numeric('--max-requests'),
    pageSize: numeric('--page-size'),
    dryRun: argv.includes('--dry-run'),
    sample: argv.includes('--sample'),
    onProgress: (message: string) => console.log(message),
  };

  if (argv.includes('--backfill')) {
    const from = value('--from');
    if (from === undefined) {
      throw new Error('--backfill needs --from <yyyy-mm-dd>. It is a one-off historical pull, not a sync.');
    }
    const to = value('--to');
    const result = await withTransaction((client) =>
      backfillOpportunities(client, {
        ...shared,
        postedFrom: parseDay(from, '--from'),
        postedTo: to === undefined ? undefined : parseDay(to, '--to'),
      }),
    );
    report(result);
    return;
  }

  const since = value('--since');
  if (since !== undefined && Number.isNaN(new Date(since).getTime())) {
    throw new Error('--since takes an ISO 8601 instant, for example 2026-08-01T00:00:00Z.');
  }

  const result = await withTransaction((client) =>
    syncOpportunities(client, {
      ...shared,
      since: since === undefined ? undefined : new Date(since),
      firstSyncDays: numeric('--first-sync-days'),
      mode: argv.includes('--unfiltered') ? 'unfiltered' : 'filtered',
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
