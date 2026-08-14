-- 0016_subcontract_edge_identity.sql
--
-- Prepares subcontract_edge to be loaded from the real exports.
--
-- 0004_awards.sql already made source_record_id unique where it is not null, so
-- idempotency was provided for. The exports confirm the choice was right:
-- companies_fpds-subcontracts-in and -out carry an 'ID' column holding Deltek's own
-- record identifier, and across the nine supplied files there are 4,043 rows, 4,043
-- distinct IDs, and zero rows where one ID carried two different payloads. It is a
-- real key.
--
-- What 0004 could not know is that a record id is only unique *within* a source. A
-- DACIS subcontract id and an id from some later source can collide, and the table has
-- no column saying which source a row came from, so the collision would silently merge
-- two unrelated edges. This migration adds source_system and moves the unique index
-- onto (source_system, source_record_id).
--
-- 'in' and 'out' are relative to whichever company was queried, and the same record
-- can legitimately appear in both an in-file and an out-file when both parties are
-- Astrion entities. The rows are self-describing -- Prime Name and Sub Name are on
-- every row -- so the loader does not record a direction. Direction is derived by
-- teaming_direction from which side resolves to an Astrion entity, which is what
-- section 20 asks for and the reason a duplicate across the two files must land as one
-- edge rather than two.
--
-- Three columns are added because the exports carry the information and dropping it
-- would mean going back to the CSVs later:
--
--   prime_cage_code, sub_cage_code  Both sides arrive with a CAGE code. It is the
--                                   identity anchor the resolver actually trusts, and
--                                   keeping it on the edge means an edge can be
--                                   re-resolved after BD Ops confirms an alias,
--                                   without re-reading a file.
--   customer_name                   The using activity, distinct from agency_name and
--                                   office_name. 'Example Launch Center' where the
--                                   office is 'EXAMPLE LAUNCH CENTER' and the
--                                   agency is 'National Aeronautics and Space
--                                   Administration (NASA)'. The evidence rail in
--                                   section 15 needs the customer, not the office.

alter table subcontract_edge
  add column source_system   text,
  add column prime_cage_code text,
  add column sub_cage_code   text,
  add column customer_name   text;

comment on column subcontract_edge.source_record_id is
  'The source system''s own record id. Deltek supplies it as the ID column. Unique per edge.';
comment on column subcontract_edge.prime_cage_code is
  'CAGE of the prime as supplied. Kept so the edge can be re-resolved without the CSV.';
comment on column subcontract_edge.sub_cage_code is
  'CAGE of the sub as supplied. Kept for the same reason.';
comment on column subcontract_edge.customer_name is
  'The using activity. Distinct from agency_name and office_name.';

-- The identity of an edge. Still partial, because an edge from some future source with
-- no record id of its own is permitted; it simply cannot be deduplicated on this key.
drop index subcontract_edge_source_idx;

create unique index subcontract_edge_identity_idx
  on subcontract_edge (source_system, source_record_id)
  where source_record_id is not null;

-- 0004 already indexes prime_entity_id, sub_entity_id and prime_piid, which is what
-- teaming_direction reads. Nothing further is needed for it.

-- ---------------------------------------------------------------------------
-- Edges where neither side reached the authored map.
-- ---------------------------------------------------------------------------
-- An edge with one side resolved is useful: it is a real teaming relationship with a
-- named counterparty, and teaming_direction counts it as soon as the counterparty
-- becomes known. An edge with neither side resolved cannot be placed relative to
-- Astrion at all, and is the only case worth a person's attention.
create view subcontract_edge_unplaced as
select
  edge_id,
  source_system,
  source_record_id,
  prime_name_raw,
  prime_cage_code,
  sub_name_raw,
  sub_cage_code,
  award_number,
  value_usd,
  award_date,
  agency_name,
  customer_name
from subcontract_edge
where prime_entity_id is null
  and sub_entity_id is null;

comment on view subcontract_edge_unplaced is
  'Subcontract edges where neither prime nor sub resolved, so the edge cannot be '
  'placed relative to Astrion. An edge with one side resolved is not a problem.';

-- ---------------------------------------------------------------------------
-- Counterparties seen in the subcontract graph that are not on the watchlist.
-- ---------------------------------------------------------------------------
-- Section 20 seeds 47 watchlist rows describing 45 companies. The graph names many
-- more. A company that subcontracts to Astrion repeatedly, or takes repeated
-- subcontracts from it, and is absent from the watchlist is a candidate for it.
create view subcontract_counterparty_offwatchlist as
with astrion as (
  select entity_id from entity
   where entity_type = 'astrion_family'
      or ultimate_parent_id in (select entity_id from entity where entity_type = 'astrion_family')
),
sides as (
  select sub_name_raw   as name_raw, sub_cage_code   as cage_code, 'astrion_prime' as direction, value_usd
    from subcontract_edge
   where prime_entity_id in (select entity_id from astrion) and sub_entity_id is null
  union all
  select prime_name_raw as name_raw, prime_cage_code as cage_code, 'astrion_sub'   as direction, value_usd
    from subcontract_edge
   where sub_entity_id in (select entity_id from astrion) and prime_entity_id is null
)
select
  name_raw,
  max(cage_code)                                                  as cage_code,
  count(*)                                                        as edges,
  count(*) filter (where direction = 'astrion_prime')             as times_they_subbed_to_astrion,
  count(*) filter (where direction = 'astrion_sub')               as times_astrion_subbed_to_them,
  count(distinct direction)                                       as directions,
  sum(coalesce(value_usd, 0))                                     as total_value_usd
from sides
group by name_raw;

comment on view subcontract_counterparty_offwatchlist is
  'Counterparties in the subcontract graph that did not resolve to an entity, so they '
  'are not on the watchlist. A row with directions = 2 is an unlisted competimate. '
  'Ranked by edges or total_value_usd, this is the watchlist''s candidate list.';
