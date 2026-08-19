-- 0028_govwin_in_the_feed.sql
--
-- Making GovWin reachable from a person's patch.
--
-- Migration 0027 loaded 2,629 GovWin opportunities and gave them nowhere to appear. That was a real
-- omission rather than a staged rollout: 769 of those rows are Pre-RFP or Forecast Pre-RFP, which is
-- the earliest warning this system has, and a requirement nobody can see is worth nothing. This adds
-- the matching that puts them in front of the right person.
--
-- **It mirrors `follow_pursuit` rather than replacing it.** Decision D32 keeps GovWin records out of
-- `pursuit`, because their lifecycle, their estimate provenance and their disagreements with SAM.gov
-- are the reason to have them. That decision is about storage and it stands. Where a person's follows
-- are concerned the question is different — "is this in my patch" — and the answer has to be computed
-- the same way for both kinds of record or a follow means two things.
--
-- **What matches, and what deliberately does not.** Capability, agency, office, raw NAICS and keyword
-- all match, on the same rules as the pursuit view: a capability through the crosswalks BD authored, a
-- NAICS code as a prefix so 5413 catches 541330. Two arms are absent:
--
--   PSC. GovWin's export carries no product or service code at all, so a PSC follow cannot match a
--   GovWin row. Silently returning nothing would read as "no early work in my area"; the readiness
--   report counts it instead.
--
--   Company. GovWin lists incumbents as an unparsed string — dozens of names on a multiple-award
--   vehicle, with commas inside the names themselves. Splitting that on commas would attribute work to
--   companies that are not on it. Company matching waits for resolution through the review queue,
--   which is where every other name in this system earns its entity.

-- ---------------------------------------------------------------------------
-- follow_govwin
-- ---------------------------------------------------------------------------
create view follow_govwin as
-- capability, through the crosswalks BD authored
select f.follow_id,
       f.principal_name,
       f.follow_type,
       g.govwin_id,
       nc.crosswalk_type  as matched_field,
       nc.crosswalk_value as matched_value
  from follow f
  join node_crosswalk nc on nc.node_id = f.node_id
  join taxonomy_node tn  on tn.node_id = f.node_id and tn.active
  join govwin_opportunity g on true
 where f.follow_type = 'capability'
   and coalesce(nc.crosswalk_value, '') <> ''
   and (
     (nc.crosswalk_type = 'naics'
      and exists (select 1 from govwin_opportunity_naics n
                   where n.govwin_id = g.govwin_id
                     and n.naics_code like nc.crosswalk_value || '%'))
     -- No PSC arm: the export has no product or service code to match against.
     or (nc.crosswalk_type = 'keyword'
         and coalesce(g.program_name, '') ilike '%' || nc.crosswalk_value || '%')
   )

union all

-- an agency, by the code resolved from GovWin's agency names
select f.follow_id, f.principal_name, f.follow_type, g.govwin_id,
       'agency', g.agency_code
  from follow f
  join govwin_opportunity g on g.agency_code = f.agency_code
 where f.follow_type = 'agency'

union all

-- an office. GovWin's hierarchy resolves to one code rather than an agency-and-office pair, so an
-- office follow matches when that single resolved code is the office. Fewer matches than the pursuit
-- view finds, and honestly fewer rather than approximately more.
select f.follow_id, f.principal_name, f.follow_type, g.govwin_id,
       'office', g.agency_code
  from follow f
  join govwin_opportunity g on g.agency_code = f.office_code
 where f.follow_type = 'office'

union all

-- a raw NAICS code, as a prefix
select distinct f.follow_id, f.principal_name, f.follow_type, g.govwin_id,
       'naics', n.naics_code
  from follow f
  join govwin_opportunity_naics n on n.naics_code like f.target || '%'
  join govwin_opportunity g on g.govwin_id = n.govwin_id
 where f.follow_type = 'naics'

union all

-- a keyword, against the programme name, which is the only title a GovWin row has
select f.follow_id, f.principal_name, f.follow_type, g.govwin_id,
       'keyword', f.target
  from follow f
  join govwin_opportunity g on coalesce(g.program_name, '') ilike '%' || f.target || '%'
 where f.follow_type = 'keyword';

comment on view follow_govwin is
  'Which of a person''s follows put a GovWin record in their patch. Mirrors follow_pursuit. No PSC arm because the export has no PSC, and no company arm until incumbent names are resolved.';

-- ---------------------------------------------------------------------------
-- govwin_early
-- ---------------------------------------------------------------------------
-- The slice worth putting in front of somebody, with the estimate spelled out.
--
-- Pre-RFP and Forecast Pre-RFP only. Everything later is either already visible through SAM.gov, where
-- the notice itself is a better record, or finished. `days_until_expected` is null where GovWin named no
-- date, which is a third of the early rows: an early requirement with no expected date is still worth
-- seeing and is not worth inventing a date for.
create view govwin_early as
select g.govwin_id,
       g.status,
       g.program_name,
       g.acronym,
       g.agency_code,
       g.org_level_1,
       g.org_level_2,
       g.solicitation_number,
       g.value_usd,
       g.solicitation_date,
       g.solicitation_date_precision,
       g.solicitation_date_basis,
       g.projected_award_date,
       g.earliest_expiration_date,
       g.advertised_interest,
       g.incumbent_names,
       g.govwin_url,
       g.first_seen_at,
       g.last_seen_at,
       (select array_agg(n.naics_code order by n.is_primary desc, n.naics_code)
          from govwin_opportunity_naics n where n.govwin_id = g.govwin_id) as naics_codes,
       case when g.solicitation_date is null then null
            else (g.solicitation_date - current_date) end as days_until_expected,
       cie_fiscal_year(g.solicitation_date)               as expected_fy,
       cie_fiscal_quarter(g.solicitation_date)            as expected_quarter
  from govwin_opportunity g
 where g.status in ('Pre-RFP', 'Forecast Pre-RFP');

comment on view govwin_early is
  'GovWin requirements with no solicitation yet: the earliest warning this system has. A null expected date is a third of them and is not filled in.';

-- ---------------------------------------------------------------------------
-- govwin_coverage
-- ---------------------------------------------------------------------------
-- Whether this source can actually reach anybody, which is not the same as whether it loaded.
--
-- Two ways it silently cannot. An unresolved agency code means an agency or office follow can never
-- match the row, and GovWin names agencies rather than coding them. A follow on a PSC can never match
-- at all, because the export has no PSC column. Both are counted here so the readiness report can say
-- so rather than leaving somebody to conclude there is no early work in their area.
create view govwin_coverage as
select
  (select count(*) from govwin_opportunity)                                as loaded,
  (select count(*) from govwin_early)                                      as early,
  (select count(*) from govwin_opportunity where agency_code is not null)  as agency_resolved,
  (select count(*) from govwin_opportunity where agency_code is null)      as agency_unresolved,
  (select count(*) from govwin_early where solicitation_date is not null)  as early_with_expected_date,
  (select count(distinct govwin_id) from follow_govwin)                    as reachable_by_a_follow,
  (select count(*) from follow where follow_type = 'psc')                  as psc_follows_that_cannot_match,
  (select count(*) from follow where follow_type = 'company')              as company_follows_that_cannot_match;

comment on view govwin_coverage is
  'Whether GovWin can reach anybody: resolved agencies, rows a follow matches, and the follow types that cannot match this source at all.';
