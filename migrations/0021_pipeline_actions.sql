-- 0021_pipeline_actions.sql
--
-- What business development does to a pursuit, and who did it.
--
-- Everything before this migration was read only, deliberately: spec section 20 requires an
-- audit trail on every change, and a write screen without one is worse than no write screen
-- because it makes the corpus untrustworthy quietly. `audit_log` has existed since migration
-- 0008 and has had nothing to record. This is what it records.
--
-- Three additions, and one thing deliberately not added.
--
--   app_user       Who has signed in. Populated from the Entra token on each request, not
--                  managed by hand, so it cannot drift from who actually has access.
--   pursuit_note   What somebody wrote down about a pursuit. The thing a spreadsheet is
--                  usually kept for.
--   snoozed_until  "Not now" as a first-class answer, distinct from "no".
--
-- Not added: a status column that duplicates `pursuit.state`. The states in spec section 9
-- are already the pipeline, and a second one alongside it would drift within a week.

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------
-- Identity comes from Microsoft Entra through Container Apps, which terminates
-- authentication before the request reaches this container. The application never holds a
-- password and never issues a token; it reads the principal the platform vouched for and
-- records it. This table exists so a pursuit can be assigned to somebody who is not
-- currently looking at the screen, and so the audit trail can show a display name rather
-- than an object id.
create table app_user (
  user_id        bigserial primary key,
  -- The Entra principal name, which is the stable handle. Assignment and audit rows key
  -- on this rather than on the display name, because a person can be renamed.
  principal_name text not null unique,
  display_name   text,
  email          text,
  -- Set false to stop a departed person appearing in the assignment list without
  -- destroying the history of what they did.
  active         boolean not null default true,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index app_user_active_idx on app_user (active, display_name);

select cie_attach_touch('app_user');

comment on table app_user is
  'Populated from the Entra token on sign-in, never maintained by hand. A row here means '
  'the platform has vouched for that principal at least once.';

-- ---------------------------------------------------------------------------
-- pursuit_note
-- ---------------------------------------------------------------------------
create table pursuit_note (
  note_id    bigserial primary key,
  pursuit_id bigint not null references pursuit (pursuit_id) on delete cascade,
  author     text not null,
  body       text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pursuit_note_pursuit_idx on pursuit_note (pursuit_id, created_at desc);

select cie_attach_touch('pursuit_note');

comment on table pursuit_note is
  'What a person wrote down about a pursuit. Append only from the interface: a note that '
  'can be edited away is a note nobody trusts.';

-- ---------------------------------------------------------------------------
-- Working state on the pursuit itself
-- ---------------------------------------------------------------------------
-- "Not now" is a real answer and a different one from "no". Without it the only way to
-- clear something out of the way is to drop it, which loses the distinction between work
-- that was judged and work that was deferred.
alter table pursuit add column snoozed_until date;
alter table pursuit add column state_changed_at timestamptz;
alter table pursuit add column state_changed_by text;

create index pursuit_owner_idx on pursuit (owner) where owner is not null;
create index pursuit_snoozed_idx on pursuit (snoozed_until) where snoozed_until is not null;

comment on column pursuit.snoozed_until is
  'Deferred rather than declined. The pipeline hides it until this date and then brings it '
  'back, so nothing is lost by getting it off the screen.';

-- ---------------------------------------------------------------------------
-- The pipeline as business development sees it
-- ---------------------------------------------------------------------------
-- One row per pursuit with the working state, the current score, and whether it needs
-- attention today. The dashboard reads this rather than assembling it in six places.
create view pipeline_item as
select
  p.pursuit_id,
  p.signal_class,
  p.title,
  p.state,
  p.owner,
  p.snoozed_until,
  p.agency_code,
  p.solicitation_number,
  p.related_piid,
  p.naics_code,
  p.psc_code,
  p.estimated_value,
  p.response_date,
  p.period_end_date,
  p.astrion_position,
  p.incumbent_entity_id,
  p.notice_url,
  p.state_changed_at,
  coalesce(p.response_date, p.period_end_date)            as due_date,
  a.assessment_id,
  a.band,
  a.strategic_fit,
  a.evidence_confidence,
  a.timing_urgency,
  a.coverage,
  -- Snoozed work is out of the way until its date comes round. Everything else that is
  -- open and unclaimed is waiting for somebody to pick it up.
  (p.snoozed_until is not null and p.snoozed_until > current_date) as is_snoozed,
  (p.state = 'open' and p.owner is null)                           as is_unclaimed,
  (p.state in ('won', 'lost', 'dropped'))                          as is_closed,
  (select count(*) from pursuit_note n where n.pursuit_id = p.pursuit_id) as note_count
from pursuit p
left join assessment a
       on a.pursuit_id = p.pursuit_id
      and a.score_model_version = (select score_model_version from score_model where is_current limit 1);

comment on view pipeline_item is
  'The pipeline as BD sees it: working state, current score, and whether it needs attention. '
  'The dashboard and the pipeline screen both read this, so they cannot disagree.';
