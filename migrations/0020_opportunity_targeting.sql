-- 0020_opportunity_targeting.sql
--
-- What Astrion is looking for, so that a solicitation feed is a pipeline rather than a
-- firehose.
--
-- SAM.gov publishes every federal notice. Pulling all of them and sorting it out
-- afterwards produces a list nobody reads: the useful question is not "what was posted"
-- but "what was posted that this company could win". That question already has two
-- answers in this database and neither of them is new work.
--
--   The authored answer. capability_taxonomy_seed.csv carries psc_crosswalk,
--   naics_crosswalk and agency_crosswalk on every capability node, loaded into
--   node_crosswalk. That is BD's own statement of what the company does, expressed in
--   exactly the codes SAM.gov filters on.
--
--   The observed answer. The FPDS corpus says which NAICS and PSC codes Astrion has
--   actually been paid under and which agencies bought it. That is harder to argue with
--   than an authored list and it catches work the taxonomy has not caught up with.
--
-- opportunity_profile holds both, one row per code, tagged with where it came from. It is
-- data, not code, for the same reason the score model weights are: spec section 13 gives
-- BD Ops the thresholds, and a targeting list that can only be changed by a deploy is a
-- targeting list that goes stale.
--
-- Nothing here decides whether a notice is a good opportunity. It decides which notices
-- are worth fetching at all. Ranking is the scoring engine's job.

-- ---------------------------------------------------------------------------
-- opportunity_profile
-- ---------------------------------------------------------------------------
create table opportunity_profile (
  profile_id      bigserial primary key,

  code_type       text not null check (code_type in ('naics', 'psc', 'agency', 'set_aside')),
  code_value      text not null,
  label           text,

  -- Where this code came from. 'taxonomy' is what BD authored, 'observed' is what the
  -- corpus shows, 'manual' is a person adding one directly. A code can arrive from more
  -- than one origin and each is kept, because "the taxonomy says so AND we have won 40 of
  -- them" is a stronger statement than either alone.
  origin          text not null check (origin in ('taxonomy', 'observed', 'manual')),
  node_id         bigint references taxonomy_node (node_id),

  -- Populated for origin = 'observed'. The evidence for the row being here at all.
  observed_actions      integer,
  observed_obligations  numeric(20, 2),
  observed_last_fy      integer,

  -- BD Ops turns a row off rather than deleting it, so a decision to stop chasing a code
  -- is recorded rather than being indistinguishable from never having considered it.
  active          boolean not null default true,
  notes           text,

  -- Spec section 20. A seeded row is not trusted until BD Ops confirms it, exactly as
  -- the taxonomy and watchlist rows are not.
  confirmed_by    text,
  confirmed_at    timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One row per code per capability node, not one row per code.
  --
  -- A NAICS code serves more than one capability: 541330 crosswalks to several nodes in
  -- the seeded taxonomy, and collapsing those into a single row would throw away which
  -- capability the code is there to serve, which is exactly the trace that answers "why is
  -- this in my pipeline". The observed rows carry no node and are unique per code, which
  -- `nulls not distinct` enforces -- without it Postgres treats every null node_id as
  -- distinct and the same observed code could land twice.
  --
  -- opportunity_profile_effective collapses this back down for the search itself, so the
  -- duplication costs nothing at query time.
  unique nulls not distinct (code_type, code_value, origin, node_id)
);

create index opportunity_profile_active_idx on opportunity_profile (code_type, active);

select cie_attach_touch('opportunity_profile');

comment on table opportunity_profile is
  'Which NAICS, PSC, agency and set-aside codes are worth searching for. Data, not code: '
  'BD Ops owns it, per spec section 13.';

-- The codes a search actually uses: active, de-duplicated across origins, with the
-- strongest origin winning the label. A code authored in the taxonomy AND observed in the
-- corpus appears once here, and origins carries both.
create view opportunity_profile_effective as
select
  code_type,
  code_value,
  max(label)                                             as label,
  array_agg(distinct origin order by origin)             as origins,
  sum(observed_actions)                                  as observed_actions,
  sum(observed_obligations)                              as observed_obligations,
  max(observed_last_fy)                                  as observed_last_fy,
  bool_or(confirmed_at is not null)                      as confirmed
from opportunity_profile
where active
group by code_type, code_value;

comment on view opportunity_profile_effective is
  'The de-duplicated search list. A code authored in the taxonomy and also observed in the '
  'corpus appears once, with both origins.';

-- ---------------------------------------------------------------------------
-- What a notice carries that a recompete does not
-- ---------------------------------------------------------------------------
-- pursuit already holds notice_id, solicitation_number, response_date, agency_code,
-- office_code and estimated_value, which covers most of a SAM.gov notice. These are the
-- rest: the fields that say what kind of notice it is and whether the company may bid on
-- it at all.
alter table pursuit add column notice_type text;
alter table pursuit add column posted_date date;
alter table pursuit add column naics_code text;
alter table pursuit add column psc_code text;
alter table pursuit add column set_aside_code text;
alter table pursuit add column place_of_performance_state text;
alter table pursuit add column notice_url text;

create index pursuit_notice_type_idx on pursuit (notice_type) where notice_type is not null;
create index pursuit_posted_idx on pursuit (posted_date) where posted_date is not null;

comment on column pursuit.notice_type is
  'The SAM.gov notice type, kept raw. It is what decides the signal class: a sources '
  'sought is a shaping target and a solicitation is an active one, and collapsing them '
  'would throw away the only thing that says how early this is.';
comment on column pursuit.set_aside_code is
  'Drives the set_aside gate in the score model. A notice reserved for a category Astrion '
  'does not hold is not a low score, it is ineligible. Spec 10.';

-- ---------------------------------------------------------------------------
-- Why a notice was pulled
-- ---------------------------------------------------------------------------
-- Spec section 15 asks that every figure trace to a source. The same applies to a signal
-- appearing at all: "this is in your pipeline because NAICS 541330 is on the profile, and
-- that code is there because capability node CAP-01 crosswalks to it" is an answer. "The
-- search returned it" is not.
create table pursuit_profile_match (
  pursuit_id   bigint not null references pursuit (pursuit_id) on delete cascade,
  profile_id   bigint not null references opportunity_profile (profile_id) on delete cascade,
  matched_on   text not null check (matched_on in ('naics', 'psc', 'agency', 'set_aside')),
  created_at   timestamptz not null default now(),
  primary key (pursuit_id, profile_id, matched_on)
);

create index pursuit_profile_match_profile_idx on pursuit_profile_match (profile_id);

comment on table pursuit_profile_match is
  'Which profile rows caused this notice to be pulled. The answer to "why is this in my '
  'pipeline", which is the first thing anyone asks of a feed they did not curate.';
