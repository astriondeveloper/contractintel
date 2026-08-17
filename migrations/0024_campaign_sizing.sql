-- 0024_campaign_sizing.sql
--
-- Market sizing for a campaign, and the report of what no campaign claims.
--
-- Spec section 11, and acceptance tests 9 and 10. The tables have existed since migration 0006
-- with nothing computing them; this is the arithmetic and the evidence behind it.
--
-- One thing has to be said before the SQL, because it is the difference between a defensible
-- figure and a number somebody will quote in a review.
--
-- **This corpus is not the federal market.** It is a targeted extract: Astrion's own history plus
-- the competitors on the watchlist. A true total addressable market means every dollar every
-- agency spent under these codes, and that is not in here and cannot be derived from what is.
-- So TAM as computed below is a **floor** — the market this corpus can see — and every screen and
-- every evidence row says so. The alternative was to compute it anyway and let the label imply a
-- completeness it does not have, which is the failure that makes a whole system untrustworthy
-- rather than merely incomplete.
--
-- What that leaves is still worth having, and the narrower figures are the sounder ones:
--
--   TAM   Obligations under the campaign's capability codes, any office, over the window.
--         A floor, bounded by the corpus.
--   SAM   The same, restricted to the offices the campaign actually targets. Narrower, and
--         better founded: a campaign that names its offices has said where it competes.
--   SOM   SAM times the observed capture rate. Not an aspiration and not a target.
--
-- The capture rate is measured rather than assumed: Astrion's obligations as a share of the same
-- slice. Spec 11.2 requires the sample size beside it, and this is why — a capture rate over three
-- awards and a capture rate over four hundred are different claims, and a screen showing only the
-- percentage invites the reader to treat them as the same.

-- ---------------------------------------------------------------------------
-- campaign_code
-- ---------------------------------------------------------------------------
-- The codes a campaign competes under: the NAICS and PSC crosswalks of every capability node
-- assigned to it.
--
-- `office_freetext` is excluded and `agency` is not a code. Migration 0005 says only resolved
-- `office` rows count for market sizing, and an unresolved seed string like "AFTC, AEDC, NSC test
-- organizations" is not an office. Sizing against it would produce a number from a sentence.
create view campaign_code as
select distinct
  cn.campaign_id,
  nc.crosswalk_type as code_type,
  nc.crosswalk_value as code_value
from campaign_node cn
join taxonomy_node tn on tn.node_id = cn.node_id and tn.active
join node_crosswalk nc on nc.node_id = cn.node_id
where nc.crosswalk_type in ('naics', 'psc')
  and coalesce(nc.crosswalk_value, '') <> '';

comment on view campaign_code is
  'The NAICS and PSC codes a campaign competes under, from its capability nodes. Agency and '
  'office_freetext crosswalks are excluded: one is not a code and the other is an unresolved string.';

-- ---------------------------------------------------------------------------
-- cie_campaign_market
-- ---------------------------------------------------------------------------
-- The obligation slice behind one campaign's sizing, over an explicit fiscal-year window.
--
-- A function rather than a view because the window is a parameter of the question. A campaign
-- sized over FY20 to FY24 and the same campaign sized over FY22 to FY24 are different numbers, and
-- the engine has to be able to ask for either without editing the campaign first.
--
-- Codes match as prefixes, the same rule the follows use: a campaign crosswalked to 5413 counts
-- 541330. The award is counted once however many of the campaign's codes it matches, which is why
-- the match is an `exists` rather than a join: a join would multiply the obligation by the number
-- of matching codes and produce a total several times the truth.
create or replace function cie_campaign_market(
  p_campaign_id bigint,
  p_fy_from integer,
  p_fy_to integer
)
returns table (
  tam_usd              numeric,
  tam_awards           bigint,
  sam_usd              numeric,
  sam_awards           bigint,
  sam_astrion_usd      numeric,
  sam_astrion_awards   bigint,
  offices_named        bigint,
  codes_named          bigint
)
language sql
stable
strict
parallel safe
as $$
  with family as (
    select e.entity_id
      from entity e
     where coalesce(e.ultimate_parent_id, e.entity_id) =
           (select entity_id from entity where canonical_name = 'Astrion')
  ),
  scoped as (
    select
      a.*,
      -- In the campaign's offices, which is what makes an addressable dollar a served one.
      exists (
        select 1 from campaign_office co
         where co.campaign_id = p_campaign_id
           and co.agency_code = a.awarding_agency_code
           and co.office_code = a.contracting_office_code
      ) as in_scope_office,
      (a.incumbent_entity_id in (select entity_id from family)) as is_astrion
    from cie_award_shape_asof(date '9999-12-31') a
    where a.starts_on is not null
      and cie_fiscal_year(a.starts_on) between p_fy_from and p_fy_to
      and exists (
        select 1 from campaign_code cc
         where cc.campaign_id = p_campaign_id
           and ((cc.code_type = 'naics' and a.naics_code is not null
                 and a.naics_code like cc.code_value || '%')
             or (cc.code_type = 'psc' and a.psc_code is not null
                 and a.psc_code like cc.code_value || '%'))
      )
  )
  select
    sum(obligated_usd),
    count(*),
    sum(obligated_usd) filter (where in_scope_office),
    count(*) filter (where in_scope_office),
    sum(obligated_usd) filter (where in_scope_office and is_astrion),
    count(*) filter (where in_scope_office and is_astrion),
    (select count(*) from campaign_office where campaign_id = p_campaign_id),
    (select count(*) from campaign_code where campaign_id = p_campaign_id)
  from scoped;
$$;

comment on function cie_campaign_market(bigint, integer, integer) is
  'The obligation slice behind one campaign, over an explicit fiscal-year window. TAM here is a '
  'floor bounded by what the corpus contains, which is not the whole federal market.';

-- ---------------------------------------------------------------------------
-- campaign_sizing_evidence
-- ---------------------------------------------------------------------------
-- Why each figure is what it is, and what it is not.
--
-- The same pattern as `evidence_ref` on an assessment and `forecast_evidence` on a projection, and
-- for the same reason: a number nobody can open is a number to be argued with rather than used.
-- `supports = false` is a caveat rather than a supporting fact, and it is shown first.
create table campaign_sizing_evidence (
  evidence_id   bigserial primary key,
  campaign_id   bigint not null references campaign (campaign_id) on delete cascade,
  figure        text not null check (figure in ('tam', 'sam', 'som', 'capture_rate', 'scope')),
  rule_id       text not null,
  detail        text not null,
  supports      boolean not null default true,
  created_at    timestamptz not null default now()
);

create index campaign_sizing_evidence_idx on campaign_sizing_evidence (campaign_id, figure, supports);

comment on table campaign_sizing_evidence is
  'One fact per row behind a campaign figure. supports = false is a caveat, shown first. The '
  'corpus-is-not-the-market caveat on TAM is always one of them.';

-- ---------------------------------------------------------------------------
-- campaign_summary
-- ---------------------------------------------------------------------------
-- One row per campaign with the stored sizing and the scope it was computed over.
--
-- `capture_rate_sample_size` sits beside `capture_rate` here and on the screen, never apart from
-- it. Acceptance test 9 is about exactly that, and it is a display requirement rather than a
-- storage one, so the view is where it is enforced: anything reading this view gets both or
-- neither.
create view campaign_summary as
select
  c.campaign_id,
  c.campaign_name,
  c.owner,
  c.business_unit,
  c.state,
  c.tam_usd,
  c.sam_usd,
  c.som_usd,
  c.capture_rate,
  c.capture_rate_sample_size,
  -- The sample size is what decides whether the rate means anything. Three bands rather than a
  -- number, because a threshold invites an argument about the threshold.
  case
    when c.capture_rate is null then 'not computed'
    when c.capture_rate_sample_size is null then 'no sample recorded'
    when c.capture_rate_sample_size < 10 then 'too few awards to be a rate'
    when c.capture_rate_sample_size < 40 then 'thin'
    else 'reasonable'
  end                                                          as capture_rate_standing,
  c.sizing_fy_from,
  c.sizing_fy_to,
  c.sizing_computed_at,
  (select count(*) from campaign_node cn where cn.campaign_id = c.campaign_id)   as nodes,
  (select count(*) from campaign_office co where co.campaign_id = c.campaign_id) as offices,
  (select count(*) from campaign_code cc where cc.campaign_id = c.campaign_id)   as codes,
  (select count(*) from pursuit p where p.campaign_id = c.campaign_id)           as requirements,
  (select count(*) from campaign_sizing_evidence e
    where e.campaign_id = c.campaign_id and not e.supports)                      as caveats
from campaign c;

comment on view campaign_summary is
  'One row per campaign. capture_rate and capture_rate_sample_size are together here so a reader '
  'cannot get one without the other. Acceptance test 9.';

-- ---------------------------------------------------------------------------
-- campaign_gap
-- ---------------------------------------------------------------------------
-- Requirements no campaign claims, and which campaign would claim them.
--
-- Acceptance test 10 asks only that the report list at least one. The `would_match` column is what
-- makes it worth opening: "nothing has been assigned to a campaign" is a fact about the database,
-- whereas "this requirement matches the codes of a campaign somebody owns and is not in it" is a
-- thing to go and do something about.
--
-- Market movement is excluded on the same argument the feed excludes it: an award notice describes
-- work that is finished, and a gap in coverage of the past is a different report.
create view campaign_gap as
select
  p.pursuit_id,
  p.title,
  p.signal_class,
  p.agency_code,
  p.office_code,
  p.naics_code,
  p.psc_code,
  p.estimated_value,
  p.response_date,
  p.period_end_date,
  p.created_at                                          as first_seen_at,
  -- The campaigns whose codes this requirement matches, so the gap is actionable rather than
  -- merely countable.
  (select string_agg(distinct c.campaign_name, '; ' order by c.campaign_name)
     from campaign_code cc
     join campaign c on c.campaign_id = cc.campaign_id and c.state = 'active'
    where (cc.code_type = 'naics' and p.naics_code is not null
           and p.naics_code like cc.code_value || '%')
       or (cc.code_type = 'psc' and p.psc_code is not null
           and p.psc_code like cc.code_value || '%'))    as would_match,
  (p.naics_code is null and p.psc_code is null)          as uncodeable
from pursuit p
where p.campaign_id is null
  and p.signal_class <> 'market_movement';

comment on view campaign_gap is
  'Requirements in no campaign, with the campaign whose codes they match. uncodeable marks the ones '
  'carrying neither a NAICS nor a PSC, which no campaign could claim on codes alone.';

-- ---------------------------------------------------------------------------
-- Scope for a campaign, recorded rather than implied
-- ---------------------------------------------------------------------------
-- A campaign sized over a window nobody recorded is a figure that cannot be reproduced. The
-- columns exist on `campaign` from 0006; this makes the absence of them visible.
comment on column campaign.sizing_fy_from is
  'The fiscal-year window the sizing was computed over. Null means the figures were never '
  'computed, or were computed by something that did not record its own inputs.';
