-- 0006_campaign_pursuit.sql
-- Spec section 7.5. Campaign is the top level for market sizing. Decision D7.

create table campaign (
  campaign_id       bigserial primary key,
  campaign_name     text not null,
  owner             text,
  business_unit     text,
  tam_usd           numeric(20, 2),
  sam_usd           numeric(20, 2),
  som_usd           numeric(20, 2),
  -- The capture rate behind SOM, and the sample size behind the rate.
  -- Spec 11.2 requires the sample size next to the rate.
  capture_rate      numeric(8, 5),
  capture_rate_sample_size integer,
  sizing_fy_from    integer,
  sizing_fy_to      integer,
  sizing_computed_at timestamptz,
  state             text not null default 'active'
                      check (state in ('active', 'paused', 'closed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index campaign_name_idx on campaign (cie_normalize_name(campaign_name));

comment on column campaign.capture_rate_sample_size is
  'Shown beside the rate in the interface. A thin office has a small sample. Spec 11.2.';

-- A campaign owns capability nodes and customer offices. Spec section 3.
create table campaign_node (
  campaign_id bigint not null references campaign (campaign_id) on delete cascade,
  node_id     bigint not null references taxonomy_node (node_id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (campaign_id, node_id)
);

create table campaign_office (
  campaign_id   bigint not null references campaign (campaign_id) on delete cascade,
  agency_code   text   not null,
  office_code   text   not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (campaign_id, agency_code, office_code)
);

-- ---------------------------------------------------------------------------
-- pursuit
-- ---------------------------------------------------------------------------
create table pursuit (
  pursuit_id              bigserial primary key,
  -- Spec decision D6 and section 9. Four classes, each with its own rhythm.
  signal_class            text not null
                            check (signal_class in
                              ('active_solicitation', 'recompete_window', 'shaping_target', 'market_movement')),
  title                   text not null,
  agency_code             text,
  office_code             text,
  solicitation_number     text,
  notice_id               text,
  related_piid            text,
  estimated_value         numeric(20, 2),
  response_date           date,
  expected_solicitation_fy integer,
  incumbent_entity_id     bigint references entity (entity_id),
  incumbent_confidence    text check (incumbent_confidence in ('confirmed', 'probable', 'unresolved')),
  required_vehicle        text,
  campaign_id             bigint references campaign (campaign_id),
  owner                   text,
  state                   text not null default 'open'
                            check (state in ('open', 'qualifying', 'pursuing', 'submitted', 'won', 'lost', 'dropped')),
  source_version_id       bigint references source_version (source_version_id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index pursuit_signal_class_idx  on pursuit (signal_class, state);
create index pursuit_campaign_idx      on pursuit (campaign_id);
create index pursuit_response_date_idx on pursuit (response_date);
create index pursuit_related_piid_idx  on pursuit (related_piid) where related_piid is not null;
create index pursuit_office_idx        on pursuit (agency_code, office_code);
create unique index pursuit_notice_idx on pursuit (notice_id) where notice_id is not null;

comment on column pursuit.incumbent_confidence is
  'Three states, never a percentage. A percentage invites a false debate. Spec 14.6.';

-- ---------------------------------------------------------------------------
-- pursuit_entity_role
-- ---------------------------------------------------------------------------
-- Spec decision D5: partner and competitor are per-pursuit roles. They are NOT
-- company labels. A company can be a partner on one pursuit and a competitor on
-- another. That company is a competimate.
create table pursuit_entity_role (
  pursuit_id  bigint not null references pursuit (pursuit_id) on delete cascade,
  entity_id   bigint not null references entity (entity_id) on delete cascade,
  role        text   not null check (role in ('partner', 'competitor', 'incumbent', 'unknown')),
  rationale   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (pursuit_id, entity_id, role)
);

-- ---------------------------------------------------------------------------
-- signal_class_threshold
-- ---------------------------------------------------------------------------
-- Spec 13: BD Ops sets the threshold for each signal class. Spec 9 gives the
-- starting rhythm and threshold band for each.
create table signal_class_threshold (
  signal_class      text primary key
                      check (signal_class in
                        ('active_solicitation', 'recompete_window', 'shaping_target', 'market_movement')),
  min_strategic_fit integer not null check (min_strategic_fit between 0 and 100),
  rhythm            text not null
                      check (rhythm in ('daily', 'weekly', 'monthly', 'quarterly')),
  horizon_months_from integer,
  horizon_months_to   integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Starting values from the table in spec section 9.
insert into signal_class_threshold
  (signal_class, min_strategic_fit, rhythm, horizon_months_from, horizon_months_to) values
  ('active_solicitation', 70, 'daily',      0,  6),
  ('recompete_window',    55, 'monthly',   12, 36),
  ('shaping_target',      40, 'quarterly', 12, 60),
  ('market_movement',     55, 'weekly',    null, null);

select cie_attach_touch('campaign');
select cie_attach_touch('campaign_node');
select cie_attach_touch('campaign_office');
select cie_attach_touch('pursuit');
select cie_attach_touch('pursuit_entity_role');
select cie_attach_touch('signal_class_threshold');
