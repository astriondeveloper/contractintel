-- 0001_helpers.sql
-- Shared helpers. Spec section 7: snake_case names, created_at and updated_at on every table.

-- ---------------------------------------------------------------------------
-- Name normalisation
-- ---------------------------------------------------------------------------
-- Two levels, and the difference between them matters. Spec section 8.1.
--
-- cie_normalize_name  Case, punctuation, and whitespace only. Deterministic and
--                     safe. This level makes acceptance test 3 pass:
--                     'LARKSPUR, INCORPORATED' and 'LARKSPUR INCORPORATED' both become
--                     'LARKSPUR INCORPORATED'.
--
-- cie_core_name       Additionally removes corporate suffixes. This level is
--                     used ONLY to propose merge candidates for a human to
--                     confirm. It never merges anything by itself. Spec 8.1:
--                     'A merge from name similarity alone is not permitted.'

create or replace function cie_normalize_name(raw text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          -- Drop a trailing parenthesised numeric token. The corpus carries
          -- 'TESSELLATE CONCEPTS INCORPORATED (5855)'.
          regexp_replace(upper(raw), '\(\s*[0-9]+\s*\)', ' ', 'g'),
          -- Fold every character that is not a letter, digit, or space.
          -- This is the step that makes the comma in 'LARKSPUR, INCORPORATED'
          -- stop mattering. That single alias holds 1,761 transactions.
          '[^A-Z0-9 ]', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

comment on function cie_normalize_name(text) is
  'Case, punctuation, and whitespace normalisation. Safe for automatic lookup.';

create or replace function cie_core_name(raw text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          cie_normalize_name(raw),
          -- Remove one or more trailing corporate suffix tokens.
          '(\s+(INCORPORATED|INCORORATED|INC|LLC|LLP|LP|LTD|CORPORATION|CORP|COMPANY|CO|THE|PLC|GMBH|SA|NV|AG))+$',
          '', 'g'
        ),
        -- Remove a leading 'THE'.
        '^THE\s+', '', 'g'
      )
    ),
    ''
  );
$$;

comment on function cie_core_name(text) is
  'Suffix-stripped name. Proposes merge candidates for human review only. Never merges.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function cie_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attach the updated_at trigger to a table. Called by later migrations so the
-- boilerplate stays in one place.
create or replace function cie_attach_touch(target_table regclass)
returns void
language plpgsql
as $$
declare
  trigger_name text := 'touch_' || relname
    from pg_class where oid = target_table;
begin
  execute format(
    'create trigger %I before update on %s for each row execute function cie_touch_updated_at()',
    trigger_name, target_table::text
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Fiscal year of a date. US federal fiscal year starts 1 October.
-- ---------------------------------------------------------------------------
create or replace function cie_fiscal_year(d date)
returns integer
language sql
immutable
strict
parallel safe
as $$
  select case when extract(month from d) >= 10
              then extract(year from d)::int + 1
              else extract(year from d)::int
         end;
$$;
