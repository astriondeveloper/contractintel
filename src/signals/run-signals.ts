/**
 * Signal detection entry point. Spec section 9.
 *
 *   npm run signals -- --dry-run          work it out, write nothing
 *   npm run signals                       detect and write
 *   npm run signals -- --min-value 1000000
 *   npm run signals -- --position prime_incumbent,subcontractor
 *
 * Safe to run repeatedly and meant to be: `signal_class_threshold.rhythm` says
 * `monthly` for the recompete window, so this is a scheduled job. Every generated
 * pursuit carries a `signal_key`, so a second run updates what the first one wrote
 * rather than adding to it, and a pursuit somebody created by hand is never touched.
 */
import { withTransaction, closePool } from '../db/index.js';
import { detectRecompetes, type AstrionPosition, type RecompeteOptions } from './recompete.js';

const POSITIONS: readonly AstrionPosition[] = ['prime_incumbent', 'subcontractor', 'none'];

function parseArgs(): RecompeteOptions & { help: boolean } {
  const argv = process.argv.slice(2);
  const options: { help: boolean; dryRun: boolean; minValueUsd?: number; positions?: AstrionPosition[] } = {
    help: argv.includes('--help') || argv.includes('-h'),
    dryRun: argv.includes('--dry-run'),
  };

  const valueAt = argv.indexOf('--min-value');
  if (valueAt !== -1) {
    const raw = Number(argv[valueAt + 1]);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('--min-value takes a non-negative number of dollars.');
    }
    options.minValueUsd = raw;
  }

  const positionAt = argv.indexOf('--position');
  if (positionAt !== -1) {
    const raw = (argv[positionAt + 1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    const bad = raw.filter((p) => !POSITIONS.includes(p as AstrionPosition));
    if (raw.length === 0 || bad.length > 0) {
      throw new Error(`--position takes a comma-separated list of: ${POSITIONS.join(', ')}`);
    }
    options.positions = raw as AstrionPosition[];
  }

  return options;
}

function usage(): void {
  console.log(`
Signal detection. Spec section 9.

  npm run signals -- [options]

  --dry-run              Report what would be written. Writes nothing.
  --min-value <usd>      Ignore contracts whose estimated value is below this.
                         A contract with no known value is never dropped by it:
                         blank is not zero.
  --position <list>      Comma-separated, from: ${POSITIONS.join(', ')}
                         Default: all three.
  --help                 This.

The window itself is not an option. It lives in signal_class_threshold, which BD Ops
owns per spec section 13, and it is seeded at 12 to 36 months from spec section 9.
`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  if (options.help) {
    usage();
    return;
  }

  const result = await withTransaction((client) => detectRecompetes(client, options));

  const mode = options.dryRun === true ? 'Dry run: nothing written.' : 'Written.';
  console.log('');
  console.log(`Recompete window: contracts ending ${result.horizonFrom} to ${result.horizonTo} months out.`);
  console.log('');
  console.log(`  candidates in the window       ${String(result.candidates).padStart(6)}`);
  console.log(`  signals                        ${String(result.written).padStart(6)}`);
  console.log(`    Astrion holds as prime       ${String(result.byPosition.prime_incumbent).padStart(6)}`);
  console.log(`    Astrion subs on              ${String(result.byPosition.subcontractor).padStart(6)}`);
  console.log(`    no Astrion position          ${String(result.byPosition.none).padStart(6)}`);

  if (result.skippedByPosition > 0) {
    console.log(`  skipped by --position          ${String(result.skippedByPosition).padStart(6)}`);
  }
  if (result.skippedBelowFloor > 0) {
    console.log(`  skipped below --min-value      ${String(result.skippedBelowFloor).padStart(6)}`);
  }

  if (result.run !== null) {
    console.log('');
    console.log(
      `  ${result.run.inserted} new, ${result.run.updated} changed, ${result.run.unchanged} unchanged.`,
    );
    if (result.run.unchanged === result.run.records && result.run.records > 0) {
      console.log('  Nothing changed since the last run, which is what a second run should say.');
    }
  }

  console.log('');
  console.log(mode);

  if (result.candidates === 0) {
    console.log('');
    console.log('No contract in the corpus ends inside the window. Either nothing is due, or');
    console.log('the FPDS corpus has not been loaded: npm run load -- --dir <directory>.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
