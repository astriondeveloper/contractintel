-- 0002_provenance.sql
-- Spec section 7.6. Provenance comes first because award rows reference it.

-- A single execution of a loader against a single source.
create table source_run (
  run_id          bigserial primary key,
  source_system   text        not null,
  source_label    text,                       -- the file name, or the API route
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  record_count    integer     not null default 0,
  inserted_count  integer     not null default 0,
  updated_count   integer     not null default 0,
  unchanged_count integer     not null default 0,
  status          text        not null default 'running'
                    check (status in ('running', 'succeeded', 'failed')),
  error_text      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on column source_run.unchanged_count is
  'Rows whose payload hash already matched. Proves loader idempotence. Acceptance test 2.';

create index source_run_system_started_idx on source_run (source_system, started_at desc);

-- One row for each distinct observed state of one source record.
-- The loader compares payload_hash and writes a new version only on change.
-- Spec section 7.6.
create table source_version (
  source_version_id bigserial primary key,
  run_id            bigint      not null references source_run (run_id),
  source_system     text        not null,
  source_record_id  text        not null,
  payload_hash      text        not null,
  payload           jsonb,
  observed_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The same record with the same hash is never versioned twice.
create unique index source_version_identity_idx
  on source_version (source_system, source_record_id, payload_hash);

create index source_version_record_idx
  on source_version (source_system, source_record_id, observed_at desc);

select cie_attach_touch('source_run');
select cie_attach_touch('source_version');

-- ---------------------------------------------------------------------------
-- Data freshness, for the stale-data interface state. Spec section 14.7.
-- ---------------------------------------------------------------------------
create view source_freshness as
select
  source_system,
  max(finished_at)                                          as last_success_at,
  now() - max(finished_at)                                  as age,
  (now() - max(finished_at)) > interval '48 hours'           as is_stale
from source_run
where status = 'succeeded'
group by source_system;

comment on view source_freshness is
  'Drives the Supernova stale-data bar. A run older than 48 hours is stale. Spec 14.7.';
