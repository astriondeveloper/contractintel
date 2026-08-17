/**
 * What the scoring engine needs in front of it before it can judge anything, and the
 * shapes a rule returns.
 *
 * The model itself is rows: `score_model_factor` carries the weights and
 * `score_model_gate` the gates, both pinned by version on every assessment. Nothing here
 * hardcodes a weight, which is decision D2 and the correction of defect 1 in the Codex
 * baseline. Changing a weight means inserting a new model version, and a past score stays
 * exactly as it was computed. Acceptance test 6.
 */
import type { PoolClient } from 'pg';

/**
 * Coverage below this gives no rank. Spec 10.3 step 6, and stated on
 * `assessment.coverage` in migration 0007 so the database says it too.
 */
export const MIN_COVERAGE = 0.6;

/** The three states a factor can be in. They are never interchangeable. Spec 10.5. */
export type FactorState = 'scored' | 'unknown' | 'not_applicable';

export type GateState = 'pass' | 'fail' | 'review' | 'not_evaluated';

/**
 * A source row behind a number.
 *
 * `source_uri` is what acceptance test 7 requires: every score opens a rule trace with a
 * source link. For a SAM.gov notice that is the notice itself. For anything derived from
 * the corpus there is no public URL, so it is a link into this interface at the screen that
 * shows the rows the number came from -- which is the thing a reader actually wants to
 * open, and is a real link rather than a restatement of the claim.
 */
export interface Evidence {
  readonly sourceSystem: string;
  readonly sourceRecordId?: string | null;
  readonly sourceUri?: string | null;
  readonly displayedValue?: string | null;
  /** Evidence that argues against the score. Shown, never hidden. Spec 14.2. */
  readonly isContrary?: boolean;
}

export interface FactorOutcome {
  readonly state: FactorState;
  /** 0 to 100. Present only when state is 'scored'; the database enforces it too. */
  readonly score?: number;
  readonly ruleId: string;
  readonly summary: string;
  /** How much the evidence behind this factor can be relied on. 0 to 100. */
  readonly confidence?: number;
  readonly evidence: readonly Evidence[];
}

export interface GateOutcome {
  readonly state: GateState;
  readonly ruleId: string;
  readonly reason: string;
  readonly evidence: readonly Evidence[];
}

/** The pursuit being assessed, with everything a rule might read already on it. */
export interface PursuitRow {
  readonly pursuit_id: string;
  readonly signal_class: string;
  readonly title: string;
  readonly agency_code: string | null;
  readonly office_code: string | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly set_aside_code: string | null;
  readonly notice_type: string | null;
  readonly notice_url: string | null;
  readonly solicitation_number: string | null;
  readonly related_piid: string | null;
  readonly required_vehicle: string | null;
  readonly estimated_value: string | null;
  readonly response_date: Date | null;
  readonly period_end_date: Date | null;
  readonly posted_date: Date | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_confidence: string | null;
  readonly astrion_position: string | null;
}

export interface ModelFactor {
  readonly factor_code: string;
  readonly factor_name: string;
  readonly weight: number;
  readonly is_mandatory: boolean;
  readonly display_order: number;
}

export interface ModelGate {
  readonly gate_code: string;
  readonly gate_name: string;
  readonly description: string | null;
  readonly display_order: number;
}

export interface Threshold {
  readonly signal_class: string;
  readonly min_strategic_fit: number;
}

/**
 * Everything the rules read that is the same for every pursuit in a run, loaded once.
 *
 * Loading it per pursuit would be the same answer computed thousands of times, and would
 * also let the model drift mid-run, which would make the assessments in one run
 * incomparable.
 */
export interface ScoringContext {
  readonly scoreModelVersion: number;
  readonly taxonomyVersion: number;
  readonly factors: readonly ModelFactor[];
  readonly gates: readonly ModelGate[];
  readonly thresholds: ReadonlyMap<string, number>;

  /** NAICS and PSC codes on the profile, and the capability node behind each. */
  readonly capabilityCodes: ReadonlyMap<string, { label: string | null; nodeIds: string[]; origins: string[] }>;
  /** Agency codes on the profile. */
  readonly agencyCodes: ReadonlyMap<string, { label: string | null; origins: string[] }>;
  /** Set-aside codes the corpus shows Astrion being awarded under. */
  readonly setAsides: ReadonlySet<string>;
  /** Whether the taxonomy carries any node typed as a technology. */
  readonly hasTechnologyNodes: boolean;
  /** Growth priority per capability node, where BD Ops has filled it in. */
  readonly growthPriority: ReadonlyMap<string, string>;
  /** True once any Astrion contract action is loaded, so past performance is knowable. */
  readonly corpusLoaded: boolean;
}

function key(codeType: string, codeValue: string): string {
  return `${codeType}:${codeValue}`;
}

export async function loadContext(client: PoolClient): Promise<ScoringContext> {
  const model = await client.query<{ score_model_version: number }>(
    'select score_model_version from score_model where is_current order by score_model_version desc limit 1',
  );
  if (model.rows.length === 0) {
    throw new Error(
      'No current score model. Migration 0009 seeds version 1 from spec section 10.2; if ' +
        'is_current was cleared, set it on the version that should be used.',
    );
  }
  const scoreModelVersion = model.rows[0]!.score_model_version;

  const taxonomy = await client.query<{ version: number }>(
    'select version from taxonomy_version where is_current order by version desc limit 1',
  );
  if (taxonomy.rows.length === 0) {
    throw new Error('No current taxonomy version. Run npm run seed.');
  }

  // Sequential, not Promise.all. These share one PoolClient, and pg queues concurrent
  // queries on a single client and warns that it will stop doing so. The engine runs
  // inside one transaction on one client, so the connection is the thing being shared and
  // the queries have to take turns on it.
  const factors = await client.query<ModelFactor>(
        `select factor_code, factor_name, weight::float8 as weight, is_mandatory, display_order
       from score_model_factor where score_model_version = $1 order by display_order`,
    [scoreModelVersion],
  );
  const gates = await client.query<ModelGate>(
        `select gate_code, gate_name, description, display_order
       from score_model_gate where score_model_version = $1 order by display_order`,
    [scoreModelVersion],
  );
  const thresholds = await client.query<Threshold>(
    'select signal_class, min_strategic_fit::float8 as min_strategic_fit from signal_class_threshold',
  );
  const capability = await client.query<{ code_type: string; code_value: string; label: string | null; node_ids: string[]; origins: string[] }>(
        `select p.code_type, p.code_value, max(p.label) as label,
                array_remove(array_agg(distinct p.node_id::text), null) as node_ids,
                array_agg(distinct p.origin order by p.origin)          as origins
           from opportunity_profile p
          where p.active and p.code_type in ('naics', 'psc')
      group by p.code_type, p.code_value`,
  );
  const agency = await client.query<{ code_value: string; label: string | null; origins: string[] }>(
        `select code_value, max(label) as label, array_agg(distinct origin order by origin) as origins
       from opportunity_profile where active and code_type = 'agency' group by code_value`,
  );
  const setAside = await client.query<{ code_value: string }>(
    `select code_value from opportunity_profile where active and code_type = 'set_aside'`,
  );
  const technology = await client.query<{ n: string }>(
        `select count(*)::text as n from taxonomy_node
      where active and node_type is not null and node_type ilike '%tech%'`,
  );
  const growth = await client.query<{ node_id: string; growth_priority: string }>(
        `select node_id::text, growth_priority from taxonomy_node
      where active and coalesce(trim(growth_priority), '') <> ''`,
  );
  const corpus = await client.query<{ n: string }>(
        `select count(*)::text as n from contract_action ca
           join entity e on e.entity_id = ca.entity_id
          where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')`,
  );

  return {
    scoreModelVersion,
    taxonomyVersion: taxonomy.rows[0]!.version,
    factors: factors.rows,
    gates: gates.rows,
    thresholds: new Map(thresholds.rows.map((t) => [t.signal_class, t.min_strategic_fit])),
    capabilityCodes: new Map(
      capability.rows.map((r) => [key(r.code_type, r.code_value), { label: r.label, nodeIds: r.node_ids, origins: r.origins }]),
    ),
    agencyCodes: new Map(agency.rows.map((r) => [r.code_value, { label: r.label, origins: r.origins }])),
    setAsides: new Set(setAside.rows.map((r) => r.code_value)),
    hasTechnologyNodes: Number(technology.rows[0]?.n ?? 0) > 0,
    growthPriority: new Map(growth.rows.map((r) => [r.node_id, r.growth_priority])),
    corpusLoaded: Number(corpus.rows[0]?.n ?? 0) > 0,
  };
}

/** Look up a profile code without the caller building the composite key. */
export function capability(
  context: ScoringContext,
  codeType: 'naics' | 'psc',
  codeValue: string | null,
): { label: string | null; nodeIds: string[]; origins: string[] } | undefined {
  if (codeValue === null || codeValue === '') return undefined;
  return context.capabilityCodes.get(key(codeType, codeValue));
}
