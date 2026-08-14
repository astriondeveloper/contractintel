-- 0003_identity.sql
-- Spec section 7.1. Corrects Codex defect 3: incumbent was free text, no entity tables.

-- ---------------------------------------------------------------------------
-- entity: the canonical company
-- ---------------------------------------------------------------------------
create table entity (
  entity_id          bigserial primary key,
  canonical_name     text not null,
  entity_type        text not null
                       check (entity_type in ('astrion_family', 'watchlist', 'other')),
  ultimate_parent_id bigint references entity (entity_id),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index entity_canonical_name_idx on entity (cie_normalize_name(canonical_name));
create index entity_parent_idx on entity (ultimate_parent_id);
create index entity_type_idx on entity (entity_type);

-- Spec section 7.1 does not carry an ownership percentage. The user does not need it.

-- ---------------------------------------------------------------------------
-- entity_alias: one row for each observed name
-- ---------------------------------------------------------------------------
create table entity_alias (
  alias_id             bigserial primary key,
  entity_id            bigint not null references entity (entity_id) on delete cascade,
  alias_name           text   not null,
  -- Generated, so a lookup never depends on the loader remembering to normalise.
  alias_name_normalized text generated always as (cie_normalize_name(alias_name)) stored,
  alias_name_core       text generated always as (cie_core_name(alias_name)) stored,
  source_system        text   not null,
  first_seen_fy        integer,
  last_seen_fy         integer,
  transaction_count    integer,
  obligations_usd      numeric(20, 2),
  confirmed_by         text,
  confirmed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One observed spelling from one source resolves to exactly one entity.
-- The raw spelling is the key, not the normalised form: 'LARKSPUR, INCORPORATED' and
-- 'LARKSPUR INCORPORATED' are two legitimate rows that share a normalised form.
create unique index entity_alias_observed_idx on entity_alias (source_system, alias_name);

create index entity_alias_normalized_idx on entity_alias (alias_name_normalized);
create index entity_alias_core_idx on entity_alias (alias_name_core);
create index entity_alias_entity_idx on entity_alias (entity_id);

-- Only a confirmed alias is authoritative for resolution. Spec section 8.2 step 3.
create index entity_alias_confirmed_idx on entity_alias (alias_name_normalized)
  where confirmed_at is not null;

comment on column entity_alias.confirmed_at is
  'Null means BD Ops has not confirmed this row. Spec 20: seeds ship unconfirmed.';

-- ---------------------------------------------------------------------------
-- entity_identifier
-- ---------------------------------------------------------------------------
create table entity_identifier (
  identifier_id    bigserial primary key,
  entity_id        bigint not null references entity (entity_id) on delete cascade,
  identifier_type  text   not null check (identifier_type in ('uei', 'cage', 'duns')),
  identifier_value text   not null,
  effective_from   date,
  effective_to     date,
  source_system    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- NOTE, and this is a fact from the corpus rather than a preference.
-- identifier_value is NOT unique. In astrion_entity_map_seed.csv four UEI values
-- and four CAGE values each appear against two different legacy entities:
--   ZZ1TESTUEI01 / ZC001  Northwind Group, LLC   and  Beacon Research, Inc.
--   ZZ2TESTUEI02 / ZC002  Cardinal LLC           and  Quantalytic
--   ZZ3TESTUEI03 / ZC003  Cardinal LLC           and  Meridian Engineering
--   ZZ4TESTUEI04 / ZC004  Larkspur, Incorporated    and  Halcyon Systems, LLC
-- The registrations were carried forward through the rollup. A unique constraint
-- here would reject the real data. The resolver handles the ambiguity instead.
-- See src/resolve/entity-resolver.ts and the identifier_collision view below.
create unique index entity_identifier_unique_idx
  on entity_identifier (entity_id, identifier_type, identifier_value);

create index entity_identifier_lookup_idx on entity_identifier (identifier_type, identifier_value);

-- ---------------------------------------------------------------------------
-- entity_relationship
-- ---------------------------------------------------------------------------
create table entity_relationship (
  relationship_id  bigserial primary key,
  parent_entity_id bigint not null references entity (entity_id) on delete cascade,
  child_entity_id  bigint not null references entity (entity_id) on delete cascade,
  relationship_type text  not null
                      check (relationship_type in ('subsidiary', 'joint_venture_member', 'predecessor')),
  effective_from   date,
  effective_to     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (parent_entity_id <> child_entity_id)
);

create unique index entity_relationship_unique_idx
  on entity_relationship (parent_entity_id, child_entity_id, relationship_type);
create index entity_relationship_child_idx on entity_relationship (child_entity_id);

-- ---------------------------------------------------------------------------
-- entity_merge_candidate: a proposal, never an action
-- ---------------------------------------------------------------------------
-- Spec 8.1: probabilistic matching is for the watchlist only, a match produces a
-- candidate, and a candidate needs human confirmation.
create table entity_merge_candidate (
  candidate_id     bigserial primary key,
  entity_id_a      bigint not null references entity (entity_id) on delete cascade,
  entity_id_b      bigint not null references entity (entity_id) on delete cascade,
  match_basis      text   not null
                     check (match_basis in ('core_name', 'uei', 'cage', 'manual')),
  match_detail     text,
  state            text   not null default 'open'
                     check (state in ('open', 'confirmed_same', 'confirmed_different')),
  decided_by       text,
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (entity_id_a < entity_id_b)
);

create unique index entity_merge_candidate_pair_idx
  on entity_merge_candidate (entity_id_a, entity_id_b, match_basis);
create index entity_merge_candidate_open_idx on entity_merge_candidate (state)
  where state = 'open';

select cie_attach_touch('entity');
select cie_attach_touch('entity_alias');
select cie_attach_touch('entity_identifier');
select cie_attach_touch('entity_relationship');
select cie_attach_touch('entity_merge_candidate');

-- ---------------------------------------------------------------------------
-- Data quality views. These make the hard parts of the build visible.
-- ---------------------------------------------------------------------------

-- An identifier that more than one entity claims.
create view identifier_collision as
select
  ei.identifier_type,
  ei.identifier_value,
  count(distinct ei.entity_id)                       as entity_count,
  array_agg(distinct e.canonical_name order by e.canonical_name) as entity_names,
  count(distinct e.ultimate_parent_id)               as distinct_parent_count
from entity_identifier ei
join entity e on e.entity_id = ei.entity_id
group by ei.identifier_type, ei.identifier_value
having count(distinct ei.entity_id) > 1;

comment on view identifier_collision is
  'UEI and CAGE values shared by more than one entity. Expected: 4 UEI, 4 CAGE from the seed map.';

-- A normalised spelling that points at more than one entity. This should be empty.
-- A row here is a genuine resolution defect, not a curiosity.
create view alias_normalization_conflict as
select
  alias_name_normalized,
  count(distinct entity_id)                          as entity_count,
  array_agg(distinct alias_name order by alias_name) as spellings
from entity_alias
group by alias_name_normalized
having count(distinct entity_id) > 1;

comment on view alias_normalization_conflict is
  'Must be empty. A row means one normalised name resolves to two entities.';

-- Every alias that belongs to the Astrion family, with its family root.
create view astrion_family_alias as
select
  root.entity_id      as family_entity_id,
  root.canonical_name as family_name,
  le.entity_id        as legacy_entity_id,
  le.canonical_name   as legacy_entity_name,
  a.alias_id,
  a.alias_name,
  a.alias_name_normalized,
  a.transaction_count,
  a.obligations_usd,
  a.first_seen_fy,
  a.last_seen_fy,
  a.confirmed_at
from entity_alias a
join entity le   on le.entity_id = a.entity_id
join entity root on root.entity_id = coalesce(le.ultimate_parent_id, le.entity_id)
where root.entity_type = 'astrion_family' or le.entity_type = 'astrion_family';
