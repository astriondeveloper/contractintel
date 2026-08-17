/**
 * Scoring the forecast against what actually happened.
 *
 * The forecast is the least verifiable thing in this build. Every other screen shows
 * something the corpus already contains, so a mistake in it is visible to anybody who looks
 * at the source row. A forecast is a claim about 2028, and the honest answer to "how accurate
 * is it" is otherwise "ask me in 2028".
 *
 * So it is scored backwards. Recompute the projection as it would have stood on a past date,
 * using only what was knowable then, and look at what the corpus says happened next.
 *
 * **What the forecast actually claims.** Two things, and they are worth separating because one
 * is nearly free and the other is the whole value:
 *
 *   That this contract will be re-competed at all. Not free. Plenty of contracts end and are
 *   never re-let: the work stops, gets absorbed into a bigger vehicle, or the office extends
 *   the incumbent for years. This is the claim the confidence bands are about, and the hit
 *   rate is how it is scored.
 *
 *   That the follow-on lands near the end of the current period. Nearly free for a contract
 *   with a firm end date, which is why the hit test is generous about timing and the timing
 *   claim is reported separately as a distribution of how far off each hit was. Reporting a
 *   high hit rate from a wide window and calling it accuracy would be the easiest way to
 *   mislead with this table, so the window is on the run and on the screen.
 *
 * **What counts as a hit.** The corpus shows a follow-on award succeeding the same contract:
 * the same office buying the same PSC again, starting around the time this contract ends,
 * which is `cie_followon_chain_asof`'s definition and the same one the cadence is learned
 * from. The award has to have been made after the as-of date, or the projection would be
 * scored against something that had already happened when it was made.
 *
 * **What the hit rate does not measure.** Recall over every recompete in the window, because
 * the forecast projects every contract ending in its horizon and would score close to one by
 * construction. `unforecast` measures the useful version instead: recompetes that happened in
 * the window whose contract this forecast never had a candidate for, because its end date was
 * outside the horizon or the contract carried no office or PSC. That is a statement about
 * coverage rather than about precision, and it is the number that says what the forecast is
 * blind to.
 *
 * **The leak this is built to avoid.** A backtest that learns from data it should not have had
 * reports a hit rate it cannot repeat. Two guards: `cie_award_shape_asof` excludes
 * modifications signed after the as-of date, so an end date extended in 2025 is invisible to a
 * 2023 projection, and `cie_followon_chain_asof` excludes chains whose follow-on had not been
 * awarded yet, so a rhythm cannot be learned from the award being predicted. Without both, this
 * file would produce a reassuring number and nothing else.
 */
import type { PoolClient } from 'pg';
import { projectAsOf, type Confidence, type ForecastOptions, type Projection } from './forecast.js';

/**
 * How far from the projected period end a follow-on award can land and still count.
 *
 * A year. Generous, and deliberately so: a recompete that slips two quarters is a recompete
 * BD needed to know about, and a tolerance tight enough to call that a miss would push the
 * method towards projecting nothing it was not certain of. The figure is stored on every run
 * and shown beside every hit rate, because a hit rate without its tolerance is not a number.
 */
export const DEFAULT_TOLERANCE_DAYS = 365;

export interface BacktestOptions extends ForecastOptions {
  readonly asOf: Date;
  readonly toleranceDays?: number;
  /** Work it out and report, write no backtest row. */
  readonly dryRun?: boolean;
}

export interface ScoredProjection {
  readonly projection: Projection;
  readonly outcome: 'hit' | 'miss';
  readonly matchedPiid: string | null;
  readonly matchedSignedDate: Date | null;
  readonly daysOff: number | null;
}

export interface BacktestResult {
  readonly backtestId: number | null;
  readonly asOf: string;
  readonly horizonMonths: number;
  readonly toleranceDays: number;
  readonly method: string;

  readonly projected: number;
  readonly hits: number;
  readonly misses: number;
  /** Projections whose period end has not passed yet, so there is nothing to score them against. */
  readonly unresolved: number;
  readonly unforecast: number;

  readonly byConfidence: Record<Confidence, { projected: number; hits: number }>;
  /** Absolute days between the projected period end and the follow-on award, on hits only. */
  readonly medianDaysOff: number | null;
  readonly scored: readonly ScoredProjection[];
}

interface FollowOn {
  readonly awarding_agency_code: string;
  readonly idv_piid_key: string;
  readonly piid: string;
  readonly prior_ends_on: Date;
  readonly next_piid: string;
  readonly next_starts_on: Date;
}

/**
 * Every follow-on the corpus knows about, keyed by the contract it succeeded.
 *
 * Read with no as-of date, because this is the answer sheet: it is what actually happened,
 * including everything that happened after the projection was made. The as-of discipline
 * applies to the inputs of the projection and never to this.
 */
async function followOns(client: PoolClient, after: string): Promise<Map<string, FollowOn>> {
  const { rows } = await client.query<FollowOn>(
    `select awarding_agency_code, prior_idv_piid_key as idv_piid_key, prior_piid as piid,
            prior_ends_on, next_piid, next_starts_on
       from contract_followon_chain
      where next_starts_on > $1::date`,
    [after],
  );

  const byContract = new Map<string, FollowOn>();
  for (const row of rows) {
    byContract.set(`${row.awarding_agency_code}|${row.idv_piid_key}|${row.piid}`, row);
  }
  return byContract;
}

/**
 * Recompetes in the scored window that this forecast had no candidate for.
 *
 * The contract behind them ended outside the horizon the projection looked at, or carried no
 * office or PSC and so never entered the cadence world at all. Counted rather than ignored:
 * a report that only ever divides hits by its own projections cannot tell a narrow forecast
 * from an accurate one.
 */
async function unforecastCount(
  client: PoolClient,
  asOf: string,
  windowEnd: string,
  projectedKeys: readonly string[],
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n
       from contract_followon_chain c
      where c.next_starts_on > $1::date
        and c.next_starts_on <= $2::date
        and not (('forecast:end:' || c.awarding_agency_code || ':' || c.prior_idv_piid_key
                  || ':' || c.prior_piid) = any($3::text[]))`,
    [asOf, windowEnd, projectedKeys],
  );
  return Number(rows[0]?.n ?? 0);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export function describeMethod(toleranceDays: number): string {
  return (
    'Projections recomputed from actions signed on or before the as-of date, so a later ' +
    'modification cannot supply the end date and a later award cannot supply the cadence. ' +
    'A projection hits when the corpus shows a follow-on award succeeding the same contract, ' +
    'as cie_followon_chain_asof defines it, awarded after the as-of date and starting within ' +
    `${toleranceDays} days of the projected period end. Only projections whose period end plus ` +
    'that tolerance has already passed are scored; the rest are reported as unresolved. ' +
    'unforecast counts follow-on awards in the window whose contract the projection had no ' +
    'candidate for, which measures coverage rather than precision.'
  );
}

export async function runBacktest(
  client: PoolClient,
  options: BacktestOptions,
): Promise<BacktestResult> {
  const toleranceDays = options.toleranceDays ?? DEFAULT_TOLERANCE_DAYS;
  const asOf = isoDay(options.asOf);
  const today = new Date();

  if (options.asOf.getTime() > today.getTime()) {
    throw new Error(
      `The as-of date ${asOf} is in the future. A backtest scores a projection against what ` +
        'happened afterwards, so there has to be an afterwards.',
    );
  }

  // Only the contract-end basis is scored. A vehicle expiry projects an on-ramp competition,
  // and a replacement vehicle does not appear in FPDS as a follow-on to the old one under the
  // same PSC in the same office, so there is nothing here to score it against. Reporting a hit
  // rate that quietly excluded them would be worse than saying so: they are excluded, and the
  // vehicle projections still carry their own evidence on the screen.
  const set = await projectAsOf(client, {
    ...options,
    contractsOnly: true,
    // A backtest scores what the forecast said would happen next, so it looks forward from the
    // as-of date only. The backfill window exists to surface overdue solicitations to a reader
    // and has no place in a score.
    backfillMonths: 0,
  });

  const horizonMonths = set.horizonMonths;
  const windowEnd = isoDay(addDays(options.asOf, Math.round(horizonMonths * 30.44)));
  const actual = await followOns(client, asOf);

  const byConfidence: Record<Confidence, { projected: number; hits: number }> = {
    high: { projected: 0, hits: 0 },
    medium: { projected: 0, hits: 0 },
    low: { projected: 0, hits: 0 },
  };

  const scored: ScoredProjection[] = [];
  const daysOffOnHits: number[] = [];
  let unresolved = 0;

  for (const projection of set.kept) {
    // Nothing can be said about a projection whose window has not closed yet.
    const resolvesOn = addDays(projection.period_end_date, toleranceDays);
    if (resolvesOn.getTime() > today.getTime()) {
      unresolved += 1;
      continue;
    }

    const key = `${projection.agency_code ?? ''}|${projection.idv_piid ?? ''}|${projection.related_piid ?? ''}`;
    const match = actual.get(key) ?? null;
    const daysOff =
      match === null
        ? null
        : Math.round(
            (new Date(match.next_starts_on).getTime() - projection.period_end_date.getTime()) /
              (24 * 60 * 60 * 1000),
          );

    const isHit = match !== null && daysOff !== null && Math.abs(daysOff) <= toleranceDays;

    byConfidence[projection.confidence].projected += 1;
    if (isHit) {
      byConfidence[projection.confidence].hits += 1;
      daysOffOnHits.push(Math.abs(daysOff!));
    }

    scored.push({
      projection,
      outcome: isHit ? 'hit' : 'miss',
      matchedPiid: isHit ? match!.next_piid : null,
      matchedSignedDate: isHit ? new Date(match!.next_starts_on) : null,
      daysOff: isHit ? daysOff : null,
    });
  }

  const hits = scored.filter((s) => s.outcome === 'hit').length;
  const misses = scored.length - hits;
  const unforecast = await unforecastCount(
    client,
    asOf,
    windowEnd,
    set.kept.map((p) => p.forecast_key),
  );

  const method = describeMethod(toleranceDays);
  const result: Omit<BacktestResult, 'backtestId'> = {
    asOf,
    horizonMonths,
    toleranceDays,
    method,
    projected: scored.length,
    hits,
    misses,
    unresolved,
    unforecast,
    byConfidence,
    medianDaysOff: median(daysOffOnHits),
    scored,
  };

  if (options.dryRun === true) return { ...result, backtestId: null };

  const { rows } = await client.query<{ backtest_id: string }>(
    `insert into forecast_backtest (
       as_of_date, horizon_months, tolerance_days, method,
       projected, hits, misses, unforecast,
       hits_high, projected_high, hits_medium, projected_medium, hits_low, projected_low, notes
     ) values (
       $1::date, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, $15
     ) returning backtest_id`,
    [
      asOf,
      horizonMonths,
      toleranceDays,
      method,
      scored.length,
      hits,
      misses,
      unforecast,
      byConfidence.high.hits,
      byConfidence.high.projected,
      byConfidence.medium.hits,
      byConfidence.medium.projected,
      byConfidence.low.hits,
      byConfidence.low.projected,
      `${unresolved} projection(s) excluded as unresolved: their period end plus the tolerance ` +
        `has not passed. Median absolute error on hits: ` +
        `${median(daysOffOnHits) === null ? 'no hits' : `${median(daysOffOnHits)} days`}.`,
    ],
  );

  const backtestId = Number(rows[0]!.backtest_id);

  for (const item of scored) {
    await client.query(
      `insert into forecast_backtest_item (
         backtest_id, agency_code, office_code, psc_code, related_piid,
         projected_solicitation_date, projected_fy, projected_quarter, confidence, lead_source,
         estimated_value, outcome, matched_piid, matched_signed_date, days_off
       ) values (
         $1::bigint, $2, $3, $4, $5,
         $6::date, $7, $8, $9, $10,
         $11::numeric, $12, $13, $14::date, $15
       )`,
      [
        backtestId,
        item.projection.agency_code,
        item.projection.office_code,
        item.projection.psc_code,
        item.projection.related_piid,
        isoDay(item.projection.projected),
        item.projection.projected_fy,
        item.projection.projected_quarter,
        item.projection.confidence,
        item.projection.lead.source,
        item.projection.estimated_value,
        item.outcome,
        item.matchedPiid,
        item.matchedSignedDate === null ? null : isoDay(item.matchedSignedDate),
        item.daysOff,
      ],
    );
  }

  return { ...result, backtestId };
}
