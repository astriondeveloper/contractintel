-- 0019_signal_generation.sql
--
-- What a contract is, so that a recompete signal can be about one.
--
-- Spec section 9.1 asks for a signal when a contract is inside the recompete window.
-- contract_action holds transactions, not contracts, so something has to say which
-- transactions are the same award. The obvious answer is wrong in a way that is worth
-- writing down, because it is the trap docs/BACKLOG.md item 3 names.
--
-- Grouping by (awarding_agency_code, piid) merges unrelated contracts. On the supplied
-- corpus, agency 9700 PIID '0001' modification '0' carries 58 distinct payloads, and
-- '0002' and '0003' are similar. Those are not 58 modifications of one contract. A task
-- order PIID is assigned by the ordering office and is only unique inside the vehicle it
-- was ordered against, so '0001' is the first task order under this IDV, and also the
-- first under every other IDV. Merging them would take the latest end date from an
-- unrelated award and raise a recompete signal on the wrong contract.
--
-- So the group key is (awarding_agency_code, coalesce(idv_piid, ''), piid), which is the
-- FPDS identity of an award rather than a convenient prefix of it.
--
-- There is a sharper edge here than grouping, found while writing tests/recompete.test.ts.
-- contract_action's own primary key is spec 7.2's natural key, (awarding_agency_code,
-- piid, modification_number, transaction_number), and the vehicle is not in it. Two task
-- orders numbered '0001' under two different IDVs therefore collide on the primary key
-- itself, not merely in a group by. The only column that keeps them apart is the
-- transaction number, which the export leaves blank on every row.
--
-- That makes decision D3 load bearing for this feature rather than merely tidy. The
-- content-derived surrogate transaction number, on by default in the FPDS loader, is what
-- gives those task orders separate rows at all. Loaded with --spec-transaction-key
-- instead, one task order overwrites the other and this view reports a single contract
-- with whichever end date landed last -- a recompete signal on the wrong contract, with
-- nothing on screen to suggest anything is missing.
--
-- When the export starts populating 'Transaction #', real numbers take over and the same
-- property holds for a better reason.
--
-- Where idv_piid is blank the key degenerates to (agency, piid), which is correct for a
-- standalone award and is the residual risk here. contract_group_ambiguous measures
-- exactly that residue: it counts groups carrying more than one awardee or more than one
-- contracting office, which is what a merge of unrelated awards looks like from the
-- outside. It is a diagnostic, in the same spirit as fpds_collapse_summary in 0015: the
-- defect is made visible and countable rather than assumed away.
--
-- The awardee is NOT part of the key, deliberately. A novation moves a contract to
-- another company, and keying on the awardee would split one contract into two and raise
-- two recompete signals for one recompete. The incumbent is instead read from the most
-- recently signed action, and a group with several awardees shows up in the diagnostic.

-- ---------------------------------------------------------------------------
-- contract_group
-- ---------------------------------------------------------------------------
create view contract_group as
select
  ca.awarding_agency_code,
  coalesce(ca.idv_piid, '')                         as idv_piid_key,
  max(ca.idv_piid)                                  as idv_piid,
  ca.piid,

  count(*)::bigint                                  as action_count,
  sum(ca.action_obligation)                         as obligated_usd,
  max(ca.base_and_all_options)                      as base_and_all_options,

  min(ca.signed_date)                               as first_signed,
  max(ca.signed_date)                               as last_signed,
  -- A modification extends the period of performance, so the latest ultimate completion
  -- date across the group is the contract's end. current_completion_date is carried
  -- beside it because the two disagree on an option-bearing award and the difference is
  -- the option period.
  max(ca.ultimate_completion_date)                  as ends_on,
  max(ca.current_completion_date)                   as current_ends_on,

  count(distinct ca.entity_id)                      as distinct_awardees,
  count(distinct ca.contracting_office_code)        as distinct_offices,

  -- The awardee on the most recently signed action. On a novated contract this is the
  -- company that holds it now, which is the one a recompete is against.
  (array_agg(ca.entity_id order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.entity_id is not null))[1]    as incumbent_entity_id,
  (array_agg(ca.vendor_name_raw order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.vendor_name_raw is not null))[1] as incumbent_name_raw,
  (array_agg(ca.entity_match_confidence order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.entity_match_confidence is not null))[1] as incumbent_confidence,
  (array_agg(ca.contracting_agency_code order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.contracting_agency_code is not null))[1] as contracting_agency_code,
  (array_agg(ca.contracting_office_code order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.contracting_office_code is not null))[1] as contracting_office_code,
  (array_agg(ca.set_aside_type order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.set_aside_type is not null))[1] as set_aside_type,
  (array_agg(ca.extent_competed order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.extent_competed is not null))[1] as extent_competed,
  (array_agg(ca.award_type order by ca.signed_date desc nulls last, ca.contract_action_id desc)
     filter (where ca.award_type is not null))[1]   as award_type
from contract_action ca
group by ca.awarding_agency_code, coalesce(ca.idv_piid, ''), ca.piid;

comment on view contract_group is
  'One row per award. Key is (awarding_agency_code, idv_piid, piid): a task order PIID is '
  'only unique inside its vehicle. See contract_group_ambiguous for the residual risk.';

-- ---------------------------------------------------------------------------
-- contract_group_ambiguous
-- ---------------------------------------------------------------------------
-- The measurement behind the claim above. A group holding more than one awardee or more
-- than one contracting office is either a novation, or two unrelated awards that share a
-- short PIID and carry no IDV to separate them. Both are worth seeing; the second is the
-- one that would produce a wrong signal.
create view contract_group_ambiguous as
select
  awarding_agency_code,
  idv_piid_key,
  piid,
  action_count,
  distinct_awardees,
  distinct_offices,
  ends_on,
  obligated_usd,
  case
    when idv_piid_key <> '' then 'has_idv'
    when distinct_awardees > 1 and distinct_offices > 1 then 'likely_unrelated_awards'
    when distinct_awardees > 1 then 'novation_or_unrelated'
    else 'multi_office'
  end as ambiguity
from contract_group
where distinct_awardees > 1 or distinct_offices > 1;

comment on view contract_group_ambiguous is
  'Groups whose identity is not certain. likely_unrelated_awards is the short-PIID '
  'collision docs/BACKLOG.md item 3 names: no IDV to separate them, and both the awardee '
  'and the office differ.';

-- ---------------------------------------------------------------------------
-- Generated signals
-- ---------------------------------------------------------------------------
-- Detection is a batch job that re-runs on a rhythm (signal_class_threshold.rhythm), so
-- it needs to be idempotent in the same way the loaders are. pursuit already has a unique
-- index on notice_id, which covers a signal that came from a solicitation notice and
-- nothing else. signal_key is the equivalent for a signal the system derived: a
-- deterministic string built from what the signal is about, so a second detection run
-- updates the row it wrote last time instead of writing a second one.
alter table pursuit add column signal_key text;
alter table pursuit add column generated_by text;
alter table pursuit add column generated_at timestamptz;

create unique index pursuit_signal_key_idx on pursuit (signal_key) where signal_key is not null;

comment on column pursuit.signal_key is
  'Deterministic identity of a generated signal, so detection is idempotent. Null on a '
  'pursuit a person created by hand, which is why the unique index is partial.';
comment on column pursuit.generated_by is
  'The detector that wrote this row. Null means a person did. A detector must never '
  'overwrite a hand-created pursuit, and the null is what stops it.';

-- When the contract this signal is about actually ends.
--
-- pursuit carries response_date, which is the date a solicitation closes, and
-- expected_solicitation_fy, which is a derived guess. Neither is the thing a recompete is
-- timed against. Reading it back from contract_group at query time would mean joining on
-- related_piid alone, and the whole point of this migration is that a PIID on its own does
-- not identify a contract.
alter table pursuit add column period_end_date date;

create index pursuit_period_end_idx on pursuit (period_end_date) where period_end_date is not null;

comment on column pursuit.period_end_date is
  'End of the period of performance of the contract behind this signal. The date a '
  'recompete is timed against; response_date is for a solicitation that is already out.';

-- Astrion's position on the contract this signal is about.
--
-- Stored rather than derived. It is the first thing BD filters on, and it is a property
-- of the signal at the moment it was detected rather than of the corpus as it stands
-- later; a re-run recomputes it. pursuit_entity_role still carries the per-pursuit roles
-- that decision D5 describes, and this column does not replace them.
alter table pursuit add column astrion_position text
  check (astrion_position in ('prime_incumbent', 'subcontractor', 'none'));

comment on column pursuit.astrion_position is
  'prime_incumbent: the award resolves into the Astrion family. subcontractor: Astrion '
  'holds a subcontract on it. none: neither, so this is a competitor recompete. Three '
  'different plays, and docs/BACKLOG.md item 3 says the distinction is worth carrying.';

create index pursuit_astrion_position_idx on pursuit (astrion_position, signal_class);
create index pursuit_generated_idx on pursuit (generated_by) where generated_by is not null;
