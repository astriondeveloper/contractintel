-- 0013_code_label_counts.sql
--
-- cie_observe_code_label gains a count, so a loader can report 'this label
-- appeared on 1,412 records in this file' with one round trip instead of 1,412.
--
-- Why this matters. observation_count is documented as the number of source
-- records that carried a label, and its purpose is to make a one-off spelling
-- visible as a one-off. The first version of the loader deduplicated labels
-- within a file before calling this function, so a label seen on 1,412 records
-- and a label seen on 1 both recorded a count of 1. The number was therefore
-- useless for the one thing it was for.
--
-- The loader now tallies labels in memory while it streams the file and flushes
-- the totals once at the end. A label on a row whose payload hash was unchanged is
-- not counted again, because that record was counted on the run that first loaded
-- it. So observation_count means: distinct source records, across all runs, whose
-- payload was new or changed and which carried this label.

drop function if exists cie_observe_code_label(text, text, text, text);

create or replace function cie_observe_code_label(
  p_code_type text,
  p_code_value text,
  p_label text,
  p_source_system text default null,
  p_count integer default 1
)
returns void
language plpgsql
as $$
begin
  if p_count < 1 then
    raise exception 'cie_observe_code_label needs a count of at least 1, got %', p_count;
  end if;

  insert into code_label (code_type, code_value, label, source_system, observation_count)
  values (p_code_type, p_code_value, p_label, p_source_system, p_count)
  on conflict (code_type, code_value, label) do update
    set last_observed_at = now(),
        observation_count = code_label.observation_count + p_count;

  perform cie_refresh_current_label(p_code_type, p_code_value);
end;
$$;

comment on function cie_observe_code_label(text, text, text, text, integer) is
  'The only way a loader should write a label. Handles two descriptions for one code. Spec 4.1.';
