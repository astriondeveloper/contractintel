/**
 * Loader for astrion_entity_map_seed.csv. 50 rows, 12 legacy entities.
 *
 * Spec section 8.1: the Astrion family is a closed set. Do not use probabilistic
 * matching on it. Load the authored map. A BD Ops user confirms each row.
 *
 * Every alias lands with confirmed_at null, because the seed file ships with
 * confirmed_by_bd_ops = NO on all 50 rows. Spec section 20.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, optionalInteger, optionalNumber, splitMulti, isConfirmedFlag } from '../lib/normalize.js';

const SOURCE_SYSTEM = 'seed_entity_map';
const FILE_NAME = 'astrion_entity_map_seed.csv';

/** The family root. Every legacy entity hangs off this one. */
const FAMILY_ROOT_NAME = 'Astrion';

interface SeedRow {
  alias_name_as_in_fpds: string;
  legacy_entity: string;
  ultimate_parent: string;
  uei_observed: string;
  cage_observed: string;
  transaction_count: string;
  first_fy: string;
  last_fy: string;
  obligations_usd: string;
  confirmed_by_bd_ops: string;
}

async function upsertEntity(
  client: PoolClient,
  canonicalName: string,
  entityType: 'astrion_family' | 'watchlist' | 'other',
  ultimateParentId: number | null,
): Promise<number> {
  // cie_normalize_name(canonical_name) carries the unique index, so the conflict
  // target is the expression, not the column.
  const { rows } = await client.query<{ entity_id: string }>(
    `insert into entity (canonical_name, entity_type, ultimate_parent_id)
     values ($1, $2, $3)
     on conflict (cie_normalize_name(canonical_name)) do update
       set entity_type = excluded.entity_type,
           ultimate_parent_id = coalesce(excluded.ultimate_parent_id, entity.ultimate_parent_id)
     returning entity_id`,
    [canonicalName, entityType, ultimateParentId],
  );
  return Number(rows[0]!.entity_id);
}

export async function loadEntityMap(client: PoolClient, seedDir: string): Promise<RunHandle> {
  const filePath = path.join(seedDir, FILE_NAME);
  const csv = await readFile(filePath, 'utf8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as SeedRow[];

  const run = await startRun(client, SOURCE_SYSTEM, FILE_NAME);

  // The family root first, so legacy entities have a parent to point at.
  const familyRootId = await upsertEntity(client, FAMILY_ROOT_NAME, 'astrion_family', null);

  const legacyEntityIds = new Map<string, number>();

  for (const row of rows) {
    const aliasName = optional(row.alias_name_as_in_fpds);
    const legacyName = optional(row.legacy_entity);
    if (!aliasName || !legacyName) {
      throw new Error(`${FILE_NAME}: a row is missing alias_name_as_in_fpds or legacy_entity`);
    }

    const version = await recordVersion(client, run, aliasName, {
      alias_name: aliasName,
      legacy_entity: legacyName,
      ultimate_parent: optional(row.ultimate_parent),
      uei_observed: optional(row.uei_observed),
      cage_observed: optional(row.cage_observed),
      transaction_count: optionalInteger(row.transaction_count),
      first_fy: optionalInteger(row.first_fy),
      last_fy: optionalInteger(row.last_fy),
      obligations_usd: optionalNumber(row.obligations_usd),
      confirmed_by_bd_ops: optional(row.confirmed_by_bd_ops),
    });

    // A legacy entity is a predecessor company of Astrion. Spec section 3.
    let legacyEntityId = legacyEntityIds.get(legacyName);
    if (legacyEntityId === undefined) {
      legacyEntityId = await upsertEntity(client, legacyName, 'astrion_family', familyRootId);
      legacyEntityIds.set(legacyName, legacyEntityId);

      if (legacyEntityId !== familyRootId) {
        await client.query(
          `insert into entity_relationship
             (parent_entity_id, child_entity_id, relationship_type)
           values ($1, $2, 'predecessor')
           on conflict (parent_entity_id, child_entity_id, relationship_type) do nothing`,
          [familyRootId, legacyEntityId],
        );
      }
    }

    if (!version.changed) continue;

    // The alias row. alias_name_normalized and alias_name_core are generated
    // columns, so the loader cannot forget to normalise.
    const confirmed = isConfirmedFlag(row.confirmed_by_bd_ops);
    await client.query(
      `insert into entity_alias
         (entity_id, alias_name, source_system, first_seen_fy, last_seen_fy,
          transaction_count, obligations_usd, confirmed_by, confirmed_at)
       values ($1, $2, 'fpds', $3, $4, $5, $6, $7, $8)
       on conflict (source_system, alias_name) do update
         set entity_id = excluded.entity_id,
             first_seen_fy = excluded.first_seen_fy,
             last_seen_fy = excluded.last_seen_fy,
             transaction_count = excluded.transaction_count,
             obligations_usd = excluded.obligations_usd`,
      [
        legacyEntityId,
        aliasName,
        optionalInteger(row.first_fy),
        optionalInteger(row.last_fy),
        optionalInteger(row.transaction_count),
        optionalNumber(row.obligations_usd),
        confirmed ? 'seed_file' : null,
        confirmed ? new Date() : null,
      ],
    );

    // Identifiers. A cell may hold several values separated by a semicolon.
    // These are deliberately not unique across entities: four UEI values and four
    // CAGE values in this file each belong to two legacy entities, because the
    // registrations carried forward through the rollup. See 0003_identity.sql.
    for (const uei of splitMulti(row.uei_observed)) {
      await client.query(
        `insert into entity_identifier (entity_id, identifier_type, identifier_value, source_system)
         values ($1, 'uei', $2, 'fpds')
         on conflict (entity_id, identifier_type, identifier_value) do nothing`,
        [legacyEntityId, uei],
      );
    }
    for (const cage of splitMulti(row.cage_observed)) {
      await client.query(
        `insert into entity_identifier (entity_id, identifier_type, identifier_value, source_system)
         values ($1, 'cage', $2, 'fpds')
         on conflict (entity_id, identifier_type, identifier_value) do nothing`,
        [legacyEntityId, cage],
      );
    }
  }

  await finishRun(client, run);
  console.log(summarize(run, 'entity map'));
  return run;
}
