-- 0026_award_key.sql
--
-- The globally-unique award key, stored and measured rather than trusted.
--
-- Decision D13 says a contract is `(awarding_agency_code, idv_piid, piid)`, because a task order PIID
-- is only unique inside its vehicle: two agencies both issue `0001`, and grouping on the PIID alone
-- merges unrelated work. `contract_group_ambiguous` measures the residue that grouping leaves.
--
-- GovCon API supplies `contract_award_unique_key`, which it describes as globally unique and as the
-- join key to use when a PIID is ambiguous. If that holds, it is strictly better than the composite:
-- it would resolve exactly the cases D13 works around.
--
-- **It is stored and not acted on.** Changing how contracts are grouped would silently change the
-- forecast, the recompete lineages and every campaign figure, on the strength of a field this system
-- has never seen a value of. So this migration adds the column and a view that measures whether the
-- key and the composite agree on the corpus as it actually is. When there is enough data to answer,
-- the answer decides whether D13 changes; until then nothing reads the column.
--
-- One addition and one view. No behaviour change.

-- ---------------------------------------------------------------------------
-- contract_action.contract_award_key
-- ---------------------------------------------------------------------------
-- Nullable, and permanently so: a bulk FPDS extract does not carry this field, so most rows will
-- never have one. Null means "the source did not supply it", never "this action has no award".
alter table contract_action add column contract_award_key text;

create index contract_action_award_key_idx on contract_action (contract_award_key)
  where contract_award_key is not null;

comment on column contract_action.contract_award_key is
  'The source API''s globally-unique award key. Null when the source did not supply one, which is every bulk-extract row. Measured by contract_award_key_agreement; nothing reads it yet. See D29.';

-- ---------------------------------------------------------------------------
-- contract_award_key_agreement
-- ---------------------------------------------------------------------------
-- Does the API's key agree with D13's grouping?
--
-- Two ways it can disagree, and they mean opposite things:
--
--   split      One award key spans more than one D13 group. The composite is splitting a single
--              award — D13 is too strict, and the key would fix it.
--   merged     One D13 group holds more than one award key. The composite is merging distinct
--              awards — D13 is too loose, and the key would fix that too.
--
-- Either count being non-zero is interesting. Both being zero on a corpus with a real number of
-- keyed rows is the finding that would justify leaving D13 alone.
create view contract_award_key_agreement as
with keyed as (
  select contract_award_key,
         awarding_agency_code,
         coalesce(idv_piid, '') as idv_piid,
         piid
    from contract_action
   where contract_award_key is not null
)
select
  (select count(*) from keyed)                                             as keyed_actions,
  (select count(distinct contract_award_key) from keyed)                   as distinct_keys,
  -- One key seen under more than one (agency, vehicle, piid) triple.
  (select count(*) from (
     select contract_award_key
       from keyed
      group by contract_award_key
     having count(distinct (awarding_agency_code, idv_piid, piid)) > 1
   ) s)                                                                    as keys_split_across_groups,
  -- One triple holding more than one key.
  (select count(*) from (
     select awarding_agency_code, idv_piid, piid
       from keyed
      group by awarding_agency_code, idv_piid, piid
     having count(distinct contract_award_key) > 1
   ) m)                                                                    as groups_holding_many_keys;

comment on view contract_award_key_agreement is
  'Whether the API''s globally-unique award key agrees with D13''s (agency, vehicle, piid) grouping. Evidence for a future decision, not an input to a current one.';
