-- 0004_awards.sql
-- Spec section 7.2. Corrects Codex defects 4 and 5:
-- there were no award tables at all, and NAICS and PSC were single text columns.

-- ---------------------------------------------------------------------------
-- contract_action
-- ---------------------------------------------------------------------------
create table contract_action (
  -- Surrogate key, so child tables carry one column instead of four.
  contract_action_id        bigserial not null unique,

  -- The natural key. Spec 7.2: this composite is what makes the loader
  -- idempotent. Acceptance test 2 depends on it.
  -- modification_number and transaction_number default to the empty string
  -- because FPDS leaves them blank on a base award and a primary key column
  -- cannot be null.
  awarding_agency_code      text not null,
  piid                      text not null,
  modification_number       text not null default '',
  transaction_number        text not null default '',

  idv_piid                  text,
  idv_agency_code           text,
  award_type                text,

  signed_date               date,
  effective_date            date,
  current_completion_date   date,
  ultimate_completion_date  date,

  action_obligation         numeric(20, 2),
  base_and_all_options      numeric(20, 2),

  contracting_department_code text,
  contracting_agency_code     text,
  contracting_office_code     text,
  funding_agency_code         text,
  funding_office_code         text,
  place_of_performance_state  text,

  extent_competed           text,
  set_aside_type            text,
  number_of_offers_received integer,

  vendor_name_raw           text,
  entity_id                 bigint references entity (entity_id),
  entity_match_method       text check (entity_match_method in
                              ('uei', 'cage', 'confirmed_alias', 'parent_fallback', 'candidate', 'unresolved')),
  entity_match_confidence   text check (entity_match_confidence in
                              ('confirmed', 'probable', 'unresolved')),

  source_version_id         bigint references source_version (source_version_id),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  primary key (awarding_agency_code, piid, modification_number, transaction_number)
);

create index contract_action_entity_idx      on contract_action (entity_id);
create index contract_action_piid_idx        on contract_action (piid);
create index contract_action_idv_idx         on contract_action (idv_piid) where idv_piid is not null;
create index contract_action_office_idx      on contract_action (contracting_agency_code, contracting_office_code);
create index contract_action_ultimate_end_idx on contract_action (ultimate_completion_date)
  where ultimate_completion_date is not null;
create index contract_action_signed_idx      on contract_action (signed_date);
create index contract_action_vendor_norm_idx on contract_action (cie_normalize_name(vendor_name_raw));
create index contract_action_setaside_idx    on contract_action (set_aside_type);

comment on column contract_action.entity_match_confidence is
  'Three states only: confirmed, probable, unresolved. Never a percentage. Spec 14.6.';

-- ---------------------------------------------------------------------------
-- contract_action_classification
-- ---------------------------------------------------------------------------
-- NAICS and PSC are multi-valued. Spec 7.2 forbids a text column on
-- contract_action for these.
create table contract_action_classification (
  classification_id  bigserial primary key,
  contract_action_id bigint not null references contract_action (contract_action_id) on delete cascade,
  code_type          text   not null check (code_type in ('naics', 'psc')),
  code_value         text   not null,
  is_principal       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index contract_action_classification_unique_idx
  on contract_action_classification (contract_action_id, code_type, code_value);
create index contract_action_classification_code_idx
  on contract_action_classification (code_type, code_value);

-- ---------------------------------------------------------------------------
-- code_label
-- ---------------------------------------------------------------------------
-- Spec 4.1: PSC R425 appears with two different descriptions in one dataset.
-- The application stores the code. The label is versioned separately.
create table code_label (
  code_label_id  bigserial primary key,
  code_type      text not null check (code_type in ('naics', 'psc', 'agency', 'office', 'set_aside', 'extent_competed', 'award_type')),
  code_value     text not null,
  label          text not null,
  effective_from date not null default date '1900-01-01',
  effective_to   date,
  source_system  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index code_label_version_idx
  on code_label (code_type, code_value, effective_from);
create index code_label_current_idx on code_label (code_type, code_value)
  where effective_to is null;

-- The application always shows the current label. Spec 7.2.
create view code_label_current as
select code_type, code_value, label, effective_from
from code_label
where effective_to is null;

-- ---------------------------------------------------------------------------
-- subcontract_edge
-- ---------------------------------------------------------------------------
create table subcontract_edge (
  edge_id          bigserial primary key,
  source_record_id text,
  prime_entity_id  bigint references entity (entity_id),
  sub_entity_id    bigint references entity (entity_id),
  prime_name_raw   text,
  sub_name_raw     text,
  prime_piid       text,
  prime_idv_piid   text,
  award_number     text,
  -- The value may be negative. A negative value is a deobligation. Keep it.
  -- Spec 7.2. There is deliberately no check constraint here.
  value_usd        numeric(20, 2),
  award_date       date,
  agency_name      text,
  office_name      text,
  description      text,
  source_version_id bigint references source_version (source_version_id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index subcontract_edge_prime_idx on subcontract_edge (prime_entity_id);
create index subcontract_edge_sub_idx   on subcontract_edge (sub_entity_id);
create index subcontract_edge_piid_idx  on subcontract_edge (prime_piid);
create unique index subcontract_edge_source_idx on subcontract_edge (source_record_id)
  where source_record_id is not null;

select cie_attach_touch('contract_action');
select cie_attach_touch('contract_action_classification');
select cie_attach_touch('code_label');
select cie_attach_touch('subcontract_edge');

-- ---------------------------------------------------------------------------
-- Teaming role view. Spec decision D5: partner and competitor are per-pursuit
-- roles, not company labels. This view reports observed direction only.
-- A company observed in both directions is a competimate. Spec section 3.
-- ---------------------------------------------------------------------------
create view teaming_direction as
with astrion as (
  select entity_id from entity
  where entity_type = 'astrion_family'
     or ultimate_parent_id in (select entity_id from entity where entity_type = 'astrion_family')
),
subbed_to_them as (
  select prime_entity_id as counterparty_entity_id, count(*) as n
  from subcontract_edge
  where sub_entity_id in (select entity_id from astrion)
    and prime_entity_id not in (select entity_id from astrion)
  group by prime_entity_id
),
they_subbed_to_us as (
  select sub_entity_id as counterparty_entity_id, count(*) as n
  from subcontract_edge
  where prime_entity_id in (select entity_id from astrion)
    and sub_entity_id not in (select entity_id from astrion)
  group by sub_entity_id
)
select
  e.entity_id,
  e.canonical_name,
  coalesce(a.n, 0) as times_astrion_subbed_to_them,
  coalesce(b.n, 0) as times_they_subbed_to_astrion,
  case
    when coalesce(a.n, 0) > 0 and coalesce(b.n, 0) > 0 then 'both'
    when coalesce(a.n, 0) > 0 then 'astrion_subs_to_them'
    when coalesce(b.n, 0) > 0 then 'they_sub_to_astrion'
    else 'none'
  end as observed_relationship
from entity e
left join subbed_to_them   a on a.counterparty_entity_id = e.entity_id
left join they_subbed_to_us b on b.counterparty_entity_id = e.entity_id
where coalesce(a.n, 0) > 0 or coalesce(b.n, 0) > 0;

comment on view teaming_direction is
  'Observed teaming direction from the subcontract graph. A row with both is a competimate.';
