-- 0015_collapsed_transaction_view.sql
--
-- Surfaces a source defect found on the first real corpus load.
--
-- The Astrion FPDS export carries a 'Transaction #' column and leaves it blank on
-- every one of the 49,013 rows supplied. FPDS-NG uses that column to distinguish
-- several transactions recorded against one modification, and spec 7.2 makes it the
-- fourth component of contract_action's natural key. With it blank, the key
-- degenerates to (awarding_agency_code, piid, modification_number) and the upsert
-- in the loader overwrites one transaction with the next.
--
-- Measured on the supplied corpus:
--
--   rows read                                       49,013
--   distinct payloads retained in source_version    22,624
--   rows in contract_action                         17,712
--   modifications carrying more than one payload     2,035
--   payloads the upsert overwrote                     4,912
--   Action Obligation across all payloads      $10,080,776,364
--   Action Obligation in contract_action         $8,207,835,808
--   difference                                   $1,872,940,555
--
-- Nothing is actually lost. source_version is keyed on
-- (source_system, source_record_id, payload_hash), so every distinct payload is
-- archived. The collapse happens only in the contract_action projection, and these
-- views reconstruct exactly what it dropped, so the discrepancy can be quantified
-- at any time without re-reading a CSV.
--
-- Fixing the projection is a decision, not a defect fix, because each option
-- changes what a row in contract_action means:
--
--   A. Have the export populate 'Transaction #'. Restores spec 7.2 as written.
--      The column already exists in the export, so this is an export configuration
--      change, not new data.
--   B. Synthesise a deterministic transaction number from payload content. Already
--      implemented in the loader, off by default, behind
--      LoadFpdsOptions.syntheticTransactionNumber. Keeps every transaction and the
--      full obligation. Cost: if FPDS later corrects a substantive field on a
--      transaction, the corrected row arrives as an additional action rather than an
--      update to the existing one.
--   C. Treat the extra payloads as funding lines of one action and sum the
--      obligation. Keeps the money, discards the per-transaction funding office and
--      place of performance detail.
--
-- Until that is settled the loader's default behaviour stays as spec 7.2 describes
-- it, and these views make the cost of that default explicit rather than silent.

-- ---------------------------------------------------------------------------
-- One row per natural key that carries more than one distinct payload.
-- ---------------------------------------------------------------------------
create view fpds_collapsed_transaction as
with versions as (
  select
    source_record_id,
    payload_hash,
    payload,
    row_number() over (
      partition by source_record_id
      order by observed_at desc, source_version_id desc
    ) as recency
  from source_version
  where source_system = 'fpds'
),
grouped as (
  select
    source_record_id,
    count(*)                                                as payload_count,
    sum(coalesce((payload ->> 'action_obligation')::numeric, 0)) as obligation_all_payloads,
    max(case when recency = 1
             then coalesce((payload ->> 'action_obligation')::numeric, 0) end) as obligation_most_recent
  from versions
  group by source_record_id
)
select
  split_part(source_record_id, '|', 1) as awarding_agency_code,
  split_part(source_record_id, '|', 2) as piid,
  split_part(source_record_id, '|', 3) as modification_number,
  split_part(source_record_id, '|', 4) as transaction_number,
  payload_count,
  payload_count - 1                    as payloads_overwritten,
  obligation_all_payloads,
  obligation_most_recent,
  obligation_all_payloads - obligation_most_recent as obligation_not_in_contract_action
from grouped
where payload_count > 1;

comment on view fpds_collapsed_transaction is
  'Natural keys where the blank Transaction # column let several FPDS transactions '
  'share one key, so contract_action holds only the most recent. Source rows are all '
  'still in source_version. See migration 0015.';

-- ---------------------------------------------------------------------------
-- The same thing as one row, for a status check or an acceptance assertion.
-- ---------------------------------------------------------------------------
create view fpds_collapse_summary as
select
  (select count(*) from source_version where source_system = 'fpds')      as distinct_payloads,
  (select count(*) from contract_action)                                  as contract_actions,
  (select count(*) from fpds_collapsed_transaction)                       as keys_affected,
  (select coalesce(sum(payloads_overwritten), 0)
     from fpds_collapsed_transaction)                                     as payloads_overwritten,
  (select coalesce(sum(obligation_all_payloads), 0)
     from fpds_collapsed_transaction)                                     as obligation_all_payloads,
  (select coalesce(sum(obligation_not_in_contract_action), 0)
     from fpds_collapsed_transaction)                                     as obligation_not_in_contract_action;

comment on view fpds_collapse_summary is
  'One row quantifying how much the blank Transaction # column costs the '
  'contract_action projection. Zero rows affected means the export was fixed or the '
  'loader ran with syntheticTransactionNumber enabled.';
