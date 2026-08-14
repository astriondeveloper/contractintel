-- 0018_split_role_conflict.sql
--
-- Corrects a view that 0017 named wrongly, and in doing so buried a useful signal.
--
-- 0017 created dacis_contract_role_conflict as any contract asserted both as a loss and
-- as won. On the real corpus that returns five rows, and four of them are not conflicts
-- at all: each is a multiple-award task order asserted as both 'loss' and 'sub'. Only the
-- fifth, asserted as 'loss' and 'prime', is genuinely contradictory. The specific contracts
-- are in the Phase 1 status document rather than here; this file records the rule.
--
-- 'loss' and 'sub' together is a perfectly coherent outcome and a common one: Astrion bid
-- the prime, did not win it, and took a subcontract position on the winning team instead.
-- That is not a data problem, it is one of the more actionable facts in the corpus -- it
-- names the competitions where Astrion is already inside the winning team and could bid
-- the prime at recompete.
--
-- Only 'loss' together with 'prime' or 'out' is genuinely contradictory: a company does
-- not hold the prime and lose the same competition. That is one row.
--
-- A view called 'conflict' that is 80 percent legitimate outcomes teaches people to
-- ignore it, so the two are separated.

drop view dacis_contract_role_conflict;

-- ---------------------------------------------------------------------------
-- Lost the prime, took a subcontract. A pursuit list, not an error list.
-- ---------------------------------------------------------------------------
create view dacis_contract_lost_prime_won_sub as
select
  c.dacis_contract_id,
  c.source_record_id,
  c.contract_number,
  c.solicitation_number,
  c.title,
  c.value_usd,
  c.value_is_shared,
  c.award_date,
  c.end_date,
  c.customer_using_activity,
  -- Who did win it, from the Companies column on the same record.
  (
    select string_agg(co.company_name_raw, '; ' order by co.company_name_raw)
      from dacis_contract_company co
     where co.dacis_contract_id = c.dacis_contract_id
       and co.company_role = 'awardee'
  ) as awardees
from dacis_contract c
where exists (
        select 1 from dacis_contract_role r
         where r.dacis_contract_id = c.dacis_contract_id and r.astrion_role = 'loss')
  and exists (
        select 1 from dacis_contract_role r
         where r.dacis_contract_id = c.dacis_contract_id and r.astrion_role = 'sub');

comment on view dacis_contract_lost_prime_won_sub is
  'Contracts Astrion lost as prime and holds a subcontract on. Already inside the winning '
  'team, so a candidate to bid the prime at recompete. Read end_date with section 9.1.';

-- ---------------------------------------------------------------------------
-- Genuinely contradictory assertions only.
-- ---------------------------------------------------------------------------
create view dacis_contract_role_conflict as
select
  c.dacis_contract_id,
  c.source_record_id,
  c.contract_number,
  c.title,
  string_agg(r.astrion_role, ', ' order by r.astrion_role) as roles_asserted,
  string_agg(distinct r.source_label, '; ') as source_files
from dacis_contract c
join dacis_contract_role r on r.dacis_contract_id = c.dacis_contract_id
group by c.dacis_contract_id, c.source_record_id, c.contract_number, c.title
having bool_or(r.astrion_role = 'loss')
   and bool_or(r.astrion_role in ('prime', 'out'));

comment on view dacis_contract_role_conflict is
  'Contracts asserted as both held and lost, which cannot both be true. Excludes the '
  'loss-plus-sub combination, which is a real outcome -- see '
  'dacis_contract_lost_prime_won_sub. Surfaced rather than resolved: only whoever ran the '
  'export knows which assertion is right. source_files names the exports that disagree.';
