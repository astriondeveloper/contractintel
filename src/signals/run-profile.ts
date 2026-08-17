/**
 * Build the opportunity profile: the codes worth searching SAM.gov for.
 *
 *   npm run profile -- --dry-run     report the current profile, change nothing
 *   npm run profile                  rebuild from the taxonomy and the corpus
 *   npm run profile -- --min 10      raise the observed-evidence floor
 *
 * Run it after loading a corpus and after the taxonomy changes. It is idempotent: a code
 * already on the profile is refreshed, and a row BD Ops turned off stays off, because
 * `active` is theirs and the builder never sets it.
 */
import { withTransaction, closePool, query } from '../db/index.js';
import { buildProfile, MIN_OBSERVED_ACTIONS } from './profile.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const taxonomyOnly = argv.includes('--taxonomy-only');

  const minAt = argv.indexOf('--min');
  const minObservedActions = minAt === -1 ? MIN_OBSERVED_ACTIONS : Number(argv[minAt + 1]);
  if (!Number.isFinite(minObservedActions) || minObservedActions < 1) {
    throw new Error('--min takes a positive number of contract actions.');
  }

  const result = await withTransaction((client) =>
    buildProfile(client, { dryRun, taxonomyOnly, minObservedActions }),
  );

  console.log('');
  console.log('Opportunity profile');
  console.log('='.repeat(60));
  console.log('  type        origin      codes');
  for (const row of result.counts) {
    console.log(`  ${row.code_type.padEnd(11)} ${row.origin.padEnd(11)} ${String(row.n).padStart(5)}`);
  }
  console.log('-'.repeat(60));

  // Only NAICS and PSC are SAM.gov search parameters (`ncode` and `ccode`). Agency and
  // set-aside are carried for a different job: they feed the score model's gates, where a
  // set-aside the company does not hold makes a notice ineligible rather than low scoring.
  // Reporting one total for both would overstate how much searching this profile causes.
  const searchable = result.counts
    .filter((c) => c.code_type === 'naics' || c.code_type === 'psc')
    .reduce((sum, c) => sum + c.n, 0);
  const distinctSearchable = await query<{ n: string }>(
    `select count(*)::text as n from opportunity_profile_effective
      where code_type in ('naics', 'psc')`,
  );

  console.log(`  ${distinctSearchable[0]!.n} distinct code(s) drive the SAM.gov search`);
  console.log(`  (${searchable} profile row(s) across origins; one request per code per run).`);
  console.log(`  ${result.effective - Number(distinctSearchable[0]!.n)} more are gate input rather than search terms.`);

  if (result.total === 0) {
    console.log('');
    console.log('Nothing on the profile. The taxonomy crosswalks come from');
    console.log('capability_taxonomy_seed.csv, so run npm run seed first. The observed side');
    console.log('needs a loaded FPDS corpus.');
  }

  // Unconfirmed is the expected state on a fresh build, and saying so here saves the next
  // person working out whether it is a fault. Spec section 20.
  const unconfirmed = await query<{ n: string }>(
    'select count(*)::text as n from opportunity_profile where active and confirmed_at is null',
  );
  if (Number(unconfirmed[0]?.n ?? 0) > 0) {
    console.log('');
    console.log(`  ${unconfirmed[0]!.n} row(s) are unconfirmed, which is expected on a fresh build.`);
    console.log('  BD Ops confirms a profile row the same way they confirm a taxonomy node.');
  }

  if (dryRun) {
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
