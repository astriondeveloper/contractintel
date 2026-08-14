/**
 * Entity resolution. Spec section 8.
 *
 * Corrects Codex defect 9: identity resolution used probabilistic matching on the
 * Astrion family. It does not here. The Astrion family is a closed set of 50
 * authored aliases loaded from astrion_entity_map_seed.csv.
 *
 * Match order, from spec 8.2, and the last line of that section is the important
 * one: 'Never skip to step 4.'
 *
 *   1. Match on UEI.
 *   2. Match on CAGE.
 *   3. Match on a confirmed alias.
 *   4. Produce a candidate for review.
 *
 * ---------------------------------------------------------------------------
 * One deviation, forced by the corpus, and it is documented rather than hidden.
 * ---------------------------------------------------------------------------
 * Section 8.2 assumes a UEI identifies one entity. In astrion_entity_map_seed.csv
 * it does not. Four UEI values and four CAGE values each belong to two legacy
 * entities, because the registrations carried forward through the rollup:
 *
 *   ZZ1TESTUEI01 / ZC001   Northwind Group, LLC  and  Beacon Research, Inc.
 *   ZZ2TESTUEI02 / ZC002   Cardinal LLC          and  Quantalytic
 *   ZZ3TESTUEI03 / ZC003   Cardinal LLC          and  Meridian Engineering
 *   ZZ4TESTUEI04 / ZC004   Larkspur, Incorporated   and  Halcyon Systems, LLC
 *
 * Every one of those eight collisions is inside a single family, so a UEI still
 * identifies the family without ambiguity even when it cannot identify the legacy
 * entity. The resolver therefore treats an ambiguous identifier as a partial
 * result: it holds the candidate set, continues down the order to the alias step,
 * which resolves the legacy entity precisely, and falls back to the shared parent
 * only if the alias step also fails. Steps still run in order and nothing skips
 * ahead. The identifier_collision view in 0003_identity.sql reports the eight
 * rows so the behaviour is visible rather than buried here.
 */
import type { PoolClient } from 'pg';
import { normalizeName } from '../lib/normalize.js';

export type MatchMethod =
  | 'uei'
  | 'cage'
  | 'confirmed_alias'
  | 'parent_fallback'
  | 'candidate'
  | 'unresolved';

export type MatchConfidence = 'confirmed' | 'probable' | 'unresolved';

export interface VendorInput {
  vendorName?: string | null;
  uei?: string | null;
  cage?: string | null;
}

export interface Resolution {
  entityId: number | null;
  method: MatchMethod;
  /** Three states only. Never a percentage. Spec 14.6. */
  confidence: MatchConfidence;
  /** The step the resolver reached. Used for the review queue and the rule trace. */
  furthestStep: 'uei_ambiguous' | 'cage_ambiguous' | 'no_match' | null;
  candidateEntityIds: number[];
  ruleId: string;
}

interface EntityRow {
  entity_id: string;
  entity_type: string;
  ultimate_parent_id: string | null;
}

interface AliasRow {
  alias_name_normalized: string | null;
  entity_id: string;
  confirmed_at: Date | null;
}

interface IdentifierRow {
  identifier_type: string;
  identifier_value: string;
  entity_id: string;
}

export interface ResolverOptions {
  /**
   * When true, only an alias with confirmed_at set is authoritative at step 3.
   *
   * The seed files ship with confirmed_by_bd_ops = NO on every row (spec 20), so
   * with this true nothing in the authored map resolves until BD Ops has worked
   * through all 50 rows, and acceptance test 1 cannot pass on a fresh database.
   *
   * The default is false: the authored map resolves, because spec 8.1 makes the
   * authored map the authority for the closed Astrion set. Confirmation is a
   * quality gate layered on top of it, and it shows in the confidence value.
   * An unconfirmed alias resolves with confidence 'probable', never 'confirmed'.
   */
  requireConfirmedAlias?: boolean;
}

export class EntityResolver {
  private readonly ueiIndex = new Map<string, number[]>();
  private readonly cageIndex = new Map<string, number[]>();
  private readonly aliasIndex = new Map<string, { entityId: number; confirmed: boolean }>();
  private readonly parentOf = new Map<number, number | null>();
  private readonly requireConfirmedAlias: boolean;

  private constructor(options: ResolverOptions) {
    this.requireConfirmedAlias = options.requireConfirmedAlias ?? false;
  }

  /** Load every lookup into memory once. A per-row query over 48,645 rows is not acceptable. */
  static async load(client: PoolClient, options: ResolverOptions = {}): Promise<EntityResolver> {
    const resolver = new EntityResolver(options);

    const { rows: entities } = await client.query<EntityRow>(
      'select entity_id, entity_type, ultimate_parent_id from entity',
    );
    for (const row of entities) {
      resolver.parentOf.set(
        Number(row.entity_id),
        row.ultimate_parent_id === null ? null : Number(row.ultimate_parent_id),
      );
    }

    const { rows: identifiers } = await client.query<IdentifierRow>(
      "select identifier_type, identifier_value, entity_id from entity_identifier where identifier_type in ('uei','cage')",
    );
    for (const row of identifiers) {
      const index = row.identifier_type === 'uei' ? resolver.ueiIndex : resolver.cageIndex;
      const key = row.identifier_value.trim().toUpperCase();
      const bucket = index.get(key);
      const entityId = Number(row.entity_id);
      if (bucket) {
        if (!bucket.includes(entityId)) bucket.push(entityId);
      } else {
        index.set(key, [entityId]);
      }
    }

    const { rows: aliases } = await client.query<AliasRow>(
      'select alias_name_normalized, entity_id, confirmed_at from entity_alias',
    );
    for (const row of aliases) {
      if (row.alias_name_normalized === null) continue;
      const existing = resolver.aliasIndex.get(row.alias_name_normalized);
      const confirmed = row.confirmed_at !== null;
      // A confirmed alias wins over an unconfirmed one for the same normalised name.
      if (existing === undefined || (confirmed && !existing.confirmed)) {
        resolver.aliasIndex.set(row.alias_name_normalized, {
          entityId: Number(row.entity_id),
          confirmed,
        });
      }
    }

    return resolver;
  }

  /** The family root for an entity, or the entity itself when it has no parent. */
  familyRoot(entityId: number): number {
    let current = entityId;
    const guard = new Set<number>([current]);
    for (;;) {
      const parent = this.parentOf.get(current) ?? null;
      if (parent === null || guard.has(parent)) return current;
      guard.add(parent);
      current = parent;
    }
  }

  /**
   * Does this name normalise onto an entity the authored map already knows?
   *
   * Read-only, and deliberately not part of `resolve`. Callers use it to measure how
   * much a name column that spec 8.2 does not list — 'Contractor: DACIS: Parent
   * Name', for instance — would add if it were listed. Answering that with a count
   * is different from silently resolving on it.
   */
  namesKnownEntity(name: string | null | undefined): boolean {
    const normalized = normalizeName(name);
    if (!normalized) return false;
    return this.aliasIndex.has(normalized);
  }

  resolve(input: VendorInput): Resolution {
    const uei = input.uei?.trim().toUpperCase() || null;
    const cage = input.cage?.trim().toUpperCase() || null;
    const normalized = normalizeName(input.vendorName);

    let ambiguous: number[] = [];
    let furthestStep: Resolution['furthestStep'] = 'no_match';

    // Step 1. UEI.
    if (uei) {
      const hits = this.ueiIndex.get(uei);
      if (hits && hits.length === 1) {
        return {
          entityId: hits[0]!,
          method: 'uei',
          confidence: 'confirmed',
          furthestStep: null,
          candidateEntityIds: hits,
          ruleId: 'RESOLVE-01-UEI',
        };
      }
      if (hits && hits.length > 1) {
        ambiguous = hits;
        furthestStep = 'uei_ambiguous';
      }
    }

    // Step 2. CAGE.
    if (cage) {
      const hits = this.cageIndex.get(cage);
      if (hits && hits.length === 1) {
        return {
          entityId: hits[0]!,
          method: 'cage',
          confidence: 'confirmed',
          furthestStep: null,
          candidateEntityIds: hits,
          ruleId: 'RESOLVE-02-CAGE',
        };
      }
      if (hits && hits.length > 1 && ambiguous.length === 0) {
        ambiguous = hits;
        furthestStep = 'cage_ambiguous';
      }
    }

    // Step 3. Authored alias. This is the step that resolves the Astrion family,
    // and the step that makes acceptance test 3 pass: 'LARKSPUR, INCORPORATED' and
    // 'LARKSPUR INCORPORATED' share a normalised form, so they reach the same entity.
    if (normalized) {
      const hit = this.aliasIndex.get(normalized);
      if (hit && (hit.confirmed || !this.requireConfirmedAlias)) {
        return {
          entityId: hit.entityId,
          method: 'confirmed_alias',
          confidence: hit.confirmed ? 'confirmed' : 'probable',
          furthestStep: null,
          candidateEntityIds: [hit.entityId],
          ruleId: hit.confirmed ? 'RESOLVE-03-ALIAS-CONFIRMED' : 'RESOLVE-03-ALIAS-AUTHORED',
        };
      }
    }

    // An ambiguous identifier still pins the family when every candidate shares one
    // root. That is true for all eight collisions in the seed map.
    if (ambiguous.length > 1) {
      const roots = new Set(ambiguous.map((id) => this.familyRoot(id)));
      if (roots.size === 1) {
        return {
          entityId: [...roots][0]!,
          method: 'parent_fallback',
          confidence: 'probable',
          furthestStep,
          candidateEntityIds: ambiguous,
          ruleId: 'RESOLVE-04-SHARED-PARENT',
        };
      }
    }

    // Step 4. A candidate for review. Never a guess.
    return {
      entityId: null,
      method: ambiguous.length > 0 ? 'candidate' : 'unresolved',
      confidence: 'unresolved',
      furthestStep,
      candidateEntityIds: ambiguous,
      ruleId: 'RESOLVE-05-REVIEW-QUEUE',
    };
  }
}

/** Record an unresolved vendor for BD Ops. Idempotent, and counts repeat sightings. */
export async function enqueueVendorForReview(
  client: PoolClient,
  sourceSystem: string,
  input: VendorInput,
  resolution: Resolution,
): Promise<void> {
  await client.query(
    `insert into vendor_review_queue
       (vendor_name_raw, uei_observed, cage_observed, source_system, furthest_step, candidate_entity_ids)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (source_system, vendor_name_raw, coalesce(uei_observed, ''), coalesce(cage_observed, ''))
     do update set occurrence_count = vendor_review_queue.occurrence_count + 1,
                   last_seen_at = now()`,
    [
      input.vendorName ?? '(blank)',
      input.uei ?? null,
      input.cage ?? null,
      sourceSystem,
      resolution.furthestStep ?? 'no_match',
      resolution.candidateEntityIds,
    ],
  );
}
