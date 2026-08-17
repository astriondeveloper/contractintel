/**
 * Forecast backtest entry point.
 *
 *   npm run forecast:backtest -- --as-of 2022-10-01
 *   npm run forecast:backtest -- --as-of 2022-10-01 --horizon 24 --tolerance 180
 *   npm run forecast:backtest -- --sweep 2020,2021,2022,2023
 *   npm run forecast:backtest -- --as-of 2022-10-01 --dry-run
 *
 * This is the answer to "how much should I believe the forecast screen". It recomputes the
 * projection as it would have stood on a past date, using only actions signed by then, and
 * scores it against what the corpus says happened next.
 *
 * Read the by-band lines first. The confidence bands make a falsifiable claim about
 * themselves: high should beat low. If they come out level, the banding is decoration and the
 * honest response is to say so on the screen rather than keep three colours of chip.
 *
 * `--sweep` runs several as-of dates in one go, because one run is an anecdote. A method that
 * scores well in 2022 and badly in 2020 has found something about 2022.
 */
import { withTransaction, closePool } from '../db/index.js';
import { DEFAULT_HORIZON_MONTHS } from './forecast.js';
import { runBacktest, DEFAULT_TOLERANCE_DAYS, type BacktestResult } from './backtest.js';

interface Args {
  readonly help: boolean;
  readonly asOfDates: readonly Date[];
  readonly horizonMonths?: number;
  readonly toleranceDays?: number;
  readonly minValueUsd?: number;
  readonly dryRun: boolean;
}

function parseDate(raw: string): Date {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a date. Use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`"${trimmed}" is not a date.`);
  return parsed;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const help = argv.includes('--help') || argv.includes('-h');
  const dryRun = argv.includes('--dry-run');

  const asOfDates: Date[] = [];

  const asOfAt = argv.indexOf('--as-of');
  if (asOfAt !== -1) asOfDates.push(parseDate(argv[asOfAt + 1] ?? ''));

  const sweepAt = argv.indexOf('--sweep');
  if (sweepAt !== -1) {
    const raw = (argv[sweepAt + 1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    if (raw.length === 0) {
      throw new Error('--sweep takes a comma-separated list of dates or fiscal years.');
    }
    for (const item of raw) {
      // A bare year is read as the start of that federal fiscal year, which is the natural
      // thing to type and the natural place to stand when asking what the year would bring.
      asOfDates.push(/^\d{4}$/.test(item) ? parseDate(`${Number(item) - 1}-10-01`) : parseDate(item));
    }
  }

  const options: {
    help: boolean;
    asOfDates: Date[];
    dryRun: boolean;
    horizonMonths?: number;
    toleranceDays?: number;
    minValueUsd?: number;
  } = { help, asOfDates, dryRun };

  const horizonAt = argv.indexOf('--horizon');
  if (horizonAt !== -1) {
    const raw = Number(argv[horizonAt + 1]);
    if (!Number.isInteger(raw) || raw < 1 || raw > 120) {
      throw new Error('--horizon takes a whole number of months between 1 and 120.');
    }
    options.horizonMonths = raw;
  }

  const toleranceAt = argv.indexOf('--tolerance');
  if (toleranceAt !== -1) {
    const raw = Number(argv[toleranceAt + 1]);
    if (!Number.isInteger(raw) || raw < 0 || raw > 1095) {
      throw new Error('--tolerance takes a whole number of days between 0 and 1095.');
    }
    options.toleranceDays = raw;
  }

  const valueAt = argv.indexOf('--min-value');
  if (valueAt !== -1) {
    const raw = Number(argv[valueAt + 1]);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('--min-value takes a non-negative number of dollars.');
    }
    options.minValueUsd = raw;
  }

  return options;
}

function usage(): void {
  console.log(`
Forecast backtest: score the projection against what actually happened.

  npm run forecast:backtest -- [options]

  --as-of <YYYY-MM-DD>   Recompute the forecast as if it were this date. Required, unless
                         --sweep is given.
  --sweep <list>         Several as-of dates in one go. A bare year means the start of that
                         federal fiscal year, so --sweep 2021,2022,2023 stands at
                         1 October 2020, 2021 and 2022.
  --horizon <months>     How far past the as-of date to score. Default ${DEFAULT_HORIZON_MONTHS}.
  --tolerance <days>     How far a follow-on award can land from the projected period end
                         and still count as a hit. Default ${DEFAULT_TOLERANCE_DAYS}.
  --min-value <usd>      Score only contracts above this known value.
  --dry-run              Report, write no backtest row.
  --help                 This.

Only the contract-end basis is scored. A vehicle expiry projects an on-ramp competition, and
a replacement vehicle does not appear in FPDS as a follow-on to the old one, so there is
nothing to score it against.
`);
}

function report(result: BacktestResult): void {
  const pad = (n: number) => String(n).padStart(6);
  const rate = (hits: number, projected: number) =>
    projected === 0 ? '     —' : `${((hits / projected) * 100).toFixed(1).padStart(5)}%`;

  console.log('');
  console.log(
    `As of ${result.asOf}, ${result.horizonMonths} months out, ` +
      `${result.toleranceDays}-day tolerance.`,
  );
  console.log('');
  console.log(`  projections scored             ${pad(result.projected)}`);
  console.log(`    hit                          ${pad(result.hits)}   ${rate(result.hits, result.projected)}`);
  console.log(`    missed                       ${pad(result.misses)}`);
  console.log(`  not yet resolved, excluded     ${pad(result.unresolved)}`);
  console.log(`  recompetes not projected       ${pad(result.unforecast)}`);

  console.log('');
  console.log('  by confidence band');
  for (const band of ['high', 'medium', 'low'] as const) {
    const { projected, hits } = result.byConfidence[band];
    console.log(
      `    ${band.padEnd(28)} ${pad(projected)}   ${rate(hits, projected)}`,
    );
  }

  if (result.medianDaysOff !== null) {
    console.log('');
    console.log(`  median error on a hit          ${pad(result.medianDaysOff)} days`);
  }

  const high = result.byConfidence.high;
  const low = result.byConfidence.low;
  if (high.projected >= 5 && low.projected >= 5) {
    const highRate = high.hits / high.projected;
    const lowRate = low.hits / low.projected;
    console.log('');
    if (highRate > lowRate + 0.1) {
      console.log('  The bands separate: high beats low by more than ten points, so the confidence');
      console.log('  chip on the forecast screen is carrying information.');
    } else {
      console.log('  The bands do not separate on this run. If that holds across a sweep, the');
      console.log('  confidence chip is decoration and the screen should stop implying otherwise.');
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }

  if (options.asOfDates.length === 0) {
    usage();
    throw new Error('Give --as-of a date, or --sweep a list of them.');
  }

  const results: BacktestResult[] = [];
  for (const asOf of options.asOfDates) {
    const result = await withTransaction((client) =>
      runBacktest(client, {
        asOf,
        horizonMonths: options.horizonMonths,
        toleranceDays: options.toleranceDays,
        minValueUsd: options.minValueUsd,
        dryRun: options.dryRun,
      }),
    );
    results.push(result);
    report(result);
  }

  if (results.length > 1) {
    const totalProjected = results.reduce((sum, r) => sum + r.projected, 0);
    const totalHits = results.reduce((sum, r) => sum + r.hits, 0);
    console.log('');
    console.log('Across the sweep:');
    console.log(
      `  ${totalHits} of ${totalProjected} projections hit` +
        (totalProjected === 0 ? '.' : ` (${((totalHits / totalProjected) * 100).toFixed(1)}%).`),
    );
  }

  console.log('');
  console.log(results[0]!.method);
  console.log('');
  console.log(options.dryRun ? 'Dry run: no backtest row written.' : 'Written to forecast_backtest.');

  if (results.every((r) => r.projected === 0)) {
    console.log('');
    console.log('Nothing was scored. Either the corpus does not reach back to the as-of date, or');
    console.log('every projection is still unresolved. A backtest needs history on both sides of');
    console.log('the as-of date: contracts that had already been awarded, and follow-ons that have');
    console.log('since happened.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
