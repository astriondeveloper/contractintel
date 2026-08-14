/**
 * DACIS program loader.
 *
 * Five columns: DACIS Link, Program Name, Description, Companies (Top 500), Customers.
 * Three exports share the shape and differ only in lifecycle:
 *
 *   companies_programs           38 rows  active
 *   companies_programsarchived   34 rows  archived
 *   companies_advance             2 rows  pre-RFP, before a solicitation exists
 *
 * All 74 DACIS ids are distinct and the three sets do not intersect at all, so lifecycle
 * is a clean partition and a genuine property of the record rather than an artefact of
 * which export was run. It is therefore stored, unlike the subcontract in/out case where
 * direction was derivable and storing it would have been redundant.
 *
 * The pre-RFP export is the most valuable of the three despite being the smallest. It is
 * the only source in the corpus describing opportunities that have no solicitation yet,
 * which is the pipeline input sections 9 and 11 need. On the supplied file, one of the two
 * rows names Halcyon Systems and Quillmark among the companies tracked against an NSC
 * artificial intelligence requirement.
 *
 * One caveat that has to travel with every count this loader produces. The participant
 * column is headed 'Companies (Top 500)' and 10 of the 74 programs supply exactly 500
 * entries, which means they were truncated. For those programs a participant count is a
 * floor, not a total, and `participant_list_truncated` says so on the row.
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
  rawListLength,
  trailingAcronym,
  PROGRAM_PARTICIPANT_CAP,
} from './dacis-common.js';

export const PROGRAM_SOURCE_SYSTEM = 'dacis_program';

export const PROGRAM_REQUIRED_HEADERS = ['Program Name', 'Companies (Top 500)'];

export type ProgramLifecycle = 'active' | 'archived' | 'pre_rfp';

/**
 * Lifecycle is asserted by the export, so it is passed in rather than sniffed inside the
 * row loop. The router derives it from the filename and says so; a caller can override.
 */
export interface LoadProgramsOptions {
  lifecycle: ProgramLifecycle;
  limit?: number;
}

export interface LoadProgramsResult {
  run: RunHandle;
  lifecycle: ProgramLifecycle;
  programs: number;
  truncatedLists: number;
  participantsSupplied: number;
  participantsResolved: number;
  customersNamed: number;
  customersMatched: number;
  customersMatchedByAcronym: number;
  skippedUnkeyable: number;
}

/** Customer name and acronym lookup, loaded once per file. */
interface CustomerIndex {
  byName: Map<string, number>;
  byAcronym: Map<string, number>;
}

async function loadCustomerIndex(client: PoolClient): Promise<CustomerIndex> {
  const { rows } = await client.query<{
    customer_org_id: string;
    name_normalized: string | null;
    acronym: string | null;
  }>('select customer_org_id, name_normalized, acronym from customer_org');

  const byName = new Map<string, number>();
  const byAcronym = new Map<string, number>();
  for (const row of rows) {
    const id = Number(row.customer_org_id);
    if (row.name_normalized) if (!byName.has(row.name_normalized)) byName.set(row.name_normalized, id);
    if (row.acronym) {
      const key = row.acronym.trim().toUpperCase();
      // An acronym is not guaranteed unique across 854 customers. A duplicate is
      // recorded as unusable rather than resolved to whichever row was seen first.
      if (byAcronym.has(key)) byAcronym.set(key, -1);
      else byAcronym.set(key, id);
    }
  }
  return { byName, byAcronym };
}

/**
 * Match a customer string to customer_org: normalised name first, then a trailing
 * acronym. Returns the id and which route found it, so the hit rate of each is reportable
 * rather than a matter of belief.
 */
export function matchCustomer(
  index: CustomerIndex,
  name: string,
  nameNormalized: string | null,
): { id: number | null; byAcronym: boolean } {
  if (nameNormalized) {
    const hit = index.byName.get(nameNormalized);
    if (hit !== undefined) return { id: hit, byAcronym: false };
  }
  const acronym = trailingAcronym(name);
  if (acronym) {
    const hit = index.byAcronym.get(acronym.toUpperCase());
    if (hit !== undefined && hit !== -1) return { id: hit, byAcronym: true };
  }
  return { id: null, byAcronym: false };
}

export async function loadDacisPrograms(
  client: PoolClient,
  filePath: string,
  resolver: EntityResolver,
  options: LoadProgramsOptions,
): Promise<LoadProgramsResult> {
  const fileName = filePath.split('/').pop() ?? filePath;
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }),
  );

  const run = await startRun(client, PROGRAM_SOURCE_SYSTEM, fileName);
  const customers = await loadCustomerIndex(client);

  let programs = 0;
  let truncatedLists = 0;
  let participantsSupplied = 0;
  let participantsResolved = 0;
  let customersNamed = 0;
  let customersMatched = 0;
  let customersMatchedByAcronym = 0;
  let skippedUnkeyable = 0;
  let rowNumber = 0;

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    if (options.limit !== undefined && rowNumber > options.limit) break;

    const name = optional(row['Program Name']);
    const recordId = dacisRecordId(row['DACIS Link']);
    if (name === null || recordId === null) {
      skippedUnkeyable += 1;
      continue;
    }

    const participants = parseParties(row['Companies (Top 500)']);
    const namedCustomers = parseParties(row['Customers']);
    // Tested against what the export emitted, not against what survives de-duplication.
    // See rawListLength: the de-duplicated test misses more than half the truncated rows.
    const truncated = rawListLength(row['Companies (Top 500)']) >= PROGRAM_PARTICIPANT_CAP;
    if (truncated) truncatedLists += 1;

    const payload = {
      program_name: name,
      description: optional(row['Description']),
      lifecycle_status: options.lifecycle,
      participants_supplied: participants.length,
      participants_emitted: rawListLength(row['Companies (Top 500)']),
      participant_list_truncated: truncated,
      participant_names: participants.map((p) => p.raw),
      customer_names: namedCustomers.map((c) => c.raw),
      dacis_url: optional(row['DACIS Link']),
    };

    const version = await recordVersion(client, run, recordId, payload);
    if (!version.changed) continue;

    const { rows: inserted } = await client.query<{ program_id: string }>(
      `insert into program (
         source_system, source_record_id, program_name, name_normalized, description,
         lifecycle_status, participant_list_truncated, participants_supplied,
         dacis_url, source_version_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (source_system, source_record_id) do update set
         program_name = excluded.program_name,
         name_normalized = excluded.name_normalized,
         description = excluded.description,
         lifecycle_status = excluded.lifecycle_status,
         participant_list_truncated = excluded.participant_list_truncated,
         participants_supplied = excluded.participants_supplied,
         dacis_url = excluded.dacis_url,
         source_version_id = excluded.source_version_id
       returning program_id`,
      [
        PROGRAM_SOURCE_SYSTEM, recordId, name, normalizeName(name), payload.description,
        options.lifecycle, truncated, participants.length,
        payload.dacis_url, version.sourceVersionId,
      ],
    );
    const programId = Number(inserted[0]!.program_id);
    programs += 1;

    for (const party of participants) {
      participantsSupplied += 1;
      // Name only. These exports carry no UEI or CAGE, so the resolver has nothing else
      // to work with and most participants will not resolve. That is expected: one
      // program alone names 500 companies against a 45 company watchlist.
      const resolution = resolver.resolve({ vendorName: party.name, uei: null, cage: null });
      if (resolution.entityId !== null) participantsResolved += 1;

      await client.query(
        `insert into program_participant (program_id, company_name_raw, name_normalized, location_raw, entity_id)
         values ($1,$2,$3,$4,$5)
         on conflict (program_id, company_name_raw) do update set
           name_normalized = excluded.name_normalized,
           location_raw = excluded.location_raw,
           entity_id = excluded.entity_id`,
        [programId, party.raw, party.nameNormalized, party.location, resolution.entityId],
      );
    }

    for (const party of namedCustomers) {
      customersNamed += 1;
      const match = matchCustomer(customers, party.name, party.nameNormalized);
      if (match.id !== null) {
        customersMatched += 1;
        if (match.byAcronym) customersMatchedByAcronym += 1;
      }
      await client.query(
        `insert into program_customer (program_id, customer_name_raw, name_normalized, location_raw, customer_org_id)
         values ($1,$2,$3,$4,$5)
         on conflict (program_id, customer_name_raw) do update set
           name_normalized = excluded.name_normalized,
           location_raw = excluded.location_raw,
           customer_org_id = excluded.customer_org_id`,
        [programId, party.raw, party.nameNormalized, party.location, match.id],
      );
    }
  }

  await finishRun(client, run);
  console.log(summarize(run, fileName.slice(0, 27)));

  return {
    run,
    lifecycle: options.lifecycle,
    programs,
    truncatedLists,
    participantsSupplied,
    participantsResolved,
    customersNamed,
    customersMatched,
    customersMatchedByAcronym,
    skippedUnkeyable,
  };
}

export { loadCustomerIndex };
export type { CustomerIndex };
