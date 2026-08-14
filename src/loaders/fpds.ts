/**
 * FPDS contract action loader. Spec section 7.2 and 4.1.
 *
 * Three facts from the corpus drive the design.
 *
 * 1. Exports contain duplicates. Two supplied files are identical, one file is a
 *    superset of another, and 368 rows repeat across files. So the loader must be
 *    idempotent, and it is, on the composite natural key
 *    (awarding_agency_code, piid, modification_number, transaction_number).
 *    Acceptance test 2 asserts this.
 *
 * 2. A name search fails. A query on the current legal name returns 0.7 percent of
 *    the history, so every row resolves through the authored entity map rather
 *    than through its vendor name string. Acceptance test 1 asserts this.
 *
 * 3. Code labels change. PSC R425 appears with two different descriptions in one
 *    dataset. So the loader stores the code on the action and versions the label
 *    in code_label. It never stores a label on the action.
 */
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse';
import type { PoolClient } from 'pg';
import {
  startRun,
  finishRun,
  recordVersion,
  summarize,
  type RunHandle,
} from '../lib/provenance.js';
import { optional, optionalInteger, optionalNumber } from '../lib/normalize.js';
import { EntityResolver, enqueueVendorForReview } from '../resolve/entity-resolver.js';
import {
  buildColumnMap,
  describeColumnMap,
  splitCodeLabel,
  CODE_BEARING_FIELDS,
  REQUIRED_FIELDS,
  type ColumnMap,
  type FpdsField,
} from './fpds-columns.js';

const SOURCE_SYSTEM = 'fpds';

export interface LoadFpdsOptions {
  /** Print the header mapping and stop. Nothing is written. */
  reportHeadersOnly?: boolean;
  /** Stop after this many data rows. Useful for a first look at a large file. */
  limit?: number;
  /** Emit a progress line every N rows. */
  progressEvery?: number;
  /**
   * ON by default, by Gavin Taylor's decision of 14 August 2026, taken with the
   * figures below in front of him. Set false for spec 7.2 as literally written.
   *
   * The Astrion export leaves 'Transaction #' blank on every row, so the natural key
   * loses its fourth component and several FPDS transactions recorded against one
   * modification collapse onto one contract_action row. Measured on the supplied
   * corpus: 2,023 modifications, 4,912 payloads overwritten, $1.87bn of Action
   * Obligation -- 18.6 percent of the corpus total -- absent from contract_action.
   * Migration 0015 documents this and its views quantify it on demand.
   *
   * The accompanying action is to have 'Transaction #' populated upstream. When it
   * arrives the surrogate stops firing on its own: a row carrying a real transaction
   * number always uses it, and no code change is needed to hand over.
   *
   * This substitutes a deterministic surrogate: 'H:' followed by 12 hex characters of
   * a SHA-256 over the row's mapped payload with transaction_number removed.
   * Properties that matter:
   *
   *   - Deterministic. The same row in the same or another file yields the same
   *     surrogate, so the loader stays idempotent and acceptance test 2 still holds.
   *   - Order independent. It does not depend on file order or row order.
   *   - Content derived. Two transactions on one modification that differ in any
   *     mapped field get different surrogates, so both are kept.
   *
   * The cost, stated plainly: the surrogate is content derived, so if FPDS later
   * corrects a mapped field on a transaction, the corrected row arrives as a new
   * action rather than an update to the existing one. Audit columns are not mapped,
   * so a re-export that only touches them does not trigger this.
   *
   * Only ever applied when the transaction number is genuinely absent. A row that
   * carries a real transaction number always uses it.
   */
  syntheticTransactionNumber?: boolean;
}

/** Length of the hex slice used for a surrogate transaction number. */
const SURROGATE_HEX_LENGTH = 12;
export const SURROGATE_PREFIX = 'H:';

/**
 * Deterministic stand-in for a missing transaction number.
 *
 * Keyed on the mapped payload with transaction_number removed, so the surrogate does
 * not depend on itself. Keys are sorted, so JSON key order cannot change the result.
 */
export function surrogateTransactionNumber(payload: Record<string, unknown>): string {
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    if (key === 'transaction_number') continue;
    stable[key] = payload[key];
  }
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  return SURROGATE_PREFIX + digest.slice(0, SURROGATE_HEX_LENGTH);
}

/** FPDS writes dates in several shapes. Accept the ones that actually appear. */
function parseDate(raw: string | null | undefined): string | null {
  const value = optional(raw);
  if (value === null) return null;

  // ISO, with or without a time part: 2024-09-30, 2024-09-30 00:00:00
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // US, with 2 or 4 digit year: 09/30/2024, 9/30/24
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (us) {
    const month = us[1]!.padStart(2, '0');
    const day = us[2]!.padStart(2, '0');
    let year = us[3]!;
    if (year.length === 2) {
      // FPDS starts in 1990. A two digit year of 90 or above is last century.
      year = Number(year) >= 90 ? `19${year}` : `20${year}`;
    }
    return `${year}-${month}-${day}`;
  }

  // Compact: 20240930
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return null;
}

/** FPDS money arrives with currency symbols, thousands separators, and parenthesised negatives. */
function parseMoney(raw: string | null | undefined): number | null {
  const value = optional(raw);
  if (value === null) return null;
  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

function cell(row: Record<string, string>, map: ColumnMap, field: FpdsField): string | null {
  const header = map.mapped.get(field);
  if (header === undefined) return null;
  return optional(row[header]);
}

/**
 * One row's code-bearing cells, split into the code that goes on the action and the
 * label that goes to code_label. A cell that carries a bare code yields a null
 * label, which is the shape every other export produces.
 */
type CodeCells = Map<FpdsField, { code: string | null; label: string | null }>;

function readCodeCells(row: Record<string, string>, map: ColumnMap): CodeCells {
  const out: CodeCells = new Map();
  for (const { field } of CODE_BEARING_FIELDS) {
    out.set(field, splitCodeLabel(cell(row, map, field)));
  }
  return out;
}

function codeOf(cells: CodeCells, field: FpdsField): string | null {
  return cells.get(field)?.code ?? null;
}

export interface FpdsLoadResult {
  run: RunHandle;
  columnMap: ColumnMap;
  resolvedByMethod: Record<string, number>;
  unresolvedRows: number;
  classificationsWritten: number;
  labelsWritten: number;
  skippedUnkeyable: number;
  /**
   * Rows the authored entity map could not resolve, for which
   * 'Contractor: DACIS: Parent Name' did name a known Astrion family entity.
   * Evidence for whether spec 8.2 should gain a fourth match step.
   */
  unresolvedButParentNamed: number;
  /** Distinct parent names seen on unresolved rows, with row counts. */
  unresolvedParentNames: Map<string, number>;
  /** Rows whose 'Transaction #' cell was empty. Spec 7.2 needs it for the key. */
  blankTransactionNumbers: number;
  /** Rows given a content derived transaction number instead. Opt in only. */
  surrogateKeysIssued: number;
  /**
   * Rows whose natural key had already been written in this file with a different
   * payload, so the upsert overwrote a distinct transaction. Zero when the export
   * supplies transaction numbers, or when syntheticTransactionNumber is enabled.
   */
  collapsedTransactions: number;
  /** Action Obligation carried on those overwriting rows. */
  collapsedObligation: number;
}

export async function loadFpdsFile(
  client: PoolClient,
  filePath: string,
  resolver: EntityResolver,
  options: LoadFpdsOptions = {},
): Promise<FpdsLoadResult | null> {
  const fileName = filePath.split('/').pop() ?? filePath;

  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }),
  );

  let columnMap: ColumnMap | null = null;
  const resolvedByMethod: Record<string, number> = {};
  let unresolvedRows = 0;
  let classificationsWritten = 0;
  let labelsWritten = 0;
  let skippedUnkeyable = 0;
  let unresolvedButParentNamed = 0;
  let blankTransactionNumbers = 0;
  let surrogateKeysIssued = 0;
  let collapsedTransactions = 0;
  let collapsedObligation = 0;
  let rowNumber = 0;
  // Natural key -> the payload hash last written for it in this file.
  const seenKeyHash = new Map<string, string>();
  const unresolvedParentNames = new Map<string, number>();

  const run = await startRun(client, SOURCE_SYSTEM, fileName);

  // Label tally, flushed after the file. Keyed by code type, code, and label text.
  const labelTally = new Map<
    string,
    {
      codeType: 'naics' | 'psc' | 'agency' | 'office';
      codeValue: string;
      label: string;
      count: number;
    }
  >();

  const tallyLabel = (
    codeType: 'naics' | 'psc' | 'agency' | 'office',
    codeValue: string | null,
    label: string | null,
  ): void => {
    if (!codeValue || !label) return;
    const key = `${codeType}\0${codeValue}\0${label}`;
    const existing = labelTally.get(key);
    if (existing) existing.count += 1;
    else labelTally.set(key, { codeType, codeValue, label, count: 1 });
  };

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;

    if (columnMap === null) {
      columnMap = buildColumnMap(Object.keys(row));

      const missingRequired = REQUIRED_FIELDS.filter((f) => !columnMap!.mapped.has(f));
      if (missingRequired.length > 0) {
        throw new Error(
          `${fileName}: cannot key rows, no header matched ${missingRequired.join(', ')}.` +
            `${describeColumnMap(columnMap)}\n\n` +
            'Add the header to FPDS_COLUMN_CANDIDATES in src/loaders/fpds-columns.ts.',
        );
      }

      if (options.reportHeadersOnly) {
        console.log(`${fileName}: ${Object.keys(row).length} headers${describeColumnMap(columnMap)}`);
        await finishRun(client, run, 'succeeded');
        return null;
      }
    }

    if (options.limit !== undefined && rowNumber > options.limit) break;

    const codes = readCodeCells(row, columnMap);

    const piid = cell(row, columnMap, 'piid');
    const awardingAgency = codeOf(codes, 'awarding_agency_code');
    if (!piid || !awardingAgency) {
      skippedUnkeyable += 1;
      continue;
    }
    // A base award leaves these blank. The empty string keeps them usable in a
    // primary key, where null is not allowed.
    const modificationNumber = cell(row, columnMap, 'modification_number') ?? '';
    const suppliedTransactionNumber = cell(row, columnMap, 'transaction_number') ?? '';
    if (suppliedTransactionNumber === '') blankTransactionNumbers += 1;

    const vendorName = cell(row, columnMap, 'vendor_name');
    const vendorUei = cell(row, columnMap, 'vendor_uei');
    const vendorCage = cell(row, columnMap, 'vendor_cage');
    const vendorParentName = cell(row, columnMap, 'vendor_parent_name');
    const naicsCode = codeOf(codes, 'naics_code');
    const pscCode = codeOf(codes, 'psc_code');

    const payload = {
      awarding_agency_code: awardingAgency,
      piid,
      modification_number: modificationNumber,
      transaction_number: suppliedTransactionNumber,
      idv_piid: cell(row, columnMap, 'idv_piid'),
      idv_agency_code: codeOf(codes, 'idv_agency_code'),
      award_type: cell(row, columnMap, 'award_type'),
      signed_date: parseDate(cell(row, columnMap, 'signed_date')),
      effective_date: parseDate(cell(row, columnMap, 'effective_date')),
      current_completion_date: parseDate(cell(row, columnMap, 'current_completion_date')),
      ultimate_completion_date: parseDate(cell(row, columnMap, 'ultimate_completion_date')),
      action_obligation: parseMoney(cell(row, columnMap, 'action_obligation')),
      base_and_all_options: parseMoney(cell(row, columnMap, 'base_and_all_options')),
      contracting_department_code: codeOf(codes, 'contracting_department_code'),
      contracting_agency_code: codeOf(codes, 'contracting_agency_code'),
      contracting_office_code: codeOf(codes, 'contracting_office_code'),
      funding_agency_code: codeOf(codes, 'funding_agency_code'),
      funding_office_code: codeOf(codes, 'funding_office_code'),
      place_of_performance_state: cell(row, columnMap, 'place_of_performance_state'),
      extent_competed: cell(row, columnMap, 'extent_competed'),
      set_aside_type: cell(row, columnMap, 'set_aside_type'),
      number_of_offers_received: optionalInteger(cell(row, columnMap, 'number_of_offers_received')),
      vendor_name_raw: vendorName,
      vendor_uei: vendorUei,
      vendor_cage: vendorCage,
      vendor_parent_name: vendorParentName,
      naics_code: naicsCode,
      psc_code: pscCode,
    };

    // The surrogate is derived from the payload, so it is computed after the payload
    // exists and then written back into it. Both the key and the archived payload
    // therefore carry the same transaction number, and re-reading the archive
    // reproduces the key exactly.
    let transactionNumber = suppliedTransactionNumber;
    if (transactionNumber === '' && (options.syntheticTransactionNumber ?? true)) {
      transactionNumber = surrogateTransactionNumber(payload);
      payload.transaction_number = transactionNumber;
      surrogateKeysIssued += 1;
    }

    const sourceRecordId = [awardingAgency, piid, modificationNumber, transactionNumber].join('|');

    // A key already seen in this file with a different payload is a transaction the
    // upsert below is about to overwrite. Counted, never hidden. Migration 0015's
    // views report the same thing corpus wide, from the archive.
    const priorHashForKey = seenKeyHash.get(sourceRecordId);

    const version = await recordVersion(client, run, sourceRecordId, payload);

    if (priorHashForKey !== undefined && priorHashForKey !== version.payloadHash) {
      collapsedTransactions += 1;
      collapsedObligation += payload.action_obligation ?? 0;
    }
    seenKeyHash.set(sourceRecordId, version.payloadHash);

    // The hash skip lives here, where it matters. A re-run of an unchanged 48,645
    // row file does no write work at all beyond the hash lookups.
    if (!version.changed) continue;

    const resolution = resolver.resolve({
      vendorName,
      uei: vendorUei,
      cage: vendorCage,
    });
    resolvedByMethod[resolution.method] = (resolvedByMethod[resolution.method] ?? 0) + 1;

    if (resolution.entityId === null) {
      unresolvedRows += 1;
      // Measure only. Resolution semantics are unchanged: spec 8.2 does not list
      // the DACIS parent column, so the loader does not silently start using it.
      if (vendorParentName !== null) {
        unresolvedParentNames.set(
          vendorParentName,
          (unresolvedParentNames.get(vendorParentName) ?? 0) + 1,
        );
        if (resolver.namesKnownEntity(vendorParentName)) unresolvedButParentNamed += 1;
      }
      await enqueueVendorForReview(client, SOURCE_SYSTEM, { vendorName, uei: vendorUei, cage: vendorCage }, resolution);
    }

    const { rows: actionRows } = await client.query<{ contract_action_id: string }>(
      `insert into contract_action (
         awarding_agency_code, piid, modification_number, transaction_number,
         idv_piid, idv_agency_code, award_type,
         signed_date, effective_date, current_completion_date, ultimate_completion_date,
         action_obligation, base_and_all_options,
         contracting_department_code, contracting_agency_code, contracting_office_code,
         funding_agency_code, funding_office_code, place_of_performance_state,
         extent_competed, set_aside_type, number_of_offers_received,
         vendor_name_raw, entity_id, entity_match_method, entity_match_confidence,
         source_version_id
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27
       )
       on conflict (awarding_agency_code, piid, modification_number, transaction_number) do update set
         idv_piid = excluded.idv_piid,
         idv_agency_code = excluded.idv_agency_code,
         award_type = excluded.award_type,
         signed_date = excluded.signed_date,
         effective_date = excluded.effective_date,
         current_completion_date = excluded.current_completion_date,
         ultimate_completion_date = excluded.ultimate_completion_date,
         action_obligation = excluded.action_obligation,
         base_and_all_options = excluded.base_and_all_options,
         contracting_department_code = excluded.contracting_department_code,
         contracting_agency_code = excluded.contracting_agency_code,
         contracting_office_code = excluded.contracting_office_code,
         funding_agency_code = excluded.funding_agency_code,
         funding_office_code = excluded.funding_office_code,
         place_of_performance_state = excluded.place_of_performance_state,
         extent_competed = excluded.extent_competed,
         set_aside_type = excluded.set_aside_type,
         number_of_offers_received = excluded.number_of_offers_received,
         vendor_name_raw = excluded.vendor_name_raw,
         entity_id = excluded.entity_id,
         entity_match_method = excluded.entity_match_method,
         entity_match_confidence = excluded.entity_match_confidence,
         source_version_id = excluded.source_version_id
       returning contract_action_id`,
      [
        awardingAgency, piid, modificationNumber, transactionNumber,
        payload.idv_piid, payload.idv_agency_code, payload.award_type,
        payload.signed_date, payload.effective_date, payload.current_completion_date, payload.ultimate_completion_date,
        payload.action_obligation, payload.base_and_all_options,
        payload.contracting_department_code, payload.contracting_agency_code, payload.contracting_office_code,
        payload.funding_agency_code, payload.funding_office_code, payload.place_of_performance_state,
        payload.extent_competed, payload.set_aside_type, payload.number_of_offers_received,
        vendorName, resolution.entityId, resolution.method, resolution.confidence,
        version.sourceVersionId,
      ],
    );
    const contractActionId = Number(actionRows[0]!.contract_action_id);

    // NAICS and PSC go to their own table. Spec 7.2 forbids a text column here,
    // which was Codex defect 5.
    for (const [codeType, codeValue] of [
      ['naics', naicsCode],
      ['psc', pscCode],
    ] as Array<['naics' | 'psc', string | null]>) {
      if (!codeValue) continue;
      const { rowCount } = await client.query(
        `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
         values ($1, $2, $3, true)
         on conflict (contract_action_id, code_type, code_value) do nothing`,
        [contractActionId, codeType, codeValue],
      );
      classificationsWritten += rowCount ?? 0;
    }

    // Labels are tallied in memory and flushed once after the file, so
    // observation_count is a true per-record count rather than a per-file flag.
    // See migration 0013 for why that distinction matters.
    //
    // A label reaches the tally from one of two places: a dedicated description
    // column when the export has one, or the code cell itself when the export packs
    // 'CODE: LABEL' into a single column. The dedicated column wins where it exists.
    for (const { field, labelType } of CODE_BEARING_FIELDS) {
      if (labelType === null) continue;
      const split = codes.get(field);
      if (!split?.code) continue;

      let label = split.label;
      if (labelType === 'naics') label = cell(row, columnMap, 'naics_description') ?? label;
      if (labelType === 'psc') label = cell(row, columnMap, 'psc_description') ?? label;

      tallyLabel(labelType, split.code, label);
    }

    if (options.progressEvery && rowNumber % options.progressEvery === 0) {
      console.log(`    ${fileName}: ${rowNumber} rows`);
    }
  }

  // Flush the label tally. One round trip per distinct label, not per row.
  for (const entry of labelTally.values()) {
    await client.query('select cie_observe_code_label($1, $2, $3, $4, $5)', [
      entry.codeType,
      entry.codeValue,
      entry.label,
      SOURCE_SYSTEM,
      entry.count,
    ]);
    labelsWritten += 1;
  }

  await finishRun(client, run);
  console.log(summarize(run, fileName.slice(0, 27)));

  return {
    run,
    columnMap: columnMap ?? buildColumnMap([]),
    resolvedByMethod,
    unresolvedRows,
    classificationsWritten,
    labelsWritten,
    skippedUnkeyable,
    unresolvedButParentNamed,
    unresolvedParentNames,
    blankTransactionNumbers,
    surrogateKeysIssued,
    collapsedTransactions,
    collapsedObligation,
  };
}
