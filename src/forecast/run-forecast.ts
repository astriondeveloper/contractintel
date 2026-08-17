/**
 * Forecast entry point.
 *
 *   npm run forecast -- --dry-run           work it out, write nothing
 *   npm run forecast                        project and write
 *   npm run forecast -- --horizon 24        24 months of quarters instead of 36
 *   npm run forecast -- --min-value 1000000
 *   npm run forecast -- --contracts-only    skip the expiring vehicles
 *   npm run forecast -- --as-of 2024-01-01  project as if it were then
 *
 * Safe to run repeatedly and meant to be. Every row carries a `forecast_key`, so a second run
 * updates what the first wrote, and anything this run would no longer project is deleted:
 * a forecast is wholly derived and a stale projection is worse than a missing one, because it
 * reads as current.
 *
 * The summary prints where the lead times came from, and that line is the one to read. A run
 * whose projections all rest on the default lead time is arithmetic on an assumption; the same
 * run after `npm run load:sam` has been going for a few months will start reporting measured
 * lags, and the forecast gets better without the code changing.
 */
import { withTransaction, closePool } from '../db/index.js';
import { buildForecast, DEFAULT_HORIZON_MONTHS, type ForecastOptions } from './forecast.js';

interface Args extends ForecastOptions {
  readonly help: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const options: {
    help: boolean;
    dryRun: boolean;
    contractsOnly: boolean;
    horizonMonths?: number;
    minValueUsd?: number;
    asOf?: Date;
  } = {
    help: argv.includes('--help') || argv.includes('-h'),
    dryRun: argv.includes('--dry-run'),
    contractsOnly: argv.includes('--contracts-only'),
  };

  const horizonAt = argv.indexOf('--horizon');
  if (horizonAt !== -1) {
    const raw = Number(argv[horizonAt + 1]);
    if (!Number.isInteger(raw) || raw < 1 || raw > 120) {
      throw new Error('--horizon takes a whole number of months between 1 and 120.');
    }
    options.horizonMonths = raw;
  }

  const valueAt = argv.indexOf('--min-value');
  if (valueAt !== -1) {
    const raw = Number(argv[valueAt + 1]);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('--min-value takes a non-negative number of dollars.');
    }
    options.minValueUsd = raw;
  }

  const asOfAt = argv.indexOf('--as-of');
  if (asOfAt !== -1) {
    const raw = (argv[asOfAt + 1] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('--as-of takes a date as YYYY-MM-DD.');
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`--as-of ${raw} is not a date.`);
    options.asOf = parsed;
  }

  return options;
}

function usage(): void {
  console.log(`
Forecast: what will solicit, and roughly when.

  npm run forecast -- [options]

  --dry-run              Report what would be written. Writes nothing.
  --horizon <months>     How far out to project. Default ${DEFAULT_HORIZON_MONTHS}.
  --min-value <usd>      Ignore contracts whose known value is below this. A contract
                         with no recorded value is never dropped by it: blank is not zero.
  --contracts-only       Skip the expiring vehicles. A vehicle ending is an on-ramp
                         opportunity and is projected by default.
  --as-of <YYYY-MM-DD>   Project as if it were this date, using only actions signed by
                         then. For inspecting what the forecast would have said; use
                         npm run forecast:backtest to score it.
  --help                 This.

The projection is: period end date minus a lead time. The lead time is measured from this
office's own notice-to-award history where there is enough of it, inferred from its observed
recompete rhythm where there is not, and assumed at 365 days where there is neither. Every
row records which of the three it used, and the screen shows it.
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }

  const result = await withTransaction((client) => buildForecast(client, options));

  const pad = (n: number) => String(n).padStart(6);

  console.log('');
  console.log(`Forecast as of ${result.asOf}, ${result.horizonMonths} months out.`);
  console.log('');
  console.log(`  candidates considered          ${pad(result.candidates)}`);
  console.log(`  projections                    ${pad(result.written)}`);
  console.log(`    from a contract ending       ${pad(result.byBasis.contract_end)}`);
  console.log(`    from a vehicle expiring      ${pad(result.byBasis.vehicle_expiry)}`);
  console.log('');
  console.log(`  high confidence                ${pad(result.byConfidence.high)}`);
  console.log(`  medium confidence              ${pad(result.byConfidence.medium)}`);
  console.log(`  low confidence                 ${pad(result.byConfidence.low)}`);
  console.log('');
  console.log('  lead time drawn from');
  console.log(`    a measured notice lag        ${pad(result.byLeadSource['observed_notice_lag'] ?? 0)}`);
  console.log(`    an observed office cadence   ${pad(result.byLeadSource['office_cadence'] ?? 0)}`);
  console.log(`    the 365-day default          ${pad(result.byLeadSource['default'] ?? 0)}`);

  if (result.skippedOutsideWindow > 0) {
    console.log('');
    console.log(`  outside the projection window  ${pad(result.skippedOutsideWindow)}`);
  }
  if (result.skippedBelowFloor > 0) {
    console.log(`  below --min-value              ${pad(result.skippedBelowFloor)}`);
  }
  if (result.pruned > 0) {
    console.log(`  pruned, no longer projected    ${pad(result.pruned)}`);
  }

  if (result.run !== null) {
    console.log('');
    console.log(
      `  ${result.run.inserted} new, ${result.run.updated} changed, ${result.run.unchanged} unchanged.`,
    );
  }

  console.log('');
  console.log(options.dryRun === true ? 'Dry run: nothing written.' : 'Written.');

  if (result.written === 0) {
    console.log('');
    console.log('Nothing to project. Either no contract in the corpus ends inside the window, or');
    console.log('the FPDS corpus has not been loaded: npm run load -- --dir <directory>.');
  } else if ((result.byLeadSource['default'] ?? 0) === result.written) {
    console.log('');
    console.log('Every lead time here is the default. That is the expected state before SAM.gov');
    console.log('has been running long enough to measure a notice-to-award lag and before the');
    console.log('corpus goes back far enough to show an office re-letting the same work three');
    console.log('times. The dates are arithmetic on an assumption until then, and every row says so.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
