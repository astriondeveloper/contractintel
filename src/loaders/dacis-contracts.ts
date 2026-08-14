/**
 * DACIS contract record loader. The 20-column export shape.
 *
 * Four exports share it and assert different roles for Astrion:
 *
 *   companies_contracts-prime   234 rows   prime
 *   companies_contracts-out      19 rows   out
 *   companies_subcontracts      141 rows   sub
 *   companies_contractslosses    40 rows   loss
 *
 * 434 rows, 213 distinct contracts. 18 contracts appear under more than one role, so role
 * is stored in dacis_contract_role rather than on the contract.
 *
 * ---------------------------------------------------------------------------
 * The role must be told to the loader, not inferred from the row
 * ---------------------------------------------------------------------------
 * The subcontract edge loader deliberately stores no direction, because each row names its
 * own prime and sub. This shape is the opposite, and the difference was measured rather
 * than assumed:
 *
 *   role     rows   Astrion in 'Companies'   Astrion in 'Other Bidders'   neither
 *   prime     234                      234                            2         0
 *   out        19                       19                            0         0
 *   subs      141                       11                            2       128
 *   losses     40                        2                            8        31
 *
 * A prime row always names Astrion, so it is self-describing. A subcontract row usually
 * names it nowhere: the row describes the prime contract and Astrion's involvement is
 * carried only by which export produced it. A loss row names it nowhere on 31 of 40. So the
 * export is the only carrier of the role for two of the four, and guessing would invent
 * facts. `role_source` records whether a human declared the role or the filename was read.
 *
 * The two loss rows that do name an Astrion company under 'Companies' are contradictions --
 * a company does not win and lose the same contract -- and reach
 * dacis_contract_role_conflict rather than being quietly reconciled.
 *
 * ---------------------------------------------------------------------------
 * Other Bidders
 * ---------------------------------------------------------------------------
 * Populated on 26 of 434 rows, naming 18 distinct companies. It is the only place in the
 * corpus that names who else bid, so it is stored in full as evidence. Nothing scores on
 * it: at 6 percent coverage a factor derived from it would rank on whether Deltek happened
 * to record the bidders rather than on anything about the competition.
 */
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, normalizeName } from '../lib/normalize.js';
import type { EntityResolver } from '../resolve/entity-resolver.js';
import {
  dacisRecordId,
  parseParties,
  parseYesNo,
  parseMillionsToUsd,
  parseDacisDate,
} from './dacis-common.js';
import { loadCustomerIndex, matchCustomer, type CustomerIndex } from './dacis-programs.js';

export const CONTRACT_SOURCE_SYSTEM = 'dacis_contract';

export const CONTRACT_REQUIRED_HEADERS = ['Contract #', 'Companies', 'Value ($M)'];

export type AstrionRole = 'prime' | 'out' | 'sub' | 'loss';
export type RoleSource = 'declared' | 'inferred_from_filename';

export interface LoadContractsOptions {
  role: AstrionRole;
  roleSource: RoleSource;
  limit?: number;
}

export interface LoadContractsResult {
  run: RunHandle;
  role: AstrionRole;
  roleSource: RoleSource;
  contracts: number;
  awardeesNamed: number;
  awardeesResolved: number;
  otherBiddersNamed: number;
  otherBiddersResolved: number;
  rowsWithOtherBidders: number;
  programsNamed: number;
  programsLinked: number;
  customersNamed: number;
  customersMatched: number;
  blankValues: number;
  sharedValues: number;
  skippedUnkeyable: number;
  /** Rows asserted as a loss that nonetheless name an Astrion company as an awardee. */
  lossNamingAstrionAsAwardee: number;
}

/** Program name lookup, so a contract's Programs column can be joined to loaded programs. */
async function loadProgramIndex(client: PoolClient): Promise<Map<string, number>> {
  const { rows } = await client.query<{ program_id: string; name_normalized: string | null }>(
    'select program_id, name_normalized from program',
  );
  const index = new Map<string, number>();
  for (const row of rows) {
    if (row.name_normalized && !index.has(row.name_normalized)) {
      index.set(row.name_normalized, Number(row.program_id));
    }
  }
  return index;
}

async function astrionEntityIds(client: PoolClient): Promise<Set<number>> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select entity_id from entity
      where entity_type = 'astrion_family'
         or ultimate_parent_id in (select entity_id from entity where entity_type = 'astrion_family')`,
  );
  return new Set(rows.map((r) => Number(r.entity_id)));
}

export async function loadDacisContracts(
  client: PoolClient,
  filePath: string,
  resolver: EntityResolver,
  options: LoadContractsOptions,
): Promise<LoadContractsResult> {
  const fileName = filePath.split('/').pop() ?? filePath;
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }),
  );

  const run = await startRun(client, CONTRACT_SOURCE_SYSTEM, fileName);
  const customers: CustomerIndex = await loadCustomerIndex(client);
  const programIndex = await loadProgramIndex(client);
  const astrion = await astrionEntityIds(client);

  let contracts = 0;
  let awardeesNamed = 0;
  let awardeesResolved = 0;
  let otherBiddersNamed = 0;
  let otherBiddersResolved = 0;
  let rowsWithOtherBidders = 0;
  let programsNamed = 0;
  let programsLinked = 0;
  let customersNamed = 0;
  let customersMatched = 0;
  let blankValues = 0;
  let sharedValues = 0;
  let skippedUnkeyable = 0;
  let lossNamingAstrionAsAwardee = 0;
  let rowNumber = 0;

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    if (options.limit !== undefined && rowNumber > options.limit) break;

    const recordId = dacisRecordId(row['DACIS Link']);
    if (recordId === null) {
      skippedUnkeyable += 1;
      continue;
    }

    const rawValue = optional(row['Value ($M)']);
    if (rawValue === null) blankValues += 1;
    const shared = parseYesNo(row['Value is Shared']);
    if (shared === true) sharedValues += 1;

    const awardees = parseParties(row['Companies']);
    const bidders = parseParties(row['Other Bidders']);
    if (bidders.length > 0) rowsWithOtherBidders += 1;
    const namedPrograms = parseParties(row['Programs']);
    const namedCustomers = parseParties(row['Customers']);

    const payload = {
      title: optional(row['Title']),
      brief: optional(row['Brief']),
      contract_number: optional(row['Contract #']),
      solicitation_number: optional(row['Solicitation #']),
      contract_type_raw: optional(row['Contract Type']),
      value_usd: parseMillionsToUsd(rawValue),
      value_is_shared: shared,
      award_date: parseDacisDate(row['Award Date']),
      end_date: parseDacisDate(row['End Date']),
      doge_canceled: parseYesNo(row['DOGE Canceled']),
      customer_using_activity: optional(row['Customer (USING ACTIVITY)']),
      customer_country: optional(row['Customer Country']),
      customer_region_raw: optional(row['Customer Region']),
      customer_type_raw: optional(row['Customer Type']),
      dacis_url: optional(row['DACIS Link']),
      awardees: awardees.map((a) => a.raw),
      other_bidders: bidders.map((b) => b.raw),
      programs: namedPrograms.map((p) => p.raw),
      customers: namedCustomers.map((c) => c.raw),
    };

    // The role is not part of the payload. The same contract legitimately arrives under
    // two roles, and putting the role in the hash would make the second arrival look like
    // a changed record when only the export differed.
    const version = await recordVersion(client, run, recordId, payload);

    const { rows: inserted } = await client.query<{ dacis_contract_id: string }>(
      `insert into dacis_contract (
         source_system, source_record_id, title, brief, contract_number, solicitation_number,
         contract_type_raw, value_usd, value_is_shared, award_date, end_date, doge_canceled,
         customer_using_activity, customer_country, customer_region_raw, customer_type_raw,
         dacis_url, source_version_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (source_system, source_record_id) do update set
         title = excluded.title,
         brief = excluded.brief,
         contract_number = excluded.contract_number,
         solicitation_number = excluded.solicitation_number,
         contract_type_raw = excluded.contract_type_raw,
         value_usd = excluded.value_usd,
         value_is_shared = excluded.value_is_shared,
         award_date = excluded.award_date,
         end_date = excluded.end_date,
         doge_canceled = excluded.doge_canceled,
         customer_using_activity = excluded.customer_using_activity,
         customer_country = excluded.customer_country,
         customer_region_raw = excluded.customer_region_raw,
         customer_type_raw = excluded.customer_type_raw,
         dacis_url = excluded.dacis_url,
         source_version_id = excluded.source_version_id
       returning dacis_contract_id`,
      [
        CONTRACT_SOURCE_SYSTEM, recordId, payload.title, payload.brief, payload.contract_number,
        payload.solicitation_number, payload.contract_type_raw, payload.value_usd,
        payload.value_is_shared, payload.award_date, payload.end_date, payload.doge_canceled,
        payload.customer_using_activity, payload.customer_country, payload.customer_region_raw,
        payload.customer_type_raw, payload.dacis_url, version.sourceVersionId,
      ],
    );
    const contractId = Number(inserted[0]!.dacis_contract_id);
    contracts += 1;

    // The role is asserted every time, even when the payload was unchanged, because a
    // second export can add a role to a contract already loaded.
    await client.query(
      `insert into dacis_contract_role (dacis_contract_id, astrion_role, role_source, source_label)
       values ($1,$2,$3,$4)
       on conflict (dacis_contract_id, astrion_role) do update set
         role_source = excluded.role_source,
         source_label = excluded.source_label`,
      [contractId, options.role, options.roleSource, fileName],
    );

    if (!version.changed) continue;

    for (const [parties, companyRole] of [
      [awardees, 'awardee'],
      [bidders, 'other_bidder'],
    ] as Array<[typeof awardees, 'awardee' | 'other_bidder']>) {
      for (const party of parties) {
        const resolution = resolver.resolve({ vendorName: party.name, uei: null, cage: null });
        if (companyRole === 'awardee') {
          awardeesNamed += 1;
          if (resolution.entityId !== null) awardeesResolved += 1;
          if (
            options.role === 'loss' &&
            resolution.entityId !== null &&
            astrion.has(resolution.entityId)
          ) {
            lossNamingAstrionAsAwardee += 1;
          }
        } else {
          otherBiddersNamed += 1;
          if (resolution.entityId !== null) otherBiddersResolved += 1;
        }

        await client.query(
          `insert into dacis_contract_company
             (dacis_contract_id, company_name_raw, company_role, name_normalized, location_raw, entity_id)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (dacis_contract_id, company_name_raw, company_role) do update set
             name_normalized = excluded.name_normalized,
             location_raw = excluded.location_raw,
             entity_id = excluded.entity_id`,
          [contractId, party.raw, companyRole, party.nameNormalized, party.location, resolution.entityId],
        );
      }
    }

    for (const party of namedPrograms) {
      programsNamed += 1;
      const programId = party.nameNormalized ? programIndex.get(party.nameNormalized) ?? null : null;
      if (programId !== null) programsLinked += 1;
      await client.query(
        `insert into dacis_contract_program (dacis_contract_id, program_name_raw, name_normalized, program_id)
         values ($1,$2,$3,$4)
         on conflict (dacis_contract_id, program_name_raw) do update set
           name_normalized = excluded.name_normalized,
           program_id = excluded.program_id`,
        [contractId, party.raw, party.nameNormalized, programId],
      );
    }

    for (const party of namedCustomers) {
      customersNamed += 1;
      const match = matchCustomer(customers, party.name, party.nameNormalized);
      if (match.id !== null) customersMatched += 1;
      await client.query(
        `insert into dacis_contract_customer
           (dacis_contract_id, customer_name_raw, name_normalized, location_raw, customer_org_id)
         values ($1,$2,$3,$4,$5)
         on conflict (dacis_contract_id, customer_name_raw) do update set
           name_normalized = excluded.name_normalized,
           location_raw = excluded.location_raw,
           customer_org_id = excluded.customer_org_id`,
        [contractId, party.raw, party.nameNormalized, party.location, match.id],
      );
    }
  }

  await finishRun(client, run);
  console.log(summarize(run, fileName.slice(0, 27)));

  return {
    run,
    role: options.role,
    roleSource: options.roleSource,
    contracts,
    awardeesNamed,
    awardeesResolved,
    otherBiddersNamed,
    otherBiddersResolved,
    rowsWithOtherBidders,
    programsNamed,
    programsLinked,
    customersNamed,
    customersMatched,
    blankValues,
    sharedValues,
    skippedUnkeyable,
    lossNamingAstrionAsAwardee,
  };
}

/**
 * Read the Astrion role from a DACIS export filename.
 *
 * Deltek's own naming, which Gavin's exports preserve. Returns null when the filename does
 * not say, in which case the caller must be told the role explicitly rather than guessing.
 * Order matters: 'contractslosses' contains 'contracts'.
 */
export function inferRoleFromFileName(fileName: string): AstrionRole | null {
  const lower = fileName.toLowerCase();
  if (lower.includes('contractslosses') || lower.includes('contracts-losses')) return 'loss';
  if (lower.includes('contracts-prime')) return 'prime';
  if (lower.includes('contracts-out')) return 'out';
  if (lower.includes('subcontracts')) return 'sub';
  return null;
}
