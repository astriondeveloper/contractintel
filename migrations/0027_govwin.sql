-- 0027_govwin.sql
--
-- GovWin tracked opportunities: the one source that knows about a requirement before it exists.
--
-- This closes half of Gate B in docs/DECISIONS.md. The API is still unanswered; the export is not, and
-- the export is enough to be useful weekly.
--
-- **Why this is worth a table of its own.** Every other source here describes something that has
-- already happened. FPDS describes awards. SAM.gov describes notices the government has published. A
-- GovWin record describes a requirement an analyst is *tracking*, often years before anything is
-- published: of 2,629 rows in the first export, 673 carry a Deltek estimate of when the solicitation
-- will drop and 421 sit in Forecast Pre-RFP, which means no solicitation number exists yet. That is
-- the earliest warning this system has ever had access to, and it is a different kind of record from a
-- notice rather than a variant of one. Forcing it into `pursuit` alone would lose its lifecycle, its
-- estimate provenance and the fact that GovWin's status and SAM.gov's notice type disagree by design.
--
-- **The precision decision, which is the important one.** In the first export the estimate flag and the
-- date precision correspond exactly: all 624 `Actual` solicitation dates are `mm/dd/yyyy`, and all 673
-- Deltek estimates and 37 government estimates are `mm/yyyy`. Nobody is claiming to know the day an
-- unpublished solicitation will drop. So each date is stored with its precision and its basis, and a
-- month-precision estimate is stored on the first of its month with `..._precision = 'month'` beside
-- it. Storing it as a bare date would silently promote "sometime in June 2027" to "the 1st of June
-- 2027", and the forecast would then treat a guess as a fact — the exact failure decision D19 was
-- written to prevent on this system's own projections.
--
-- **The prose is deliberately not stored.** `Summary` and `Latest News` are Deltek's written analysis,
-- present on every row and the largest fields in the export. They are licensed content, and this
-- system renders to a snapshot that embeds every row it shows (scripts/build-demo.ts), so holding them
-- would put licensed prose one careless publish away from a shareable URL. The structured fields are
-- stored and `govwin_url` links out to the record, where the reader's own licence applies. Same
-- pattern as the SAM.gov link on the hand-off panel: this system points at the source rather than
-- re-hosting it.

-- ---------------------------------------------------------------------------
-- govwin_opportunity
-- ---------------------------------------------------------------------------
create table govwin_opportunity (
  -- GovWin's own opportunity id, unique across all 2,629 rows of the first export and stable across
  -- exports, which makes it the natural key and makes a re-import an update rather than a duplicate.
  govwin_id            text primary key,

  -- 'Tracked Opportunities', 'SAM Notices', 'APFS Procurement Notices'.
  --
  -- Worth keeping rather than filtering on import: 1,066 of the first export's rows are SAM notices,
  -- which this system already fetches twice over from api.sam.gov and GovCon API. Knowing which rows
  -- are GovWin's own intelligence and which are a third copy of a notice is what stops the feed being
  -- told the same requirement three times.
  opp_type             text not null,

  -- GovWin's lifecycle stage: Forecast Pre-RFP, Pre-RFP, Source Selection, Post-RFP, Awarded, Protest,
  -- Partial Award, Expired/Archived, Deleted/Canceled, Umbrella Program, Other.
  status               text not null,

  program_name         text,
  acronym              text,
  solicitation_number  text,

  -- The agency hierarchy as GovWin words it, which is names rather than codes. Kept verbatim because
  -- it is what the source said, with the resolved code beside it.
  org_level_1          text,
  org_level_2          text,
  org_level_3          text,
  org_level_4          text,
  -- Resolved from the labels the corpus has already observed. Null when the name resolves to nothing:
  -- a wrong agency code puts a requirement in the wrong person's feed, which is worse than a blank.
  agency_code          text,

  primary_requirement  text,
  place_of_perf_state  text,
  place_of_perf_country text,
  place_of_perf_location text,

  -- In dollars.
  --
  -- The export's column is headed 'Value (USD-$K)' and is genuinely in thousands: the first export
  -- ranges from 96 to 172,400,000, which is $96k to $172.4bn — the latter being the OASIS+ umbrella,
  -- a figure that only makes sense at that scale. Read as dollars it would be $96 to $172m, and every
  -- number in the system would be wrong by a factor of a thousand without anything failing. The loader
  -- multiplies on the way in so that nothing downstream has to remember.
  value_usd            numeric(20, 2),

  -- Each date with the precision the source actually claimed, and where the claim came from.
  solicitation_date            date,
  solicitation_date_precision  text check (solicitation_date_precision in ('day', 'month')),
  solicitation_date_basis      text check (solicitation_date_basis in
                                 ('actual', 'deltek_estimate', 'government_estimate')),

  projected_award_date           date,
  projected_award_date_precision text check (projected_award_date_precision in ('day', 'month')),

  -- Day precision or nothing. 26 rows of the first export read 'MULTIPLE' here, which is not a date
  -- and is stored as absent rather than resolved to one of them.
  response_date        date,

  -- The earliest expiry among the contracts on the record, and how many there were. The export packs
  -- one comma-separated date per contract number, and a multiple-award vehicle carries dozens of
  -- identical ones; the earliest is the one that matters for a recompete and the count is what says
  -- whether the single date is the whole story.
  earliest_expiration_date date,
  expiration_date_count    integer,

  duration             text,
  competition_type     text,
  contract_type        text,
  type_of_award        text,
  contract_numbers     text,

  -- The incumbents as named, unparsed. A multiple-award vehicle lists dozens, and splitting a list of
  -- company names on commas is unsafe when the names themselves contain commas ('CACI INTERNATIONAL
  -- INC, COLSA CORPORATION' versus 'SMITH, JONES AND CO'). Resolution to entities is a later step with
  -- the review queue behind it, not a split in a loader.
  incumbent_names      text,

  -- How many GovWin subscribers are tracking this. A competitive-intensity signal nothing else here
  -- has: a Pre-RFP requirement with 108 watchers is a different proposition from one with 6.
  advertised_interest  integer,

  govwin_created_date  date,
  -- Where to read the analysis this table deliberately does not hold.
  govwin_url           text,

  source_version_id    bigint references source_version (source_version_id),
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now()
);

create index govwin_opportunity_status_idx on govwin_opportunity (status);
create index govwin_opportunity_type_idx   on govwin_opportunity (opp_type);
create index govwin_opportunity_sol_idx    on govwin_opportunity (solicitation_number)
  where solicitation_number is not null;
create index govwin_opportunity_agency_idx on govwin_opportunity (agency_code)
  where agency_code is not null;
create index govwin_opportunity_solicit_idx on govwin_opportunity (solicitation_date)
  where solicitation_date is not null;

comment on table govwin_opportunity is
  'GovWin tracked opportunities from a weekly export. Licensed Deltek data: structured fields only, prose linked rather than stored. See D32.';
comment on column govwin_opportunity.value_usd is
  'Dollars. The export column is in thousands and the loader multiplies; do not multiply again.';
comment on column govwin_opportunity.solicitation_date_precision is
  'month means the source named a month, not a day. Never render a month-precision date as a day.';

-- ---------------------------------------------------------------------------
-- govwin_opportunity_naics
-- ---------------------------------------------------------------------------
-- NAICS is multi-valued, so it goes in its own table for the same reason
-- contract_action_classification exists: spec 7.2 forbids a code list in a text column.
--
-- The export packs 'code - label' pairs comma-separated, up to 36 on one row, and the label itself
-- contains commas. The code is parsed on a six-digit anchor and the label is not split out, because a
-- label recovered by splitting on commas would be wrong on most rows and this system already has
-- `code_label` for labels observed properly.
create table govwin_opportunity_naics (
  govwin_id  text not null references govwin_opportunity (govwin_id) on delete cascade,
  naics_code text not null,
  -- The first code on the row, which GovWin lists as the primary.
  is_primary boolean not null default false,
  primary key (govwin_id, naics_code)
);

create index govwin_opportunity_naics_code_idx on govwin_opportunity_naics (naics_code);

-- ---------------------------------------------------------------------------
-- govwin_opportunity_contract
-- ---------------------------------------------------------------------------
-- The contracts a GovWin record names, which is how it joins to this system's own history.
--
-- This is the useful join and it took a wrong turn to find. The obvious one is the solicitation
-- number, but a forecast projection has none by construction: it projects an event that has not
-- happened, so there is nothing published to carry a number. What both sides do have is the
-- *predecessor* contract — the one ending, which is why there is a recompete to forecast and why
-- GovWin lists an incumbent contract at all.
--
-- The export packs them newline-separated with a type prefix, `[C]W15P7T17D0132`. Median one per row;
-- a large multiple-award vehicle carried 1,924 in the first export, which is why this is a table and
-- why the loader caps what it stores and records the true count.
create table govwin_opportunity_contract (
  govwin_id text not null references govwin_opportunity (govwin_id) on delete cascade,
  piid      text not null,
  primary key (govwin_id, piid)
);

create index govwin_opportunity_contract_piid_idx on govwin_opportunity_contract (piid);

comment on table govwin_opportunity_contract is
  'Contracts named on a GovWin record. Joins GovWin to forecast_item through the predecessor contract, which is the only identifier a pre-solicitation projection can share with anything.';

-- ---------------------------------------------------------------------------
-- govwin_live
-- ---------------------------------------------------------------------------
-- The rows that describe work still ahead.
--
-- A view rather than a loader filter, because the export is the record and throwing away half of it on
-- import would mean a status change from Pre-RFP to Awarded looked like a deletion. Of the first
-- export, 944 rows are Expired/Archived, 427 Awarded and 63 Deleted/Canceled — 55 percent describing
-- work that is finished or abandoned, which is history rather than pipeline.
create view govwin_live as
select *
  from govwin_opportunity
 where status not in ('Expired/Archived', 'Awarded', 'Deleted/Canceled', 'Partial Award', 'Protest');

comment on view govwin_live is
  'GovWin rows describing work still ahead. The rest is history, not pipeline.';

-- ---------------------------------------------------------------------------
-- govwin_pursuit_link
-- ---------------------------------------------------------------------------
-- Where a GovWin record and a requirement in this system are about the same procurement.
--
-- The join is the solicitation number, which is the only identifier the two share: GovWin's export
-- carries no SAM notice id even on the rows it labels SAM Notices. In the first export 144
-- solicitation numbers appear on both a tracked opportunity and a SAM notice row, so the collision is
-- real rather than theoretical.
--
-- A view rather than a merge, deliberately. The two records disagree on purpose — for HQ085925RE001,
-- GovWin's tracked opportunity says Awarded while its own SAM notice row says Source Selection, and
-- api.sam.gov will say something else again — because they are maintained on different cadences by
-- different people. Merging them would mean choosing a winner on every field and losing the
-- disagreement, and the disagreement is information: it is often the earliest sign that something has
-- moved.
create view govwin_pursuit_link as
select g.govwin_id,
       g.status                  as govwin_status,
       g.opp_type,
       p.pursuit_id,
       p.signal_class,
       p.generated_by            as pursuit_source,
       g.solicitation_number,
       g.solicitation_date       as govwin_solicitation_date,
       g.solicitation_date_basis,
       p.response_date           as pursuit_response_date
  from govwin_opportunity g
  join pursuit p on p.solicitation_number = g.solicitation_number
 where g.solicitation_number is not null;

comment on view govwin_pursuit_link is
  'GovWin records and requirements sharing a solicitation number. A view, not a merge: they disagree by design and the disagreement is the signal.';

-- ---------------------------------------------------------------------------
-- govwin_forecast_check
-- ---------------------------------------------------------------------------
-- The first external check this system's forecast has ever had.
--
-- `forecast_item` projects when a requirement will solicit, from a contract end date minus a lead time
-- that is learned per office where there is evidence and assumed at 365 days where there is not. GovWin
-- publishes an independent estimate of the same event, at month precision, on the same procurements.
--
-- Comparing them is worth more than either alone. Where they agree, the projection has outside support
-- for the first time. Where they disagree by a quarter or more, one of them is wrong and which one is
-- worth knowing — most of all where the projection rested on the 365-day default, since that is the
-- weakest input the forecast has and the one an outside estimate is most likely to beat.
--
-- Joined on the predecessor contract rather than the solicitation number, because a projection has no
-- solicitation number: it describes something unpublished. Both sides do know which contract is ending.
--
-- The rows this view does *not* return are a finding in their own right. A GovWin Forecast Pre-RFP with
-- no matching projection is a requirement this system cannot see, usually because the predecessor
-- contract is not in the corpus. A projection with no GovWin record is one Deltek is not tracking.
-- `govwin_forecast_gap` below counts both directions.
create view govwin_forecast_check as
select g.govwin_id,
       g.program_name,
       g.status                        as govwin_status,
       g.agency_code,
       c.piid                          as joined_on_piid,
       g.solicitation_date             as govwin_expects,
       g.solicitation_date_precision,
       g.solicitation_date_basis,
       f.forecast_id,
       f.projected_solicitation_date   as we_expect,
       f.lead_source,
       f.confidence,
       (f.projected_solicitation_date - g.solicitation_date) as days_we_are_later,
       -- A month-precision estimate cannot be checked to the day, so agreement is measured at the
       -- coarser of the two precisions. The quarter is the honest unit for a date named as a month, and
       -- it is also the unit the forecast screen presents.
       (date_trunc('quarter', f.projected_solicitation_date)
          = date_trunc('quarter', g.solicitation_date))      as same_quarter
  from govwin_opportunity g
  join govwin_opportunity_contract c on c.govwin_id = g.govwin_id
  join forecast_item f
    on f.related_piid = c.piid
    or f.idv_piid = c.piid
 where g.solicitation_date is not null;

comment on view govwin_forecast_check is
  'This system''s projected solicitation date against GovWin''s, joined on the predecessor contract. Agreement measured by quarter, because an estimate named to the month cannot be checked to the day.';

-- ---------------------------------------------------------------------------
-- govwin_forecast_gap
-- ---------------------------------------------------------------------------
-- What each source knows that the other does not.
--
-- One number per direction, because that is the readiness question: is the forecast blind to
-- requirements GovWin is tracking, and is GovWin missing recompetes the corpus can see coming? Both are
-- expected to be non-zero and both should fall as the corpus deepens.
create view govwin_forecast_gap as
select
  (select count(*) from govwin_live g
    where g.status in ('Forecast Pre-RFP', 'Pre-RFP')
      and not exists (select 1 from govwin_forecast_check k where k.govwin_id = g.govwin_id))
                                                                as govwin_early_without_projection,
  (select count(*) from govwin_live g
    where g.status in ('Forecast Pre-RFP', 'Pre-RFP'))          as govwin_early_total,
  (select count(*) from forecast_item f
    where not exists (select 1 from govwin_forecast_check k where k.forecast_id = f.forecast_id))
                                                                as projections_without_govwin,
  (select count(*) from forecast_item)                          as projections_total,
  (select count(*) from govwin_forecast_check where same_quarter) as agree_on_quarter,
  (select count(*) from govwin_forecast_check)                   as compared;

comment on view govwin_forecast_gap is
  'How much each of the two forecasts sees that the other does not, and how often they agree on the quarter.';
