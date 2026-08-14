-- 0017_dacis_reference.sql
--
-- Tables for the three DACIS export shapes that section 7 has no home for:
-- customers, programs, and DACIS contract records.
--
-- Everything here is derived from measurement of the supplied exports, not from
-- guesswork. The measurements are stated inline so a reader can check them.
--
-- ---------------------------------------------------------------------------
-- Why role is a child table and not a column
-- ---------------------------------------------------------------------------
-- The 20-column contract exports arrive in four roles: contracts-prime,
-- contracts-out, subcontracts, and contractslosses. Measured across all of them:
--
--   434 rows, but only 213 distinct DACIS contract ids
--   18 ids appear under more than one role:
--        11 as (out, prime), 4 as (losses, subs), 2 as (out, prime, subs), 1 as (losses, prime)
--
-- One contract can therefore be a prime record for one Astrion legacy entity and a
-- loss record for another. Role is a property of the pairing, not of the contract, so
-- it lives in dacis_contract_role and one contract carries as many rows there as the
-- exports assert.
--
-- ---------------------------------------------------------------------------
-- Why the loader must be told the role rather than inferring it
-- ---------------------------------------------------------------------------
-- The subcontract loader deliberately does NOT store a direction, because every
-- subcontract row names its own prime and sub and the direction is derivable. This is
-- the opposite case, and the difference is measured, not stylistic:
--
--   role     rows   Astrion in 'Companies'   Astrion in 'Other Bidders'   neither
--   prime     234                      234                            2         0
--   out        19                       19                            0         0
--   subs      141                       11                            2       128
--   losses     40                        2                            8        31
--
-- On a prime row Astrion is always named, so the row is self-describing. On a
-- subcontract row it is usually named nowhere -- the row describes the prime contract
-- and Astrion's sub role is carried only by which export it came from. On a loss row it
-- is named nowhere on 31 of 40. So for this shape the file is the only carrier of the
-- role, and the loader records what it was told, with role_source saying whether a
-- human declared it or it was inferred from the filename.
--
-- The two loss rows that name an Astrion company in 'Companies' are contradictions --
-- a company does not win and lose the same contract -- and are surfaced by
-- dacis_contract_role_conflict rather than silently resolved.

-- ---------------------------------------------------------------------------
-- customer_org
-- ---------------------------------------------------------------------------
-- 854 rows, 854 distinct Customer Code values, none blank. A real key.
-- 97 rows have no acronym and 96 no state, so both are nullable.
-- 755 of 854 are USA; the rest span 30 other countries, so country is not assumed.
--
-- This is the reference dimension the FPDS agency and office codes needed. FPDS gives
-- '6920: EXAMPLE AVIATION ADMINISTRATION'; this gives the customer's acronym, address,
-- and a chronology of who commands it. Section 15's evidence rail needs the latter.
create table customer_org (
  customer_org_id  bigserial primary key,
  source_system    text not null,
  customer_code    text not null,
  customer_name    text not null,
  name_normalized  text,
  acronym          text,
  city             text,
  state            text,
  country          text,
  address          text,
  description      text,
  chronology       text,
  dacis_url        text,
  source_version_id bigint references source_version (source_version_id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index customer_org_identity_idx on customer_org (source_system, customer_code);
create index customer_org_name_idx on customer_org (name_normalized);
create index customer_org_acronym_idx on customer_org (upper(acronym)) where acronym is not null;

comment on table customer_org is
  'DACIS customer reference. 854 rows keyed on Customer Code, e.g. US-N-01A for CASCOM.';
comment on column customer_org.name_normalized is
  'cie_normalize_name of customer_name, so a customer string on a contract row can be matched.';

select cie_attach_touch('customer_org');

-- ---------------------------------------------------------------------------
-- program
-- ---------------------------------------------------------------------------
-- 74 programs: 38 active, 34 archived, 2 pre-RFP. All 74 DACIS ids are distinct and
-- the three sets do not overlap at all, so lifecycle status is a clean partition and a
-- genuine property of the record. Unlike the subcontract in/out case it is stored.
create table program (
  program_id       bigserial primary key,
  source_system    text not null,
  source_record_id text not null,
  program_name     text not null,
  name_normalized  text,
  description      text,
  lifecycle_status text not null check (lifecycle_status in ('active', 'archived', 'pre_rfp')),
  -- The export column is headed 'Companies (Top 500)'. 10 of the 74 programs supply
  -- exactly 500 participants, which means they were truncated and the real count is
  -- unknown. A participant count from those programs is a floor, not a total, and
  -- anything that ranks or scores on participant count has to say so.
  participant_list_truncated boolean not null default false,
  participants_supplied      integer not null default 0,
  dacis_url        text,
  source_version_id bigint references source_version (source_version_id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index program_identity_idx on program (source_system, source_record_id);
create index program_name_idx on program (name_normalized);
create index program_status_idx on program (lifecycle_status);

comment on table program is
  'DACIS programs. lifecycle_status pre_rfp is the companies_advance export: opportunities '
  'before a solicitation exists, which is the pipeline input sections 9 and 11 need.';
comment on column program.participant_list_truncated is
  'True when the export supplied exactly 500 participants, the documented cap. The real '
  'participant count is then unknown and participants_supplied is a floor.';

select cie_attach_touch('program');

-- ---------------------------------------------------------------------------
-- program_participant
-- ---------------------------------------------------------------------------
-- Companies named on a program. entity_id is null for anyone outside the authored map,
-- which is most of them: one program alone names 500 companies against a 45 company
-- watchlist. The raw name and the parsed location are always kept.
create table program_participant (
  program_id     bigint not null references program (program_id) on delete cascade,
  company_name_raw text not null,
  name_normalized  text,
  location_raw     text,
  entity_id        bigint references entity (entity_id),
  primary key (program_id, company_name_raw)
);

create index program_participant_entity_idx on program_participant (entity_id)
  where entity_id is not null;
create index program_participant_name_idx on program_participant (name_normalized);

comment on table program_participant is
  'Companies named on a program. The export formats each as "Name (City, ST)"; the '
  'location suffix is split off into location_raw and stripped from the name.';

-- ---------------------------------------------------------------------------
-- program_customer
-- ---------------------------------------------------------------------------
create table program_customer (
  program_id        bigint not null references program (program_id) on delete cascade,
  customer_name_raw text not null,
  name_normalized   text,
  location_raw      text,
  customer_org_id   bigint references customer_org (customer_org_id),
  primary key (program_id, customer_name_raw)
);

create index program_customer_org_idx on program_customer (customer_org_id)
  where customer_org_id is not null;

comment on table program_customer is
  'Customers named on a program, matched against customer_org where the name resolves.';

-- ---------------------------------------------------------------------------
-- dacis_contract
-- ---------------------------------------------------------------------------
-- 213 distinct contracts across 434 export rows. Keyed on the DACIS id in the link,
-- which is present and parseable on every row.
create table dacis_contract (
  dacis_contract_id bigserial primary key,
  source_system     text not null,
  source_record_id  text not null,
  title             text,
  brief             text,
  contract_number   text,
  solicitation_number text,
  contract_type_raw text,
  -- The export column is 'Value ($M)'. 429 of 434 rows carry a number, 5 are blank,
  -- none are negative. Stored in dollars so it is comparable with
  -- contract_action.action_obligation without a mental unit conversion at every use.
  value_usd         numeric(20, 2),
  -- 'Value is Shared' = Yes means the figure covers several awardees. Summing shared
  -- values across contracts double counts, so the flag travels with the number.
  value_is_shared   boolean,
  award_date        date,
  end_date          date,
  doge_canceled     boolean,
  customer_using_activity text,
  customer_country  text,
  customer_region_raw text,
  customer_type_raw text,
  dacis_url         text,
  source_version_id bigint references source_version (source_version_id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index dacis_contract_identity_idx
  on dacis_contract (source_system, source_record_id);
create index dacis_contract_number_idx on dacis_contract (contract_number)
  where contract_number is not null;
create index dacis_contract_award_date_idx on dacis_contract (award_date);
create index dacis_contract_end_date_idx on dacis_contract (end_date);

comment on table dacis_contract is
  'DACIS contract records, the 20-column export shape. 213 contracts from 434 rows.';
comment on column dacis_contract.value_is_shared is
  'From "Value is Shared". True means value_usd covers several awardees; do not sum '
  'shared values across contracts.';

select cie_attach_touch('dacis_contract');

-- ---------------------------------------------------------------------------
-- dacis_contract_role
-- ---------------------------------------------------------------------------
create table dacis_contract_role (
  dacis_contract_id bigint not null references dacis_contract (dacis_contract_id) on delete cascade,
  astrion_role      text not null check (astrion_role in ('prime', 'out', 'sub', 'loss')),
  -- Whether a human said so or the filename was read. Anything that treats a loss as a
  -- loss should be able to see which.
  role_source       text not null check (role_source in ('declared', 'inferred_from_filename')),
  source_label      text,
  created_at        timestamptz not null default now(),
  primary key (dacis_contract_id, astrion_role)
);

comment on table dacis_contract_role is
  'Astrion''s role on a contract, as asserted by the export it arrived in. Not derivable '
  'from row content: on 31 of 40 loss rows no Astrion company is named anywhere. See the '
  'measurement table at the top of migration 0017.';

-- ---------------------------------------------------------------------------
-- dacis_contract_company
-- ---------------------------------------------------------------------------
-- 'Companies' is populated on all 434 rows. 'Other Bidders' on 26, naming 18 distinct
-- companies. Both are stored the same way and told apart by company_role, because they
-- are the same kind of fact about different sides of a competition.
--
-- Deliberately no scoring factor is built on other_bidder. 6 percent coverage will not
-- support one, and a factor computed from it would rank on whether Deltek happened to
-- record the bidders rather than on anything about the competition.
create table dacis_contract_company (
  dacis_contract_id bigint not null references dacis_contract (dacis_contract_id) on delete cascade,
  company_name_raw  text not null,
  company_role      text not null check (company_role in ('awardee', 'other_bidder')),
  name_normalized   text,
  location_raw      text,
  entity_id         bigint references entity (entity_id),
  primary key (dacis_contract_id, company_name_raw, company_role)
);

create index dacis_contract_company_entity_idx on dacis_contract_company (entity_id)
  where entity_id is not null;
create index dacis_contract_company_role_idx on dacis_contract_company (company_role);
create index dacis_contract_company_name_idx on dacis_contract_company (name_normalized);

comment on column dacis_contract_company.company_role is
  'awardee from the Companies column, other_bidder from Other Bidders. Other Bidders is '
  'populated on 26 of 434 rows, so it is evidence, not a basis for scoring.';

-- ---------------------------------------------------------------------------
-- dacis_contract_program and dacis_contract_customer
-- ---------------------------------------------------------------------------
-- 'Programs' is populated on 219 of 434 rows, so the contract-to-program join is real
-- and worth having. program_id is filled when the name matches a loaded program and left
-- null otherwise, because the programs export covers 74 programs and the contracts name
-- more than that.
create table dacis_contract_program (
  dacis_contract_id bigint not null references dacis_contract (dacis_contract_id) on delete cascade,
  program_name_raw  text not null,
  name_normalized   text,
  program_id        bigint references program (program_id),
  primary key (dacis_contract_id, program_name_raw)
);

create index dacis_contract_program_id_idx on dacis_contract_program (program_id)
  where program_id is not null;

create table dacis_contract_customer (
  dacis_contract_id bigint not null references dacis_contract (dacis_contract_id) on delete cascade,
  customer_name_raw text not null,
  name_normalized   text,
  location_raw      text,
  customer_org_id   bigint references customer_org (customer_org_id),
  primary key (dacis_contract_id, customer_name_raw)
);

create index dacis_contract_customer_org_idx on dacis_contract_customer (customer_org_id)
  where customer_org_id is not null;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- A contract asserted as both won and lost. Two rows in the supplied corpus.
create view dacis_contract_role_conflict as
select
  c.dacis_contract_id,
  c.source_record_id,
  c.contract_number,
  c.title,
  string_agg(r.astrion_role, ', ' order by r.astrion_role) as roles_asserted
from dacis_contract c
join dacis_contract_role r on r.dacis_contract_id = c.dacis_contract_id
group by c.dacis_contract_id, c.source_record_id, c.contract_number, c.title
having bool_or(r.astrion_role = 'loss')
   and bool_or(r.astrion_role in ('prime', 'out', 'sub'));

comment on view dacis_contract_role_conflict is
  'Contracts the exports assert as both won and lost. Surfaced rather than resolved: '
  'only the person who ran the export knows which assertion is right.';

-- Competitors named as other bidders, with what they were bidding against.
create view dacis_other_bidder as
select
  co.company_name_raw,
  co.name_normalized,
  co.entity_id,
  count(distinct co.dacis_contract_id) as contracts,
  sum(case when r.astrion_role = 'loss' then 1 else 0 end) as on_astrion_losses,
  min(c.award_date) as first_seen,
  max(c.award_date) as last_seen
from dacis_contract_company co
join dacis_contract c on c.dacis_contract_id = co.dacis_contract_id
left join dacis_contract_role r on r.dacis_contract_id = c.dacis_contract_id
where co.company_role = 'other_bidder'
group by co.company_name_raw, co.name_normalized, co.entity_id;

comment on view dacis_other_bidder is
  'Companies recorded as competing bidders. Thin by construction: 26 of 434 contract rows '
  'carry the column. Useful as evidence on a specific competition, not as a population.';

-- Programs where Astrion is named alongside watchlist competitors.
create view program_competitive_overlap as
with astrion as (
  select entity_id from entity
   where entity_type = 'astrion_family'
      or ultimate_parent_id in (select entity_id from entity where entity_type = 'astrion_family')
)
select
  p.program_id,
  p.program_name,
  p.lifecycle_status,
  p.participant_list_truncated,
  p.participants_supplied,
  count(*) filter (where pp.entity_id in (select entity_id from astrion)) as astrion_companies,
  count(*) filter (
    where pp.entity_id is not null
      and pp.entity_id not in (select entity_id from astrion)
  ) as watchlist_companies,
  count(*) filter (where pp.entity_id is null) as unknown_companies
from program p
join program_participant pp on pp.program_id = p.program_id
group by p.program_id, p.program_name, p.lifecycle_status,
         p.participant_list_truncated, p.participants_supplied;

comment on view program_competitive_overlap is
  'Per program, how many named participants are Astrion, on the watchlist, or unknown. '
  'Read participant_list_truncated before treating any count as complete.';
