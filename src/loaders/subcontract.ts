/**
 * Subcontract edge loader. Spec section 7.2 (subcontract_edge), section 20, and the
 * teaming_direction view in migration 0004.
 *
 * What the exports actually contain, measured across the nine supplied
 * companies_fpds-subcontracts-in and -out files:
 *
 *   4,043 rows
 *   4,043 distinct ID values, so the ID column is a real key
 *   0 rows where one ID carried two different payloads
 *   60 rows with a blank Value, 33 with a negative Value
 *   68 distinct prime names, 936 distinct sub names
 *
 * Section 20 states 662 rows where Astrion is the sub and 3,381 where it is the prime.
 * Those two sum to 4,043, so the specification's figures are the in and out row counts
 * and they are exactly right. This loader does not use them: it derives direction from
 * the data, because that is what makes the numbers auditable rather than asserted.
 *
 * Three decisions worth stating, all of them consequences of the data rather than
 * preferences.
 *
 * 1. No direction column is stored. 'in' and 'out' are relative to whichever company
 *    Deltek was queried about, not properties of the relationship, and every row names
 *    its own prime and sub. The same record can appear in an in-file and an out-file
 *    when both parties are Astrion entities, so it must land as one edge. Direction is
 *    derived by teaming_direction from which side resolves into the Astrion family.
 *
 * 2. An unresolved counterparty is normal, not an error. 936 distinct sub names against
 *    a 45 company watchlist means most counterparties are simply not entities the
 *    system knows. The edge is still kept, with both raw names and both CAGE codes, and
 *    teaming_direction picks it up the moment the counterparty becomes known. Only an
 *    edge where *neither* side resolves is a problem, because that edge cannot be
 *    placed relative to Astrion at all, and only that case reaches
 *    vendor_review_queue. Flooding the queue with 900 external companies would make it
 *    useless for the thing it exists for.
 *
 * 3. CAGE is tried before the name. Both sides arrive with a CAGE code, and the
 *    resolver trusts CAGE over a name string. Spec 8.2's order does the rest.
 */
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, optionalNumber } from '../lib/normalize.js';
import { EntityResolver, enqueueVendorForReview, type Resolution } from '../resolve/entity-resolver.js';
import {
  buildSubcontractColumnMap,
  describeSubcontractColumnMap,
  SUBCONTRACT_REQUIRED_FIELDS,
  type SubcontractColumnMap,
  type SubcontractField,
} from './subcontract-columns.js';

const SOURCE_SYSTEM = 'dacis_subcontract';

export interface LoadSubcontractOptions {
  /** Print the header mapping and stop. Nothing is written. */
  reportHeadersOnly?: boolean;
  /** Stop after this many data rows. */
  limit?: number;
  /** Emit a progress line every N rows. */
  progressEvery?: number;
}

/**
 * Dates in these files are ISO. The other shapes FPDS arrives in are accepted anyway,
 * because a source that changes format silently is the normal case here and a rejected
 * date would otherwise become a null with no explanation.
 */
function parseDate(raw: string | null | undefined): string | null {
  const value = optional(raw);
  if (value === null) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (us) {
    const month = us[1]!.padStart(2, '0');
    const day = us[2]!.padStart(2, '0');
    let year = us[3]!;
    if (year.length === 2) year = Number(year) >= 90 ? `19${year}` : `20${year}`;
    return `${year}-${month}-${day}`;
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return null;
}

/**
 * A blank Value is not zero. 60 rows carry one, and recording them as 0 would let them
 * be summed as if the subcontract were worth nothing. Null says 'not supplied', which
 * is what the export means, and numeric aggregates skip it.
 *
 * A negative Value is a deobligation and is kept as-is. Spec 7.2 says so explicitly,
 * and subcontract_edge deliberately carries no check constraint on value_usd.
 */
function parseValue(raw: string | null | undefined): number | null {
  const value = optional(raw);
  if (value === null) return null;
  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function cell(
  row: Record<string, string>,
  map: SubcontractColumnMap,
  field: SubcontractField,
): string | null {
  const header = map.mapped.get(field);
  if (header === undefined) return null;
  return optional(row[header]);
}

export interface SubcontractLoadResult {
  run: RunHandle;
  columnMap: SubcontractColumnMap;
  /** Edges where the prime resolved into the Astrion family. */
  astrionIsPrime: number;
  /** Edges where the sub resolved into the Astrion family. */
  astrionIsSub: number;
  /** Edges where both sides are Astrion entities. Internal teaming. */
  bothAstrion: number;
  /** Edges where exactly one side resolved. Usable, and the normal case. */
  oneSideResolved: number;
  /** Edges where neither side resolved. The only case a person needs to see. */
  neitherSideResolved: number;
  /** Rows with no prime name or no sub name. Skipped, not guessed. */
  skippedUnkeyable: number;
  /** Rows with no ID, which cannot be deduplicated on the source key. */
  rowsWithoutRecordId: number;
  /** Rows whose Value cell was blank. Stored as null, never as zero. */
  blankValues: number;
  /** Rows whose Value was negative. Deobligations, kept. */
  negativeValues: number;
}

export async function loadSubcontractFile(
  client: PoolClient,
  filePath: string,
  resolver: EntityResolver,
  options: LoadSubcontractOptions = {},
): Promise<SubcontractLoadResult | null> {
  const fileName = filePath.split('/').pop() ?? filePath;

  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }),
  );

  let columnMap: SubcontractColumnMap | null = null;
  let astrionIsPrime = 0;
  let astrionIsSub = 0;
  let bothAstrion = 0;
  let oneSideResolved = 0;
  let neitherSideResolved = 0;
  let skippedUnkeyable = 0;
  let rowsWithoutRecordId = 0;
  let blankValues = 0;
  let negativeValues = 0;
  let rowNumber = 0;

  const run = await startRun(client, SOURCE_SYSTEM, fileName);

  const astrionFamily = await loadAstrionFamily(client);

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;

    if (columnMap === null) {
      columnMap = buildSubcontractColumnMap(Object.keys(row));

      const missing = SUBCONTRACT_REQUIRED_FIELDS.filter((f) => !columnMap!.mapped.has(f));
      if (missing.length > 0) {
        throw new Error(
          `${fileName}: no edge without both sides, no header matched ${missing.join(', ')}.` +
            `${describeSubcontractColumnMap(columnMap)}\n\n` +
            'Add the header to SUBCONTRACT_COLUMN_CANDIDATES in src/loaders/subcontract-columns.ts.',
        );
      }

      if (options.reportHeadersOnly) {
        console.log(
          `${fileName}: ${Object.keys(row).length} headers${describeSubcontractColumnMap(columnMap)}`,
        );
        await finishRun(client, run, 'succeeded');
        return null;
      }
    }

    if (options.limit !== undefined && rowNumber > options.limit) break;

    const primeName = cell(row, columnMap, 'prime_name');
    const subName = cell(row, columnMap, 'sub_name');
    if (!primeName || !subName) {
      skippedUnkeyable += 1;
      continue;
    }

    const recordId = cell(row, columnMap, 'source_record_id');
    if (recordId === null) rowsWithoutRecordId += 1;

    const primeCage = cell(row, columnMap, 'prime_cage_code');
    const subCage = cell(row, columnMap, 'sub_cage_code');

    const rawValue = cell(row, columnMap, 'value_usd');
    const value = parseValue(rawValue);
    if (rawValue === null) blankValues += 1;
    else if (value !== null && value < 0) negativeValues += 1;

    const payload = {
      source_record_id: recordId,
      award_number: cell(row, columnMap, 'award_number'),
      description: cell(row, columnMap, 'description'),
      value_usd: value,
      award_date: parseDate(cell(row, columnMap, 'award_date')),
      prime_name_raw: primeName,
      prime_piid: cell(row, columnMap, 'prime_piid'),
      prime_idv_piid: cell(row, columnMap, 'prime_idv_piid'),
      prime_cage_code: primeCage,
      sub_name_raw: subName,
      sub_cage_code: subCage,
      agency_name: cell(row, columnMap, 'agency_name'),
      office_name: cell(row, columnMap, 'office_name'),
      customer_name: cell(row, columnMap, 'customer_name'),
    };

    // Without an ID, fall back to the edge's own content so a re-run still recognises
    // the row rather than inserting it twice.
    const sourceRecordId =
      recordId ?? [primeName, subName, payload.award_number ?? '', payload.award_date ?? ''].join('|');

    const version = await recordVersion(client, run, sourceRecordId, payload);
    if (!version.changed) continue;

    const prime = resolver.resolve({ vendorName: primeName, cage: primeCage, uei: null });
    const sub = resolver.resolve({ vendorName: subName, cage: subCage, uei: null });

    const primeIsAstrion = prime.entityId !== null && astrionFamily.has(prime.entityId);
    const subIsAstrion = sub.entityId !== null && astrionFamily.has(sub.entityId);
    if (primeIsAstrion) astrionIsPrime += 1;
    if (subIsAstrion) astrionIsSub += 1;
    if (primeIsAstrion && subIsAstrion) bothAstrion += 1;

    const resolvedSides = (prime.entityId !== null ? 1 : 0) + (sub.entityId !== null ? 1 : 0);
    if (resolvedSides === 1) oneSideResolved += 1;
    if (resolvedSides === 0) {
      neitherSideResolved += 1;
      // Only this case. See the note at the top of the file: an edge with one side
      // resolved is a usable teaming relationship, not something to review.
      await enqueueUnplacedEdge(client, primeName, primeCage, prime);
      await enqueueUnplacedEdge(client, subName, subCage, sub);
    }

    await client.query(
      `insert into subcontract_edge (
         source_system, source_record_id,
         prime_entity_id, sub_entity_id,
         prime_name_raw, sub_name_raw,
         prime_cage_code, sub_cage_code,
         prime_piid, prime_idv_piid, award_number,
         value_usd, award_date,
         agency_name, office_name, customer_name, description,
         source_version_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (source_system, source_record_id) where source_record_id is not null
       do update set
         prime_entity_id = excluded.prime_entity_id,
         sub_entity_id = excluded.sub_entity_id,
         prime_name_raw = excluded.prime_name_raw,
         sub_name_raw = excluded.sub_name_raw,
         prime_cage_code = excluded.prime_cage_code,
         sub_cage_code = excluded.sub_cage_code,
         prime_piid = excluded.prime_piid,
         prime_idv_piid = excluded.prime_idv_piid,
         award_number = excluded.award_number,
         value_usd = excluded.value_usd,
         award_date = excluded.award_date,
         agency_name = excluded.agency_name,
         office_name = excluded.office_name,
         customer_name = excluded.customer_name,
         description = excluded.description,
         source_version_id = excluded.source_version_id`,
      [
        SOURCE_SYSTEM, sourceRecordId,
        prime.entityId, sub.entityId,
        primeName, subName,
        primeCage, subCage,
        payload.prime_piid, payload.prime_idv_piid, payload.award_number,
        payload.value_usd, payload.award_date,
        payload.agency_name, payload.office_name, payload.customer_name, payload.description,
        version.sourceVersionId,
      ],
    );

    if (options.progressEvery && rowNumber % options.progressEvery === 0) {
      console.log(`    ${fileName}: ${rowNumber} rows`);
    }
  }

  await finishRun(client, run);
  console.log(summarize(run, fileName.slice(0, 27)));

  return {
    run,
    columnMap: columnMap ?? buildSubcontractColumnMap([]),
    astrionIsPrime,
    astrionIsSub,
    bothAstrion,
    oneSideResolved,
    neitherSideResolved,
    skippedUnkeyable,
    rowsWithoutRecordId,
    blankValues,
    negativeValues,
  };
}

/** Entity ids inside the Astrion family, matching the teaming_direction view exactly. */
async function loadAstrionFamily(client: PoolClient): Promise<Set<number>> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select entity_id from entity
      where entity_type = 'astrion_family'
         or ultimate_parent_id in (select entity_id from entity where entity_type = 'astrion_family')`,
  );
  return new Set(rows.map((r) => Number(r.entity_id)));
}

async function enqueueUnplacedEdge(
  client: PoolClient,
  name: string,
  cage: string | null,
  resolution: Resolution,
): Promise<void> {
  if (resolution.entityId !== null) return;
  await enqueueVendorForReview(client, SOURCE_SYSTEM, { vendorName: name, cage, uei: null }, resolution);
}
