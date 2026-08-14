-- 0010_watchlist_seed_direction.sql
--
-- The direction counts carried in competitor_watchlist_seed.csv, held per
-- observed spelling rather than per entity.
--
-- Why this table exists. The seed file holds 47 rows, but two companies appear
-- under two spellings each:
--
--   KESTREL TECHNOLOGIES INC            179 / 77   both
--   KESTREL TECHNOLOGIES, INC.            8 /  0   astrion_subs_to_them
--   APPLEWOOD RESEARCH SOLUTIONS, INC    54 /  0   astrion_subs_to_them
--   APPLEWOOD RESEARCH SOLUTIONS, INC.    0 / 56   they_sub_to_astrion
--
-- Both spellings of each pair normalise to one name, so they resolve to one
-- entity, which is the behaviour acceptance test 3 requires. The counts must
-- then be summed across spellings to describe the company. Storing the counts
-- per spelling keeps the seed file's own numbers auditable and lets the rollup
-- be a view rather than a destructive edit.
--
-- This table is seed provenance, not the long-term source of truth. Once the
-- DACIS subcontract records load into subcontract_edge, the teaming_direction
-- view in 0004_awards.sql supersedes it.

create table watchlist_seed_direction (
  alias_id                     bigint primary key
                                 references entity_alias (alias_id) on delete cascade,
  times_astrion_subbed_to_them integer not null default 0,
  times_they_subbed_to_astrion integer not null default 0,
  observed_relationship_stated text,
  watchlist_tier               text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

select cie_attach_touch('watchlist_seed_direction');

-- The company-level rollup. Counts summed across every spelling that resolves to
-- the entity, and the direction recomputed from the summed counts.
create view watchlist_company as
with rolled as (
  select
    e.entity_id,
    e.canonical_name,
    count(*)                                       as spelling_count,
    array_agg(a.alias_name order by a.alias_name)   as spellings,
    array_agg(distinct d.observed_relationship_stated) as stated_directions,
    sum(d.times_astrion_subbed_to_them)            as times_astrion_subbed_to_them,
    sum(d.times_they_subbed_to_astrion)            as times_they_subbed_to_astrion
  from entity e
  join entity_alias a on a.entity_id = e.entity_id
  join watchlist_seed_direction d on d.alias_id = a.alias_id
  where e.entity_type = 'watchlist'
  group by e.entity_id, e.canonical_name
)
select
  r.*,
  case
    when r.times_astrion_subbed_to_them > 0
     and r.times_they_subbed_to_astrion > 0 then 'both'
    when r.times_astrion_subbed_to_them > 0 then 'astrion_subs_to_them'
    when r.times_they_subbed_to_astrion > 0 then 'they_sub_to_astrion'
    else 'none'
  end as observed_relationship,
  -- True when rolling the spellings together changes the direction that the seed
  -- file stated for a single spelling. A row here is a company the seed file
  -- described in only one direction because its records were split by spelling.
  (r.spelling_count > 1
   and not (case
     when r.times_astrion_subbed_to_them > 0
      and r.times_they_subbed_to_astrion > 0 then 'both'
     when r.times_astrion_subbed_to_them > 0 then 'astrion_subs_to_them'
     when r.times_they_subbed_to_astrion > 0 then 'they_sub_to_astrion'
     else 'none'
   end = all (r.stated_directions))
  ) as direction_changed_by_rollup
from rolled r;

comment on view watchlist_company is
  'Watchlist rolled up from spelling to company. A competimate is observed_relationship = both. Spec section 3 and 20.';
