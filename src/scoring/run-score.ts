/**
 * Scoring entry point. Spec section 10.
 *
 *   npm run score -- --dry-run          evaluate and report, write nothing
 *   npm run score                       assess every open pursuit
 *   npm run score -- --class recompete_window
 *   npm run score -- --pursuit 1234
 *
 * Safe to run repeatedly. One assessment is kept per pursuit per score model version, so a
 * re-run replaces the current one; changing a weight makes a new model version and the old
 * assessment survives exactly as it was computed.
 *
 * A pursuit already won, lost or dropped is not re-assessed. Scoring a decided pursuit
 * would be arguing with a decision that has already been made.
 */
import { withTransaction, closePool } from '../db/index.js';
import { scorePursuits } from './engine.js';
import { MIN_COVERAGE } from './model.js';

const BAND_ORDER = ['pursue', 'review', 'pass', 'blocked', 'insufficient_evidence'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
Scoring. Spec section 10.

  npm run score -- [options]

  --dry-run           Evaluate and report. Writes nothing.
  --class <name>      Only this signal class.
  --pursuit <id>      Only this pursuit.
  --limit <n>         Stop after n pursuits.
  --help              This.

Weights are rows in score_model_factor, not constants. Change one by inserting a new
score model version; every assessment pins the version it was computed under, so a past
score never moves.
`);
    return;
  }

  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };

  const result = await withTransaction((client) =>
    scorePursuits(client, {
      dryRun: argv.includes('--dry-run'),
      signalClass: value('--class'),
      pursuitId: value('--pursuit'),
      limit: value('--limit') === undefined ? undefined : Number(value('--limit')),
      onProgress: (message) => console.log(message),
    }),
  );

  console.log('');
  console.log(`Score model version ${result.scoreModelVersion}, taxonomy version ${result.taxonomyVersion}.`);
  console.log('');
  console.log(`  pursuits assessed        ${String(result.assessed).padStart(6)}`);

  for (const band of BAND_ORDER) {
    const n = result.byBand[band] ?? 0;
    if (n > 0) console.log(`    ${band.padEnd(22)} ${String(n).padStart(6)}`);
  }

  if (Object.keys(result.blockedBy).length > 0) {
    console.log('');
    console.log('  blocked by a hard gate:');
    for (const [gate, n] of Object.entries(result.blockedBy).sort()) {
      console.log(`    ${gate.padEnd(22)} ${String(n).padStart(6)}`);
    }
  }

  if (result.meanCoverage !== null) {
    console.log('');
    console.log(`  mean coverage            ${(result.meanCoverage * 100).toFixed(1)}%`);
    console.log(
      `  Below ${(MIN_COVERAGE * 100).toFixed(0)}% a pursuit gets no rank at all: too much of the model was unanswerable.`,
    );
  }

  const insufficient = result.byBand.insufficient_evidence ?? 0;
  if (insufficient > 0) {
    console.log('');
    console.log(`  ${insufficient} pursuit(s) carry no rank, which is a statement about the data`);
    console.log('  rather than about the opportunity. Either a mandatory factor could not be');
    console.log('  answered, or coverage fell below the floor. /pursuits shows which.');
  }

  if (argv.includes('--dry-run')) {
    console.log('');
    console.log('Dry run: nothing written.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
