-- 0014_refresh_current_label_ordering.sql
--
-- Fixes cie_refresh_current_label, which raised
--   duplicate key value violates unique constraint "code_label_one_current_idx"
-- part way through the first real corpus load, at around row 20,000 of the largest
-- FPDS export. No fixture reached it.
--
-- The cause. 0012 flips is_current for a code in one statement:
--
--   update code_label
--      set is_current = (code_label_id = winner)
--    where code_type = ... and code_value = ...
--      and is_current <> (code_label_id = winner);
--
-- That statement both clears the old current row and sets the new one.
-- code_label_one_current_idx is a partial unique index, and a partial unique index
-- cannot be declared deferrable in PostgreSQL, so it is checked as each row is
-- written rather than at statement end. If the executor happens to write the new
-- winner before it clears the previous current row, two rows for the same
-- (code_type, code_value) are momentarily is_current and the index rejects it.
--
-- Row order inside an UPDATE is not specified. With two labels in a fixture the
-- favourable order happened to come up every time, which is why 64 passing tests
-- said nothing about this. On the real corpus the other order arrives.
--
-- The fix is ordering, not a weaker constraint: clear the losers in one statement,
-- then set the winner in a second. Between the two statements zero rows are
-- current for that code, which the partial unique index permits. The invariant the
-- index exists to enforce -- at most one current label per code -- is unchanged,
-- and it still holds at every statement boundary and therefore at commit.
--
-- The winner selection is untouched.

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
  --
  -- Note on last_observed_at: now() is fixed for a transaction, so labels flushed
  -- in one transaction share a timestamp and the ordering falls through to
  -- observation_count and then code_label_id. That is deterministic, which is what
  -- this clause is for.
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
    -- Every label for this code is closed. Nothing is current, which is correct,
    -- but any stale flag has to go.
    update code_label
       set is_current = false
     where code_type = p_code_type
       and code_value = p_code_value
       and is_current;
    return;
  end if;

  -- Statement 1. Clear every row that should not be current, including the row that
  -- currently is. This must complete before the winner is set.
  update code_label
     set is_current = false
   where code_type = p_code_type
     and code_value = p_code_value
     and is_current
     and code_label_id <> winner;

  -- Statement 2. Set the winner. At most one row matches, so the partial unique
  -- index sees at most one is_current row for this code.
  update code_label
     set is_current = true
   where code_label_id = winner
     and not is_current;
end;
$$;

comment on function cie_refresh_current_label(text, text) is
  'Recomputes the current label for one code. Clears losers, then sets the winner: '
  'code_label_one_current_idx is partial and therefore not deferrable, so both cannot '
  'happen in one statement. See migration 0014.';

-- Re-run across everything already loaded, so a database that was loaded under the
-- 0012 version converges on the same answer.
do $$
declare
  r record;
begin
  for r in select distinct code_type, code_value from code_label loop
    perform cie_refresh_current_label(r.code_type, r.code_value);
  end loop;
end;
$$;
