-- 0012_code_label_versioning.sql
--
-- Corrects the unique index that 0004_awards.sql put on code_label.
--
-- The original index was (code_type, code_value, effective_from). effective_from
-- defaults to 1900-01-01, so the second distinct label for one code collided with
-- the first. The corpus contains exactly that case, and specification section 4.1
-- names it: 'PSC R425 appears with two different descriptions in one dataset.'
--
-- The mistake was assuming a label change arrives with a date attached. It does
-- not. An FPDS export carries a code and a description, with no statement about
-- when the description started to apply. Two descriptions for one code are two
-- observations, not two dated versions, and the loader cannot know which is newer
-- from the row alone.
--
-- So the grain becomes one row per distinct label string ever observed for a code:
--
--   unique (code_type, code_value, label)
--
-- Observation timestamps record when the loader saw each label. is_current marks
-- the one the interface shows, chosen as the most recently observed, with exactly
-- one current row per code enforced by a partial unique index. effective_from and
-- effective_to stay, for when an authoritative source or a BD Ops user states a
-- real effective window. They are no longer load-bearing for uniqueness.
--
-- The alternate labels are kept rather than discarded. A user who sees a PSC
-- description that does not match the one in a source document needs to be able
-- to see that both descriptions exist for that code.

drop index code_label_version_idx;
drop index code_label_current_idx;
drop view code_label_current;

alter table code_label
  add column first_observed_at  timestamptz not null default now(),
  add column last_observed_at   timestamptz not null default now(),
  add column observation_count  integer     not null default 1,
  add column is_current         boolean     not null default false;

alter table code_label alter column effective_from drop not null;
alter table code_label alter column effective_from drop default;

-- One row per distinct label string for a code.
create unique index code_label_distinct_idx on code_label (code_type, code_value, label);

-- Exactly one current label per code.
create unique index code_label_one_current_idx on code_label (code_type, code_value)
  where is_current;

comment on column code_label.is_current is
  'The label the interface shows. Most recently observed wins. Alternates are kept, not discarded.';
comment on column code_label.observation_count is
  'How many source records carried this label. A one-off spelling is visible as such.';

-- ---------------------------------------------------------------------------
-- Recompute which label is current for one code.
-- ---------------------------------------------------------------------------
create or replace function cie_refresh_current_label(p_code_type text, p_code_value text)
returns void
language plpgsql
as $$
declare
  winner bigint;
begin
  -- Prefer an explicitly dated row that is still open, then the most recently
  -- observed, then the most frequently observed, then the lowest id so the result
  -- is deterministic.
  select code_label_id into winner
    from code_label
   where code_type = p_code_type
     and code_value = p_code_value
     and effective_to is null
   order by (effective_from is not null) desc,
            effective_from desc nulls last,
            last_observed_at desc,
            observation_count desc,
            code_label_id asc
   limit 1;

  if winner is null then
    return;
  end if;

  update code_label
     set is_current = (code_label_id = winner)
   where code_type = p_code_type
     and code_value = p_code_value
     and is_current <> (code_label_id = winner);
end;
$$;

-- Record one observation of a label. Idempotent on the label string.
create or replace function cie_observe_code_label(
  p_code_type text,
  p_code_value text,
  p_label text,
  p_source_system text default null
)
returns void
language plpgsql
as $$
begin
  insert into code_label (code_type, code_value, label, source_system)
  values (p_code_type, p_code_value, p_label, p_source_system)
  on conflict (code_type, code_value, label) do update
    set last_observed_at = now(),
        observation_count = code_label.observation_count + 1;

  perform cie_refresh_current_label(p_code_type, p_code_value);
end;
$$;

comment on function cie_observe_code_label(text, text, text, text) is
  'The only way a loader should write a label. Handles the two-descriptions-for-one-code case. Spec 4.1.';

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
create view code_label_current as
select code_type, code_value, label, effective_from, last_observed_at, observation_count
from code_label
where is_current;

comment on view code_label_current is
  'The label to display. The application always stores the code and shows this. Spec 7.2.';

-- Codes that arrived with more than one description. Spec 4.1 says this happens.
-- BD Ops can use this to pick the authoritative label rather than accept the
-- most-recent default.
create view code_label_disputed as
select
  code_type,
  code_value,
  count(*)                                                        as label_count,
  array_agg(label order by last_observed_at desc)                  as labels,
  (array_agg(label order by is_current desc, last_observed_at desc))[1] as current_label
from code_label
group by code_type, code_value
having count(*) > 1;

comment on view code_label_disputed is
  'Codes carrying more than one observed description. PSC R425 is the known case.';

-- Backfill is_current for anything already loaded.
do $$
declare
  r record;
begin
  for r in select distinct code_type, code_value from code_label loop
    perform cie_refresh_current_label(r.code_type, r.code_value);
  end loop;
end $$;
