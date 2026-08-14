-- 0005_taxonomy.sql
-- Spec section 7.3. One table holds all three node types, so the Phase 4
-- solution offering overlay needs no new table.

create table taxonomy_version (
  version        integer primary key,
  effective_from date not null default current_date,
  created_by     text,
  notes          text,
  is_current     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Exactly one current taxonomy version.
create unique index taxonomy_version_single_current_idx on taxonomy_version (is_current)
  where is_current;

create table taxonomy_node (
  node_id        bigserial primary key,
  node_key       text not null,                    -- 'CAP-01' from the seed file
  node_name      text not null,
  node_type      text not null
                   check (node_type in ('capability', 'growth_priority', 'solution_offering')),
  parent_node_id bigint references taxonomy_node (node_id),
  version        integer not null references taxonomy_version (version),
  active         boolean not null default true,
  -- Backward-looking obligations carried in the seed file, in millions of USD.
  -- Null means not computed. Null is not zero. Spec 10.5.
  fy19plus_obligations_musd numeric(14, 1),
  -- Spec section 20: the growth priority column in the seed file is empty.
  -- Gavin fills it. Null until then. Null is not a low priority.
  growth_priority           text,
  confirmed_by   text,
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index taxonomy_node_key_version_idx on taxonomy_node (node_key, version);
create index taxonomy_node_type_idx   on taxonomy_node (node_type) where active;
create index taxonomy_node_parent_idx  on taxonomy_node (parent_node_id);

comment on column taxonomy_node.growth_priority is
  'Null until Gavin fills it. Spec 20. Null is unknown, not a score of zero.';

-- ---------------------------------------------------------------------------
-- node_crosswalk
-- ---------------------------------------------------------------------------
create table node_crosswalk (
  crosswalk_id    bigserial primary key,
  node_id         bigint not null references taxonomy_node (node_id) on delete cascade,
  crosswalk_type  text   not null
                    check (crosswalk_type in ('naics', 'psc', 'agency', 'office', 'office_freetext', 'keyword')),
  crosswalk_value text   not null,
  weight          numeric(6, 3) not null default 1.000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index node_crosswalk_unique_idx
  on node_crosswalk (node_id, crosswalk_type, crosswalk_value);
create index node_crosswalk_lookup_idx on node_crosswalk (crosswalk_type, crosswalk_value);

-- office_freetext holds the customer_offices_freetext column from the seed file,
-- for example 'AFTC, AEDC, NSC test organizations'. These are not office codes
-- yet. BD Ops resolves them to real office codes through the admin screen, which
-- writes crosswalk_type = 'office'. Only 'office' rows count for market sizing.
comment on column node_crosswalk.crosswalk_type is
  'office_freetext is an unresolved seed string. Market sizing uses office only. Spec 11.1.';

select cie_attach_touch('taxonomy_version');
select cie_attach_touch('taxonomy_node');
select cie_attach_touch('node_crosswalk');
