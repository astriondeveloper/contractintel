-- 0023_forecast.sql
--
-- What will solicit, and roughly when.
--
-- Everything before this migration is about requirements that already exist somewhere: a
-- notice SAM.gov posted, a contract whose end date is inside the recompete window. The
-- forecast is the one part of this system that makes a claim about the future, and that
-- makes it both the most valuable screen and the only one that can be wrong in a way nobody
-- notices for two years. So it is built to be checkable rather than to be impressive.
--
-- The projection is deliberately simple, and the arithmetic is stated on screen:
--
--     projected solicitation date  =  contract end date  -  lead time
--
-- Everything interesting is in where the lead time comes from and how much the projection
-- should be believed. Three answers, in descending order of how much they are worth:
--
--   observed_notice_lag   The office's own measured gap between posting a solicitation and
--                         signing the award, from notices this system has actually seen.
--                         A measurement. Rare, because SAM.gov coverage here starts when
--                         this system started looking.
--   office_cadence        The office's observed interval between successive lettings of the
--                         same kind of work, from FPDS. Not a lead time as such: an office
--                         that re-lets on a five-year rhythm is an office whose next
--                         competition is predictable, and the chain evidence is what says so.
--   default               Twelve months, decision D13. An assumption, and labelled one.
--
-- Confidence is derived from evidence rather than asserted, and low-confidence rows are
-- shown and flagged rather than dropped. A forecast that hides its weak rows looks better
-- and is worth less: the reader cannot tell a thin quarter from a quiet one.
--
-- Nothing here writes a `pursuit`. A forecast is not a requirement; it is a statement that
-- one is likely. Conflating the two would put speculative rows in the feed, and the feed's
-- whole claim is that everything in it is real.

-- ---------------------------------------------------------------------------
-- Fiscal quarter
-- ---------------------------------------------------------------------------
-- cie_fiscal_year already exists. The federal fiscal year starts 1 October, so Q1 is
-- October to December and the calendar quarter is off by one from the fiscal one.
create or replace function cie_fiscal_quarter(d date)
returns integer
language sql
immutable
strict
parallel safe
as $$
  select ((extract(month from d)::int + 2) % 12) / 3 + 1;
$$;

comment on function cie_fiscal_quarter(date) is
  'Federal fiscal quarter, 1 to 4. Q1 is October to December. Pairs with cie_fiscal_year.';

create or replace function cie_fiscal_quarter_label(fy integer, q integer)
returns text
language sql
immutable
strict
parallel safe
as $$
  select 'FY' || lpad((fy % 100)::text, 2, '0') || ' Q' || q;
$$;

-- ---------------------------------------------------------------------------
-- cie_award_shape_asof
-- ---------------------------------------------------------------------------
-- One row per award with the things a cadence needs: where it was bought, what kind of work
-- it was, when it started, and when it ends. As of a date.
--
-- The as-of parameter is the whole reason this is a function rather than a view, and it is
-- what makes the backtest worth running rather than reassuring.
--
-- A backtest asks "if this forecast had been produced in 2023, would it have been right?"
-- Answering that honestly means the 2023 projection may only see what was knowable in 2023,
-- and the leak is not the obvious one. Filtering out awards signed after the as-of date is
-- easy. The one that bites is the **modification**: a contract whose end date was extended by
-- a modification signed in 2025 shows a 2029 end date today, and a 2023 projection that used
-- it would be projecting from a fact that did not exist yet. It would score well, and the
-- score would mean nothing.
--
-- So the grouping is done here with a signed-date filter rather than by filtering
-- `contract_group` from migration 0019, which cannot express it: the end date is an aggregate
-- over actions, so the filter has to be inside the aggregate rather than outside the view.
-- The identity rule is 0019's and unchanged: the key is (awarding_agency_code, idv_piid, piid)
-- because a task order PIID is only unique inside its vehicle. Read 0019 before changing it.
--
-- One deliberate difference from `contract_group`: an action with no signed date is excluded.
-- It cannot be placed in time at all, so it cannot be included as-of anything, and letting it
-- through would make the as-of view differ from the plain one for reasons unrelated to the date.
--
-- The PSC comes with the row and is required downstream. A cadence is a claim about a *kind
-- of work* recurring in an office, and an award with no product or service code says nothing
-- about what kind of work it was; grouping the code-less awards together would invent a
-- category called "unclassified work in this office" and then measure its rhythm.
-- `award_shape_excluded` counts what that leaves out, in the same spirit as
-- `contract_group_ambiguous`: the gap is measured rather than assumed away.
create or replace function cie_award_shape_asof(as_of date)
returns table (
  awarding_agency_code     text,
  contracting_office_code  text,
  idv_piid_key             text,
  piid                     text,
  starts_on                date,
  ends_on                  date,
  current_ends_on          date,
  obligated_usd            numeric,
  base_and_all_options     numeric,
  incumbent_entity_id      bigint,
  incumbent_confidence     text,
  set_aside_type           text,
  action_count             bigint,
  distinct_awardees        bigint,
  distinct_offices         bigint,
  psc_code                 text,
  naics_code               text
)
language sql
stable
strict
parallel safe
as $$
  with visible as (
    select * from contract_action
     where signed_date is not null and signed_date <= as_of
  ),
  grp as (
    select
      v.awarding_agency_code,
      coalesce(v.idv_piid, '')                          as idv_piid_key,
      v.piid,
      min(v.signed_date)                                as starts_on,
      max(v.ultimate_completion_date)                   as ends_on,
      max(v.current_completion_date)                    as current_ends_on,
      sum(v.action_obligation)                          as obligated_usd,
      max(v.base_and_all_options)                       as base_and_all_options,
      count(*)                                          as action_count,
      count(distinct v.entity_id)                       as distinct_awardees,
      count(distinct v.contracting_office_code)         as distinct_offices,
      (array_agg(v.entity_id order by v.signed_date desc, v.contract_action_id desc)
         filter (where v.entity_id is not null))[1]     as incumbent_entity_id,
      (array_agg(v.entity_match_confidence order by v.signed_date desc, v.contract_action_id desc)
         filter (where v.entity_match_confidence is not null))[1] as incumbent_confidence,
      (array_agg(v.contracting_office_code order by v.signed_date desc, v.contract_action_id desc)
         filter (where v.contracting_office_code is not null))[1] as contracting_office_code,
      (array_agg(v.set_aside_type order by v.signed_date desc, v.contract_action_id desc)
         filter (where v.set_aside_type is not null))[1] as set_aside_type
    from visible v
    group by v.awarding_agency_code, coalesce(v.idv_piid, ''), v.piid
  ),
  -- Classification is many rows per action, so it is aggregated separately. Joining it into
  -- the group above would multiply every obligation by the number of codes on the action,
  -- which is a wrong number that looks entirely plausible.
  codes as (
    select
      v.awarding_agency_code,
      coalesce(v.idv_piid, '')                          as idv_piid_key,
      v.piid,
      (array_agg(cac.code_value order by cac.is_principal desc, cac.code_value)
         filter (where cac.code_type = 'psc'))[1]       as psc_code,
      (array_agg(cac.code_value order by cac.is_principal desc, cac.code_value)
         filter (where cac.code_type = 'naics'))[1]     as naics_code
    from visible v
    join contract_action_classification cac on cac.contract_action_id = v.contract_action_id
    group by v.awarding_agency_code, coalesce(v.idv_piid, ''), v.piid
  )
  select
    g.awarding_agency_code, g.contracting_office_code, g.idv_piid_key, g.piid,
    g.starts_on, g.ends_on, g.current_ends_on, g.obligated_usd, g.base_and_all_options,
    g.incumbent_entity_id, g.incumbent_confidence, g.set_aside_type,
    g.action_count, g.distinct_awardees, g.distinct_offices,
    c.psc_code, c.naics_code
  from grp g
  left join codes c
         on c.awarding_agency_code = g.awarding_agency_code
        and c.idv_piid_key = g.idv_piid_key
        and c.piid = g.piid;
$$;

comment on function cie_award_shape_asof(date) is
  'Award-level rows as they were knowable on a date, with modifications signed later excluded '
  'from the end-date aggregate. The function the backtest depends on: filtering contract_group '
  'cannot express it, because the end date is an aggregate and the filter belongs inside it.';

-- Today's view of the same thing. Everything except the backtest reads this.
create view award_shape as
  select * from cie_award_shape_asof(date '9999-12-31');

comment on view award_shape is
  'One row per award with its office, its PSC, and its dates. The input to cadence learning.';

create view award_shape_excluded as
select
  count(*)                                                               as awards,
  count(*) filter (where psc_code is null)                               as no_psc,
  count(*) filter (where ends_on is null)                                as no_end_date,
  count(*) filter (where contracting_office_code is null)                 as no_office,
  count(*) filter (where psc_code is null or ends_on is null
                      or contracting_office_code is null)                as excluded_from_cadence
from award_shape;

comment on view award_shape_excluded is
  'How much of the corpus cannot contribute to a cadence, and why. A forecast built on a '
  'third of the awards should say so rather than presenting itself as complete.';

-- ---------------------------------------------------------------------------
-- contract_followon_chain
-- ---------------------------------------------------------------------------
-- The observable trace of a recompete.
--
-- FPDS does not say "this award replaces that one": a recompete arrives as a new PIID with
-- no pointer back. What it does say is when each award started and ended, in which office,
-- for what kind of work. So a follow-on is inferred from adjacency: the same office buys the
-- same product or service code again, and the new award starts around the time the old one
-- ends. The interval between the two start dates is the cadence.
--
-- The window is deliberately asymmetric. Six months early covers an office that awards the
-- follow-on before the incumbent's period runs out, which is what a well-run recompete looks
-- like. Twelve months late covers a bridge, an extension, or a protest, which is what a
-- badly-run one looks like. Beyond that the two awards are more likely unrelated than
-- sequential, and a cadence built from unrelated awards is a number with no referent.
--
-- One successor per award, the earliest qualifying one. Without that, an office with twenty
-- awards under one PSC produces a few hundred pairs and the median interval measures the
-- density of the office's buying rather than the rhythm of any requirement in it.
--
-- `same_vehicle` is carried rather than filtered. Two consecutive task orders under one IDV
-- are not a recompete of the vehicle, but they are the office re-competing that work at the
-- task order level, which is the event BD needs to be in front of. Whether a cadence rests
-- entirely on same-vehicle chains is something the reader should be able to see, so it is a
-- column rather than a decision taken here.
--
-- As-of aware for the same reason `cie_award_shape_asof` is: a chain learned from an award
-- that had not been made yet is a rhythm the forecast could not have known, and a backtest
-- that learns from one is measuring its own inputs.
create or replace function cie_followon_chain_asof(as_of date)
returns table (
  awarding_agency_code       text,
  contracting_office_code    text,
  psc_code                   text,
  prior_piid                 text,
  prior_idv_piid_key         text,
  prior_starts_on            date,
  prior_ends_on              date,
  prior_incumbent_entity_id  bigint,
  next_piid                  text,
  next_idv_piid_key          text,
  next_starts_on             date,
  next_incumbent_entity_id   bigint,
  interval_days              integer,
  gap_days                   integer,
  prior_duration_days        integer,
  same_vehicle               boolean,
  incumbent_retained         boolean
)
language sql
stable
strict
parallel safe
as $$
  with award as (
    select * from cie_award_shape_asof(as_of)
     where ends_on is not null
       and psc_code is not null
       and contracting_office_code is not null
  )
  select
    prior.awarding_agency_code,
    prior.contracting_office_code,
    prior.psc_code,
    prior.piid,
    prior.idv_piid_key,
    prior.starts_on,
    prior.ends_on,
    prior.incumbent_entity_id,
    successor.piid,
    successor.idv_piid_key,
    successor.starts_on,
    successor.incumbent_entity_id,
    (successor.starts_on - prior.starts_on)::int,
    (successor.starts_on - prior.ends_on)::int,
    (prior.ends_on - prior.starts_on)::int,
    (prior.idv_piid_key = successor.idv_piid_key),
    (prior.incumbent_entity_id is not null
     and prior.incumbent_entity_id = successor.incumbent_entity_id)
  from award prior
  cross join lateral (
    select n.piid, n.idv_piid_key, n.starts_on, n.incumbent_entity_id
      from award n
     where n.awarding_agency_code    = prior.awarding_agency_code
       and n.contracting_office_code = prior.contracting_office_code
       and n.psc_code                = prior.psc_code
       and (n.piid, n.idv_piid_key) <> (prior.piid, prior.idv_piid_key)
       and n.starts_on > prior.starts_on
       and n.starts_on >= prior.ends_on - interval '180 days'
       and n.starts_on <= prior.ends_on + interval '365 days'
     order by n.starts_on, n.piid
     limit 1
  ) successor;
$$;

comment on function cie_followon_chain_asof(date) is
  'Inferred recompete pairs as they were knowable on a date. The backtest calls it with a '
  'past date so it cannot learn a rhythm from an award that had not happened yet.';

create view contract_followon_chain as
  select * from cie_followon_chain_asof(date '9999-12-31');

comment on view contract_followon_chain is
  'Inferred recompete pairs: the same office buying the same PSC again around the time the '
  'previous award ends. FPDS carries no pointer from a recompete back to what it replaced, '
  'so adjacency is the only available evidence and the window is stated in the migration.';

-- ---------------------------------------------------------------------------
-- office_recompete_cadence
-- ---------------------------------------------------------------------------
-- What one office's rhythm looks like, per kind of work, with the sample size beside it.
--
-- The sample size is not optional decoration. Spec 11.2 makes the same demand of a capture
-- rate for the same reason: a five-year cadence from one observed chain and a five-year
-- cadence from nine are different claims, and a screen that shows only the number invites
-- the reader to treat them as the same.
create view office_recompete_cadence as
select
  awarding_agency_code,
  contracting_office_code,
  psc_code,
  count(*)::int                                                        as chains_observed,
  count(*) filter (where not same_vehicle)::int                        as chains_across_vehicles,
  count(*) filter (where incumbent_retained)::int                      as chains_incumbent_retained,
  -- The median rather than the mean. One bridge contract at eleven months and one twenty-year
  -- vehicle in the same office would put the mean somewhere neither of them is.
  percentile_cont(0.5) within group (order by interval_days)::int       as median_interval_days,
  min(interval_days)::int                                              as min_interval_days,
  max(interval_days)::int                                              as max_interval_days,
  percentile_cont(0.5) within group (order by prior_duration_days)::int as median_duration_days,
  -- How much before the previous end date the follow-on was actually awarded. Negative means
  -- the office let the requirement lapse and came back to it.
  percentile_cont(0.5) within group (order by gap_days)::int            as median_gap_days,
  max(next_starts_on)                                                  as last_followon_starts_on
from contract_followon_chain
group by awarding_agency_code, contracting_office_code, psc_code;

comment on view office_recompete_cadence is
  'Per office and PSC: how often the same work is re-let, and from how many observed chains. '
  'The sample size is shown wherever the interval is, per the argument in spec 11.2.';

-- ---------------------------------------------------------------------------
-- office_notice_lag
-- ---------------------------------------------------------------------------
-- The only real measurement of a lead time available here.
--
-- A SAM.gov notice carries the date it was posted and the solicitation number. An FPDS
-- action carries the solicitation number it was awarded under and the date it was signed.
-- Where both exist for the same solicitation, the difference is that office's actual gap
-- between announcing a requirement and awarding it, measured rather than assumed.
--
-- Coverage is thin and will stay thin for a while: this system's SAM.gov history starts when
-- it started looking, and an award signed today was solicited before that. The lag is used
-- where it exists and the default is used, and labelled, where it does not. That is better
-- than either waiting for coverage or pretending the assumption is a measurement.
create view office_notice_lag as
select
  p.agency_code,
  p.office_code,
  count(*)::int                                                     as awards_matched,
  percentile_cont(0.5) within group (order by ca.signed_date - p.posted_date)::int as median_lag_days,
  min(ca.signed_date - p.posted_date)::int                           as min_lag_days,
  max(ca.signed_date - p.posted_date)::int                           as max_lag_days
from pursuit p
join contract_action ca
  on upper(btrim(ca.piid)) = upper(btrim(p.solicitation_number))
   or (ca.idv_piid is not null and upper(btrim(ca.idv_piid)) = upper(btrim(p.solicitation_number)))
where p.posted_date is not null
  and p.solicitation_number is not null
  and btrim(p.solicitation_number) <> ''
  and ca.signed_date is not null
  and ca.signed_date > p.posted_date
group by p.agency_code, p.office_code;

comment on view office_notice_lag is
  'Measured days from a notice being posted to the award being signed, per office, from '
  'solicitation numbers that appear in both SAM.gov and FPDS. Thin coverage by construction: '
  'an award signed today was solicited before this system existed.';

-- ---------------------------------------------------------------------------
-- expiring_vehicle
-- ---------------------------------------------------------------------------
-- A vehicle ending is not the end of anything. It is an on-ramp.
--
-- An IDV that expires has to be replaced, and the replacement is competed on-ramp by
-- on-ramp rather than as a single award, which makes it a different and often earlier
-- opportunity than any of the task orders under it. Treating it as "a contract ending"
-- would file the largest opportunities in the corpus under the smallest heading.
--
-- The vehicle's own end date is preferred where the corpus holds the IDV award itself. Where
-- it does not, the latest end date across its task orders is the floor: the vehicle cannot
-- end before the work ordered under it does.
create or replace function cie_expiring_vehicle_asof(as_of date)
returns table (
  awarding_agency_code    text,
  idv_piid                text,
  order_count             integer,
  obligated_usd           numeric,
  largest_order_ceiling   numeric,
  last_order_ends_on      date,
  vehicle_ends_on         date,
  expires_on              date,
  vehicle_record_present  boolean,
  contracting_office_code text,
  psc_code                text,
  naics_code              text,
  distinct_holders        integer
)
language sql
stable
strict
parallel safe
as $$
  with award as (select * from cie_award_shape_asof(as_of))
  select
    o.awarding_agency_code,
    o.idv_piid_key,
    count(distinct o.piid)::int,
    sum(o.obligated_usd),
    max(o.base_and_all_options),
    max(o.ends_on),
    v.ends_on,
    coalesce(v.ends_on, max(o.ends_on)),
    (v.ends_on is not null),
    -- The office that placed the most orders under it, rather than an arbitrary one. A
    -- vehicle used by several offices belongs, for forecasting purposes, to the one that
    -- actually buys through it.
    mode() within group (order by o.contracting_office_code),
    mode() within group (order by o.psc_code),
    mode() within group (order by o.naics_code),
    count(distinct o.incumbent_entity_id)::int
  from award o
  left join award v
         on v.awarding_agency_code = o.awarding_agency_code
        and v.idv_piid_key = ''
        and v.piid = o.idv_piid_key
  where o.idv_piid_key <> ''
  group by o.awarding_agency_code, o.idv_piid_key, v.ends_on;
$$;

comment on function cie_expiring_vehicle_asof(date) is
  'Vehicles and the dates they run out, as knowable on a date. As-of aware for the same '
  'reason cie_award_shape_asof is: a later modification moves the expiry.';

create view expiring_vehicle as
  select * from cie_expiring_vehicle_asof(date '9999-12-31');

comment on view expiring_vehicle is
  'One row per vehicle with the date it runs out. An IDV ending is an on-ramp opportunity, '
  'not a contract ending, and often a larger and earlier one than any order under it.';

-- ---------------------------------------------------------------------------
-- forecast_item
-- ---------------------------------------------------------------------------
-- One projected solicitation. Written by a batch job, idempotent on `forecast_key` in the
-- same way a generated pursuit is idempotent on `signal_key`, so the job can run on a
-- rhythm without accumulating duplicates.
--
-- A forecast row is derived from end to end and holds no working state. There is nothing for
-- a person to change on one: a projection you can edit is a projection whose accuracy cannot
-- be scored, and scoring it is the point of the backtest below. What a person does with a
-- forecast is follow the office, or wait for the requirement to appear in the feed.
create table forecast_item (
  forecast_id       bigserial primary key,

  -- Deterministic identity, so a re-run updates rather than duplicates.
  forecast_key      text not null unique,

  basis             text not null check (basis in ('contract_end', 'vehicle_expiry')),

  title             text not null,
  agency_code       text,
  office_code       text,
  related_piid      text,
  idv_piid          text,
  naics_code        text,
  psc_code          text,

  incumbent_entity_id  bigint references entity (entity_id),
  incumbent_confidence text check (incumbent_confidence in ('confirmed', 'probable', 'unresolved')),
  astrion_position     text check (astrion_position in ('prime_incumbent', 'subcontractor', 'none')),

  -- The arithmetic, kept in full so the screen can show it rather than restate it.
  period_end_date             date    not null,
  lead_days                   integer not null check (lead_days >= 0),
  projected_solicitation_date date    not null,
  projected_fy                integer not null,
  projected_quarter           integer not null check (projected_quarter between 1 and 4),

  -- Null means not known. Never zero. The forecast screen sums these and reports how many
  -- rows carried no figure, because a quarter's value is a floor when a third of its
  -- contracts have no ceiling recorded.
  estimated_value   numeric(20, 2),
  value_basis       text check (value_basis in ('base_and_all_options', 'obligated', 'order_ceiling')),

  confidence        text not null check (confidence in ('high', 'medium', 'low')),
  lead_source       text not null check (lead_source in ('observed_notice_lag', 'office_cadence', 'default')),
  cadence_chains    integer,
  cadence_median_days integer,
  notice_lag_sample integer,

  -- Set when a requirement for this contract has already been detected, so the forecast can
  -- say "this one has arrived" instead of counting it twice in the same quarter.
  pursuit_id        bigint references pursuit (pursuit_id) on delete set null,

  source_version_id bigint references source_version (source_version_id),
  generated_by      text,
  generated_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index forecast_item_quarter_idx  on forecast_item (projected_fy, projected_quarter);
create index forecast_item_office_idx   on forecast_item (agency_code, office_code);
create index forecast_item_psc_idx      on forecast_item (psc_code) where psc_code is not null;
create index forecast_item_naics_idx    on forecast_item (naics_code) where naics_code is not null;
create index forecast_item_entity_idx   on forecast_item (incumbent_entity_id) where incumbent_entity_id is not null;
create index forecast_item_confidence_idx on forecast_item (confidence, projected_fy, projected_quarter);

select cie_attach_touch('forecast_item');

comment on table forecast_item is
  'One projected solicitation: a contract end date or vehicle expiry, minus a lead time, '
  'placed in a fiscal quarter. Wholly derived and holds no working state, so its accuracy '
  'can be scored against what actually happened.';
comment on column forecast_item.lead_source is
  'Where the lead time came from. observed_notice_lag is a measurement; office_cadence is '
  'inferred from FPDS adjacency; default is decision D13 and is labelled as an assumption.';

-- ---------------------------------------------------------------------------
-- forecast_evidence
-- ---------------------------------------------------------------------------
-- Why this row is here and why it carries the confidence it does, one fact per row.
--
-- The same argument as `evidence_ref` on an assessment, and the same rule about contrary
-- evidence: a fact that argues against the projection is stored with `supports = false` and
-- shown first. A forecast that only ever shows its supporting reasons trains the reader to
-- stop reading them.
create table forecast_evidence (
  evidence_id   bigserial primary key,
  forecast_id   bigint not null references forecast_item (forecast_id) on delete cascade,
  -- A stable rule identifier, so a fact can be looked up and argued with.
  rule_id       text not null,
  detail        text not null,
  supports      boolean not null default true,
  source_system text,
  source_uri    text,
  created_at    timestamptz not null default now()
);

create index forecast_evidence_forecast_idx on forecast_evidence (forecast_id, supports);

comment on table forecast_evidence is
  'One fact per row behind a projection. supports = false is evidence against, shown first '
  'and never hidden, on the same argument as spec 14.2 makes for a score.';

-- ---------------------------------------------------------------------------
-- forecast_quarter
-- ---------------------------------------------------------------------------
-- The bars. Volume, value, and how much of each is worth believing.
create view forecast_quarter as
select
  projected_fy,
  projected_quarter,
  cie_fiscal_quarter_label(projected_fy, projected_quarter)        as quarter_label,
  count(*)::int                                                    as items,
  count(*) filter (where confidence = 'high')::int                 as high_confidence,
  count(*) filter (where confidence = 'medium')::int               as medium_confidence,
  count(*) filter (where confidence = 'low')::int                  as low_confidence,
  count(*) filter (where basis = 'vehicle_expiry')::int            as vehicles,
  count(*) filter (where pursuit_id is not null)::int              as already_detected,
  count(*) filter (where astrion_position = 'prime_incumbent')::int as prime_incumbent,
  count(*) filter (where astrion_position = 'subcontractor')::int   as subcontractor,
  -- A floor, not a total: the rows with no recorded value are counted separately rather than
  -- being folded in as zero.
  sum(estimated_value)                                             as value_floor_usd,
  count(*) filter (where estimated_value is null)::int             as items_without_value,
  min(projected_solicitation_date)                                 as earliest,
  max(projected_solicitation_date)                                 as latest
from forecast_item
group by projected_fy, projected_quarter;

comment on view forecast_quarter is
  'One row per projected fiscal quarter. value_floor_usd is a floor and items_without_value '
  'says by how much it could be short, because blank is not zero.';

-- ---------------------------------------------------------------------------
-- follow_forecast
-- ---------------------------------------------------------------------------
-- The forecast in one person's patch.
--
-- The same matching rules as `follow_pursuit`, against forecast rows instead of requirements.
-- Written out rather than shared through a function because the two things being matched are
-- different tables with different columns, and a clever abstraction over both would hide
-- exactly the part a reader needs to check.
create view follow_forecast as
select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id,
       nc.crosswalk_type as matched_field, nc.crosswalk_value as matched_value
  from follow f
  join node_crosswalk nc on nc.node_id = f.node_id
  join taxonomy_node tn  on tn.node_id = f.node_id and tn.active
  join forecast_item fi
    on (nc.crosswalk_type = 'naics' and fi.naics_code is not null
        and fi.naics_code like nc.crosswalk_value || '%')
    or (nc.crosswalk_type = 'psc' and fi.psc_code is not null
        and fi.psc_code like nc.crosswalk_value || '%')
    or (nc.crosswalk_type = 'keyword' and fi.title ilike '%' || nc.crosswalk_value || '%')
 where f.follow_type = 'capability'
   and coalesce(nc.crosswalk_value, '') <> ''

union all

select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id, 'agency', fi.agency_code
  from follow f
  join forecast_item fi on fi.agency_code = f.agency_code
 where f.follow_type = 'agency'

union all

select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id,
       'office', fi.agency_code || '/' || fi.office_code
  from follow f
  join forecast_item fi on fi.agency_code = f.agency_code and fi.office_code = f.office_code
 where f.follow_type = 'office'

union all

select distinct f.follow_id, f.principal_name, f.follow_type, fi.forecast_id,
       'incumbent', e.canonical_name
  from follow f
  join forecast_item fi on fi.incumbent_entity_id is not null
  join entity e on e.entity_id = fi.incumbent_entity_id
 where f.follow_type = 'company'
   and (e.entity_id = f.entity_id or coalesce(e.ultimate_parent_id, e.entity_id) = f.entity_id)

union all

select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id, 'naics', fi.naics_code
  from follow f
  join forecast_item fi on fi.naics_code is not null and fi.naics_code like f.target || '%'
 where f.follow_type = 'naics'

union all

select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id, 'psc', fi.psc_code
  from follow f
  join forecast_item fi on fi.psc_code is not null and fi.psc_code like f.target || '%'
 where f.follow_type = 'psc'

union all

select f.follow_id, f.principal_name, f.follow_type, fi.forecast_id, 'title', f.label
  from follow f
  join forecast_item fi on fi.title ilike '%' || f.target || '%'
 where f.follow_type = 'keyword';

comment on view follow_forecast is
  'Which projections fall in each person''s patch, and which follow put them there.';

-- ---------------------------------------------------------------------------
-- forecast_backtest
-- ---------------------------------------------------------------------------
-- Scoring the forecast against what actually happened.
--
-- This exists because the forecast is the least verifiable thing in the build and the
-- easiest to be quietly wrong about. Accuracy cannot be checked forwards without waiting
-- two years, so it is checked backwards: run the projection as if today were an earlier
-- date, using only awards signed before that date, then look at what the corpus says
-- actually happened in the window it projected.
--
-- What counts as a hit is a judgement and it is recorded on the run rather than hidden in
-- code, because it is the number everything else depends on. The default is deliberately
-- generous about timing and strict about subject: the same office buying the same PSC inside
-- the projected quarter plus a tolerance. Generous about timing because a projection that is
-- one quarter early is useful and a scoring rule that calls it a miss would push the method
-- towards uselessly wide windows. Strict about subject because "something was bought
-- somewhere" is not a forecast.
create table forecast_backtest (
  backtest_id     bigserial primary key,

  -- Today, as far as this run is concerned. Every input is filtered to before it.
  as_of_date      date not null,
  -- How far past as_of_date the projection was scored over.
  horizon_months  integer not null check (horizon_months > 0),
  -- Slack either side of a projected quarter that still counts as a hit.
  tolerance_days  integer not null check (tolerance_days >= 0),

  method          text not null,

  projected       integer not null,
  hits            integer not null,
  misses          integer not null,
  -- Awards that actually happened in the window and were not projected at all. The number
  -- that says how much the forecast is missing rather than how much of it is right, and the
  -- one a precision-only report would leave out.
  unforecast      integer,

  hits_high       integer,
  projected_high  integer,
  hits_medium     integer,
  projected_medium integer,
  hits_low        integer,
  projected_low   integer,

  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index forecast_backtest_asof_idx on forecast_backtest (as_of_date desc);

select cie_attach_touch('forecast_backtest');

comment on table forecast_backtest is
  'One scoring run of the forecast against history. Records what counted as a hit, because '
  'that rule is the number every other figure in the run depends on.';

create table forecast_backtest_item (
  item_id         bigserial primary key,
  backtest_id     bigint not null references forecast_backtest (backtest_id) on delete cascade,

  agency_code     text,
  office_code     text,
  psc_code        text,
  related_piid    text,
  projected_solicitation_date date not null,
  projected_fy    integer not null,
  projected_quarter integer not null,
  confidence      text not null,
  lead_source     text not null,
  estimated_value numeric(20, 2),

  outcome         text not null check (outcome in ('hit', 'miss')),
  -- The award that made it a hit, and how far off the projection was. Negative means the
  -- award landed before the projected date.
  matched_piid    text,
  matched_signed_date date,
  days_off        integer,

  created_at      timestamptz not null default now()
);

create index forecast_backtest_item_run_idx on forecast_backtest_item (backtest_id, outcome);

comment on table forecast_backtest_item is
  'Every projection in a backtest run with its outcome and, on a hit, the award that matched '
  'it. Kept per item so a bad run can be read rather than only totalled.';

create view forecast_backtest_summary as
select
  backtest_id,
  as_of_date,
  horizon_months,
  tolerance_days,
  projected,
  hits,
  misses,
  unforecast,
  case when projected > 0 then round(hits::numeric / projected, 3) end as hit_rate,
  case when projected_high   > 0 then round(hits_high::numeric   / projected_high, 3)   end as hit_rate_high,
  case when projected_medium > 0 then round(hits_medium::numeric / projected_medium, 3) end as hit_rate_medium,
  case when projected_low    > 0 then round(hits_low::numeric    / projected_low, 3)    end as hit_rate_low,
  -- What share of what actually happened was projected at all.
  case when (hits + coalesce(unforecast, 0)) > 0
       then round(hits::numeric / (hits + coalesce(unforecast, 0)), 3) end as recall,
  method,
  notes,
  created_at
from forecast_backtest;

comment on view forecast_backtest_summary is
  'Hit rate by confidence band, and recall against everything that actually happened. The '
  'confidence bands are meant to separate: if low scores as well as high, the banding is '
  'decoration and should be said to be.';
