/**
 * What the loaded corpus can and cannot support.
 *
 * Every screen in this system is honest about its own weak spots individually: the forecast says
 * when a lead time is an assumption, a quarter says how many of its rows carry no value, a cadence
 * shows its sample size. This assembles those admissions into one place, because the question
 * "should I believe this yet" is asked of the whole thing rather than of one screen.
 *
 * It exists to be run the moment a real corpus lands. Before that it reports zeroes, which is
 * correct and is the point: the figures below are the difference between a system that works and a
 * system that is useful, and nothing in this repository can tell them apart on its own.
 *
 * Nothing here writes. It is a report, and it names the command that would move each number.
 */
import type { PoolClient } from 'pg';
import { MIN_CADENCE_CHAINS, MIN_NOTICE_LAG_SAMPLE } from '../forecast/cadence.js';

/** A single figure, with what it means and what would move it. */
export interface Reading {
  readonly label: string;
  readonly value: string;
  /** What this figure implies, in a sentence. Absent when the figure speaks for itself. */
  readonly meaning?: string;
  /** Set when the figure is a problem rather than a fact. */
  readonly concern?: boolean;
}

export interface Section {
  readonly title: string;
  readonly readings: readonly Reading[];
  /** What to do next about this section, when there is something. */
  readonly next?: string;
}

function count(n: number | string | null): string {
  return n === null ? 'none' : Number(n).toLocaleString('en-US');
}

function usd(value: string | null): string {
  if (value === null) return 'not recorded';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not recorded';
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}bn`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function share(part: number, whole: number): string {
  if (whole === 0) return 'no rows';
  return `${((part / whole) * 100).toFixed(1)}% of ${count(whole)}`;
}

/* ------------------------------------------------------------------- corpus */

async function corpusSection(client: PoolClient): Promise<Section> {
  const { rows } = await client.query<{
    actions: string;
    obligations: string | null;
    first_signed: Date | null;
    last_signed: Date | null;
    unresolved: string;
    awards: string;
    with_psc: string;
    with_end_date: string;
    with_office: string;
    vehicles: string;
    ambiguous: string;
  }>(
    `select
       (select count(*)::text from contract_action)                                as actions,
       (select sum(action_obligation)::text from contract_action)                   as obligations,
       (select min(signed_date) from contract_action)                               as first_signed,
       (select max(signed_date) from contract_action)                               as last_signed,
       (select count(*)::text from contract_action where entity_id is null)          as unresolved,
       (select count(*)::text from award_shape)                                      as awards,
       (select count(*)::text from award_shape where psc_code is not null)           as with_psc,
       (select count(*)::text from award_shape where ends_on is not null)            as with_end_date,
       (select count(*)::text from award_shape
         where contracting_office_code is not null)                                 as with_office,
       (select count(*)::text from expiring_vehicle)                                as vehicles,
       (select count(*)::text from contract_group_ambiguous)                        as ambiguous`,
  );

  const row = rows[0]!;
  const awards = Number(row.awards);
  const years =
    row.first_signed === null || row.last_signed === null
      ? 0
      : (new Date(row.last_signed).getTime() - new Date(row.first_signed).getTime()) /
        (365.25 * 86_400_000);

  // Which source supplied which part of the corpus.
  //
  // The two sources are not interchangeable and the difference is invisible in the totals above. A
  // bulk FPDS extract carries fifteen years; GovCon API covers October 2024 onward comprehensively and
  // is sparse before it. So a corpus that is entirely API-sourced looks populated and cannot teach an
  // office's recompete rhythm, and this is the reading that says so before somebody trusts a forecast
  // built on it.
  // A left join, so rows with no provenance are shown rather than dropped. A breakdown whose parts do
  // not add up to the total is worse than no breakdown: it invites the reader to conclude the corpus
  // is smaller or shallower than it is. Rows without a source_version are seeds and fixtures, which
  // no loader wrote.
  const { rows: sources } = await client.query<{
    source_system: string | null;
    actions: string;
    first_signed: Date | null;
    last_signed: Date | null;
  }>(
    `select v.source_system,
            count(*)::text        as actions,
            min(a.signed_date)    as first_signed,
            max(a.signed_date)    as last_signed
       from contract_action a
       left join source_version v on v.source_version_id = a.source_version_id
      where a.signed_date is not null
      group by v.source_system
      order by v.source_system nulls last`,
  );

  const spanOf = (from: Date | null, to: Date | null): number =>
    from === null || to === null
      ? 0
      : (new Date(to).getTime() - new Date(from).getTime()) / (365.25 * 86_400_000);

  // Whether *anything* supplies depth. This is the question the per-source rows are evidence for, and
  // it must not be answered by counting sources: one deep extract is enough, and three shallow API
  // pulls are not.
  const deepestSpan = Math.max(0, ...sources.map((s) => spanOf(s.first_signed, s.last_signed)));
  const apiIsTheOnlyDepth = sources.length > 0 && deepestSpan < 15;

  const bySource: Reading[] = sources.map((source) => {
    const span = spanOf(source.first_signed, source.last_signed);
    const system = source.source_system;
    return {
      label: `  from ${system ?? 'seeds, no loader'}`,
      value: `${count(source.actions)} actions, ${span.toFixed(1)} years`,
      meaning:
        system === null
          ? 'Written directly rather than by a loader, so these carry no provenance. Expected for ' +
            'seeds and demo data; unexpected for anything else.'
          : system === 'govcon_contract'
            ? 'Recency and breadth. Comprehensive from October 2024 only, so it cannot supply the ' +
              'depth a cadence needs however many actions it carries.'
            : span >= 15
              ? 'Deep enough for a five-year rhythm to appear three times in one office.'
              : 'The depth a cadence learns from comes from here. More of it is what moves the ' +
                'forecast off the default lead time.',
      concern: system === 'govcon_contract' && apiIsTheOnlyDepth,
    };
  });

  return {
    title: 'The corpus',
    readings: [
      { label: 'Contract actions', value: count(row.actions) },
      { label: 'Obligated', value: usd(row.obligations) },
      {
        label: 'Awards, after grouping',
        value: count(awards),
        meaning: 'One row per award. A contract is its vehicle plus its PIID, per decision D13.',
      },
      {
        label: 'History it spans',
        value: years === 0 ? 'nothing dated' : `${years.toFixed(1)} years`,
        // A five-year cadence needs three chains, and three chains need four awards of the same
        // work in sequence. That is fifteen years before an office can teach the forecast anything.
        meaning:
          years < 15
            ? `Short of the ~15 years a five-year cadence needs to show ${MIN_CADENCE_CHAINS} chains. ` +
              'Offices with a shorter rhythm will still register.'
            : 'Long enough for a five-year rhythm to appear three times in one office.',
        concern: years > 0 && years < 15,
      },
      ...bySource,
      {
        label: 'Unresolved to an entity',
        value: count(row.unresolved),
        meaning: 'Acceptance test 1 is about this. The review queue holds whatever the resolver refused.',
        concern: Number(row.unresolved) > 0,
      },
      {
        label: 'Awards carrying a PSC',
        value: share(Number(row.with_psc), awards),
        meaning:
          'A cadence is a claim about a kind of work recurring, so an award with no product or ' +
          'service code cannot contribute to one.',
        concern: awards > 0 && Number(row.with_psc) / awards < 0.7,
      },
      { label: 'Awards carrying an end date', value: share(Number(row.with_end_date), awards) },
      { label: 'Awards carrying an office', value: share(Number(row.with_office), awards) },
      { label: 'Vehicles', value: count(row.vehicles), meaning: 'Each expiry is an on-ramp opportunity.' },
      {
        label: 'Awards of uncertain identity',
        value: count(row.ambiguous),
        meaning:
          'A short PIID with more than one awardee or office. These cap a projection below high ' +
          'confidence, because the end date may belong to the other award.',
        concern: Number(row.ambiguous) > 0,
      },
    ],
    next:
      awards === 0
        ? 'Load a corpus: npm run load -- --dir <directory of exports>'
        : undefined,
  };
}

/* ----------------------------------------------------------------- forecast */

async function forecastSection(client: PoolClient): Promise<Section> {
  const { rows } = await client.query<{
    chains: string;
    offices_any: string;
    offices_learnable: string;
    median_interval: string | null;
    lag_offices: string;
    lag_usable: string;
    median_lag: string | null;
    projections: string;
    measured: string;
    inferred: string;
    assumed: string;
    high: string;
    backtests: string;
    best_hit_rate: string | null;
  }>(
    `select
       (select count(*)::text from contract_followon_chain)                          as chains,
       (select count(*)::text from office_recompete_cadence)                          as offices_any,
       (select count(*)::text from office_recompete_cadence
         where chains_observed >= $1)                                                as offices_learnable,
       (select percentile_cont(0.5) within group (order by median_interval_days)::text
          from office_recompete_cadence where chains_observed >= $1)                 as median_interval,
       (select count(*)::text from office_notice_lag)                                 as lag_offices,
       (select count(*)::text from office_notice_lag
         where awards_matched >= $2)                                                 as lag_usable,
       (select percentile_cont(0.5) within group (order by median_lag_days)::text
          from office_notice_lag where awards_matched >= $2)                          as median_lag,
       (select count(*)::text from forecast_item)                                      as projections,
       (select count(*)::text from forecast_item where lead_source = 'observed_notice_lag') as measured,
       (select count(*)::text from forecast_item where lead_source = 'office_cadence')      as inferred,
       (select count(*)::text from forecast_item where lead_source = 'default')             as assumed,
       (select count(*)::text from forecast_item where confidence = 'high')                 as high,
       (select count(*)::text from forecast_backtest)                                       as backtests,
       (select max(hit_rate)::text from forecast_backtest_summary)                          as best_hit_rate`,
    [MIN_CADENCE_CHAINS, MIN_NOTICE_LAG_SAMPLE],
  );

  const row = rows[0]!;
  const projections = Number(row.projections);
  const assumed = Number(row.assumed);
  const learnable = Number(row.offices_learnable);
  const lagUsable = Number(row.lag_usable);

  const readings: Reading[] = [
    { label: 'Follow-on chains observed', value: count(row.chains) },
    {
      label: 'Offices with any observed rhythm',
      value: count(row.offices_any),
      meaning: `Of those, ${count(learnable)} clear the ${MIN_CADENCE_CHAINS}-chain bar and can drive a lead time.`,
    },
    {
      label: 'Median learned rhythm',
      value:
        row.median_interval === null
          ? 'nothing learned'
          : `${Math.round(Number(row.median_interval) / 30.44)} months`,
      meaning:
        row.median_interval === null
          ? 'No office has re-let the same kind of work often enough to measure.'
          : 'Across the offices that clear the bar.',
      concern: row.median_interval === null,
    },
    {
      label: 'Offices with a measured notice lag',
      value: `${count(lagUsable)} of ${count(row.lag_offices)}`,
      meaning:
        lagUsable === 0
          ? 'The only real measurement of a lead time available, and there is none yet. It ' +
            'accrues on its own once the SAM.gov loader has been running.'
          : `Median ${row.median_lag} days from a notice being posted to the award being signed.`,
      concern: lagUsable === 0,
    },
    { label: 'Projections', value: count(projections) },
    {
      label: 'Resting on a measurement',
      value: `${count(Number(row.measured) + Number(row.inferred))} of ${count(projections)}`,
      meaning: `${count(row.measured)} measured, ${count(row.inferred)} inferred, ${count(assumed)} assumed.`,
      concern: projections > 0 && Number(row.measured) + Number(row.inferred) === 0,
    },
    { label: 'High confidence', value: count(row.high) },
    {
      label: 'Times the forecast has been scored',
      value: count(row.backtests),
      meaning:
        Number(row.backtests) === 0
          ? 'Its accuracy is unknown. That is the honest state of it, not a missing feature.'
          : `Best hit rate so far: ${
              row.best_hit_rate === null ? 'none' : `${(Number(row.best_hit_rate) * 100).toFixed(1)}%`
            }.`,
      concern: Number(row.backtests) === 0,
    },
  ];

  const next =
    projections === 0
      ? 'Project: npm run forecast'
      : Number(row.backtests) === 0
        ? 'Score it: npm run forecast:backtest -- --sweep 2019,2020,2021,2022'
        : projections > 0 && assumed === projections
          ? 'Every lead time is the default. Let the SAM.gov loader run and load FPDS further back; ' +
            'docs/BACKLOG.md item 8 has the detail.'
          : undefined;

  return { title: 'What the forecast rests on', readings, next };
}

/* --------------------------------------------------------------------- feed */

async function feedSection(client: PoolClient): Promise<Section> {
  const { rows } = await client.query<{
    requirements: string;
    solicitations: string;
    recompetes: string;
    shaping: string;
    with_codes: string;
    with_url: string;
    people: string;
    follows: string;
    people_following: string;
    tracked: string;
    sent: string;
    senders: string;
    median_lead: string | null;
  }>(
    `select
       (select count(*)::text from feed_item)                                          as requirements,
       (select count(*)::text from feed_item where signal_class = 'active_solicitation') as solicitations,
       (select count(*)::text from feed_item where signal_class = 'recompete_window')    as recompetes,
       (select count(*)::text from feed_item where signal_class = 'shaping_target')      as shaping,
       (select count(*)::text from feed_item
         where naics_code is not null or psc_code is not null)                          as with_codes,
       (select count(*)::text from feed_item where notice_url is not null)               as with_url,
       (select count(*)::text from app_user where active)                                as people,
       (select count(*)::text from follow)                                               as follows,
       (select count(distinct principal_name)::text from follow)                         as people_following,
       (select count(*)::text from pursuit_action where action = 'track')                as tracked,
       (select count(*)::text from pursuit_action where action = 'sent')                 as sent,
       (select count(distinct principal_name)::text from pursuit_action
         where action = 'sent')                                                         as senders,
       (select percentile_cont(0.5) within group (order by days_before_response_due)::text
          from technomile_handoff)                                                      as median_lead`,
  );

  const row = rows[0]!;
  const requirements = Number(row.requirements);
  const people = Number(row.people);
  const sent = Number(row.sent);

  return {
    title: 'The feed, and whether anybody is using it',
    readings: [
      {
        label: 'Requirements',
        value: count(requirements),
        meaning: `${count(row.solicitations)} out now, ${count(row.recompetes)} recompete, ${count(row.shaping)} early enough to shape.`,
      },
      {
        label: 'Carrying a NAICS or PSC code',
        value: share(Number(row.with_codes), requirements),
        meaning:
          'A requirement with no code cannot be matched by a capability, NAICS or PSC follow. ' +
          'Only an agency, office, company or keyword follow will reach it.',
        concern: requirements > 0 && Number(row.with_codes) / requirements < 0.8,
      },
      { label: 'Linking to a SAM.gov notice', value: share(Number(row.with_url), requirements) },
      {
        label: 'People who have signed in',
        value: count(people),
        meaning: 'A row appears here the first time the platform vouches for somebody.',
      },
      {
        label: 'Follows',
        value: count(row.follows),
        meaning: `Across ${count(row.people_following)} of ${count(people)} people. Somebody with no follows sees the whole market rather than a patch.`,
        concern: people > 0 && Number(row.people_following) < people,
      },
      { label: 'Tracked', value: count(row.tracked) },
      {
        label: 'Sent to TechnoMile',
        value: count(sent),
        meaning:
          sent === 0
            ? 'The one measure of whether this tool is doing anything, and it is at zero. Every ' +
              'other figure here can look healthy while it stays there.'
            : `By ${count(row.senders)} person(s), a median ${row.median_lead} days ahead of the deadline.`,
        concern: sent === 0,
      },
    ],
    next:
      requirements === 0
        ? 'Fill the feed: npm run profile, then npm run load:sam, then npm run signals'
        : people === 0
          ? 'Nobody has signed in. Set CIE_AUTH_MODE=entra; docs/DEPLOY.md has the commands.'
          : sent === 0
            ? 'Nothing has been handed off. That is the number to watch, not any of the others.'
            : undefined,
  };
}

/* ------------------------------------------------------------------ sources */

async function sourceSection(client: PoolClient): Promise<Section> {
  const { rows } = await client.query<{
    source_system: string;
    last_success_at: Date | null;
    is_stale: boolean | null;
    runs: string;
  }>(
    `select f.source_system, f.last_success_at, f.is_stale,
            (select count(*)::text from source_run r where r.source_system = f.source_system) as runs
       from source_freshness f order by f.source_system`,
  );

  const samConfigured = (process.env.SAM_API_KEY ?? '').trim() !== '';
  const govconConfigured = (process.env.GOVCON_API_KEY ?? '').trim() !== '';
  const readings: Reading[] = rows.map((row) => ({
    label: row.source_system,
    value:
      row.last_success_at === null
        ? 'never'
        : new Date(row.last_success_at).toISOString().slice(0, 16).replace('T', ' '),
    meaning: `${count(row.runs)} run(s)${row.is_stale ? ', stale' : ''}`,
    concern: row.is_stale === true,
  }));

  readings.push({
    label: 'GOVCON_API_KEY',
    value: govconConfigured ? 'configured' : 'not set',
    meaning: govconConfigured
      ? 'The primary notice feed can run. Check it with npm run load:govcon -- --probe.'
      : 'Without it the notice feed falls back to the daily SAM.gov search, so a requirement is ' +
        'seen a day late rather than an hour late.',
    concern: !govconConfigured,
  });

  readings.push({
    label: 'SAM_API_KEY',
    value: samConfigured ? 'configured' : 'not set',
    meaning: samConfigured
      ? 'The fallback loader can reach SAM.gov directly.'
      : 'Without it the feed carries only what recompete detection found in the corpus, and no ' +
        'notice lag can ever be measured.',
    concern: !samConfigured,
  });

  // The cursor is the one piece of state that can be wrong while every other number looks right: a
  // cursor that has not moved means the hourly job is not running, and a clamped one means a window
  // was fetched by nobody. Neither shows up anywhere else.
  const { rows: cursors } = await client.query<{
    source_system: string;
    endpoint: string;
    cursor_at: Date;
    hours_behind: string;
    last_clamped: boolean;
    last_clamp_note: string | null;
  }>(
    `select source_system, endpoint, cursor_at,
            round(extract(epoch from (now() - cursor_at)) / 3600.0, 1)::text as hours_behind,
            last_clamped, last_clamp_note
       from sync_cursor order by source_system, endpoint`,
  );

  if (govconConfigured && cursors.length === 0) {
    readings.push({
      label: 'Delta cursor',
      value: 'never run',
      meaning: 'The incremental sync has not run once, so nothing is arriving hourly yet.',
      concern: true,
    });
  }

  for (const cursor of cursors) {
    const behind = Number(cursor.hours_behind);
    readings.push({
      label: `Cursor ${cursor.endpoint}`,
      value: `${cursor.hours_behind}h behind`,
      // Two hours is one missed run plus slack. Beyond that the job is not on its schedule.
      meaning: cursor.last_clamped
        ? `! clamped, and the gap was never fetched. ${cursor.last_clamp_note ?? ''}`
        : behind > 2
          ? 'Further behind than one missed run. The hourly job is probably not running.'
          : 'Moving on schedule.',
      concern: cursor.last_clamped || behind > 2,
    });
  }

  const clamped = cursors.find((c) => c.last_clamped);
  return {
    title: 'Sources',
    readings,
    next:
      clamped !== undefined
        ? 'Fill the gap: npm run load:govcon -- --backfill --from <yyyy-mm-dd>'
        : !govconConfigured
          ? 'Get a key at govconapi.com, then npm run load:govcon -- --probe'
          : !samConfigured
            ? 'Get a key from api.data.gov, registered for the Opportunities API.'
            : cursors.length === 0
              ? 'Run the sync once: npm run load:govcon'
              : undefined,
  };
}

/* ---------------------------------------------------------------- campaigns */

async function campaignSection(client: PoolClient): Promise<Section> {
  const { rows } = await client.query<{
    campaigns: string;
    sized: string;
    with_sample: string;
    gap: string;
  }>(
    `select
       (select count(*)::text from campaign)                                             as campaigns,
       (select count(*)::text from campaign where sizing_computed_at is not null)         as sized,
       (select count(*)::text from campaign
         where capture_rate is not null and capture_rate_sample_size is not null)        as with_sample,
       (select count(*)::text from campaign_gap)                                         as gap`,
  );

  const row = rows[0]!;
  return {
    title: 'Campaigns',
    readings: [
      { label: 'Campaigns', value: count(row.campaigns) },
      { label: 'Sized', value: count(row.sized), meaning: 'TAM, SAM and SOM computed from the corpus.' },
      {
        label: 'Capture rate with its sample size',
        value: count(row.with_sample),
        meaning: 'Spec 11.2: a rate from three awards is not a rate. The sample size is shown beside it.',
      },
      {
        label: 'Requirements in no campaign',
        value: count(row.gap),
        meaning: 'The gap report. Work the market is producing that no campaign claims.',
      },
    ],
    next:
      Number(row.campaigns) === 0
        ? 'Define one: npm run campaign -- --create "<name>" --nodes CAP-01,CAP-02 --offices 9700/ZOFF01 --actor <you>'
        : Number(row.sized) < Number(row.campaigns)
          ? 'Size them: npm run size'
          : undefined,
  };
}

export async function readiness(client: PoolClient): Promise<Section[]> {
  return [
    await corpusSection(client),
    await forecastSection(client),
    await feedSection(client),
    await campaignSection(client),
    await sourceSection(client),
  ];
}
