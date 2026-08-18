/**
 * One notice is one requirement, whichever API delivered it.
 *
 *   npm run check:convergence
 *
 * Two loaders write notices — `load:sam` against api.sam.gov and `load:govcon` against GovCon API's
 * delta endpoint — and they deliberately key on the same `signal_key`, because a notice is a SAM.gov
 * notice whichever door it came through. That is the whole non-redundancy design (decision D25), and
 * it fails silently: a second write path would show a person the same requirement twice in their feed
 * and nothing would error.
 *
 * `tests/govcon.test.ts` asserts the convergence with an injected transport. This asserts it against
 * whatever is actually in the database after the loaders have run over real HTTP, which is the claim
 * that matters and the one an injected fetch cannot make.
 *
 * Three checks, and the third is the one that stops this becoming decoration:
 *
 *   1. No notice id appears on more than one pursuit.
 *   2. No loader outside src/loaders/notice.ts writes pursuit directly.
 *   3. At least one notice was in fact delivered by more than one source system.
 *
 * Without the third, a run where the two sources happened not to overlap passes without having
 * tested anything. CI arranges the overlap by having both stubs serve one notice id in common.
 *
 * Exits non-zero on a failure and says which check failed and what to do about it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../src/db/index.js';

/** The one file allowed to write `pursuit` from a loader. */
const WRITE_PATH = join('src', 'loaders', 'notice.ts');

function tsFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const notes: string[] = [];
  const client = await pool.connect();

  try {
    // 1. The duplicate a second write path would produce.
    const { rows: dupes } = await client.query<{ notice_id: string; n: string }>(
      `select notice_id, count(*)::text as n
         from pursuit
        where notice_id is not null
        group by notice_id
       having count(*) > 1
        order by count(*) desc, notice_id
        limit 10`,
    );

    if (dupes.length > 0) {
      failures.push(
        `${dupes.length} notice id(s) appear on more than one pursuit. A notice must converge on one ` +
          'row whichever loader delivered it; two rows means a loader is not going through ' +
          `writeNotice in ${WRITE_PATH}. First few: ` +
          dupes.map((d) => `${d.notice_id} (${d.n})`).join(', '),
      );
    } else {
      notes.push('No notice id appears on more than one pursuit.');
    }

    // 3. And the overlap actually happened, so check 1 was answering a real question.
    const { rows: converged } = await client.query<{ notice_id: string; apis: string; systems: string }>(
      `select p.notice_id,
              count(distinct v.source_system)::text            as apis,
              string_agg(distinct v.source_system, ', ')       as systems
         from pursuit p
         join source_version v on v.source_record_id = p.notice_id
        where p.notice_id is not null
        group by p.notice_id
       having count(distinct v.source_system) > 1
        order by p.notice_id
        limit 5`,
    );

    if (converged.length === 0) {
      failures.push(
        'No notice was delivered by more than one source system, so the convergence was never ' +
          'exercised and check 1 passed without testing anything. Run both loaders over a notice id ' +
          'they share — CI arranges this by having scripts/sam-stub.ts and scripts/govcon-stub.ts ' +
          'both serve ZSTUB0000000000000000000000000001.',
      );
    } else {
      for (const row of converged) {
        notes.push(`${row.notice_id} arrived from ${row.apis} source systems (${row.systems}) and is one pursuit.`);
      }
    }
  } finally {
    client.release();
  }

  // 2. The structural guarantee, checked in the source rather than in the data, because this is the
  // change somebody would make and the data would only show it once the two sources overlapped.
  const offenders = tsFilesUnder(join('src', 'loaders'))
    .filter((path) => path !== WRITE_PATH)
    .filter((path) => /insert\s+into\s+pursuit\b/i.test(readFileSync(path, 'utf8')));

  if (offenders.length > 0) {
    failures.push(
      `${offenders.join(', ')} write(s) pursuit directly. Route it through writeNotice in ` +
        `${WRITE_PATH} instead: the convergence only holds while there is one write path.`,
    );
  } else {
    notes.push(`Every loader writes pursuit through ${WRITE_PATH} and nowhere else.`);
  }

  console.log('');
  for (const note of notes) console.log(`  ok    ${note}`);
  for (const failure of failures) console.log(`  FAIL  ${failure}`);
  console.log('');

  if (failures.length > 0) {
    console.log(`  ${failures.length} of 3 checks failed.`);
    process.exitCode = 1;
  } else {
    console.log('  One notice is one requirement, whichever API delivered it.');
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
