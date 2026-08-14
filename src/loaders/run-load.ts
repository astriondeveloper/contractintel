/**
 * One command for a whole folder of DACIS and FPDS exports.
 *
 *   npm run load -- --dir <directory>      load every .csv, each by its own shape
 *   npm run load -- <file> [<file> ...]    load specific files
 *   npm run load -- --dry-run --dir <dir>  classify every file and write nothing
 *   npm run load -- --role loss <file>     declare the Astrion role instead of inferring it
 *
 * Why this exists. Gavin runs the DACIS exports by hand, and the corpus arrives as a
 * folder of thirty-odd files in six different shapes with names that look alike. Asking a
 * person to sort them into the right loader is asking for a file to be loaded as the wrong
 * shape, or missed. This reads each file's header row, decides what it is, and routes it.
 * A shape with no loader is named and skipped, not attempted.
 *
 * Load order is not the order the files are listed. Customers load before programs because
 * program_customer matches against them, and programs load before contracts because
 * dacis_contract_program links to them. The router sorts by shape, so a single --dir run
 * produces the same result as loading the shapes in dependency order by hand.
 *
 * Spec decision D8: scheduled file drops, not ad hoc upload. This is the scheduled path,
 * and it is idempotent, so re-running it on the same folder changes nothing.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { withTransaction, closePool, query } from '../db/index.js';
import { EntityResolver } from '../resolve/entity-resolver.js';
import { loadFpdsFile } from './fpds.js';
import { loadSubcontractFile } from './subcontract.js';
import { loadDacisCustomers } from './dacis-customers.js';
import { loadDacisPrograms, type ProgramLifecycle } from './dacis-programs.js';
import { loadDacisContracts, inferRoleFromFileName, type AstrionRole } from './dacis-contracts.js';
// Shape classification lives in shape.ts, not here: this file calls main() at module
// load, so importing it for a helper would run a whole load.
import { classifyShape, inferLifecycle, readHeaders, LOAD_ORDER, SHAPE_LABEL, type Shape } from './shape.js';

interface Args {
  files: string[];
  dryRun: boolean;
  role?: AstrionRole;
  lifecycle?: ProgramLifecycle;
  limit?: number;
}

async function parseArgs(): Promise<Args> {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let dryRun = false;
  let role: AstrionRole | undefined;
  let lifecycle: ProgramLifecycle | undefined;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--role') {
      const value = argv[++i];
      if (value !== 'prime' && value !== 'out' && value !== 'sub' && value !== 'loss') {
        throw new Error('--role must be one of prime, out, sub, loss');
      }
      role = value;
    } else if (arg === '--lifecycle') {
      const value = argv[++i];
      if (value !== 'active' && value !== 'archived' && value !== 'pre_rfp') {
        throw new Error('--lifecycle must be one of active, archived, pre_rfp');
      }
      lifecycle = value;
    } else if (arg === '--limit') {
      limit = Number(argv[++i]);
      if (!Number.isFinite(limit)) throw new Error('--limit needs a number');
    } else if (arg === '--dir') {
      const dir = argv[++i];
      if (!dir) throw new Error('--dir needs a directory');
      for (const entry of (await readdir(dir)).sort()) {
        if (entry.toLowerCase().endsWith('.csv')) files.push(path.join(dir, entry));
      }
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0 && process.env.CIE_DROP_DIR) {
    try {
      for (const entry of (await readdir(process.env.CIE_DROP_DIR)).sort()) {
        if (entry.toLowerCase().endsWith('.csv')) files.push(path.join(process.env.CIE_DROP_DIR, entry));
      }
    } catch {
      // Handled below.
    }
  }

  return { files, dryRun, role, lifecycle, limit };
}

const money = (n: number): string =>
  (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

async function main(): Promise<void> {
  const args = await parseArgs();

  if (args.files.length === 0) {
    console.error(
      'No files to load.\n\n' +
        'Usage:\n' +
        '  npm run load -- --dir <directory>\n' +
        '  npm run load -- <file> [<file> ...]\n' +
        '  npm run load -- --dry-run --dir <directory>\n\n' +
        `CIE_DROP_DIR is ${process.env.CIE_DROP_DIR ?? 'not set'}.`,
    );
    process.exit(1);
  }

  // Classify everything before loading anything, so the plan is visible up front and a
  // misnamed or unrecognised file is known before any writing starts.
  const classified: Array<{ file: string; shape: Shape; headers: number }> = [];
  for (const file of args.files) {
    const headers = await readHeaders(file);
    classified.push({ file, shape: classifyShape(headers), headers: headers.length });
  }

  const byShape = new Map<Shape, string[]>();
  for (const { file, shape } of classified) {
    const list = byShape.get(shape) ?? [];
    list.push(file);
    byShape.set(shape, list);
  }

  console.log(`${args.files.length} file(s), classified by header row:\n`);
  for (const shape of [...LOAD_ORDER, 'dacis_company_profile' as Shape, 'unknown' as Shape]) {
    const list = byShape.get(shape);
    if (!list || list.length === 0) continue;
    console.log(`  ${SHAPE_LABEL[shape].padEnd(30)} ${String(list.length).padStart(3)} file(s)`);
  }

  const unloadable = [
    ...(byShape.get('dacis_company_profile') ?? []),
    ...(byShape.get('unknown') ?? []),
  ];
  if (unloadable.length > 0) {
    console.log(`\n${unloadable.length} file(s) have no loader and will be skipped:`);
    for (const file of unloadable) {
      const entry = classified.find((c) => c.file === file)!;
      console.log(`  ${path.basename(file).slice(0, 60).padEnd(62)} ${SHAPE_LABEL[entry.shape]}`);
    }
  }

  if (args.dryRun) {
    console.log('\n--dry-run: nothing was written.');
    return;
  }

  console.log('\nLoading in dependency order: customers, programs, FPDS, then contracts.\n');
  console.log('file'.padEnd(28) + '     records     new  changed    unchanged');
  console.log('-'.repeat(80));

  const totals = {
    customers: 0,
    programs: 0,
    programsTruncated: 0,
    participants: 0,
    participantsResolved: 0,
    contracts: 0,
    otherBidderRows: 0,
    otherBidders: 0,
    programsLinked: 0,
    programsNamedOnContracts: 0,
    contractCustomersMatched: 0,
    contractCustomersNamed: 0,
    sharedValues: 0,
    lossNamingAstrion: 0,
    fpdsRecords: 0,
    edges: 0,
    inferredRoles: 0,
  };
  const rolesSeen = new Map<AstrionRole, number>();

  for (const shape of LOAD_ORDER) {
    for (const file of byShape.get(shape) ?? []) {
      const fileName = path.basename(file);

      // One transaction per file, so a bad file rolls back alone.
      await withTransaction(async (client) => {
        const resolver = await EntityResolver.load(client);

        if (shape === 'dacis_customer') {
          const r = await loadDacisCustomers(client, file, { limit: args.limit });
          totals.customers += r.run.records;
          return;
        }

        if (shape === 'dacis_program') {
          const lifecycle = args.lifecycle ?? inferLifecycle(fileName);
          const r = await loadDacisPrograms(client, file, resolver, { lifecycle, limit: args.limit });
          totals.programs += r.run.records;
          totals.programsTruncated += r.truncatedLists;
          totals.participants += r.participantsSupplied;
          totals.participantsResolved += r.participantsResolved;
          return;
        }

        if (shape === 'fpds_transaction') {
          const r = await loadFpdsFile(client, file, resolver, { progressEvery: 10_000, limit: args.limit });
          if (r) totals.fpdsRecords += r.run.records;
          return;
        }

        if (shape === 'subcontract_edge') {
          const r = await loadSubcontractFile(client, file, resolver, {
            progressEvery: 5_000,
            limit: args.limit,
          });
          if (r) totals.edges += r.run.records;
          return;
        }

        // dacis_contract. The role is the one thing the header cannot supply.
        const inferred = inferRoleFromFileName(fileName);
        const role = args.role ?? inferred;
        if (role === null) {
          throw new Error(
            `${fileName}: cannot tell Astrion's role from the filename, and the role is not ` +
              'derivable from the rows -- on 31 of 40 loss rows no Astrion company is named ' +
              'anywhere. Re-run this file with --role prime|out|sub|loss.',
          );
        }
        const roleSource = args.role ? 'declared' : 'inferred_from_filename';
        if (roleSource === 'inferred_from_filename') totals.inferredRoles += 1;
        rolesSeen.set(role, (rolesSeen.get(role) ?? 0) + 1);

        const r = await loadDacisContracts(client, file, resolver, {
          role,
          roleSource,
          limit: args.limit,
        });
        totals.contracts += r.run.records;
        totals.otherBidderRows += r.rowsWithOtherBidders;
        totals.otherBidders += r.otherBiddersNamed;
        totals.programsNamedOnContracts += r.programsNamed;
        totals.programsLinked += r.programsLinked;
        totals.contractCustomersNamed += r.customersNamed;
        totals.contractCustomersMatched += r.customersMatched;
        totals.sharedValues += r.sharedValues;
        totals.lossNamingAstrion += r.lossNamingAstrionAsAwardee;
      });
    }
  }

  console.log('-'.repeat(80));

  if (totals.customers > 0) console.log(`\nCustomers: ${totals.customers} row(s).`);

  if (totals.programs > 0) {
    console.log(
      `\nPrograms: ${totals.programs} row(s), ${totals.participants} participant mention(s), ` +
        `${totals.participantsResolved} resolved to a known entity.`,
    );
    if (totals.programsTruncated > 0) {
      console.log(
        `  ${totals.programsTruncated} program(s) supplied exactly 500 participants, the export's ` +
          "documented cap.\n  Their participant counts are floors, not totals. participant_list_truncated " +
          'is set on those rows.',
      );
    }
  }

  if (totals.contracts > 0) {
    console.log(`\nDACIS contracts: ${totals.contracts} row(s).`);
    const roleList = [...rolesSeen].map(([r, n]) => `${r} (${n} file${n === 1 ? '' : 's'})`).join(', ');
    console.log(`  roles asserted: ${roleList}`);
    if (totals.inferredRoles > 0) {
      console.log(
        `  ${totals.inferredRoles} file(s) had the role read from the filename rather than declared. ` +
          'role_source records this.\n  Pass --role to declare it explicitly.',
      );
    }
    console.log(
      `  Other Bidders on ${totals.otherBidderRows} row(s), ${totals.otherBidders} company mention(s). ` +
        'Stored as evidence; nothing scores on it.',
    );
    console.log(
      `  Programs named on contracts: ${totals.programsNamedOnContracts}, of which ` +
        `${totals.programsLinked} matched a loaded program.`,
    );
    console.log(
      `  Customers named on contracts: ${totals.contractCustomersNamed}, of which ` +
        `${totals.contractCustomersMatched} matched customer_org.`,
    );
    if (totals.sharedValues > 0) {
      console.log(
        `  ${totals.sharedValues} contract(s) are marked 'Value is Shared'. Do not sum their values.`,
      );
    }
    if (totals.lossNamingAstrion > 0) {
      console.log(
        `  ${totals.lossNamingAstrion} row(s) asserted as a loss name an Astrion company as an ` +
          'awardee.\n  Contradictory, and surfaced rather than resolved: select * from ' +
          'dacis_contract_role_conflict;',
      );
    }
  }

  const lostPrimeWonSub = await query<{ n: string }>(
    'select count(*)::text as n from dacis_contract_lost_prime_won_sub',
  );
  if (Number(lostPrimeWonSub[0]!.n) > 0) {
    console.log(
      `\n${lostPrimeWonSub[0]!.n} contract(s) were lost as prime and are held as a subcontract. ` +
        'Astrion is already\n  inside the winning team on those, so they are recompete candidates ' +
        'rather than errors:\n    select * from dacis_contract_lost_prime_won_sub order by end_date;',
    );
  }

  const conflicts = await query<{ n: string }>(
    'select count(*)::text as n from dacis_contract_role_conflict',
  );
  if (Number(conflicts[0]!.n) > 0) {
    console.log(
      `\n${conflicts[0]!.n} contract(s) are asserted as both held and lost, which cannot both be ` +
        'true.\n  Only the person who ran the export knows which is right:\n' +
        '    select * from dacis_contract_role_conflict;',
    );
  }

  const unplaced = await query<{ n: string }>(
    'select count(*)::text as n from subcontract_edge_unplaced',
  );
  const totalValue = await query<{ v: string | null }>(
    'select sum(value_usd)::text as v from dacis_contract where coalesce(value_is_shared, false) = false',
  );
  if (Number(totalValue[0]!.v ?? 0) > 0) {
    console.log(
      `\nDACIS contract value, excluding shared-value rows: ${money(Number(totalValue[0]!.v))}.`,
    );
  }
  if (Number(unplaced[0]!.n) > 0) {
    console.log(`${unplaced[0]!.n} subcontract edge(s) could not be placed: subcontract_edge_unplaced.`);
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(`\nLoad failed: ${error instanceof Error ? error.message : String(error)}`);
    await closePool();
    process.exit(1);
  });
