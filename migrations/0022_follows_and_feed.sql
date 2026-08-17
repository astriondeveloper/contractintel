-- 0022_follows_and_feed.sql
--
-- Follows, a feed, and three per-person actions.
--
-- The previous migration built a pipeline: one owner per pursuit, a funnel state, a snooze,
-- an assignment. That is the shape of a system of record, and this is not one. TechnoMile is
-- the system of record and stays it. What 20-odd BD people need from this tool is narrower
-- and harder to get anywhere else: "tell me a federal requirement appeared in my patch before
-- anyone else noticed it."
--
-- So the model changes from assignment to subscription, and the change is deliberate rather
-- than cosmetic.
--
--   A follow is per person.        Nobody is assigned anything. A person says what their
--                                  patch is and the system answers with what is in it.
--   A feed is the union.           Not a queue with a bottom. There is no "done", only
--                                  "seen", so nothing accumulates as a debt.
--   Three actions, all per person. track, dismiss, sent. Two people can reach opposite
--                                  conclusions about the same requirement and both are
--                                  recorded, because they are opinions rather than state.
--
-- Nothing is dropped. `pursuit.owner`, `pursuit.state` and `pursuit.snoozed_until` stay on
-- the table with the rows already written to them: forward-only migrations, and a column
-- the interface stopped reading is cheaper than a column that has to be restored when
-- somebody asks what happened to the funnel. The interface is what changed. `pipeline_item`
-- is left in place for the same reason, and `feed_item` below is what replaces it.

-- ---------------------------------------------------------------------------
-- follow
-- ---------------------------------------------------------------------------
-- Four kinds of thing to follow, of which three cost nothing to match because the corpus
-- already resolved them.
--
--   capability   A taxonomy node. `node_crosswalk` already carries the NAICS, PSC and
--                keyword crosswalks BD authored, so following a capability is following
--                a set of codes somebody has already thought about.
--   agency       An awarding agency code.
--   office       An agency and office code pair.
--   company      An entity. `entity` and `entity_alias` already resolve the 40-odd legal
--                names in an Astrion-sized corporate family onto one row, which is the
--                whole point of acceptance test 1, so following a company follows the
--                family rather than one spelling of it.
--   naics/psc    A raw code, matched as a prefix so following 5413 catches 541330.
--   keyword      A phrase matched against the title. The escape hatch for work whose
--                shape has no code yet.
--
-- One table with a canonical `target` string rather than seven tables or seven nullable
-- key columns with a partial unique index each. `target` is what uniqueness is defined on;
-- the typed columns beside it exist so a retired taxonomy node or a merged entity cannot
-- leave a follow pointing at a row that is gone.
create table follow (
  follow_id       bigserial primary key,

  -- The Entra principal. Every follow belongs to exactly one person; there is no shared
  -- or team follow, because a shared follow is an assignment wearing a different hat.
  principal_name  text not null references app_user (principal_name),

  follow_type     text not null
                    check (follow_type in
                      ('capability', 'agency', 'office', 'company', 'naics', 'psc', 'keyword')),

  -- The canonical target, one form per type, and the only thing uniqueness is defined on:
  --   capability  taxonomy_node.node_key, so a follow survives a taxonomy re-version
  --   agency      the agency code
  --   office      'agency/office'
  --   company     the entity id as text
  --   naics, psc  the code
  --   keyword     the phrase, lowercased and trimmed
  target          text not null check (btrim(target) <> ''),

  -- Typed references, set for the types that point at a row in this database. `on delete
  -- cascade` rather than a null-out: a follow on a node that no longer exists is not a
  -- follow, and leaving it behind would show a person an empty patch with no explanation.
  node_id         bigint references taxonomy_node (node_id) on delete cascade,
  entity_id       bigint references entity (entity_id) on delete cascade,
  agency_code     text,
  office_code     text,

  -- What to call it on screen, captured when the follow is made. A denormalisation on
  -- purpose: a code whose label changes should still read as the thing the person chose,
  -- and `code_label` is versioned precisely because labels move.
  label           text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Each type carries exactly the columns that identify it, so a malformed follow cannot
  -- be written at all rather than being written and matching nothing.
  constraint follow_shape check (
    case follow_type
      when 'capability' then node_id is not null
      when 'company'    then entity_id is not null
      when 'agency'     then agency_code is not null and office_code is null
      when 'office'     then agency_code is not null and office_code is not null
      else node_id is null and entity_id is null
    end
  )
);

create unique index follow_person_target_idx on follow (principal_name, follow_type, target);
create index follow_principal_idx on follow (principal_name, follow_type);
create index follow_target_idx    on follow (follow_type, target);
create index follow_node_idx      on follow (node_id)   where node_id is not null;
create index follow_entity_idx    on follow (entity_id) where entity_id is not null;

select cie_attach_touch('follow');

comment on table follow is
  'What one person has said their patch is. A personal feed is the union of these rows. '
  'There is no team follow: a shared follow is an assignment with the serial numbers filed off.';
comment on column follow.target is
  'The canonical identity of the followed thing, one form per type. Uniqueness is defined '
  'on it so the same follow cannot be added twice under two spellings.';

-- ---------------------------------------------------------------------------
-- feed_watermark
-- ---------------------------------------------------------------------------
-- "Since I last looked" needs a mark, and where the mark moves is the whole question.
--
-- Advancing it on page load is the obvious choice and it is wrong: a refresh would erase
-- the unread markers of the thing you were halfway through reading, and the interface
-- answers GET without writing anything precisely so that the audit trail cannot be
-- side-stepped. So the mark moves only when a person says it has, through a POST that
-- writes an audit row like every other write.
--
-- With no row here, the feed shows a default window and says which, rather than declaring
-- everything ever loaded to be new.
create table feed_watermark (
  principal_name  text primary key references app_user (principal_name),
  -- Everything created at or before this instant has been seen.
  seen_through    timestamptz not null,
  -- What it was before the last advance, so "what did I just mark read" is answerable.
  previous_seen_through timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

select cie_attach_touch('feed_watermark');

comment on table feed_watermark is
  'Where a person has read up to. Moved only by an explicit action, never by a page load: '
  'a mark that moves on refresh loses the item somebody was reading.';

-- ---------------------------------------------------------------------------
-- pursuit_action
-- ---------------------------------------------------------------------------
-- Three actions, and the reason they are three rows rather than one state column.
--
-- track and dismiss are opposites, so taking one clears the other. sent is not their
-- opposite and must never be cleared by either: it is the count that answers "is this tool
-- doing anything", and a metric a later click can silently erase is not a metric. A person
-- who sends a requirement to TechnoMile and then dismisses it from their own feed has still
-- sent it. Held as a single state column, that fact would be gone.
--
-- Per person, not per pursuit. Two BD people can look at the same requirement and reach
-- opposite conclusions, and both conclusions are true statements about who thought what.
-- A shared verdict would make one of them the owner, which is the model this replaces.
create table pursuit_action (
  action_id       bigserial primary key,
  pursuit_id      bigint not null references pursuit (pursuit_id) on delete cascade,
  principal_name  text   not null references app_user (principal_name),
  action          text   not null check (action in ('track', 'dismiss', 'sent')),
  -- Why. Optional on track and dismiss; on sent it is where it went, if the person says.
  note            text,
  acted_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (pursuit_id, principal_name, action)
);

create index pursuit_action_person_idx  on pursuit_action (principal_name, action, acted_at desc);
create index pursuit_action_pursuit_idx on pursuit_action (pursuit_id, action);
create index pursuit_action_sent_idx    on pursuit_action (acted_at desc) where action = 'sent';

select cie_attach_touch('pursuit_action');

comment on table pursuit_action is
  'What one person did about one requirement. track and dismiss are opposites and clear '
  'each other; sent is neither and is never cleared by them, because it is the number that '
  'answers whether this tool fed anything into TechnoMile.';

-- ---------------------------------------------------------------------------
-- follow_pursuit
-- ---------------------------------------------------------------------------
-- Which requirements each follow matches, and why.
--
-- The "why" is not decoration. A feed nobody curated is only trusted if it can say what
-- put each item there, which is the same argument `pursuit_profile_match` makes for the
-- SAM.gov pull. Here the answer is the follow itself plus the field that matched.
--
-- One decision inside the capability arm is worth stating, because the obvious reading is
-- too broad. A capability node crosswalks to NAICS, PSC, keywords **and agencies**. NAICS,
-- PSC and keyword say what the work is; agency says who buys it. Matching on the agency
-- crosswalk would mean following one capability quietly subscribed you to every notice
-- that agency posts, which is the firehose in a different costume. So the capability arm
-- matches on what the work is, and following a buyer is a separate, explicit choice.
create view follow_pursuit as
-- capability, through the crosswalks BD authored
select f.follow_id,
       f.principal_name,
       f.follow_type,
       p.pursuit_id,
       nc.crosswalk_type                        as matched_field,
       nc.crosswalk_value                       as matched_value
  from follow f
  join node_crosswalk nc on nc.node_id = f.node_id
  join taxonomy_node tn  on tn.node_id = f.node_id and tn.active
  join pursuit p
    on (nc.crosswalk_type = 'naics'
        and p.naics_code is not null
        and p.naics_code like nc.crosswalk_value || '%')
    or (nc.crosswalk_type = 'psc'
        and p.psc_code is not null
        and p.psc_code like nc.crosswalk_value || '%')
    or (nc.crosswalk_type = 'keyword'
        and p.title ilike '%' || nc.crosswalk_value || '%')
 where f.follow_type = 'capability'
   and coalesce(nc.crosswalk_value, '') <> ''

union all

-- an awarding agency
select f.follow_id, f.principal_name, f.follow_type, p.pursuit_id,
       'agency', p.agency_code
  from follow f
  join pursuit p on p.agency_code = f.agency_code
 where f.follow_type = 'agency'

union all

-- an office inside an agency
select f.follow_id, f.principal_name, f.follow_type, p.pursuit_id,
       'office', p.agency_code || '/' || p.office_code
  from follow f
  join pursuit p on p.agency_code = f.agency_code and p.office_code = f.office_code
 where f.follow_type = 'office'

union all

-- a company, through the entity rollup rather than a name
--
-- Following the top of a corporate family catches the family; following one subsidiary
-- catches that subsidiary. Rolling a subsidiary follow up to its parent and back down
-- would subscribe somebody to sister companies they did not ask for.
--
-- Two sources of "this company is on this requirement" and both are wanted: the incumbent
-- column the recompete detector fills in, and `pursuit_entity_role`, which decision D5 says
-- is where partner and competitor live because they are roles on a pursuit rather than
-- labels on a company. `distinct` collapses the overlap, since the detector writes an
-- incumbent role row as well as the column and a doubled row would show the same reason twice.
select distinct f.follow_id, f.principal_name, f.follow_type, m.pursuit_id, m.role, m.canonical_name
  from follow f
  join (
    select p.pursuit_id, e.entity_id, e.ultimate_parent_id, e.canonical_name, 'incumbent'::text as role
      from pursuit p
      join entity e on e.entity_id = p.incumbent_entity_id
    union
    select per.pursuit_id, e.entity_id, e.ultimate_parent_id, e.canonical_name, per.role
      from pursuit_entity_role per
      join entity e on e.entity_id = per.entity_id
  ) m on m.entity_id = f.entity_id
      or coalesce(m.ultimate_parent_id, m.entity_id) = f.entity_id
 where f.follow_type = 'company'

union all

-- a raw NAICS code, as a prefix: 5413 catches 541330
select f.follow_id, f.principal_name, f.follow_type, p.pursuit_id, 'naics', p.naics_code
  from follow f
  join pursuit p on p.naics_code is not null and p.naics_code like f.target || '%'
 where f.follow_type = 'naics'

union all

-- a raw PSC code, likewise: R4 catches R425
select f.follow_id, f.principal_name, f.follow_type, p.pursuit_id, 'psc', p.psc_code
  from follow f
  join pursuit p on p.psc_code is not null and p.psc_code like f.target || '%'
 where f.follow_type = 'psc'

union all

-- a phrase in the title
select f.follow_id, f.principal_name, f.follow_type, p.pursuit_id, 'title', f.label
  from follow f
  join pursuit p on p.title ilike '%' || f.target || '%'
 where f.follow_type = 'keyword';

comment on view follow_pursuit is
  'Every (follow, requirement) match, with the field that matched. The answer to "why is '
  'this in my feed", which is the first thing anybody asks of a list they did not curate.';

-- ---------------------------------------------------------------------------
-- feed_item
-- ---------------------------------------------------------------------------
-- One row per requirement, with the fields a feed row shows and nothing about ownership.
--
-- This is the replacement for `pipeline_item`: the same "assembled once so two screens
-- cannot disagree" argument, minus owner, state, snooze and the funnel. `market_movement`
-- is excluded because an award notice is a thing that already happened, and this feed is
-- about what has not happened yet.
create view feed_item as
select
  p.pursuit_id,
  p.signal_class,
  p.title,
  p.agency_code,
  p.office_code,
  p.solicitation_number,
  p.related_piid,
  p.notice_id,
  p.notice_type,
  p.notice_url,
  p.naics_code,
  p.psc_code,
  p.set_aside_code,
  p.place_of_performance_state,
  p.estimated_value,
  p.response_date,
  p.posted_date,
  p.period_end_date,
  p.expected_solicitation_fy,
  p.astrion_position,
  p.incumbent_entity_id,
  p.incumbent_confidence,
  p.generated_by,
  -- When this requirement first landed in this database. `created_at` and not
  -- `generated_at`: detection re-runs monthly and refreshes `generated_at` on every row it
  -- touches, so a feed keyed on it would declare the whole corpus new once a month.
  p.created_at                                            as first_seen_at,
  coalesce(p.response_date, p.period_end_date)             as key_date,
  a.assessment_id,
  a.band,
  a.strategic_fit,
  a.evidence_confidence,
  a.timing_urgency,
  a.coverage
from pursuit p
left join assessment a
       on a.pursuit_id = p.pursuit_id
      and a.score_model_version = (select score_model_version from score_model where is_current limit 1)
where p.signal_class <> 'market_movement';

comment on view feed_item is
  'One row per requirement as a feed row needs it. Replaces pipeline_item for the '
  'interface: no owner, no funnel state, no snooze. first_seen_at is when it landed here.';

-- ---------------------------------------------------------------------------
-- technomile_handoff
-- ---------------------------------------------------------------------------
-- The answer to "is this thing working".
--
-- Not a count of sign-ins, or of items in the feed, or of anything the system can inflate
-- by loading more data. A row here means a person read a requirement this tool surfaced and
-- carried it into TechnoMile by hand, which is the only outcome that matters and the only
-- one worth reporting to leadership.
create view technomile_handoff as
select
  pa.pursuit_id,
  pa.principal_name,
  pa.acted_at,
  pa.note,
  p.title,
  p.signal_class,
  p.agency_code,
  p.solicitation_number,
  p.related_piid,
  p.estimated_value,
  p.notice_url,
  cie_fiscal_year(pa.acted_at::date)              as fiscal_year,
  date_trunc('week', pa.acted_at)::date           as week_starting,
  p.generated_by                                  as surfaced_by,
  -- How long the tool was ahead. Positive means it was in front of the deadline by this
  -- many days when somebody moved it across.
  case when p.response_date is not null
       then (p.response_date - pa.acted_at::date)
  end                                             as days_before_response_due
from pursuit_action pa
join pursuit p on p.pursuit_id = pa.pursuit_id
where pa.action = 'sent';

comment on view technomile_handoff is
  'Every requirement a person carried from here into TechnoMile. The count of these rows is '
  'the measure of whether this tool earns its place; nothing else on any screen is.';
