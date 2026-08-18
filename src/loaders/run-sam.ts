/**
 * SAM.gov opportunities entry point.
 *
 *   npm run load:sam -- --probe            one request: is the key good and the host reachable
 *   npm run load:sam -- --dry-run          search and classify, write nothing
 *   npm run load:sam                       last 90 days, every code on the profile
 *   npm run load:sam -- --days 30
 *   npm run load:sam -- --from 01/01/2026 --to 06/30/2026
 *   npm run load:sam -- --types r,s,p      only these notice types
 *   npm run load:sam -- --naics 541330     one code, ignoring the profile
 *   npm run load:sam -- --include-awards   add award notices as market movement
 *
 * Needs `SAM_API_KEY` in the environment and a profile to search with: run
 * `npm run profile` first.
 *
 * Safe to run repeatedly. `signal_class_threshold.rhythm` says `daily` for an active
 * solicitation, which is the cadence this is built for; a notice already seen is updated
 * in place and reported unchanged.
 */
import { withTransaction, closePool } from '../db/index.js';
import {
  loadSamOpportunities,
  probeSam,
  DEFAULT_NOTICE_TYPES,
  NOTICE_TYPES,
  type NoticeType,
} from './sam.js';

function parseDate(value: string | undefined, flag: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((value ?? '').trim());
  if (!match) throw new Error(`${flag} takes a date in mm/dd/yyyy, as the SAM.gov API does.`);
  return new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
}

function usage(): void {
  console.log(`
SAM.gov opportunities. Targeted by the opportunity profile.

  npm run load:sam -- [options]

  --probe                One request. Is the key good and the host reachable? Writes nothing.
  --dry-run              Search and classify. Writes nothing.
  --days <n>             Posted in the last n days. Default: 90.
  --from <mm/dd/yyyy>    Posted from. Overrides --days.
  --to <mm/dd/yyyy>      Posted to. Default: today.
  --types <list>         Comma-separated notice types. Default: ${DEFAULT_NOTICE_TYPES.join(',')}
  --include-awards       Add award notices, which land as market movement.
  --naics <list>         Search these NAICS codes instead of the profile.
  --psc <list>           Search these PSC codes instead of the profile.
  --max-requests <n>     Stop after n HTTP calls. Default: 200.
  --page-size <n>        Records per call, up to 1000. Default: 200.
  --help                 This.

Notice types, and what each becomes:
${Object.entries(NOTICE_TYPES)
  .map(([code, meta]) => `  ${code}  ${meta.label.padEnd(30)} ${meta.signalClass}`)
  .join('\n')}

The search is driven by opportunity_profile, so a notice outside what the company does is
never fetched. npm run profile builds it from the capability taxonomy crosswalks and from
the codes the corpus shows Astrion working under.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  // Before any of the option parsing, and before the database is touched: a probe is what somebody
  // runs when nothing works, and it should not be able to fail for a second reason.
  if (argv.includes('--probe')) {
    const probe = await probeSam();
    console.log('');
    console.log(`  ${probe.ok ? 'reachable' : 'NOT REACHABLE'}   ${probe.host}`);
    console.log('');
    console.log(`  ${probe.detail}`);
    console.log('');
    if (!probe.ok) process.exitCode = 1;
    return;
  }

  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const list = (flag: string): string[] | undefined => {
    const raw = value(flag);
    if (raw === undefined) return undefined;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error(`${flag} takes a comma-separated list.`);
    return parts;
  };

  const days = value('--days');
  if (days !== undefined && (!Number.isFinite(Number(days)) || Number(days) < 1)) {
    throw new Error('--days takes a positive number of days.');
  }

  let noticeTypes: NoticeType[] | undefined;
  const types = list('--types');
  if (types) {
    const bad = types.filter((t) => !(t in NOTICE_TYPES));
    if (bad.length > 0) {
      throw new Error(`Unknown notice type(s): ${bad.join(', ')}. Valid: ${Object.keys(NOTICE_TYPES).join(', ')}`);
    }
    noticeTypes = types as NoticeType[];
  } else if (argv.includes('--include-awards')) {
    noticeTypes = [...DEFAULT_NOTICE_TYPES, 'a'];
  }

  const from = value('--from');
  const to = value('--to');

  const result = await withTransaction((client) =>
    loadSamOpportunities(client, {
      dryRun: argv.includes('--dry-run'),
      lookbackDays: days === undefined ? undefined : Number(days),
      postedFrom: from === undefined ? undefined : parseDate(from, '--from'),
      postedTo: to === undefined ? undefined : parseDate(to, '--to'),
      noticeTypes,
      naics: list('--naics'),
      psc: list('--psc'),
      maxRequests: value('--max-requests') === undefined ? undefined : Number(value('--max-requests')),
      pageSize: value('--page-size') === undefined ? undefined : Number(value('--page-size')),
      onProgress: (message) => console.log(message),
    }),
  );

  console.log('');
  console.log(`  codes searched            ${String(result.codesSearched).padStart(6)}`);
  console.log(`  HTTP requests             ${String(result.requests).padStart(6)}`);
  console.log(`  notices returned          ${String(result.fetched).padStart(6)}`);
  console.log(`  distinct notices          ${String(result.matched).padStart(6)}`);
  console.log(`  written                   ${String(result.written).padStart(6)}`);

  for (const [signalClass, n] of Object.entries(result.byClass).sort()) {
    console.log(`    ${signalClass.padEnd(22)} ${String(n).padStart(6)}`);
  }

  if (result.skippedUnknownType > 0) {
    console.log(`  skipped, unknown type     ${String(result.skippedUnknownType).padStart(6)}`);
    console.log('    A notice type this build does not recognise. Worth a look rather than a guess.');
  }
  if (result.skippedNoNoticeId > 0) {
    console.log(`  skipped, no notice id     ${String(result.skippedNoNoticeId).padStart(6)}`);
  }

  if (result.run !== null) {
    console.log('');
    console.log(
      `  ${result.run.inserted} new, ${result.run.updated} changed, ${result.run.unchanged} unchanged.`,
    );
  }

  if (result.truncated) {
    console.log('');
    console.log('  Stopped at the request cap before every code was searched. This run is');
    console.log('  incomplete: raise --max-requests, or narrow the profile.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
