/**
 * The forecast: what will solicit, and roughly when.
 *
 * One line of arithmetic, and everything else is about how much to believe it:
 *
 *     projected solicitation date  =  period end date  -  lead time
 *
 * Two things end and therefore project. A **contract** ending has to be re-competed or let
 * go. A **vehicle** ending has to be replaced, and the replacement is competed on-ramp by
 * on-ramp, which usually makes it a larger and earlier opportunity than any of the task
 * orders under it. Treating a vehicle as just another contract would file the biggest
 * opportunities in the corpus under the smallest heading, so it is a separate basis with its
 * own evidence.
 *
 * Four properties are load bearing.
 *
 * **It never writes a pursuit.** A forecast says a requirement is likely; the feed says one
 * exists. The feed's entire claim is that everything in it is real, and one speculative row
 * in it would cost that. Where a requirement for a forecast contract has already been
 * detected, the forecast row points at it and says so rather than counting it twice.
 *
 * **Stale rows are pruned.** A `pursuit` is a real thing and survives a re-detection. A
 * forecast is wholly derived, so a projection whose contract has been extended out of the
 * horizon has to disappear, or the forecast slowly fills with dates that were true once.
 * Anything this detector wrote and did not write again is deleted.
 *
 * **Low confidence is shown, not dropped.** A quarter with four low-confidence bars and a
 * quarter with nothing in it are different facts, and hiding the weak rows makes them look
 * the same. Every projection carries its evidence, including the evidence against it.
 *
 * **Blank stays blank.** A contract with no recorded ceiling contributes to the volume of a
 * quarter and not to its value, and the quarter reports how many of its rows did that. The
 * alternative is a dollar figure that quietly treats unknown as zero, which is the failure
 * `src/web/format.ts` exists to prevent at the other end of the same pipe.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, type RunHandle } from '../lib/provenance.js';
import {
  DEFAULT_LEAD_DAYS,
  MIN_CADENCE_CHAINS,
  leadTimeFor,
  loadCadence,
  loadNoticeLag,
  type LeadTime,
  type OfficeCadence,
  type OfficeLag,
} from './cadence.js';

export const SOURCE_SYSTEM = 'forecast';

/** How far out projections are kept, in months from the as-of date. */
export const DEFAULT_HORIZON_MONTHS = 36;

/**
 * How far back a projection may fall and still be reported.
 *
 * A contract ending in four months projects a solicitation eight months ago. That is not a
 * broken calculation: it is the statement that the follow-on should already be visible and
 * is not, which is worth surfacing rather than discarding. Beyond a year in the past the
 * contract is nearly over and the useful conclusion is about the extension rather than the
 * recompete.
 */
export const DEFAULT_BACKFILL_MONTHS = 12;

export type AstrionPosition = 'prime_incumbent' | 'subcontractor' | 'none';
export type Confidence = 'high' | 'medium' | 'low';
export type Basis = 'contract_end' | 'vehicle_expiry';

export interface ForecastOptions {
  /** Treat this as today. The backtest sets it; a normal run leaves it null. */
  readonly asOf?: Date | null;
  readonly horizonMonths?: number;
  readonly backfillMonths?: number;
  /** Ignore contracts whose known value is below this. Never drops an unknown value. */
  readonly minValueUsd?: number;
  /** Skip the vehicle-expiry basis. */
  readonly contractsOnly?: boolean;
  /** Work out what would be written, write nothing. */
  readonly dryRun?: boolean;
}

export interface ForecastResult {
  readonly asOf: string;
  readonly horizonMonths: number;
  readonly candidates: number;
  readonly written: number;
  readonly pruned: number;
  readonly skippedBelowFloor: number;
  readonly skippedOutsideWindow: number;
  readonly byConfidence: Record<Confidence, number>;
  readonly byBasis: Record<Basis, number>;
  readonly byLeadSource: Record<string, number>;
  readonly run: RunHandle | null;
}

/* --------------------------------------------------------------------- candidates */

interface EndingContract {
  readonly awarding_agency_code: string;
  readonly contracting_office_code: string | null;
  readonly idv_piid_key: string;
  readonly piid: string;
  readonly ends_on: Date;
  readonly current_ends_on: Date | null;
  readonly obligated_usd: string | null;
  readonly base_and_all_options: string | null;
  readonly psc_code: string | null;
  readonly naics_code: string | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_confidence: string | null;
  readonly action_count: string;
  readonly is_ambiguous: boolean;
  readonly astrion_position: AstrionPosition;
  readonly existing_pursuit_id: string | null;
}

/**
 * Contracts whose period of performance ends inside the window this run cares about.
 *
 * The window is on the **end date** and is wider than the projection window on both sides by
 * the maximum lead time, because a contract ending three years out projects a solicitation
 * two years out and would otherwise be missed. The projection window is applied afterwards,
 * once each row's own lead time is known.
 *
 * `is_ambiguous` comes from `contract_group_ambiguous`, migration 0019. A group holding more
 * than one awardee or more than one contracting office is either a novation or two unrelated
 * awards sharing a short PIID, and in the second case the end date belongs to a different
 * contract. That is the single most damaging error this projection can make, so it is carried
 * onto the row and it caps the confidence rather than being left in a diagnostic view nobody
 * opens.
 */
async function endingContracts(
  client: PoolClient,
  asOf: string,
  fromDays: number,
  toDays: number,
): Promise<EndingContract[]> {
  const { rows } = await client.query<EndingContract>(
    `with family as (
       select e.entity_id
         from entity e
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')
     )
     select
       a.awarding_agency_code,
       a.contracting_office_code,
       a.idv_piid_key,
       a.piid,
       a.ends_on,
       a.current_ends_on,
       a.obligated_usd::text,
       a.base_and_all_options::text,
       a.psc_code,
       a.naics_code,
       a.incumbent_entity_id::text,
       a.incumbent_confidence,
       a.action_count::text,
       exists (
         select 1 from contract_group_ambiguous g
          where g.awarding_agency_code = a.awarding_agency_code
            and g.idv_piid_key = a.idv_piid_key
            and g.piid = a.piid
       )                                                        as is_ambiguous,
       case
         when a.incumbent_entity_id in (select entity_id from family) then 'prime_incumbent'
         when exists (
           select 1 from subcontract_edge se
            where se.sub_entity_id in (select entity_id from family)
              and (se.prime_piid = a.piid
                   or (a.idv_piid_key <> '' and se.prime_idv_piid = a.idv_piid_key))
         ) then 'subcontractor'
         else 'none'
       end                                                      as astrion_position,
       (select p.pursuit_id::text from pursuit p
         where p.signal_key = 'recompete:fpds:' || a.awarding_agency_code || ':'
                              || a.idv_piid_key || ':' || a.piid)  as existing_pursuit_id
     -- The as-of function rather than the award_shape view, so a projection can be recomputed
     -- for a past date without seeing modifications signed since. Migration 0023 sets out why
     -- that leak is the one that would make the backtest meaningless.
     from cie_award_shape_asof($1::date) a
    where a.ends_on is not null
      and a.ends_on >= ($1::date + ($2 || ' days')::interval)::date
      and a.ends_on <= ($1::date + ($3 || ' days')::interval)::date`,
    [asOf, String(fromDays), String(toDays)],
  );
  return rows;
}

interface ExpiringVehicle {
  readonly awarding_agency_code: string;
  readonly idv_piid: string;
  readonly contracting_office_code: string | null;
  readonly order_count: number;
  readonly obligated_usd: string | null;
  readonly largest_order_ceiling: string | null;
  readonly expires_on: Date;
  readonly vehicle_record_present: boolean;
  readonly psc_code: string | null;
  readonly naics_code: string | null;
  readonly distinct_holders: number;
  readonly astrion_holds_an_order: boolean;
}

async function expiringVehicles(
  client: PoolClient,
  asOf: string,
  fromDays: number,
  toDays: number,
): Promise<ExpiringVehicle[]> {
  const { rows } = await client.query<ExpiringVehicle>(
    `with family as (
       select e.entity_id
         from entity e
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')
     )
     select v.awarding_agency_code, v.idv_piid, v.contracting_office_code, v.order_count,
            v.obligated_usd::text, v.largest_order_ceiling::text, v.expires_on,
            v.vehicle_record_present, v.psc_code, v.naics_code, v.distinct_holders,
            exists (
              select 1 from cie_award_shape_asof($1::date) o
               where o.awarding_agency_code = v.awarding_agency_code
                 and o.idv_piid_key = v.idv_piid
                 and o.incumbent_entity_id in (select entity_id from family)
            )                                                    as astrion_holds_an_order
       from cie_expiring_vehicle_asof($1::date) v
      where v.expires_on is not null
        and v.expires_on >= ($1::date + ($2 || ' days')::interval)::date
        and v.expires_on <= ($1::date + ($3 || ' days')::interval)::date`,
    [asOf, String(fromDays), String(toDays)],
  );
  return rows;
}

/* ----------------------------------------------------------------------- evidence */

export interface Fact {
  readonly rule_id: string;
  readonly detail: string;
  readonly supports: boolean;
}

export interface Projection {
  readonly forecast_key: string;
  readonly basis: Basis;
  readonly title: string;
  readonly agency_code: string | null;
  readonly office_code: string | null;
  readonly related_piid: string | null;
  readonly idv_piid: string | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_confidence: string | null;
  readonly astrion_position: AstrionPosition;
  readonly period_end_date: Date;
  readonly lead: LeadTime;
  readonly projected: Date;
  readonly projected_fy: number;
  readonly projected_quarter: number;
  readonly estimated_value: string | null;
  readonly value_basis: 'base_and_all_options' | 'obligated' | 'order_ceiling' | null;
  readonly confidence: Confidence;
  readonly pursuit_id: string | null;
  readonly facts: readonly Fact[];
}

/** Federal fiscal year and quarter of a date. Mirrors cie_fiscal_year and cie_fiscal_quarter. */
export function fiscalPeriod(date: Date): { fy: number; quarter: number } {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return {
    fy: month >= 10 ? year + 1 : year,
    quarter: Math.floor(((month + 2) % 12) / 3) + 1,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The confidence band, derived from the facts rather than asserted.
 *
 * Two rules do the work and both are about refusing to be confident:
 *
 *   Any fact arguing against the projection caps it below high. Contract identity is the one
 *   that matters most: if the group holding this end date might be two unrelated awards, the
 *   date itself might belong to a different contract and nothing downstream can recover from
 *   that.
 *
 *   A projection resting on the default lead time with no cadence evidence at all is low. It
 *   is not wrong, and it is the honest output for an office that has never been seen to
 *   re-let this work, but it is arithmetic on an assumption and should not sit in a table
 *   next to a measurement looking identical.
 */
export function bandFor(lead: LeadTime, facts: readonly Fact[]): Confidence {
  const against = facts.filter((f) => !f.supports);
  const noCadence = lead.cadence === null || lead.cadence.chains_observed < MIN_CADENCE_CHAINS;

  if (lead.source === 'default' && noCadence) return 'low';
  if (against.length > 0) return 'medium';
  if (lead.source === 'default') return 'medium';
  return 'high';
}

/* --------------------------------------------------------------------- projection */

function projectContract(
  contract: EndingContract,
  cadences: Map<string, OfficeCadence>,
  lags: Map<string, OfficeLag>,
): Projection {
  const lead = leadTimeFor(
    contract.awarding_agency_code,
    contract.contracting_office_code,
    contract.psc_code,
    cadences,
    lags,
  );

  const endsOn = new Date(contract.ends_on);
  const projected = addDays(endsOn, -lead.days);
  const { fy, quarter } = fiscalPeriod(projected);

  const facts: Fact[] = [
    {
      rule_id: 'lead_time',
      detail: lead.reason,
      supports: lead.source !== 'default',
    },
    {
      rule_id: 'period_end',
      detail:
        `The latest ultimate completion date across ${contract.action_count} recorded action(s) on ` +
        `${contract.piid} is ${isoDay(endsOn)}` +
        (contract.current_ends_on !== null &&
        new Date(contract.current_ends_on).getTime() < endsOn.getTime()
          ? `, with the current period ending ${isoDay(new Date(contract.current_ends_on))}. The ` +
            'difference is the option period, so the later date is what a recompete is timed against.'
          : '.'),
      supports: true,
    },
  ];

  if (contract.is_ambiguous) {
    facts.push({
      rule_id: 'ambiguous_contract_identity',
      detail:
        `This PIID carries more than one awardee or more than one contracting office, so it may ` +
        `be two unrelated awards sharing a short PIID rather than one contract. If it is, this ` +
        `end date belongs to the other one. See contract_group_ambiguous.`,
      supports: false,
    });
  }

  if (lead.cadence !== null && lead.cadence.chains_observed > 0) {
    facts.push({
      rule_id: 'office_cadence',
      detail:
        `${lead.cadence.chains_observed} follow-on chain(s) observed in this office for PSC ` +
        `${contract.psc_code}, ${lead.cadence.chains_across_vehicles} of them across different ` +
        `vehicles, median ${lead.cadence.median_interval_days} days apart` +
        (lead.cadence.chains_incumbent_retained > 0
          ? `. The incumbent kept the work on ${lead.cadence.chains_incumbent_retained} of them.`
          : '. The incumbent kept the work on none of them.'),
      supports: lead.cadence.chains_observed >= MIN_CADENCE_CHAINS,
    });
  } else {
    facts.push({
      rule_id: 'no_office_cadence',
      detail:
        `No follow-on chain observed in this office for PSC ${contract.psc_code ?? 'unrecorded'}. ` +
        'Either the work has never been re-let here, or the corpus does not go back far enough ' +
        'to have seen it happen. The projection rests on the end date and the default lead time.',
      supports: false,
    });
  }

  const value = contract.base_and_all_options ?? contract.obligated_usd;
  const valueBasis =
    contract.base_and_all_options !== null
      ? ('base_and_all_options' as const)
      : contract.obligated_usd !== null
        ? ('obligated' as const)
        : null;

  if (value === null) {
    facts.push({
      rule_id: 'value_unknown',
      detail:
        'No ceiling and no obligation recorded on this contract, so it adds to the volume of its ' +
        'quarter and not to the value. Blank is not zero.',
      supports: false,
    });
  }

  if (contract.existing_pursuit_id !== null) {
    facts.push({
      rule_id: 'already_detected',
      detail:
        'A recompete signal already exists for this contract, so it is in the feed as well as ' +
        'here. The forecast counts it once and links to it rather than presenting it as news.',
      supports: true,
    });
  }

  const title =
    `${contract.piid}` +
    (contract.idv_piid_key !== '' ? ` under ${contract.idv_piid_key}` : '') +
    ` ends ${isoDay(endsOn)}`;

  return {
    forecast_key: `forecast:end:${contract.awarding_agency_code}:${contract.idv_piid_key}:${contract.piid}`,
    basis: 'contract_end',
    title,
    agency_code: contract.awarding_agency_code,
    office_code: contract.contracting_office_code,
    related_piid: contract.piid,
    idv_piid: contract.idv_piid_key === '' ? null : contract.idv_piid_key,
    naics_code: contract.naics_code,
    psc_code: contract.psc_code,
    incumbent_entity_id: contract.incumbent_entity_id,
    incumbent_confidence: contract.incumbent_confidence,
    astrion_position: contract.astrion_position,
    period_end_date: endsOn,
    lead,
    projected,
    projected_fy: fy,
    projected_quarter: quarter,
    estimated_value: value,
    value_basis: valueBasis,
    confidence: bandFor(lead, facts),
    pursuit_id: contract.existing_pursuit_id,
    facts,
  };
}

/**
 * A vehicle expiry as a forecast item.
 *
 * The lead time is the same one a contract gets, and that is very probably too short. A
 * vehicle replacement is a multi-award competition with a draft solicitation, an industry day
 * and often a phased on-ramp, and it starts earlier than a single follow-on award does. There
 * is nothing in this corpus that measures how much earlier, so rather than inventing a
 * multiplier the projection uses the contract lead time and records the shortfall as evidence
 * against itself. That caps a vehicle at medium confidence unless the office has a measured
 * notice lag, which is the honest position: the date is a floor, the opportunity is real.
 */
function projectVehicle(
  vehicle: ExpiringVehicle,
  cadences: Map<string, OfficeCadence>,
  lags: Map<string, OfficeLag>,
): Projection {
  const lead = leadTimeFor(
    vehicle.awarding_agency_code,
    vehicle.contracting_office_code,
    vehicle.psc_code,
    cadences,
    lags,
  );

  const expiresOn = new Date(vehicle.expires_on);
  const projected = addDays(expiresOn, -lead.days);
  const { fy, quarter } = fiscalPeriod(projected);

  const facts: Fact[] = [
    { rule_id: 'lead_time', detail: lead.reason, supports: lead.source !== 'default' },
    {
      rule_id: 'vehicle_expiry',
      detail:
        `${vehicle.idv_piid} carries ${vehicle.order_count} order(s) across ` +
        `${vehicle.distinct_holders} holder(s) and runs out ${isoDay(expiresOn)}` +
        (vehicle.vehicle_record_present
          ? ', from the vehicle award record itself.'
          : '. The corpus holds no award record for the vehicle, so this is the latest end date ' +
            'across its orders, which is a floor: the vehicle cannot end before the work under it does.'),
      supports: vehicle.vehicle_record_present,
    },
    {
      rule_id: 'vehicle_lead_is_a_floor',
      detail:
        'A vehicle replacement is competed on-ramp by on-ramp and starts earlier than a single ' +
        'follow-on award. Nothing in this corpus measures how much earlier, so this projection ' +
        'uses the contract lead time and is therefore a late estimate rather than a central one.',
      supports: false,
    },
  ];

  if (vehicle.astrion_holds_an_order) {
    facts.push({
      rule_id: 'astrion_on_vehicle',
      detail: 'Astrion holds at least one order under this vehicle, so this is an on-ramp to defend.',
      supports: true,
    });
  }

  const value = vehicle.largest_order_ceiling ?? vehicle.obligated_usd;
  if (value === null) {
    facts.push({
      rule_id: 'value_unknown',
      detail: 'No ceiling or obligation recorded under this vehicle. Blank is not zero.',
      supports: false,
    });
  }

  return {
    forecast_key: `forecast:vehicle:${vehicle.awarding_agency_code}:${vehicle.idv_piid}`,
    basis: 'vehicle_expiry',
    title: `Vehicle ${vehicle.idv_piid} expires ${isoDay(expiresOn)}`,
    agency_code: vehicle.awarding_agency_code,
    office_code: vehicle.contracting_office_code,
    related_piid: null,
    idv_piid: vehicle.idv_piid,
    naics_code: vehicle.naics_code,
    psc_code: vehicle.psc_code,
    incumbent_entity_id: null,
    incumbent_confidence: null,
    astrion_position: vehicle.astrion_holds_an_order ? 'prime_incumbent' : 'none',
    period_end_date: expiresOn,
    lead,
    projected,
    projected_fy: fy,
    projected_quarter: quarter,
    estimated_value: value,
    value_basis: vehicle.largest_order_ceiling !== null ? 'order_ceiling' : value !== null ? 'obligated' : null,
    confidence: bandFor(lead, facts),
    pursuit_id: null,
    facts,
  };
}

/* ------------------------------------------------------------------------- write */

async function upsert(
  client: PoolClient,
  projection: Projection,
  sourceVersionId: number,
): Promise<void> {
  const { rows } = await client.query<{ forecast_id: string }>(
    `insert into forecast_item (
       forecast_key, basis, title, agency_code, office_code, related_piid, idv_piid,
       naics_code, psc_code, incumbent_entity_id, incumbent_confidence, astrion_position,
       period_end_date, lead_days, projected_solicitation_date, projected_fy, projected_quarter,
       estimated_value, value_basis, confidence, lead_source, cadence_chains,
       cadence_median_days, notice_lag_sample, pursuit_id, source_version_id,
       generated_by, generated_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10::bigint, $11, $12,
       $13::date, $14, $15::date, $16, $17,
       $18::numeric, $19, $20, $21, $22,
       $23, $24, $25::bigint, $26,
       $27, now()
     )
     on conflict (forecast_key) do update set
       basis                      = excluded.basis,
       title                      = excluded.title,
       agency_code                = excluded.agency_code,
       office_code                = excluded.office_code,
       related_piid               = excluded.related_piid,
       idv_piid                   = excluded.idv_piid,
       naics_code                 = excluded.naics_code,
       psc_code                   = excluded.psc_code,
       incumbent_entity_id        = excluded.incumbent_entity_id,
       incumbent_confidence       = excluded.incumbent_confidence,
       astrion_position           = excluded.astrion_position,
       period_end_date            = excluded.period_end_date,
       lead_days                  = excluded.lead_days,
       projected_solicitation_date = excluded.projected_solicitation_date,
       projected_fy               = excluded.projected_fy,
       projected_quarter         = excluded.projected_quarter,
       estimated_value            = excluded.estimated_value,
       value_basis                = excluded.value_basis,
       confidence                 = excluded.confidence,
       lead_source                = excluded.lead_source,
       cadence_chains             = excluded.cadence_chains,
       cadence_median_days        = excluded.cadence_median_days,
       notice_lag_sample          = excluded.notice_lag_sample,
       pursuit_id                 = excluded.pursuit_id,
       source_version_id          = excluded.source_version_id,
       generated_by               = excluded.generated_by,
       generated_at               = excluded.generated_at
     returning forecast_id`,
    [
      projection.forecast_key,
      projection.basis,
      projection.title,
      projection.agency_code,
      projection.office_code,
      projection.related_piid,
      projection.idv_piid,
      projection.naics_code,
      projection.psc_code,
      projection.incumbent_entity_id,
      projection.incumbent_confidence,
      projection.astrion_position,
      isoDay(projection.period_end_date),
      projection.lead.days,
      isoDay(projection.projected),
      projection.projected_fy,
      projection.projected_quarter,
      projection.estimated_value,
      projection.value_basis,
      projection.confidence,
      projection.lead.source,
      projection.lead.cadence?.chains_observed ?? null,
      projection.lead.cadence?.median_interval_days ?? null,
      projection.lead.lag?.awards_matched ?? null,
      projection.pursuit_id,
      sourceVersionId,
      SOURCE_SYSTEM,
    ],
  );

  const forecastId = rows[0]!.forecast_id;

  // Evidence is wholly derived from the same inputs as the row it hangs off, so it is
  // rewritten rather than merged. A merge would leave behind a fact that was true under last
  // month's corpus, and a stale reason is worse than no reason: it reads as current.
  await client.query('delete from forecast_evidence where forecast_id = $1::bigint', [forecastId]);
  for (const fact of projection.facts) {
    await client.query(
      `insert into forecast_evidence (forecast_id, rule_id, detail, supports, source_system)
       values ($1::bigint, $2, $3, $4, $5)`,
      [forecastId, fact.rule_id, fact.detail, fact.supports, SOURCE_SYSTEM],
    );
  }
}

export interface ProjectionSet {
  readonly asOf: string;
  readonly horizonMonths: number;
  /** Every candidate considered, before the window and the value floor are applied. */
  readonly considered: number;
  readonly kept: readonly Projection[];
  readonly skippedBelowFloor: number;
  readonly skippedOutsideWindow: number;
}

/**
 * Work out the projections and return them, writing nothing.
 *
 * Separated from `buildForecast` because the backtest needs exactly this and must not write:
 * it recomputes the forecast as it would have stood on a past date, and a backtest that wrote
 * its historical projections into the live table would replace the current forecast with an
 * old one. One code path, so the thing being scored is the thing that ships.
 */
export async function projectAsOf(
  client: PoolClient,
  options: ForecastOptions = {},
): Promise<ProjectionSet> {
  const asOfDate = options.asOf ?? new Date();
  const asOf = isoDay(asOfDate);
  const horizonMonths = options.horizonMonths ?? DEFAULT_HORIZON_MONTHS;
  const backfillMonths = options.backfillMonths ?? DEFAULT_BACKFILL_MONTHS;
  const floor = options.minValueUsd ?? null;

  const [cadences, lags] = await Promise.all([
    loadCadence(client, options.asOf ?? null),
    loadNoticeLag(client, options.asOf ?? null),
  ]);

  // The end-date window has to be wider than the projection window by the longest lead time
  // any row could draw, or a contract ending beyond it would be dropped before its own lead
  // time had a chance to pull the projection inside the window. The widest possible lead is
  // the default plus the largest head start any office cadence reports.
  const widestLead =
    DEFAULT_LEAD_DAYS +
    Math.max(
      0,
      ...[...cadences.values()].map((c) => Math.max(0, -(c.median_gap_days ?? 0))),
    );

  const endFromDays = -Math.round(backfillMonths * 30.44);
  const endToDays = Math.round(horizonMonths * 30.44) + widestLead;

  const [contracts, vehicles] = await Promise.all([
    endingContracts(client, asOf, endFromDays, endToDays),
    options.contractsOnly === true
      ? Promise.resolve([] as ExpiringVehicle[])
      : expiringVehicles(client, asOf, endFromDays, endToDays),
  ]);

  const projections = [
    ...contracts.map((c) => projectContract(c, cadences, lags)),
    ...vehicles.map((v) => projectVehicle(v, cadences, lags)),
  ];

  const windowFrom = addDays(asOfDate, -Math.round(backfillMonths * 30.44));
  const windowTo = addDays(asOfDate, Math.round(horizonMonths * 30.44));

  let skippedBelowFloor = 0;
  let skippedOutsideWindow = 0;
  const kept: Projection[] = [];

  for (const projection of projections) {
    if (
      projection.projected.getTime() < windowFrom.getTime() ||
      projection.projected.getTime() > windowTo.getTime()
    ) {
      skippedOutsideWindow += 1;
      continue;
    }
    // A contract with no recorded value is never dropped by a floor. A floor is a statement
    // about known small contracts, not about ones nobody has priced.
    if (
      floor !== null &&
      projection.estimated_value !== null &&
      Number(projection.estimated_value) < floor
    ) {
      skippedBelowFloor += 1;
      continue;
    }
    kept.push(projection);
  }

  return {
    asOf,
    horizonMonths,
    considered: projections.length,
    kept,
    skippedBelowFloor,
    skippedOutsideWindow,
  };
}

export async function buildForecast(
  client: PoolClient,
  options: ForecastOptions = {},
): Promise<ForecastResult> {
  const set = await projectAsOf(client, options);
  const { asOf, horizonMonths, kept, skippedBelowFloor, skippedOutsideWindow } = set;

  const byConfidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  const byBasis: Record<Basis, number> = { contract_end: 0, vehicle_expiry: 0 };
  const byLeadSource: Record<string, number> = {};

  for (const projection of kept) {
    byConfidence[projection.confidence] += 1;
    byBasis[projection.basis] += 1;
    byLeadSource[projection.lead.source] = (byLeadSource[projection.lead.source] ?? 0) + 1;
  }

  if (options.dryRun === true) {
    return {
      asOf, horizonMonths, candidates: set.considered, written: kept.length, pruned: 0,
      skippedBelowFloor, skippedOutsideWindow, byConfidence, byBasis, byLeadSource, run: null,
    };
  }

  const run = await startRun(client, SOURCE_SYSTEM, `as of ${asOf}, ${horizonMonths} months`);

  try {
    for (const projection of kept) {
      // The payload is what the projection asserts, so an unchanged corpus hashes to the same
      // value and the run reports unchanged. The as-of date is deliberately absent from it:
      // including it would make every scheduled run report every row as changed, which is the
      // opposite of what acceptance test 2's property is for.
      const version = await recordVersion(client, run, projection.forecast_key, {
        basis: projection.basis,
        period_end_date: isoDay(projection.period_end_date),
        lead_days: projection.lead.days,
        lead_source: projection.lead.source,
        projected: isoDay(projection.projected),
        estimated_value: projection.estimated_value,
        confidence: projection.confidence,
        astrion_position: projection.astrion_position,
        psc_code: projection.psc_code,
        naics_code: projection.naics_code,
        agency_code: projection.agency_code,
        office_code: projection.office_code,
      });

      await upsert(client, projection, version.sourceVersionId);
    }

    // Prune. A forecast row whose contract has been extended past the horizon, or whose end
    // date moved, is no longer a projection this run would make, and a derived table that
    // keeps rows nobody would derive again is a table that slowly stops being true.
    const { rowCount } = await client.query(
      `delete from forecast_item
        where generated_by = $1
          and not (forecast_key = any($2::text[]))`,
      [SOURCE_SYSTEM, kept.map((p) => p.forecast_key)],
    );

    await finishRun(client, run);

    return {
      asOf, horizonMonths, candidates: set.considered, written: kept.length,
      pruned: rowCount ?? 0, skippedBelowFloor, skippedOutsideWindow,
      byConfidence, byBasis, byLeadSource, run,
    };
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
