-- 0025_govcon_sync.sql
--
-- A second way in to the same notices, and the bookkeeping that stops it costing twice.
--
-- GovCon API resells SAM.gov and USAspending through one key, and the thing it adds that matters
-- here is a delta endpoint: "what changed since this timestamp". The direct SAM.gov loader makes one
-- request per code on the opportunity profile — seventeen on the profile this was built against —
-- against a quota measured per day. The delta endpoint makes one request for all of it. So the cost
-- argument is not marginal, and the only thing standing between "cheaper" and "cheaper and correct"
-- is remembering where the last sync got to.
--
-- Three additions.
--
--   sync_cursor       Where an incremental endpoint got to. One row per (source, endpoint).
--   vendor_entity     A SAM.gov entity registration, cached.
--   vendor_exclusion  A federal exclusion (debarment) record, cached.
--
-- Deliberately not added: a second notices table. Notices from both APIs land in `pursuit` under the
-- same `signal_key`, so a notice that arrives from SAM.gov directly and from GovCon API's delta is
-- one row and one feed item. See src/loaders/notice.ts. Duplicating the notice store to keep the two
-- sources apart would create the reconciliation problem it looked like it was solving.

-- ---------------------------------------------------------------------------
-- sync_cursor
-- ---------------------------------------------------------------------------
-- The high-water mark for an incremental pull.
--
-- Why a table and not a file or an environment variable: the container is ephemeral and the job runs
-- on a schedule, so anywhere other than the database loses the cursor on the first restart and the
-- next run silently re-downloads a window it already had. That failure is invisible — the data is
-- correct, the bill is not — which is exactly the kind of thing to put in a table with a name.
create table sync_cursor (
  source_system   text        not null,
  -- The endpoint path, so one source can have several independent cursors. Opportunities and awards
  -- move at different rates and are pulled on different schedules.
  endpoint        text        not null,
  -- Everything created or modified at or before this instant has been pulled. The next request asks
  -- for changes since this value.
  cursor_at       timestamptz not null,
  -- What the last run actually asked for. Kept separate from cursor_at because the API clamps a
  -- `since` older than its own window, and a clamp means the gap between the two was never fetched:
  -- the run looks successful and has a hole in it. Storing both makes the hole detectable after
  -- the fact instead of only in the log line nobody read.
  last_since      timestamptz,
  last_clamped    boolean     not null default false,
  last_clamp_note text,
  last_run_id     bigint      references source_run (run_id),
  records_seen    integer     not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (source_system, endpoint)
);

comment on table sync_cursor is
  'High-water mark per incremental endpoint. Lives in the database because the container does not.';
comment on column sync_cursor.last_clamped is
  'True when the API clamped the requested since to its own window, which means this run has a gap.';

-- ---------------------------------------------------------------------------
-- vendor_entity
-- ---------------------------------------------------------------------------
-- A company as SAM.gov's entity registry describes it: UEI, CAGE, name, status, addresses.
--
-- This is a cache, not a corpus. It is filled one company at a time, when somebody is looking at a
-- requirement and wants to know who the incumbent is — never swept, because sweeping the entity
-- registry would be a large number of requests to answer questions nobody asked. `fetched_at` is
-- what makes it a cache: a lookup inside the freshness window is free, and outside it goes back to
-- the API.
create table vendor_entity (
  -- The UEI is the federal government's own identifier and it is stable, which is more than can be
  -- said for the name. Entities are keyed on it.
  uei                text primary key,
  cage_code          text,
  legal_name         text,
  dba_name           text,
  -- 'Active' / 'Expired' / 'Submitted'. An expired registration cannot receive an award, so this
  -- field is the difference between a viable teaming partner and a dead end.
  registration_status text,
  registration_expires_on date,
  physical_state     text,
  physical_city      text,
  naics_codes        text[],
  -- Small-business and socioeconomic certifications, as the registry words them. Kept as given
  -- rather than mapped to a set this system invented, because a set-aside determination turns on
  -- the government's wording and not on ours.
  certifications     text[],
  source_version_id  bigint references source_version (source_version_id),
  fetched_at         timestamptz not null default now()
);

create index vendor_entity_cage on vendor_entity (cage_code) where cage_code is not null;
create index vendor_entity_name on vendor_entity (lower(legal_name));

comment on table vendor_entity is
  'SAM.gov entity registrations, cached on demand. Not a corpus: filled one lookup at a time.';

-- ---------------------------------------------------------------------------
-- vendor_exclusion
-- ---------------------------------------------------------------------------
-- The federal exclusion list: who may not receive an award, and until when.
--
-- Kept separate from vendor_entity rather than as a flag on it, for two reasons. An exclusion can
-- name a party this system has no entity record for, including an individual, so a flag would have
-- nowhere to live. And one party can carry several exclusions with different agencies and different
-- dates, which a boolean cannot hold.
--
-- What this is for: a hand-off to TechnoMile that names an excluded incumbent is worse than no
-- hand-off, so the screening result belongs on the screen where the hand-off happens.
create table vendor_exclusion (
  exclusion_id      bigserial primary key,
  -- The API's own record identifier, so a re-screen updates rather than accumulates.
  source_record_id  text not null unique,
  uei               text,
  cage_code         text,
  excluded_name     text not null,
  -- 'Ineligible (Proceedings Completed)' and friends, as worded by the list.
  classification    text,
  exclusion_type    text,
  excluding_agency  text,
  active_date       date,
  -- Null means indefinite, which is not the same as "not excluded" and must not be read as such.
  termination_date  date,
  source_version_id bigint references source_version (source_version_id),
  fetched_at        timestamptz not null default now()
);

create index vendor_exclusion_uei on vendor_exclusion (uei) where uei is not null;
create index vendor_exclusion_name on vendor_exclusion (lower(excluded_name));

comment on column vendor_exclusion.termination_date is
  'Null is an indefinite exclusion, not an absent one. Do not read null as clear.';

-- ---------------------------------------------------------------------------
-- vendor_exclusion_current
-- ---------------------------------------------------------------------------
-- Exclusions in force today.
--
-- A view rather than a column, because "current" is a function of the date and a stored boolean
-- would be wrong the morning after it was written. `termination_date is null` is included on
-- purpose: an indefinite exclusion is the most serious kind.
create view vendor_exclusion_current as
select *
  from vendor_exclusion
 where (active_date is null or active_date <= current_date)
   and (termination_date is null or termination_date >= current_date);

comment on view vendor_exclusion_current is
  'Exclusions in force today, including indefinite ones. Current is a function of the date, so it is a view.';
