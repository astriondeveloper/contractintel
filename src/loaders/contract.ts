/**
 * One contract action, one row, whether it arrived as a CSV cell or as JSON.
 *
 * There are two ways award history reaches this system. `fpds.ts` reads a bulk FPDS extract, which is
 * the right shape for millions of transactions and is where the corpus's depth comes from.
 * `govcon/contracts.ts` asks GovCon API for transactions, which is how a contract awarded last week
 * arrives without waiting for the next extract, and how a company the extract never covered gets
 * filled in at all.
 *
 * They overlap, and the same rule applies as for notices (decision D25): **the natural key is the
 * identity, not the loader.** `(awarding_agency_code, piid, modification_number, transaction_number)`
 * is the key in both — spec 7.2's composite, which acceptance test 2 depends on — so a transaction
 * that arrives from both converges on one `contract_action` row. Whichever loader sees it second
 * updates rather than inserts.
 *
 * That is not only about duplicate rows. Everything downstream reads `contract_action`:
 * `cie_award_shape_asof` computes the end date, `office_recompete_cadence` learns the rhythm,
 * `contract_followon_chain` infers succession, campaign sizing sums obligations. Two rows for one
 * transaction would double an obligation and put a phantom award in a lineage, and nothing would
 * error. So neither loader has an `insert into contract_action` of its own, and
 * `npm run check:convergence` fails the build if one grows one.
 *
 * Three things this module owns because getting them wrong is silent:
 *
 * **Entity resolution.** A transaction whose vendor did not resolve is a transaction that cannot say
 * whether Astrion is the incumbent, which is the field the feed filters on. Both loaders go through
 * the same `EntityResolver` and both enqueue an unresolved vendor for review, so an API-sourced row
 * is exactly as resolvable as a CSV-sourced one rather than quietly less so.
 *
 * **Classifications.** NAICS and PSC live in `contract_action_classification`, never in a text column
 * on the action — spec 7.2 forbids it, and it was a real defect once.
 *
 * **Labels.** A code is stored and its label is displayed, so a loader that writes codes without
 * observing labels produces screens full of bare numbers. `LabelTally` collects them in memory and
 * flushes once, so `observation_count` is a true count of records rather than a per-run flag.
 */
import type { PoolClient } from 'pg';
import { recordVersion, type RunHandle } from '../lib/provenance.js';
import { enqueueVendorForReview, type EntityResolver, type Resolution } from '../resolve/entity-resolver.js';

/** The label types a contract action can teach the system about. */
export type LabelType = 'naics' | 'psc' | 'agency' | 'office';

/**
 * A contract action reduced to what this system stores, with the source's naming gone.
 *
 * Every field but the four key parts is nullable on purpose. Blank is not zero throughout this
 * codebase: an absent obligation is not a zero-dollar action, and an absent end date is not a
 * contract ending today.
 */
export interface NormalizedTransaction {
  readonly awardingAgencyCode: string;
  readonly piid: string;
  readonly modificationNumber: string;
  readonly transactionNumber: string;

  readonly idvPiid: string | null;
  readonly idvAgencyCode: string | null;
  readonly awardType: string | null;

  readonly signedDate: string | null;
  readonly effectiveDate: string | null;
  readonly currentCompletionDate: string | null;
  readonly ultimateCompletionDate: string | null;

  readonly actionObligation: number | null;
  readonly baseAndAllOptions: number | null;

  readonly contractingDepartmentCode: string | null;
  readonly contractingAgencyCode: string | null;
  readonly contractingOfficeCode: string | null;
  readonly fundingAgencyCode: string | null;
  readonly fundingOfficeCode: string | null;
  readonly placeOfPerformanceState: string | null;

  readonly extentCompeted: string | null;
  readonly setAsideType: string | null;
  readonly numberOfOffersReceived: number | null;

  readonly vendorNameRaw: string | null;
  readonly vendorUei: string | null;
  readonly vendorCage: string | null;

  readonly naicsCode: string | null;
  readonly pscCode: string | null;

  /**
   * The API's globally-unique award key, when the source supplies one.
   *
   * FPDS extracts do not carry it; GovCon API does. It disambiguates a PIID that two agencies both
   * issued, which is the condition decision D13 works around by grouping on the vehicle as well as
   * the PIID. Stored rather than acted on: `contract_award_key_agreement` measures whether it agrees
   * with that grouping before anything starts trusting it.
   */
  readonly awardKey: string | null;
}

/** The natural key as one string, which is what `source_version` records a transaction under. */
export function sourceRecordIdFor(txn: {
  awardingAgencyCode: string;
  piid: string;
  modificationNumber: string;
  transactionNumber: string;
}): string {
  return [txn.awardingAgencyCode, txn.piid, txn.modificationNumber, txn.transactionNumber].join('|');
}

/**
 * Code labels, tallied in memory and written once.
 *
 * One round trip per distinct label rather than per row, and `cie_observe_code_label` is the only way
 * a label may be written — it handles the two-descriptions-for-one-code case that migration 0012
 * exists for. Writing `code_label` directly leaves the row invisible in `code_label_current`, which
 * is a mistake that looks like working code.
 */
export class LabelTally {
  private readonly entries = new Map<
    string,
    { codeType: LabelType; codeValue: string; label: string; count: number }
  >();

  observe(codeType: LabelType, codeValue: string | null, label: string | null): void {
    if (!codeValue || !label) return;
    const key = `${codeType}\0${codeValue}\0${label}`;
    const existing = this.entries.get(key);
    if (existing) existing.count += 1;
    else this.entries.set(key, { codeType, codeValue, label, count: 1 });
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns how many distinct labels were written. */
  async flush(client: PoolClient, sourceSystem: string): Promise<number> {
    let written = 0;
    for (const entry of this.entries.values()) {
      await client.query('select cie_observe_code_label($1, $2, $3, $4, $5)', [
        entry.codeType,
        entry.codeValue,
        entry.label,
        sourceSystem,
        entry.count,
      ]);
      written += 1;
    }
    return written;
  }
}

export interface WriteTransactionResult {
  /**
   * False when this exact payload was already archived under this key.
   *
   * The caller can stop there: the row is already correct and re-writing it would cost a round trip
   * to change nothing. This is what makes a re-run of an unchanged 48,645-row extract do no write
   * work at all, which acceptance test 2 asserts.
   */
  readonly changed: boolean;
  /** The hash the payload stored under, so a caller can tell two payloads apart under one key. */
  readonly payloadHash: string;
  readonly contractActionId: number | null;
  readonly resolution: Resolution | null;
  readonly classificationsWritten: number;
}

/**
 * Write one contract action, its classifications, and enqueue its vendor if unresolved.
 *
 * `raw` is archived exactly as the source produced it — CSV cells or API JSON — so a mapping bug
 * found later can be re-derived from what was stored rather than re-fetched. The payload is also what
 * the hash is taken over, which is why the two loaders can have different payload shapes without
 * interfering: a transaction that arrives from both simply archives two versions of the same row.
 */
export async function writeContractAction(
  client: PoolClient,
  run: RunHandle,
  txn: NormalizedTransaction,
  raw: Record<string, unknown>,
  resolver: EntityResolver,
): Promise<WriteTransactionResult> {
  const version = await recordVersion(client, run, sourceRecordIdFor(txn), raw);

  if (!version.changed) {
    return {
      changed: false,
      payloadHash: version.payloadHash,
      contractActionId: null,
      resolution: null,
      classificationsWritten: 0,
    };
  }

  const resolution = resolver.resolve({
    vendorName: txn.vendorNameRaw,
    uei: txn.vendorUei,
    cage: txn.vendorCage,
  });

  if (resolution.entityId === null) {
    await enqueueVendorForReview(
      client,
      run.sourceSystem,
      { vendorName: txn.vendorNameRaw, uei: txn.vendorUei, cage: txn.vendorCage },
      resolution,
    );
  }

  const { rows } = await client.query<{ contract_action_id: string }>(
    `insert into contract_action (
       awarding_agency_code, piid, modification_number, transaction_number,
       idv_piid, idv_agency_code, award_type,
       signed_date, effective_date, current_completion_date, ultimate_completion_date,
       action_obligation, base_and_all_options,
       contracting_department_code, contracting_agency_code, contracting_office_code,
       funding_agency_code, funding_office_code, place_of_performance_state,
       extent_competed, set_aside_type, number_of_offers_received,
       vendor_name_raw, entity_id, entity_match_method, entity_match_confidence,
       source_version_id, contract_award_key
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
     )
     on conflict (awarding_agency_code, piid, modification_number, transaction_number) do update set
       idv_piid = excluded.idv_piid,
       idv_agency_code = excluded.idv_agency_code,
       award_type = excluded.award_type,
       signed_date = excluded.signed_date,
       effective_date = excluded.effective_date,
       current_completion_date = excluded.current_completion_date,
       ultimate_completion_date = excluded.ultimate_completion_date,
       action_obligation = excluded.action_obligation,
       base_and_all_options = excluded.base_and_all_options,
       contracting_department_code = excluded.contracting_department_code,
       contracting_agency_code = excluded.contracting_agency_code,
       contracting_office_code = excluded.contracting_office_code,
       funding_agency_code = excluded.funding_agency_code,
       funding_office_code = excluded.funding_office_code,
       place_of_performance_state = excluded.place_of_performance_state,
       extent_competed = excluded.extent_competed,
       set_aside_type = excluded.set_aside_type,
       number_of_offers_received = excluded.number_of_offers_received,
       vendor_name_raw = excluded.vendor_name_raw,
       entity_id = excluded.entity_id,
       entity_match_method = excluded.entity_match_method,
       entity_match_confidence = excluded.entity_match_confidence,
       source_version_id = excluded.source_version_id,
       -- Never overwrite a key with a blank. A bulk extract carries no award key, and a later
       -- extract row must not erase what the API already established for that transaction.
       contract_award_key = coalesce(excluded.contract_award_key, contract_action.contract_award_key)
     returning contract_action_id`,
    [
      txn.awardingAgencyCode, txn.piid, txn.modificationNumber, txn.transactionNumber,
      txn.idvPiid, txn.idvAgencyCode, txn.awardType,
      txn.signedDate, txn.effectiveDate, txn.currentCompletionDate, txn.ultimateCompletionDate,
      txn.actionObligation, txn.baseAndAllOptions,
      txn.contractingDepartmentCode, txn.contractingAgencyCode, txn.contractingOfficeCode,
      txn.fundingAgencyCode, txn.fundingOfficeCode, txn.placeOfPerformanceState,
      txn.extentCompeted, txn.setAsideType, txn.numberOfOffersReceived,
      txn.vendorNameRaw, resolution.entityId, resolution.method, resolution.confidence,
      version.sourceVersionId, txn.awardKey,
    ],
  );

  const contractActionId = Number(rows[0]!.contract_action_id);

  // NAICS and PSC go to their own table. Spec 7.2 forbids a text column on contract_action for
  // these, which was a real defect once.
  let classificationsWritten = 0;
  for (const [codeType, codeValue] of [
    ['naics', txn.naicsCode],
    ['psc', txn.pscCode],
  ] as Array<['naics' | 'psc', string | null]>) {
    if (!codeValue) continue;
    const { rowCount } = await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1, $2, $3, true)
       on conflict (contract_action_id, code_type, code_value) do nothing`,
      [contractActionId, codeType, codeValue],
    );
    classificationsWritten += rowCount ?? 0;
  }

  return {
    changed: true,
    payloadHash: version.payloadHash,
    contractActionId,
    resolution,
    classificationsWritten,
  };
}
