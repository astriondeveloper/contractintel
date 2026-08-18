/**
 * Screen a company against the federal exclusion list, and read its SAM.gov registration.
 *
 *   npm run screen -- ZQF7MRQR4KL5          by UEI: exclusions and the registration
 *   npm run screen -- 1ABC2                 by CAGE code
 *   npm run screen -- "Example Systems"     by name
 *   npm run screen -- --find "Example"      candidate entities for a name, with their UEIs
 *   npm run screen -- ZQF7MRQR4KL5 --refresh   ignore the cache
 *
 * Two requests at most, and none when the answer is already cached. This is the on-demand half of
 * the GovCon integration: nothing here runs on a schedule, because screening every company in the
 * corpus would spend the hourly allowance answering questions nobody asked.
 *
 * It makes no determination. A name match on the exclusion list is frequently a different company
 * with a similar name, and "no match" is not a clearance. The caveats printed with every result say
 * so, and they are not optional decoration.
 */
import { withTransaction, closePool } from '../../db/index.js';
import { screen, findEntities } from './screening.js';

function usage(): void {
  console.log(`
Screen a company: is it excluded, and what does SAM.gov say about it.

  npm run screen -- <uei | cage | name> [--refresh]
  npm run screen -- --find "<name>"

  --find <name>   Candidate entities for a name, with their UEIs. Use this first when the UEI is
                  not known: an exclusions check keyed on a UEI is worth far more than one keyed
                  on a name, because names collide and UEIs do not.
  --refresh       Go to the API even if a fresh answer is cached.
  --help          This.

A UEI is twelve alphanumeric characters and a CAGE code is five; anything else is treated as a name.
Exclusion answers are cached for a day and registrations for a week, so repeating a lookup is free.
`);
}

function fmtDate(value: Date | null): string {
  return value === null ? 'indefinite' : value.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }

  const findAt = argv.indexOf('--find');
  if (findAt !== -1) {
    const name = argv[findAt + 1];
    if (name === undefined) throw new Error('--find takes a name.');
    const { candidates, requests } = await findEntities(name);
    console.log('');
    if (candidates.length === 0) {
      console.log(`  Nothing matched "${name}". A registration is filed under a legal name, which is`);
      console.log('  often not the name a company trades under.');
    } else {
      for (const candidate of candidates) {
        const uei = candidate.uei ?? 'no uei';
        const legal = candidate.legal_business_name ?? candidate.legal_name ?? candidate.name ?? 'unnamed';
        const status = candidate.registration_status ?? candidate.status ?? 'status not reported';
        console.log(`  ${uei.padEnd(14)} ${legal}`);
        console.log(`  ${''.padEnd(14)} ${status}${candidate.physical_state ?? candidate.state ? ` · ${candidate.physical_state ?? candidate.state}` : ''}`);
      }
      console.log('');
      console.log(`  ${candidates.length} candidate(s), ${requests} request(s). Screen one by its UEI.`);
    }
    console.log('');
    return;
  }

  const query = argv.find((arg) => !arg.startsWith('--'));
  if (query === undefined) throw new Error('Pass a UEI, a CAGE code or a company name.');

  const result = await withTransaction((client) =>
    screen(client, query, { refresh: argv.includes('--refresh') }),
  );

  console.log('');
  console.log(`  ${result.query}`);
  console.log(
    `  ${result.cached ? 'from the cache' : `${result.requests} request(s)`}` +
      (result.fetchedAt === null ? '' : `, as of ${result.fetchedAt.toISOString().slice(0, 16)}Z`),
  );

  console.log('');
  if (result.entity === null) {
    console.log('  registration    not found');
  } else {
    console.log(`  registration    ${result.entity.registration_status ?? 'not reported'}`);
    console.log(`  legal name      ${result.entity.legal_name ?? 'not recorded'}`);
    if (result.entity.dba_name !== null) console.log(`  dba             ${result.entity.dba_name}`);
    console.log(`  cage            ${result.entity.cage_code ?? 'not recorded'}`);
    console.log(`  expires         ${fmtDate(result.entity.registration_expires_on)}`);
    const place = [result.entity.physical_city, result.entity.physical_state].filter(Boolean).join(', ');
    if (place !== '') console.log(`  location        ${place}`);
  }

  console.log('');
  if (result.exclusions.length === 0) {
    console.log('  exclusions      none in force matched this query');
  } else {
    console.log(`  exclusions      ${result.exclusions.length} in force`);
    for (const exclusion of result.exclusions) {
      console.log('');
      console.log(`    ${exclusion.excluded_name}`);
      console.log(`    ${exclusion.classification ?? 'classification not reported'}`);
      console.log(`    ${exclusion.excluding_agency ?? 'excluding agency not reported'}`);
      console.log(`    active ${fmtDate(exclusion.active_date)} to ${fmtDate(exclusion.termination_date)}`);
      if (exclusion.uei !== null) console.log(`    uei ${exclusion.uei}`);
    }
  }

  console.log('');
  for (const caveat of result.caveats) {
    console.log(`  ! ${caveat}`);
  }
  console.log('');
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
