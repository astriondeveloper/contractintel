-- 0007_scoring.sql
-- Spec section 7.4 and section 10.
-- Corrects Codex defect 1, the largest defect in the baseline: factor weights
-- were a TypeScript constant, so a past score was not reproducible.
-- Here a weight is a row. Decision D2.

-- ---------------------------------------------------------------------------
-- score_model and score_model_factor
-- ---------------------------------------------------------------------------
create table score_model (
  score_model_version integer primary key,
  effective_from      date not null default current_date,
  created_by          text,
  notes               text,
  is_current          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index score_model_single_current_idx on score_model (is_current) where is_current;

create table score_model_factor (
  score_model_version integer not null references score_model (score_model_version) on delete cascade,
  factor_code         text    not null,
  factor_name         text    not null,
  weight              numeric(6, 3) not null check (weight >= 0),
  is_mandatory        boolean not null default false,
  display_order       integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (score_model_version, factor_code)
);

comment on table score_model_factor is
  'A weight is a row, never a code constant. Decision D2. Corrects defect 1.';

-- Hard gates. Spec section 3: a rule that stops a pursuit. A score cannot
-- override a hard gate.
create table score_model_gate (
  score_model_version integer not null references score_model (score_model_version) on delete cascade,
  gate_code           text    not null,
  gate_name           text    not null,
  description         text,
  display_order       integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (score_model_version, gate_code)
);

-- ---------------------------------------------------------------------------
-- assessment
-- ---------------------------------------------------------------------------
create table assessment (
  assessment_id       bigserial primary key,
  pursuit_id          bigint  not null references pursuit (pursuit_id) on delete cascade,
  -- An assessment pins both versions it was computed under. A later weight
  -- change does not alter this row. Acceptance test 6.
  score_model_version integer not null references score_model (score_model_version),
  taxonomy_version    integer not null references taxonomy_version (version),
  computed_at         timestamptz not null default now(),

  eligibility         text not null check (eligibility in ('pass', 'fail', 'review')),
  status              text not null check (status in ('scored', 'insufficient_evidence')),

  -- Four separate outputs. Spec 10.1 says do not merge them.
  -- Null when status is insufficient_evidence or eligibility is fail.
  strategic_fit       numeric(6, 2) check (strategic_fit between 0 and 100),
  evidence_confidence numeric(6, 2) check (evidence_confidence between 0 and 100),
  timing_urgency      numeric(6, 2) check (timing_urgency between 0 and 100),

  -- Diagnostics behind the coverage rule in spec 10.3 steps 3 to 6.
  applicable_weight   numeric(10, 3),
  known_weight        numeric(10, 3),
  coverage            numeric(6, 4),

  rank_value          numeric(8, 4),
  band                text check (band in ('pursue', 'review', 'pass', 'blocked', 'insufficient_evidence')),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index assessment_pursuit_idx on assessment (pursuit_id, computed_at desc);
create index assessment_rank_idx    on assessment (rank_value desc nulls last);
create index assessment_band_idx    on assessment (band);

-- A pursuit has at most one current assessment per score model version.
create unique index assessment_current_idx
  on assessment (pursuit_id, score_model_version, taxonomy_version, computed_at);

comment on column assessment.strategic_fit is
  'Not a probability of win. The interface must say so. Spec 10.1.';
comment on column assessment.coverage is
  'known_weight / applicable_weight. Below 0.60 gives no rank. Spec 10.3 step 6.';

-- ---------------------------------------------------------------------------
-- factor_result
-- ---------------------------------------------------------------------------
create table factor_result (
  assessment_id  bigint not null references assessment (assessment_id) on delete cascade,
  factor_code    text   not null,
  -- Three states, and they are never interchangeable. Spec 10.5:
  -- unknown, not_applicable, and a score of zero are three different things.
  state          text   not null check (state in ('scored', 'unknown', 'not_applicable')),
  score          numeric(6, 2) check (score between 0 and 100),
  weight_applied numeric(6, 3),
  contribution   numeric(10, 4),
  rule_id        text   not null,
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (assessment_id, factor_code),
  -- A score is present only in the scored state. This constraint is the
  -- database-level guard for spec 10.5.
  check ((state = 'scored' and score is not null) or (state <> 'scored' and score is null))
);

comment on constraint factor_result_check on factor_result is
  'A missing description does not mean a capability score of zero. It means unknown. Spec 10.5.';

-- ---------------------------------------------------------------------------
-- gate_result
-- ---------------------------------------------------------------------------
create table gate_result (
  assessment_id bigint not null references assessment (assessment_id) on delete cascade,
  gate_code     text   not null,
  state         text   not null check (state in ('pass', 'fail', 'review', 'not_evaluated')),
  reason        text,
  rule_id       text   not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (assessment_id, gate_code)
);

-- ---------------------------------------------------------------------------
-- evidence_ref
-- ---------------------------------------------------------------------------
create table evidence_ref (
  evidence_id      bigserial primary key,
  assessment_id    bigint not null references assessment (assessment_id) on delete cascade,
  factor_code      text,
  gate_code        text,
  source_system    text not null,
  source_record_id text,
  source_uri       text,
  displayed_value  text,
  observed_at      timestamptz,
  -- An evidence row that argues against the score sets this true. The interface
  -- shows contrary evidence in Twilight T&E. It does not hide it. Spec 7.4, 14.2.
  is_contrary      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index evidence_ref_assessment_idx on evidence_ref (assessment_id, factor_code);
create index evidence_ref_contrary_idx   on evidence_ref (assessment_id) where is_contrary;

comment on column evidence_ref.is_contrary is
  'Never hidden. A user who sees only supporting evidence stops trusting the tool. Spec 14.2.';

select cie_attach_touch('score_model');
select cie_attach_touch('score_model_factor');
select cie_attach_touch('score_model_gate');
select cie_attach_touch('assessment');
select cie_attach_touch('factor_result');
select cie_attach_touch('gate_result');
select cie_attach_touch('evidence_ref');

-- ---------------------------------------------------------------------------
-- Rule trace view. Spec decision D10 and acceptance test 7:
-- every score opens a rule trace with at least one source link.
-- ---------------------------------------------------------------------------
create view assessment_trace as
select
  a.assessment_id,
  a.pursuit_id,
  a.score_model_version,
  a.taxonomy_version,
  a.status,
  a.eligibility,
  a.strategic_fit,
  a.band,
  fr.factor_code,
  smf.factor_name,
  fr.state,
  fr.score,
  fr.weight_applied,
  fr.contribution,
  fr.rule_id,
  fr.summary,
  (select count(*) from evidence_ref er
     where er.assessment_id = a.assessment_id and er.factor_code = fr.factor_code) as evidence_count,
  (select count(*) from evidence_ref er
     where er.assessment_id = a.assessment_id and er.factor_code = fr.factor_code
       and er.is_contrary) as contrary_count
from assessment a
join factor_result fr on fr.assessment_id = a.assessment_id
left join score_model_factor smf
  on smf.score_model_version = a.score_model_version
 and smf.factor_code = fr.factor_code
order by a.assessment_id, smf.display_order, fr.factor_code;
