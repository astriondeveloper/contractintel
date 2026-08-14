/**
 * Recompete detection. Spec section 9.1.
 *
 * A contract that ends inside the recompete window is a thing business development
 * should be looking at, and the corpus already knows when contracts end. This turns that
 * into `pursuit` rows of class `recompete_window`.
 *
 * Four things are worth stating before the code, because each one is a decision rather
 * than an implementation detail.
 *
 * **The window comes from the database.** `signal_class_threshold` carries
 * `horizon_months_from` and `horizon_months_to` per class, seeded from spec section 9 at
 * 12 and 36 months. BD Ops owns that row (spec section 13). Hardcoding 12 and 36 here
 * would make a threshold change a code change, which is the mistake decision D2 was
 * written about.
 *
 * **A contract is a `contract_group`, not a PIID.** Migration 0019 explains why at
 * length: a task order PIID is only unique inside its vehicle, so grouping by PIID alone
 * merges unrelated awards and takes an end date from the wrong one.
 *
 * **Astrion's position is carried, not filtered on.** A recompete of work Astrion holds
 * as prime, one it subs on, and one a competitor holds are three different plays, and
 * only BD can say which of them matters this quarter. All three are detected; the
 * `astrion_position` column and `--position` let the reader choose.
 *
 * **A person's decisions survive a re-run.** Detection is a monthly job, and the second
 * run must not undo the first month's work. The upsert writes only derived fields.
 * `state`, `owner` and `campaign_id` belong to whoever is working the pursuit, and this
 * never touches them. A pursuit with no `signal_key` was created by hand and is never
 * touched at all.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, type RunHandle } from '../lib/provenance.js';

export const SOURCE_SYSTEM = 'signal_recompete';

/**
 * How far before a contract ends the follow-on is expected to solicit, used to derive
 * `expected_solicitation_fy`.
 *
 * An assumption, not a measurement, and recorded as one in docs/DECISIONS.md D13. Twelve
 * months is the figure the recompete window itself implies: spec section 9 opens the
 * window at twelve months out, which only makes sense if that is roughly when the
 * solicitation is expected to appear. Change it here and re-run; every generated row is
 * rewritten from the source data on each run, so nothing needs migrating.
 */
export const SOLICITATION_LEAD_MONTHS = 12;

export type AstrionPosition = 'prime_incumbent' | 'subcontractor' | 'none';

export interface RecompeteOptions {
  /** Ignore contracts whose estimated value is below this. Default: no floor. */
  readonly minValueUsd?: number;
  /** Detect only these positions. Default: all three. */
  readonly positions?: readonly AstrionPosition[];
  /** Work out what would be written, write nothing. */
  readonly dryRun?: boolean;
}

export interface RecompeteResult {
  readonly horizonFrom: number;
  readonly horizonTo: number;
  readonly candidates: number;
  readonly written: number;
  readonly skippedBelowFloor: number;
  readonly skippedByPosition: number;
  readonly byPosition: Record<AstrionPosition, number>;
  readonly run: RunHandle | null;
}

interface Candidate {
  readonly source: 'fpds' | 'dacis';
  readonly signal_key: string;
  readonly title: string;
  readonly agency_code: string | null;
  readonly office_code: string | null;
  readonly related_piid: string | null;
  readonly solicitation_number: string | null;
  readonly estimated_value: string | null;
  readonly ends_on: Date | null;
  readonly expected_solicitation_fy: number | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_confidence: string | null;
  readonly astrion_position: AstrionPosition;
  readonly set_aside_type: string | null;
}

interface Threshold {
  readonly horizon_months_from: number | null;
  readonly horizon_months_to: number | null;
}

async function horizon(client: PoolClient): Promise<{ from: number; to: number }> {
  const { rows } = await client.query<Threshold>(
    `select horizon_months_from, horizon_months_to
       from signal_class_threshold
      where signal_class = 'recompete_window'`,
  );
  const row = rows[0];
  if (!row || row.horizon_months_from === null || row.horizon_months_to === null) {
    throw new Error(
      'signal_class_threshold has no horizon for recompete_window. Migration 0006 seeds it ' +
        'from spec section 9; if it was edited, put the months back.',
    );
  }
  return { from: row.horizon_months_from, to: row.horizon_months_to };
}

/**
 * Candidates from the FPDS corpus.
 *
 * The subcontract test matches an edge's prime PIID against the group's PIID or its
 * vehicle. That is a name match on a source that does not carry the awarding agency, so
 * it can over-match on a short PIID in the same way the grouping can. It is used only to
 * label the position, never to create a signal that would not otherwise exist, so the
 * cost of a false positive is a row filed under the wrong play rather than a phantom
 * opportunity.
 */
async function fpdsCandidates(client: PoolClient, from: number, to: number): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `with family as (
       select e.entity_id
         from entity e
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')
     )
     select
       'fpds'::text as source,
       'recompete:fpds:' || cg.awarding_agency_code || ':' || cg.idv_piid_key || ':' || cg.piid
                                                       as signal_key,
       -- The agency is a column on pursuit, so it is not repeated in the title. The
       -- vehicle is, because a task order PIID means nothing without it.
       'Recompete: ' || cg.piid
         || case when cg.idv_piid_key <> '' then ' under ' || cg.idv_piid_key else '' end
                                                       as title,
       cg.awarding_agency_code                         as agency_code,
       cg.contracting_office_code                      as office_code,
       cg.piid                                         as related_piid,
       null::text                                      as solicitation_number,
       coalesce(cg.base_and_all_options, cg.obligated_usd)::text as estimated_value,
       cg.ends_on,
       cie_fiscal_year((cg.ends_on - ($3 || ' months')::interval)::date) as expected_solicitation_fy,
       cg.incumbent_entity_id::text                    as incumbent_entity_id,
       cg.incumbent_confidence,
       case
         when cg.incumbent_entity_id in (select entity_id from family) then 'prime_incumbent'
         when exists (
           select 1
             from subcontract_edge se
            where se.sub_entity_id in (select entity_id from family)
              and (se.prime_piid = cg.piid
                   or (cg.idv_piid_key <> '' and se.prime_idv_piid = cg.idv_piid_key))
         ) then 'subcontractor'
         else 'none'
       end                                             as astrion_position,
       cg.set_aside_type
     from contract_group cg
     left join code_label_current al
            on al.code_type = 'agency' and al.code_value = cg.awarding_agency_code
    where cg.ends_on is not null
      and cg.ends_on >= (current_date + ($1 || ' months')::interval)::date
      and cg.ends_on <= (current_date + ($2 || ' months')::interval)::date`,
    [String(from), String(to), String(SOLICITATION_LEAD_MONTHS)],
  );
  return rows;
}

/**
 * Candidates from the DACIS contract records.
 *
 * These are a different grain from FPDS: 213 narrative records against tens of thousands
 * of transactions, carrying an end date FPDS does not always have and a role Astrion
 * declared. Backlog item 8 is about reconciling the two sources onto one contract; until
 * that exists they are detected separately and a contract present in both produces two
 * signals. That is visible and dull, where a bad join would be invisible and wrong.
 *
 * `value_is_shared` rows are detected but carry no estimated value, because the figure
 * covers several awardees and reporting it as this contract's value would be a lie of
 * exactly the kind CONTRIBUTING.md warns about.
 */
async function dacisCandidates(client: PoolClient, from: number, to: number): Promise<Candidate[]> {
  const { rows } = await client.query<Candidate>(
    `select
       'dacis'::text as source,
       'recompete:dacis:' || d.dacis_contract_id                as signal_key,
       'Recompete: ' || coalesce(nullif(d.title, ''), d.contract_number, 'DACIS contract ' || d.dacis_contract_id)
                                                                as title,
       null::text                                               as agency_code,
       null::text                                               as office_code,
       d.contract_number                                        as related_piid,
       d.solicitation_number,
       case when d.value_is_shared then null else d.value_usd::text end as estimated_value,
       d.end_date                                               as ends_on,
       cie_fiscal_year((d.end_date - ($3 || ' months')::interval)::date) as expected_solicitation_fy,
       null::text                                               as incumbent_entity_id,
       null::text                                               as incumbent_confidence,
       case r.astrion_role
         when 'prime' then 'prime_incumbent'
         when 'sub'   then 'subcontractor'
         else 'none'
       end                                                      as astrion_position,
       null::text                                               as set_aside_type
     from dacis_contract d
     left join dacis_contract_role r on r.dacis_contract_id = d.dacis_contract_id
    where d.end_date is not null
      and coalesce(d.doge_canceled, false) = false
      and d.end_date >= (current_date + ($1 || ' months')::interval)::date
      and d.end_date <= (current_date + ($2 || ' months')::interval)::date`,
    [String(from), String(to), String(SOLICITATION_LEAD_MONTHS)],
  );
  return rows;
}

/**
 * Write one signal.
 *
 * The `on conflict` list is the whole design. Everything derived is refreshed, and
 * `state`, `owner` and `campaign_id` are absent from it because they are the pursuit's
 * working state rather than the signal's content. `where pursuit.signal_key is not null`
 * is belt and braces: the partial unique index means the conflict can only fire on a
 * generated row, and the predicate says so at the point it matters.
 */
async function upsert(
  client: PoolClient,
  candidate: Candidate,
  sourceVersionId: number,
): Promise<void> {
  await client.query(
    `insert into pursuit (
       signal_class, title, agency_code, office_code, solicitation_number, related_piid,
       estimated_value, expected_solicitation_fy, incumbent_entity_id, incumbent_confidence,
       astrion_position, signal_key, generated_by, generated_at, source_version_id, state
       , period_end_date
     ) values (
       'recompete_window', $1, $2, $3, $4, $5,
       $6::numeric, $7, $8::bigint, $9,
       $10, $11, $12, now(), $13, 'open',
       $14::date
     )
     on conflict (signal_key) where signal_key is not null do update set
       title                    = excluded.title,
       agency_code              = excluded.agency_code,
       office_code              = excluded.office_code,
       solicitation_number      = excluded.solicitation_number,
       related_piid             = excluded.related_piid,
       estimated_value          = excluded.estimated_value,
       expected_solicitation_fy = excluded.expected_solicitation_fy,
       incumbent_entity_id      = excluded.incumbent_entity_id,
       incumbent_confidence     = excluded.incumbent_confidence,
       astrion_position         = excluded.astrion_position,
       period_end_date          = excluded.period_end_date,
       generated_by             = excluded.generated_by,
       generated_at             = excluded.generated_at,
       source_version_id        = excluded.source_version_id
     where pursuit.signal_key is not null`,
    [
      candidate.title,
      candidate.agency_code,
      candidate.office_code,
      candidate.solicitation_number,
      candidate.related_piid,
      candidate.estimated_value,
      candidate.expected_solicitation_fy,
      candidate.incumbent_entity_id,
      candidate.incumbent_confidence,
      candidate.astrion_position,
      candidate.signal_key,
      SOURCE_SYSTEM,
      sourceVersionId,
      candidate.ends_on,
    ],
  );

  // The incumbent as a per-pursuit role. Decision D5: partner and competitor are roles on
  // a pursuit, never labels on a company, so this is written per signal rather than
  // inferred from the entity.
  if (candidate.incumbent_entity_id !== null) {
    await client.query(
      `insert into pursuit_entity_role (pursuit_id, entity_id, role, rationale)
       select p.pursuit_id, $2::bigint, 'incumbent',
              'Awardee on the most recently signed action of this contract.'
         from pursuit p
        where p.signal_key = $1
       on conflict (pursuit_id, entity_id, role) do nothing`,
      [candidate.signal_key, candidate.incumbent_entity_id],
    );
  }
}

export async function detectRecompetes(
  client: PoolClient,
  options: RecompeteOptions = {},
): Promise<RecompeteResult> {
  const { from, to } = await horizon(client);
  const wanted = new Set<AstrionPosition>(
    options.positions ?? ['prime_incumbent', 'subcontractor', 'none'],
  );
  const floor = options.minValueUsd ?? null;

  const candidates = [
    ...(await fpdsCandidates(client, from, to)),
    ...(await dacisCandidates(client, from, to)),
  ];

  const byPosition: Record<AstrionPosition, number> = {
    prime_incumbent: 0,
    subcontractor: 0,
    none: 0,
  };
  let written = 0;
  let skippedBelowFloor = 0;
  let skippedByPosition = 0;

  if (options.dryRun === true) {
    for (const candidate of candidates) {
      if (!wanted.has(candidate.astrion_position)) {
        skippedByPosition += 1;
        continue;
      }
      // A contract with no value is never dropped by a value floor. Blank is not zero,
      // and a floor is a statement about known small contracts rather than unknown ones.
      if (floor !== null && candidate.estimated_value !== null && Number(candidate.estimated_value) < floor) {
        skippedBelowFloor += 1;
        continue;
      }
      byPosition[candidate.astrion_position] += 1;
      written += 1;
    }
    return {
      horizonFrom: from,
      horizonTo: to,
      candidates: candidates.length,
      written,
      skippedBelowFloor,
      skippedByPosition,
      byPosition,
      run: null,
    };
  }

  const run = await startRun(client, SOURCE_SYSTEM, `${from}-${to} months`);

  try {
    for (const candidate of candidates) {
      if (!wanted.has(candidate.astrion_position)) {
        skippedByPosition += 1;
        continue;
      }
      if (floor !== null && candidate.estimated_value !== null && Number(candidate.estimated_value) < floor) {
        skippedBelowFloor += 1;
        continue;
      }

      // The payload is what the signal asserts. A second run over an unchanged corpus
      // hashes to the same value and reports unchanged, which is the property acceptance
      // test 2 is about and the reason detection can be put on a monthly timer.
      const version = await recordVersion(client, run, candidate.signal_key, {
        title: candidate.title,
        agency_code: candidate.agency_code,
        office_code: candidate.office_code,
        related_piid: candidate.related_piid,
        solicitation_number: candidate.solicitation_number,
        estimated_value: candidate.estimated_value,
        ends_on: candidate.ends_on === null ? null : String(candidate.ends_on),
        expected_solicitation_fy: candidate.expected_solicitation_fy,
        incumbent_entity_id: candidate.incumbent_entity_id,
        astrion_position: candidate.astrion_position,
        set_aside_type: candidate.set_aside_type,
      });

      await upsert(client, candidate, version.sourceVersionId);

      byPosition[candidate.astrion_position] += 1;
      written += 1;
    }

    await finishRun(client, run);
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  return {
    horizonFrom: from,
    horizonTo: to,
    candidates: candidates.length,
    written,
    skippedBelowFloor,
    skippedByPosition,
    byPosition,
    run,
  };
}
