/**
 * GovWin opportunity search export.
 *
 * Reads the `.xlsx` GovWin produces from an opportunity search and writes `govwin_opportunity`. It is
 * the only source here that describes a requirement before anything about it has been published: of
 * the first export's 2,629 rows, 421 were Forecast Pre-RFP and 348 Pre-RFP, and 710 carried somebody's
 * estimate of the month a solicitation would drop.
 *
 * Three things in this file exist because getting them wrong is silent, and they are worth reading
 * before changing anything.
 *
 * **The value column is in thousands.** It is headed `Value (USD-$K)` and it means it: the first export
 * runs from 96 to 172,400,000, which is $96k to $172.4bn. Read as dollars, every figure in the system
 * would be a thousand times too small and nothing would fail — the numbers would simply be wrong on
 * every screen. `THOUSANDS` below is the multiplier and `parseValueUsd` is the only place it is applied.
 *
 * **A month is not a day.** The estimate flag and the date precision correspond exactly in the export:
 * every `Actual` date is `mm/dd/yyyy` and every Deltek or government estimate is `mm/yyyy`. Nobody
 * claims to know the day an unpublished solicitation will drop. A month-precision date is stored on the
 * first of that month *with its precision beside it*, so that nothing downstream can mistake the first
 * of June for a claim about the first of June.
 *
 * **The prose is not stored.** `Summary` and `Latest News` are Deltek's licensed analysis. This system
 * renders to a snapshot that embeds every row it shows, so holding them would put licensed prose one
 * careless publish away from a public URL. `govwin_url` links out instead. Decision D32.
 *
 * The export itself must never be committed. `data/` is gitignored for the same reason the DACIS
 * exports are: it is licensed third-party content and this is a public repository.
 */
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, type RunHandle } from '../lib/provenance.js';
import { readSheet } from './xlsx.js';

export const SOURCE_SYSTEM = 'govwin_opportunity';

/** The export's value column is in thousands of dollars. */
export const THOUSANDS = 1000;

/**
 * How many contract numbers to keep per opportunity.
 *
 * A large multiple-award vehicle listed 1,924 in the first export. They are stored to join GovWin to
 * this system's own history through the predecessor contract, and past a certain number that join stops
 * being about one procurement — an umbrella with two thousand task orders is not a recompete. The true
 * count is reported so the cap is visible rather than silent.
 */
export const MAX_CONTRACTS_PER_ROW = 200;

/** The columns the loader needs. A missing one is a changed export and stops the run. */
export const REQUIRED_COLUMNS = ['Opp ID', 'Opp Type', 'Status'] as const;

export interface LoadGovwinOptions {
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly onProgress?: (message: string) => void;
  /** Print the header row and stop. For checking a new export against this mapping. */
  readonly headersOnly?: boolean;
}

export interface LoadGovwinResult {
  readonly run: RunHandle | null;
  readonly rows: number;
  readonly written: number;
  readonly unchanged: number;
  readonly skippedNoId: number;
  readonly naicsWritten: number;
  readonly contractsWritten: number;
  readonly contractsCapped: number;
  readonly agencyResolved: number;
  readonly agencyUnresolved: number;
  readonly byStatus: Record<string, number>;
  readonly byType: Record<string, number>;
  readonly estimatedDates: number;
  readonly actualDates: number;
  readonly headers: readonly string[];
}

/** A cell, trimmed, with the empty string meaning absent. */
function cell(row: readonly string[], index: number | undefined): string {
  if (index === undefined || index < 0) return '';
  return (row[index] ?? '').trim();
}

function orNull(value: string): string | null {
  return value === '' ? null : value;
}

export interface ParsedDate {
  readonly date: string | null;
  readonly precision: 'day' | 'month' | null;
}

/**
 * A GovWin date, with the precision it was written at.
 *
 * `mm/dd/yyyy` is a day. `mm/yyyy` is a month and is anchored to the first, which is a storage
 * convention rather than a claim — the precision column is what carries the claim. Anything else,
 * including the literal `MULTIPLE` that 26 rows of the first export use for a response date, is absent:
 * a date that cannot be read is not a date to guess at.
 */
export function parseGovwinDate(raw: string): ParsedDate {
  const value = raw.trim();
  if (value === '') return { date: null, precision: null };

  const day = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (day) return { date: `${day[3]}-${day[1]}-${day[2]}`, precision: 'day' };

  const month = /^(\d{2})\/(\d{4})$/.exec(value);
  if (month) return { date: `${month[2]}-${month[1]}-01`, precision: 'month' };

  // Already ISO, which is how the reader returns a real Excel date serial.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, precision: 'day' };

  return { date: null, precision: null };
}

/** The basis GovWin gives for a date, normalised. An unrecognised basis is left absent, not guessed. */
export function parseBasis(raw: string): 'actual' | 'deltek_estimate' | 'government_estimate' | null {
  const value = raw.trim().toLowerCase();
  if (value === 'actual') return 'actual';
  if (value.includes('deltek')) return 'deltek_estimate';
  if (value.includes('government')) return 'government_estimate';
  return null;
}

/**
 * The value column, converted from thousands to dollars.
 *
 * The only place the multiplier is applied. Excel stores these in scientific notation (`1.724E8`),
 * which `Number` reads correctly; a value that does not parse is absent rather than zero, because a
 * zero-dollar opportunity and an unpriced one are different things.
 */
export function parseValueUsd(raw: string): number | null {
  const value = raw.trim().replace(/[$,]/g, '');
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed * THOUSANDS;
}

/** Every six-digit NAICS code on a row, first one first. The label is not split out; see the migration. */
export function parseNaics(raw: string): string[] {
  const seen = new Set<string>();
  for (const match of raw.matchAll(/(?:^|[,;\s])(\d{6})\s*(?:-|$|,)/g)) {
    seen.add(match[1]!);
  }
  return [...seen];
}

/** Contract numbers, dropping GovWin's type prefix. `[C]W15P7T17D0132` is `W15P7T17D0132`. */
export function parseContractNumbers(raw: string): string[] {
  const seen = new Set<string>();
  for (const match of raw.matchAll(/\[[A-Za-z]\]\s*([A-Za-z0-9-]+)/g)) {
    const piid = match[1]!.trim().toUpperCase();
    if (piid !== '') seen.add(piid);
  }
  // An export without the prefixes still yields something usable rather than nothing.
  if (seen.size === 0) {
    for (const token of raw.split(/[\s,;]+/)) {
      const piid = token.trim().toUpperCase();
      if (/^[A-Z0-9-]{6,}$/.test(piid)) seen.add(piid);
    }
  }
  return [...seen];
}

/**
 * The comma-separated expiry list, as the earliest date and a count.
 *
 * A multiple-award record repeats one date per contract, dozens of times. The earliest is the one a
 * recompete turns on; the count is what tells a reader whether that single date represents the whole
 * record or one of forty.
 */
export function parseExpirations(raw: string): { earliest: string | null; count: number } {
  const dates: string[] = [];
  for (const part of raw.split(',')) {
    const parsed = parseGovwinDate(part.trim());
    if (parsed.date !== null) dates.push(parsed.date);
  }
  if (dates.length === 0) return { earliest: null, count: 0 };
  dates.sort();
  return { earliest: dates[0]!, count: dates.length };
}

/** An integer, or absent. Excel gives `55.0` for a whole number. */
export function parseInteger(raw: string): number | null {
  const value = raw.trim();
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Agency name to agency code, from the labels the corpus has already observed.
 *
 * GovWin names agencies rather than coding them, in a four-level hierarchy. The most specific level
 * that resolves wins, because a follow on an office is more useful than one on a department. An
 * unresolved name leaves the code null: a wrong code puts a requirement in the wrong person's feed,
 * which is worse than one that needs its agency filled in.
 */
async function agencyLabels(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ code_value: string; label: string }>(
    `select code_value, label from code_label_current where code_type in ('agency', 'office')`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.label) map.set(row.label.trim().toLowerCase(), row.code_value);
  }
  return map;
}

function resolveAgency(labels: Map<string, string>, levels: readonly string[]): string | null {
  for (const name of [...levels].reverse()) {
    if (name === '') continue;
    const code = labels.get(name.trim().toLowerCase());
    if (code !== undefined) return code;
  }
  return null;
}

export async function loadGovwinExport(
  client: PoolClient,
  filePath: string,
  options: LoadGovwinOptions = {},
): Promise<LoadGovwinResult> {
  const progress = options.onProgress ?? (() => {});
  const fileName = filePath.split('/').pop() ?? filePath;

  const sheet = readSheet(readFileSync(filePath));
  if (sheet.length === 0) throw new Error(`${fileName} has no rows.`);

  const headers = sheet[0]!.map((h) => h.trim());
  const at = (name: string): number => headers.indexOf(name);

  const empty: LoadGovwinResult = {
    run: null, rows: 0, written: 0, unchanged: 0, skippedNoId: 0, naicsWritten: 0,
    contractsWritten: 0, contractsCapped: 0, agencyResolved: 0, agencyUnresolved: 0,
    byStatus: {}, byType: {}, estimatedDates: 0, actualDates: 0, headers,
  };

  if (options.headersOnly === true) {
    progress(`${fileName}: ${headers.length} columns`);
    for (const [index, header] of headers.entries()) progress(`  [${index}] ${header}`);
    return empty;
  }

  const missing = REQUIRED_COLUMNS.filter((name) => at(name) === -1);
  if (missing.length > 0) {
    throw new Error(
      `${fileName} is missing ${missing.join(', ')}, so its rows cannot be keyed. GovWin's column set ` +
        'has changed, or this is a different export. Run with --headers to see what it does have.',
    );
  }

  const labels = await agencyLabels(client);
  const dataRows = sheet.slice(1);
  const limited = options.limit === undefined ? dataRows : dataRows.slice(0, options.limit);

  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let written = 0;
  let unchanged = 0;
  let skippedNoId = 0;
  let naicsWritten = 0;
  let contractsWritten = 0;
  let contractsCapped = 0;
  let agencyResolved = 0;
  let agencyUnresolved = 0;
  let estimatedDates = 0;
  let actualDates = 0;

  const run = await startRun(client, SOURCE_SYSTEM, fileName);

  try {
    for (const row of limited) {
      const govwinId = cell(row, at('Opp ID'));
      if (govwinId === '') {
        skippedNoId += 1;
        continue;
      }

      const status = cell(row, at('Status'));
      const oppType = cell(row, at('Opp Type'));
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      byType[oppType] = (byType[oppType] ?? 0) + 1;

      const solicitation = parseGovwinDate(cell(row, at('Solicitation Date')));
      const basis = parseBasis(cell(row, at('Solicitation Date (Actual/Estimate)')));
      // Counted only where a date exists. Most rows carry a basis with no date — 1,919 said Actual in
      // the first export while only 624 had a day to go with it — so counting the flag alone would
      // report nineteen hundred solicitation dates where there were six hundred.
      if (solicitation.date !== null) {
        if (basis === 'actual') actualDates += 1;
        else if (basis !== null) estimatedDates += 1;
      }

      const award = parseGovwinDate(cell(row, at('Projected Award Date')));
      const response = parseGovwinDate(cell(row, at('Response Date')));
      const expirations = parseExpirations(cell(row, at('Current Expiration Date')));

      const levels = [
        cell(row, at('Organization Level 1')),
        cell(row, at('Organization Level 2')),
        cell(row, at('Organization Level 3')),
        cell(row, at('Organization Level 4')),
      ];
      const agencyCode = resolveAgency(labels, levels);
      if (agencyCode === null) agencyUnresolved += 1;
      else agencyResolved += 1;

      const naics = parseNaics(cell(row, at('NAICS')));
      const allContracts = parseContractNumbers(cell(row, at('Contract Numbers')));
      const contracts = allContracts.slice(0, MAX_CONTRACTS_PER_ROW);
      if (allContracts.length > contracts.length) contractsCapped += 1;

      // The archived payload is the structured reading of the row rather than the row itself, because
      // the row carries Deltek's licensed prose and source_version is stored in the database and
      // rendered into snapshots. Everything the loader acted on is here, so a mapping bug found later
      // is still re-derivable; the analysis is not, and is not ours to keep.
      const payload = {
        govwin_id: govwinId,
        opp_type: oppType,
        status,
        program_name: orNull(cell(row, at('Program Name'))),
        acronym: orNull(cell(row, at('Acronym'))),
        solicitation_number: orNull(cell(row, at('Solicitation Number'))),
        org_level_1: orNull(levels[0]!),
        org_level_2: orNull(levels[1]!),
        org_level_3: orNull(levels[2]!),
        org_level_4: orNull(levels[3]!),
        agency_code: agencyCode,
        primary_requirement: orNull(cell(row, at('Primary Requirement'))),
        place_of_perf_state: orNull(cell(row, at('Place of Perf - State/Prov.'))),
        place_of_perf_country: orNull(cell(row, at('Place of Perf - Country'))),
        place_of_perf_location: orNull(cell(row, at('Place of Perf - Location'))),
        value_usd: parseValueUsd(cell(row, at('Value (USD-$K)'))),
        solicitation_date: solicitation.date,
        solicitation_date_precision: solicitation.precision,
        solicitation_date_basis: basis,
        projected_award_date: award.date,
        projected_award_date_precision: award.precision,
        response_date: response.date,
        earliest_expiration_date: expirations.earliest,
        expiration_date_count: expirations.count,
        duration: orNull(cell(row, at('Duration'))),
        competition_type: orNull(cell(row, at('Competition Type'))),
        contract_type: orNull(cell(row, at('Contract Type'))),
        type_of_award: orNull(cell(row, at('Type of Award'))),
        contract_numbers: orNull(cell(row, at('Contract Numbers'))),
        incumbent_names: orNull(cell(row, at('Incumbent/Contractor'))),
        advertised_interest: parseInteger(cell(row, at('Advertised Interest'))),
        govwin_created_date: parseGovwinDate(cell(row, at('Created Date'))).date,
        naics,
        contract_count: allContracts.length,
      };

      if (options.dryRun === true) continue;

      const version = await recordVersion(client, run, govwinId, payload);
      if (!version.changed) {
        // Still touch the row, so "when did GovWin last confirm this" stays answerable even on a week
        // where nothing about it moved.
        await client.query(`update govwin_opportunity set last_seen_at = now() where govwin_id = $1`, [
          govwinId,
        ]);
        unchanged += 1;
        continue;
      }

      await client.query(
        `insert into govwin_opportunity (
           govwin_id, opp_type, status, program_name, acronym, solicitation_number,
           org_level_1, org_level_2, org_level_3, org_level_4, agency_code,
           primary_requirement, place_of_perf_state, place_of_perf_country, place_of_perf_location,
           value_usd,
           solicitation_date, solicitation_date_precision, solicitation_date_basis,
           projected_award_date, projected_award_date_precision, response_date,
           earliest_expiration_date, expiration_date_count,
           duration, competition_type, contract_type, type_of_award, contract_numbers,
           incumbent_names, advertised_interest, govwin_created_date, govwin_url,
           source_version_id, last_seen_at
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::numeric,
           $17::date,$18,$19,$20::date,$21,$22::date,$23::date,$24,
           $25,$26,$27,$28,$29,$30,$31,$32::date,$33,$34,now()
         )
         on conflict (govwin_id) do update set
           opp_type = excluded.opp_type,
           status = excluded.status,
           program_name = excluded.program_name,
           acronym = excluded.acronym,
           solicitation_number = excluded.solicitation_number,
           org_level_1 = excluded.org_level_1,
           org_level_2 = excluded.org_level_2,
           org_level_3 = excluded.org_level_3,
           org_level_4 = excluded.org_level_4,
           agency_code = excluded.agency_code,
           primary_requirement = excluded.primary_requirement,
           place_of_perf_state = excluded.place_of_perf_state,
           place_of_perf_country = excluded.place_of_perf_country,
           place_of_perf_location = excluded.place_of_perf_location,
           value_usd = excluded.value_usd,
           solicitation_date = excluded.solicitation_date,
           solicitation_date_precision = excluded.solicitation_date_precision,
           solicitation_date_basis = excluded.solicitation_date_basis,
           projected_award_date = excluded.projected_award_date,
           projected_award_date_precision = excluded.projected_award_date_precision,
           response_date = excluded.response_date,
           earliest_expiration_date = excluded.earliest_expiration_date,
           expiration_date_count = excluded.expiration_date_count,
           duration = excluded.duration,
           competition_type = excluded.competition_type,
           contract_type = excluded.contract_type,
           type_of_award = excluded.type_of_award,
           contract_numbers = excluded.contract_numbers,
           incumbent_names = excluded.incumbent_names,
           advertised_interest = excluded.advertised_interest,
           govwin_created_date = excluded.govwin_created_date,
           govwin_url = excluded.govwin_url,
           source_version_id = excluded.source_version_id,
           last_seen_at = now()`,
        [
          govwinId, oppType, status, payload.program_name, payload.acronym, payload.solicitation_number,
          payload.org_level_1, payload.org_level_2, payload.org_level_3, payload.org_level_4, agencyCode,
          payload.primary_requirement, payload.place_of_perf_state, payload.place_of_perf_country,
          payload.place_of_perf_location, payload.value_usd,
          solicitation.date, solicitation.precision, basis,
          award.date, award.precision, response.date,
          expirations.earliest, expirations.count,
          payload.duration, payload.competition_type, payload.contract_type, payload.type_of_award,
          payload.contract_numbers, payload.incumbent_names, payload.advertised_interest,
          payload.govwin_created_date, `https://iq.govwin.com/neo/opportunity/view/${govwinId}`,
          version.sourceVersionId,
        ],
      );

      // Replaced rather than merged: a code or a contract dropped from the export has been dropped, and
      // leaving it behind would keep a join alive that the source no longer supports.
      await client.query(`delete from govwin_opportunity_naics where govwin_id = $1`, [govwinId]);
      for (const [index, code] of naics.entries()) {
        const { rowCount } = await client.query(
          `insert into govwin_opportunity_naics (govwin_id, naics_code, is_primary)
           values ($1, $2, $3) on conflict do nothing`,
          [govwinId, code, index === 0],
        );
        naicsWritten += rowCount ?? 0;
      }

      await client.query(`delete from govwin_opportunity_contract where govwin_id = $1`, [govwinId]);
      for (const piid of contracts) {
        const { rowCount } = await client.query(
          `insert into govwin_opportunity_contract (govwin_id, piid)
           values ($1, $2) on conflict do nothing`,
          [govwinId, piid],
        );
        contractsWritten += rowCount ?? 0;
      }

      written += 1;
    }

    await finishRun(client, run);
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  return {
    run, rows: limited.length, written, unchanged, skippedNoId, naicsWritten, contractsWritten,
    contractsCapped, agencyResolved, agencyUnresolved, byStatus, byType, estimatedDates,
    actualDates, headers,
  };
}
