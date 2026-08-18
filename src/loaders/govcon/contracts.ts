/**
 * Contract actions from GovCon API.
 *
 * This is FPDS data, the same thing the bulk extract carries, arriving through the API. It exists for
 * two things the extract cannot do, and it is important to be precise about which — the temptation is
 * to treat it as a replacement for the corpus, and it is not one.
 *
 * **What it adds.** Recency: coverage is refreshed daily, so a contract awarded last week is here
 * without waiting for the next extract. And breadth: a company the extract never covered — a
 * competitor, a possible teammate — can be filled in one lookup rather than not at all.
 *
 * **What it cannot add: history.** Coverage is comprehensive from FY2025 (October 2024) onward, and
 * older fiscal years are a sparse backfill. That is fatal for the two things that need depth, and the
 * arithmetic is worth spelling out rather than discovering later:
 *
 *   `office_recompete_cadence` learns a rhythm from follow-on chains, and a chain needs a contract
 *   that *ended* plus a successor starting within [end − 180d, end + 365d]. `MIN_CADENCE_CHAINS` is 3
 *   and `MIN_USABLE_CADENCE_DAYS` is 365. Inside a window that only opens in late 2024 you cannot
 *   observe three separate lineages each turning over on an interval of a year or more. So an
 *   API-only corpus yields approximately zero learned cadence, and every projection falls back to the
 *   365-day default.
 *
 *   `forecast_backtest` scores a projection made as of a past date against what actually happened
 *   after it. With no history before the as-of date there is nothing to project from.
 *
 * So the split is: **the corpus owns depth, this owns recency and breadth.** Both write through
 * `src/loaders/contract.ts` on the spec 7.2 natural key, so a transaction arriving from both
 * converges on one row rather than double-counting an obligation. `npm run check:convergence` enforces
 * that no loader grows a second write path.
 *
 * `companies/{uei}/awards` is the one exception to the window and is a Pro-plan endpoint: it returns a
 * company's full history ungated. That is the only route to real depth here, and it is per company
 * rather than per office — enough to complete Astrion's own incumbency and a named competitor set,
 * not enough to learn how an office behaves.
 *
 * **The mapping error that would be worst.** `/contracts/{piid}` returns the latest transaction plus a
 * `transaction_rollup` summing every transaction on that PIID. Writing a rollup into
 * `contract_action` would create one row carrying a whole contract's obligation as if it were a single
 * action. `cie_award_shape_asof` would then compute the wrong shape, campaign sizing would
 * double-count against the transactions, and nothing would error. `rejectRollup` below refuses any
 * record carrying rollup markers, and there is a test for it.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun } from '../../lib/provenance.js';
import {
  writeContractAction,
  sourceRecordIdFor,
  LabelTally,
  type NormalizedTransaction,
} from '../contract.js';
import { EntityResolver } from '../../resolve/entity-resolver.js';
import { profileCodes } from '../../signals/profile.js';
import { GovconClient, MAX_PAGE, type ClientOptions } from './client.js';

export const SOURCE_SYSTEM = 'govcon_contract';

/** The cursor's endpoint key, independent of the opportunities cursor. */
export const SEARCH_ENDPOINT = '/contracts/search';

/**
 * The first fiscal year GovCon API covers comprehensively.
 *
 * Anything earlier is a sparse backfill on their side, so a run reaching before this is not wrong but
 * is not complete either, and a caller must be told which it got.
 */
export const COVERAGE_STARTS = '2024-10-01';

/** How far back a first pull reaches when there is no cursor. */
export const DEFAULT_FIRST_PULL_DAYS = 90;

/**
 * A contract transaction as GovCon API returns it.
 *
 * Field names are the documented FPDS-derived ones. Aliases are declared where the guide and the
 * endpoint could reasonably differ, and `--sample` prints the real keys on first contact so the
 * mapping is confirmed rather than assumed.
 */
export interface GovconContract {
  contract_award_unique_key?: string;
  award_unique_key?: string;

  piid?: string;
  award_id_piid?: string;
  modification_number?: string;
  award_modification_amendment_number?: string;
  transaction_number?: string;

  parent_award_id_piid?: string;
  idv_piid?: string;
  referenced_idv_agency_iden?: string;
  idv_agency_code?: string;
  award_type?: string;
  award_type_code?: string;

  action_date?: string;
  signed_date?: string;
  period_of_performance_start_date?: string;
  period_of_performance_current_end_date?: string;
  period_of_performance_potential_end_date?: string;

  federal_action_obligation?: string | number;
  action_obligation?: string | number;
  base_and_all_options_value?: string | number;
  total_dollars_obligated?: string | number;

  awarding_agency_code?: string;
  awarding_department_code?: string;
  awarding_sub_agency_code?: string;
  awarding_office_code?: string;
  funding_agency_code?: string;
  funding_office_code?: string;
  primary_place_of_performance_state_code?: string;
  place_of_performance_state?: string;

  extent_competed?: string;
  type_of_set_aside?: string;
  set_aside_type?: string;
  number_of_offers_received?: string | number;

  recipient_name?: string;
  recipient_uei?: string;
  recipient_cage_code?: string;
  vendor_name?: string;

  naics_code?: string;
  naics_description?: string;
  product_or_service_code?: string;
  psc_code?: string;
  product_or_service_code_description?: string;
  psc_description?: string;

  awarding_agency_name?: string;
  awarding_office_name?: string;

  /** Present on the detail endpoint, and the reason `rejectRollup` exists. */
  transaction_rollup?: unknown;
  subaward_rollup?: unknown;

  [key: string]: unknown;
}

export interface PullOptions extends ClientOptions {
  readonly signedFrom?: Date;
  readonly signedTo?: Date;
  readonly firstPullDays?: number;
  readonly pageSize?: number;
  readonly dryRun?: boolean;
  readonly sample?: boolean;
  /**
   * Pull these companies' full history instead of a date-filtered search.
   *
   * Uses `companies/{uei}/awards`, which is not window-gated and is Pro-tier. This is the only way to
   * get real depth out of the API, and it is per company.
   */
  readonly ueis?: readonly string[];
}

export interface PullResult {
  readonly requests: number;
  readonly fetched: number;
  readonly written: number;
  readonly unchanged: number;
  readonly skippedUnkeyable: number;
  readonly skippedRollup: number;
  readonly skippedBeforeCoverage: number;
  readonly labelsWritten: number;
  readonly classificationsWritten: number;
  readonly unresolvedVendors: number;
  readonly resolvedByMethod: Record<string, number>;
  readonly signedFrom: Date;
  readonly signedTo: Date;
  readonly cursorAdvancedTo: Date | null;
  readonly reachedBeforeCoverage: boolean;
  readonly stoppedEarly: string | null;
  readonly sampleKeys: string[] | null;
  readonly rateLimitRemaining: number | null;
  readonly mode: 'search' | 'company';
}

function first(...values: (string | undefined | null)[]): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}

function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function money(...values: (string | number | undefined | null)[]): number | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function integer(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Is this record a rollup rather than a transaction?
 *
 * The detail endpoint returns the latest transaction *plus* a rollup across every transaction on the
 * PIID, and `total_dollars_obligated` is the rollup's figure rather than this action's. A record
 * carrying either marker is refused rather than written, because writing it would put one row in
 * `contract_action` holding a whole contract's obligation as though it were a single action — and
 * every downstream sum would be wrong without anything failing.
 *
 * Deliberately conservative: it refuses on the presence of the marker, not on a judgement about
 * whether the numbers look like a rollup. A false refusal costs one transaction and is visible in the
 * `skippedRollup` count; a false accept corrupts the corpus quietly.
 */
export function isRollup(record: GovconContract): boolean {
  if (record.transaction_rollup !== undefined && record.transaction_rollup !== null) return true;
  if (record.subaward_rollup !== undefined && record.subaward_rollup !== null) return true;
  // A record with the rollup total but no per-action obligation is the same hazard wearing a
  // different field name.
  const hasActionFigure =
    record.federal_action_obligation !== undefined || record.action_obligation !== undefined;
  if (record.total_dollars_obligated !== undefined && !hasActionFigure) return true;
  return false;
}

/**
 * A GovCon contract record as this system stores it.
 *
 * Two mappings need explaining.
 *
 * **The transaction number.** FPDS leaves it blank on a base award, and the natural key cannot hold a
 * null, so the empty string stands in — same as the bulk loader. Unlike the bulk loader this does not
 * issue a content-derived surrogate: the API supplies a globally-unique award key instead, and
 * inventing a second synthetic identity alongside it would make the two sources disagree about the
 * key for the same transaction, which is precisely what breaks convergence.
 *
 * **The end date.** `period_of_performance_current_end_date` is the current end and
 * `..._potential_end_date` is the end with all options exercised. They map to
 * `current_completion_date` and `ultimate_completion_date` respectively, and the distinction matters:
 * the forecast projects from the ultimate date, so swapping them would move every projection by the
 * length of the option years.
 */
export function normalize(record: GovconContract): NormalizedTransaction | null {
  const piid = first(record.piid, record.award_id_piid);
  const awardingAgencyCode = first(record.awarding_agency_code, record.awarding_sub_agency_code);

  // Without both key parts there is nothing to write. Counted, never guessed at.
  if (piid === null || awardingAgencyCode === null) return null;

  return {
    awardingAgencyCode,
    piid,
    modificationNumber:
      first(record.modification_number, record.award_modification_amendment_number) ?? '',
    transactionNumber: first(record.transaction_number) ?? '',

    idvPiid: first(record.idv_piid, record.parent_award_id_piid),
    idvAgencyCode: first(record.idv_agency_code, record.referenced_idv_agency_iden),
    awardType: first(record.award_type, record.award_type_code),

    signedDate: isoDay(record.signed_date ?? record.action_date),
    effectiveDate: isoDay(record.period_of_performance_start_date),
    currentCompletionDate: isoDay(record.period_of_performance_current_end_date),
    ultimateCompletionDate: isoDay(record.period_of_performance_potential_end_date),

    actionObligation: money(record.federal_action_obligation, record.action_obligation),
    baseAndAllOptions: money(record.base_and_all_options_value),

    contractingDepartmentCode: first(record.awarding_department_code),
    contractingAgencyCode: first(record.awarding_agency_code, record.awarding_sub_agency_code),
    contractingOfficeCode: first(record.awarding_office_code),
    fundingAgencyCode: first(record.funding_agency_code),
    fundingOfficeCode: first(record.funding_office_code),
    placeOfPerformanceState: first(
      record.primary_place_of_performance_state_code,
      record.place_of_performance_state,
    ),

    extentCompeted: first(record.extent_competed),
    setAsideType: first(record.type_of_set_aside, record.set_aside_type),
    numberOfOffersReceived: integer(record.number_of_offers_received),

    vendorNameRaw: first(record.recipient_name, record.vendor_name),
    vendorUei: first(record.recipient_uei),
    vendorCage: first(record.recipient_cage_code),

    naicsCode: first(record.naics_code),
    pscCode: first(record.product_or_service_code, record.psc_code),

    awardKey: first(record.contract_award_unique_key, record.award_unique_key),
  };
}

/** The labels a record can teach, so codes do not arrive without anything to display. */
function observeLabels(tally: LabelTally, record: GovconContract, txn: NormalizedTransaction): void {
  tally.observe('naics', txn.naicsCode, first(record.naics_description));
  tally.observe(
    'psc',
    txn.pscCode,
    first(record.product_or_service_code_description, record.psc_description),
  );
  tally.observe('agency', txn.awardingAgencyCode, first(record.awarding_agency_name));
  tally.observe('office', txn.contractingOfficeCode, first(record.awarding_office_name));
}

export async function readCursor(client: PoolClient): Promise<{ cursor_at: Date } | null> {
  const { rows } = await client.query<{ cursor_at: Date }>(
    `select cursor_at from sync_cursor where source_system = $1 and endpoint = $2`,
    [SOURCE_SYSTEM, SEARCH_ENDPOINT],
  );
  return rows[0] ?? null;
}

/**
 * Pull contract transactions and write them through the shared path.
 *
 * Two modes. Without `ueis` it searches by the profile's NAICS codes over a signed-date range, which
 * is the scheduled shape. With `ueis` it walks `companies/{uei}/awards`, which is Pro-tier and
 * ungated by the plan window — the deep-history route, per company.
 *
 * The cursor follows the same rules as the opportunities sync: it advances to the instant the run
 * started, and not at all when the run stopped early, because a partial run that advanced would
 * silently lose whatever it never reached.
 */
export async function pullContracts(
  client: PoolClient,
  options: PullOptions = {},
): Promise<PullResult> {
  const api = new GovconClient(options);
  const progress = options.onProgress ?? (() => {});
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE, MAX_PAGE);
  const mode: 'search' | 'company' = options.ueis && options.ueis.length > 0 ? 'company' : 'search';

  const runStartedAt = new Date();
  const stored = await readCursor(client);
  const signedTo = options.signedTo ?? runStartedAt;
  const signedFrom =
    options.signedFrom ??
    stored?.cursor_at ??
    new Date(runStartedAt.getTime() - (options.firstPullDays ?? DEFAULT_FIRST_PULL_DAYS) * 86_400_000);

  if (signedFrom >= signedTo) {
    throw new Error('The signed-date range is empty: --from must be before --to.');
  }

  const coverageStart = new Date(`${COVERAGE_STARTS}T00:00:00Z`);
  const reachedBeforeCoverage = mode === 'search' && signedFrom < coverageStart;
  if (reachedBeforeCoverage) {
    progress(
      `Asked for actions signed from ${isoDay(signedFrom.toISOString())}, which is before GovCon ` +
        `API's comprehensive coverage begins (${COVERAGE_STARTS}). Anything earlier is a sparse ` +
        'backfill on their side, so this run is not a complete picture of that period. The bulk ' +
        'FPDS extract is what covers it: npm run load:fpds.',
    );
  }

  // The resolver is loaded once and reused, same as the bulk loader, so an API-sourced transaction is
  // exactly as resolvable as a CSV-sourced one rather than quietly less so.
  const resolver = await EntityResolver.load(client);
  const labelTally = new LabelTally();

  const naics = mode === 'search' ? await profileCodes(client, 'naics') : [];
  if (mode === 'search' && naics.length === 0) {
    throw new Error(
      'The opportunity profile has no NAICS codes, and /contracts/search needs a filter. Run ' +
        '`npm run profile` first, or pull specific companies with --uei.',
    );
  }

  const byMethod: Record<string, number> = {};
  let fetched = 0;
  let written = 0;
  let unchanged = 0;
  let skippedUnkeyable = 0;
  let skippedRollup = 0;
  let skippedBeforeCoverage = 0;
  let classificationsWritten = 0;
  let unresolvedVendors = 0;
  let sampleKeys: string[] | null = null;

  const run = await startRun(
    client,
    SOURCE_SYSTEM,
    mode === 'company'
      ? `companies ${options.ueis!.join(',')}`
      : `signed ${isoDay(signedFrom.toISOString())}..${isoDay(signedTo.toISOString())}`,
  );

  // The natural key seen in this run, so a transaction returned by two different code searches is
  // written once rather than counted twice.
  const seen = new Set<string>();

  // And the same for rollups. A contract carrying two of the profile's codes comes back from both
  // searches, so counting every occurrence would report eleven rollups where there was one — a figure
  // an operator would reasonably read as a data problem rather than as arithmetic. Keyed on the award
  // key, falling back to the PIID, because a rollup has no transaction identity by definition.
  const seenRollup = new Set<string>();

  try {
    const requests: { path: string; params: Record<string, string | number | undefined> }[] =
      mode === 'company'
        ? options.ueis!.map((uei) => ({
            path: `/companies/${encodeURIComponent(uei)}/awards`,
            params: {},
          }))
        : naics.map((code) => ({
            path: SEARCH_ENDPOINT,
            params: {
              naics: code.code_value,
              date_from: isoDay(signedFrom.toISOString()) ?? undefined,
              date_to: isoDay(signedTo.toISOString()) ?? undefined,
            },
          }));

    for (const request of requests) {
      for await (const page of api.pages<GovconContract>(request.path, request.params, pageSize)) {
        for (const record of page) {
          fetched += 1;
          if (sampleKeys === null && options.sample === true) sampleKeys = Object.keys(record).sort();

          // Before anything else. A rollup written as a transaction is the one error here that
          // corrupts every downstream sum without failing.
          if (isRollup(record)) {
            const rollupKey =
              first(record.contract_award_unique_key, record.award_unique_key, record.piid, record.award_id_piid) ??
              `unidentified:${skippedRollup}`;
            if (!seenRollup.has(rollupKey)) {
              seenRollup.add(rollupKey);
              skippedRollup += 1;
            }
            continue;
          }

          const txn = normalize(record);
          if (txn === null) {
            // Counted per occurrence rather than per distinct record, because a record with no PIID
            // and no awarding agency has no identity to deduplicate on — that is what makes it
            // unkeyable. Any figure above zero is worth looking at; the exact value is not.
            skippedUnkeyable += 1;
            continue;
          }

          const key = sourceRecordIdFor(txn);
          if (seen.has(key)) continue;
          seen.add(key);

          // After the dedup, so this counts transactions and not the number of code searches that
          // happened to return each one.
          const signed = txn.signedDate;
          if (signed !== null && signed < COVERAGE_STARTS) skippedBeforeCoverage += 1;

          if (options.dryRun === true) {
            observeLabels(labelTally, record, txn);
            continue;
          }

          const result = await writeContractAction(client, run, txn, record as Record<string, unknown>, resolver);
          observeLabels(labelTally, record, txn);

          if (!result.changed) {
            unchanged += 1;
            continue;
          }

          written += 1;
          classificationsWritten += result.classificationsWritten;
          const method = result.resolution!.method;
          byMethod[method] = (byMethod[method] ?? 0) + 1;
          if (result.resolution!.entityId === null) unresolvedVendors += 1;
        }
      }
      if (api.stoppedEarly !== null) break;
    }

    const labelsWritten =
      options.dryRun === true ? 0 : await labelTally.flush(client, SOURCE_SYSTEM);

    // A company pull covers whatever history that company has, not a window ending now, so it must
    // not move a cursor that means "everything signed up to here has been pulled".
    let cursorAdvancedTo: Date | null = null;
    if (options.dryRun !== true && mode === 'search' && api.stoppedEarly === null) {
      cursorAdvancedTo = runStartedAt;
      await client.query(
        `insert into sync_cursor (
           source_system, endpoint, cursor_at, last_since, last_clamped, last_clamp_note,
           last_run_id, records_seen, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (source_system, endpoint) do update set
           cursor_at       = excluded.cursor_at,
           last_since      = excluded.last_since,
           last_clamped    = excluded.last_clamped,
           last_clamp_note = excluded.last_clamp_note,
           last_run_id     = excluded.last_run_id,
           records_seen    = excluded.records_seen,
           updated_at      = now()`,
        [
          SOURCE_SYSTEM,
          SEARCH_ENDPOINT,
          runStartedAt,
          signedFrom,
          reachedBeforeCoverage,
          reachedBeforeCoverage
            ? `Reached before ${COVERAGE_STARTS}, where GovCon API's coverage is a sparse backfill. ` +
              'The bulk FPDS extract is what covers that period.'
            : null,
          run.runId,
          fetched,
        ],
      );
    }

    await finishRun(client, run);

    return {
      requests: api.requests, fetched, written, unchanged, skippedUnkeyable, skippedRollup,
      skippedBeforeCoverage, labelsWritten, classificationsWritten, unresolvedVendors,
      resolvedByMethod: byMethod, signedFrom, signedTo, cursorAdvancedTo, reachedBeforeCoverage,
      stoppedEarly: api.stoppedEarly, sampleKeys, rateLimitRemaining: api.rateLimit.remaining, mode,
    };
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
