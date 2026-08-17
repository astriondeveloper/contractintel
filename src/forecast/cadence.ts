/**
 * How often an office re-lets the same kind of work, and how much a lead time is worth.
 *
 * This is the part of the forecast that is learned rather than assumed, so it is separated
 * from the projection itself and reads only. Everything here answers one of two questions
 * about a single office:
 *
 *   Does this office actually re-compete this kind of work, and on what rhythm?
 *   How long does this office take between announcing a requirement and awarding it?
 *
 * The first is inferred from FPDS adjacency; migration 0023 sets out why that is the only
 * evidence available and where the inference can go wrong. The second is measured from
 * solicitation numbers that appear in both SAM.gov and FPDS, and the coverage is thin by
 * construction because this system's notice history starts when it started looking.
 *
 * Where neither answers, the default lead time stands and is labelled an assumption. That
 * labelling is not a formality: `lead_source` reaches the screen, and a forecast whose
 * arithmetic rests on a guess should not look like one that rests on a measurement.
 */
import type { PoolClient } from 'pg';

/**
 * The fallback lead time, in days.
 *
 * Twelve months, matching `SOLICITATION_LEAD_MONTHS` in the recompete detector and decision
 * D13 behind it. Held in days here because every other figure in the projection is in days
 * and converting months at query time invites the 30-versus-30.44 argument into the middle
 * of a date calculation.
 */
export const DEFAULT_LEAD_DAYS = 365;

/**
 * How many observed follow-on chains an office needs before its cadence is treated as
 * evidence rather than an anecdote.
 *
 * Three, for the same reason `MIN_OBSERVED_ACTIONS` in the opportunity profile is five: below
 * it, one bridge contract or one unrelated award that happened to start at the right moment
 * moves the median. Two chains agreeing is a coincidence that happens often; three is worth
 * something. It is a constant rather than a threshold row because it is a property of the
 * inference rather than a knob BD Ops should be turning, and the sample size is on screen
 * beside every figure it produces so the reader can disagree with it in the specific case.
 */
export const MIN_CADENCE_CHAINS = 3;

/** How many matched notices an office needs before its measured lag is used. */
export const MIN_NOTICE_LAG_SAMPLE = 3;

/**
 * A cadence has to be a plausible contract rhythm to be usable.
 *
 * Below a year is a bridge, an extension or a task order tempo rather than a recompete, and
 * projecting from it would put a solicitation a few months before an end date that a
 * modification will probably move anyway. Above ten years is a vehicle rather than a
 * requirement. Outside the band the chain evidence is still reported, because "this office
 * re-lets this work every fourteen years" is worth knowing, but the lead time falls back to
 * the default rather than being driven by it.
 */
export const MIN_USABLE_CADENCE_DAYS = 365;
export const MAX_USABLE_CADENCE_DAYS = 3650;

export interface OfficeCadence {
  readonly agency_code: string;
  readonly office_code: string;
  readonly psc_code: string;
  readonly chains_observed: number;
  readonly chains_across_vehicles: number;
  readonly chains_incumbent_retained: number;
  readonly median_interval_days: number | null;
  readonly min_interval_days: number | null;
  readonly max_interval_days: number | null;
  readonly median_duration_days: number | null;
  readonly median_gap_days: number | null;
}

export interface OfficeLag {
  readonly agency_code: string | null;
  readonly office_code: string | null;
  readonly awards_matched: number;
  readonly median_lag_days: number | null;
}

/**
 * Every office cadence the corpus supports, keyed for lookup by (agency, office, PSC).
 *
 * Loaded once per run rather than queried per contract. A forecast run touches every award
 * in the recompete horizon and each one needs its office's cadence; one query and a map is
 * the difference between a run that finishes and a run that issues forty thousand queries.
 *
 * `asOf` exists for the backtest. Passing a date restricts the chains to those whose
 * follow-on had already been awarded by then, so a backtest cannot learn a rhythm from an
 * award that had not happened yet when the projection it is scoring was supposedly made.
 * That leak is the easiest way to build a backtest that reports a hit rate it cannot repeat,
 * and closing it is most of what makes the backtest worth running.
 */
export async function loadCadence(
  client: PoolClient,
  asOf?: Date | null,
): Promise<Map<string, OfficeCadence>> {
  const { rows } = await client.query<OfficeCadence>(
    `select
       awarding_agency_code                                                as agency_code,
       contracting_office_code                                            as office_code,
       psc_code,
       count(*)::int                                                      as chains_observed,
       count(*) filter (where not same_vehicle)::int                      as chains_across_vehicles,
       count(*) filter (where incumbent_retained)::int                    as chains_incumbent_retained,
       percentile_cont(0.5) within group (order by interval_days)::int     as median_interval_days,
       min(interval_days)::int                                            as min_interval_days,
       max(interval_days)::int                                            as max_interval_days,
       percentile_cont(0.5) within group (order by prior_duration_days)::int as median_duration_days,
       percentile_cont(0.5) within group (order by gap_days)::int          as median_gap_days
     from cie_followon_chain_asof(coalesce($1::date, date '9999-12-31'))
      group by awarding_agency_code, contracting_office_code, psc_code`,
    [asOf ?? null],
  );

  const byKey = new Map<string, OfficeCadence>();
  for (const row of rows) byKey.set(cadenceKey(row.agency_code, row.office_code, row.psc_code), row);
  return byKey;
}

export function cadenceKey(
  agency: string | null,
  office: string | null,
  psc: string | null,
): string {
  return `${agency ?? ''}|${office ?? ''}|${psc ?? ''}`;
}

/**
 * Measured notice-to-award lag per office.
 *
 * Keyed on (agency, office) with an agency-level fallback row, because an office that has
 * never had a notice matched can still borrow its parent agency's figure, and an agency
 * median is a weaker claim than an office one but a stronger one than the default.
 */
export async function loadNoticeLag(
  client: PoolClient,
  asOf?: Date | null,
): Promise<Map<string, OfficeLag>> {
  const { rows } = await client.query<OfficeLag>(
    `with matched as (
       select p.agency_code, p.office_code, (ca.signed_date - p.posted_date) as lag_days
         from pursuit p
         join contract_action ca
           on upper(btrim(ca.piid)) = upper(btrim(p.solicitation_number))
            or (ca.idv_piid is not null
                and upper(btrim(ca.idv_piid)) = upper(btrim(p.solicitation_number)))
        where p.posted_date is not null
          and p.solicitation_number is not null
          and btrim(p.solicitation_number) <> ''
          and ca.signed_date is not null
          and ca.signed_date > p.posted_date
          and ($1::date is null or ca.signed_date <= $1::date)
     )
     select agency_code, office_code, count(*)::int as awards_matched,
            percentile_cont(0.5) within group (order by lag_days)::int as median_lag_days
       from matched group by agency_code, office_code
     union all
     -- The agency-level roll-up, with a null office so the lookup can fall back to it.
     select agency_code, null, count(*)::int,
            percentile_cont(0.5) within group (order by lag_days)::int
       from matched group by agency_code`,
    [asOf ?? null],
  );

  const byKey = new Map<string, OfficeLag>();
  for (const row of rows) byKey.set(lagKey(row.agency_code, row.office_code), row);
  return byKey;
}

export function lagKey(agency: string | null, office: string | null): string {
  return `${agency ?? ''}|${office ?? ''}`;
}

export type LeadSource = 'observed_notice_lag' | 'office_cadence' | 'default';

export interface LeadTime {
  readonly days: number;
  readonly source: LeadSource;
  /** The sentence that goes on the screen beside the projected date. */
  readonly reason: string;
  readonly cadence: OfficeCadence | null;
  readonly lag: OfficeLag | null;
}

/**
 * How far before a contract ends the follow-on is expected to appear, and on what authority.
 *
 * The order is a preference for measurement over inference over assumption, and it stops at
 * the first thing that clears its own sample-size bar. A measured lag with two matched
 * notices does not beat an inferred cadence with nine chains, so the bars are checked rather
 * than the order alone deciding.
 *
 * The cadence does not become the lead time directly. A five-year rhythm says the office
 * re-lets every five years; it does not say the solicitation appears five years early. What
 * it does say is how long the office leaves between the previous award ending and the next
 * one starting, and a negative gap means the office reliably awards the follow-on before the
 * incumbent's period runs out. That figure, plus the default, is the lead: an office that
 * awards six months early is soliciting about eighteen months out, not twelve.
 */
export function leadTimeFor(
  agency: string | null,
  office: string | null,
  psc: string | null,
  cadences: Map<string, OfficeCadence>,
  lags: Map<string, OfficeLag>,
): LeadTime {
  const cadence = cadences.get(cadenceKey(agency, office, psc)) ?? null;
  const lag = lags.get(lagKey(agency, office)) ?? lags.get(lagKey(agency, null)) ?? null;

  if (lag !== null && lag.awards_matched >= MIN_NOTICE_LAG_SAMPLE && lag.median_lag_days !== null) {
    const scope = lag.office_code === null ? `agency ${agency}` : `office ${office}`;
    return {
      days: lag.median_lag_days,
      source: 'observed_notice_lag',
      reason:
        `Measured: ${scope} took a median ${lag.median_lag_days} days from posting a notice to ` +
        `signing the award, across ${lag.awards_matched} solicitations found in both SAM.gov and FPDS.`,
      cadence,
      lag,
    };
  }

  if (
    cadence !== null &&
    cadence.chains_observed >= MIN_CADENCE_CHAINS &&
    cadence.median_interval_days !== null &&
    cadence.median_interval_days >= MIN_USABLE_CADENCE_DAYS &&
    cadence.median_interval_days <= MAX_USABLE_CADENCE_DAYS
  ) {
    // A negative median gap means the office awards the follow-on before the previous one
    // ends, so the solicitation is that much further out than the default.
    const earlyAward = cadence.median_gap_days === null ? 0 : Math.max(0, -cadence.median_gap_days);
    const days = DEFAULT_LEAD_DAYS + earlyAward;
    return {
      days,
      source: 'office_cadence',
      reason:
        `Inferred: this office has re-let PSC ${psc} ${cadence.chains_observed} times, a median ` +
        `${Math.round(cadence.median_interval_days / 30.44)} months apart` +
        (earlyAward > 0
          ? `, awarding the follow-on a median ${earlyAward} days before the previous one ended.`
          : `, awarding the follow-on a median ${cadence.median_gap_days ?? 0} days after the ` +
            'previous one ended.') +
        ` Lead time is the ${DEFAULT_LEAD_DAYS}-day default plus that head start.`,
      cadence,
      lag,
    };
  }

  return {
    days: DEFAULT_LEAD_DAYS,
    source: 'default',
    reason:
      `Assumed: ${DEFAULT_LEAD_DAYS} days, decision D13. ` +
      (cadence === null
        ? 'This office has no observed history of re-letting this kind of work, so there is ' +
          'nothing to infer a rhythm from.'
        : `Only ${cadence.chains_observed} follow-on chain(s) observed here, below the ` +
          `${MIN_CADENCE_CHAINS} needed before a rhythm is treated as evidence.`),
    cadence,
    lag,
  };
}
