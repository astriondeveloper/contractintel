/**
 * Loader for competitor_watchlist_seed.csv. 47 rows.
 *
 * Spec section 8.1: probabilistic matching is permitted for watchlist companies
 * only, a probabilistic match produces a candidate, and a candidate needs human
 * confirmation. A merge from name similarity alone is not permitted.
 *
 * So this loader creates one entity per observed spelling and then writes a row
 * to entity_merge_candidate wherever two spellings share a suffix-stripped core
 * name. It never merges. The seed file holds at least two such pairs:
 *
 *   KESTREL TECHNOLOGIES INC              and  KESTREL TECHNOLOGIES, INC.
 *   APPLEWOOD RESEARCH SOLUTIONS, INC     and  APPLEWOOD RESEARCH SOLUTIONS, INC.
 *
 * Each pair carries different direction counts, which is itself evidence that the
 * two spellings are one company recorded twice. A human confirms that.
 *
 * Spec section 20: 14 of these companies appear in both directions. Those 14 are
 * the competimates. Spec decision D5 keeps partner and competitor as per-pursuit
 * roles, so this loader records the observed direction and nothing more.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, optionalInteger, isConfirmedFlag } from '../lib/normalize.js';

const SOURCE_SYSTEM = 'seed_watchlist';
const FILE_NAME = 'competitor_watchlist_seed.csv';

interface SeedRow {
  company_name: string;
  times_astrion_subbed_to_them: string;
  times_they_subbed_to_astrion: string;
  observed_relationship: string;
  watchlist_tier: string;
  alias_map_built: string;
  confirmed_by_bd_ops: string;
}

export async function loadWatchlist(client: PoolClient, seedDir: string): Promise<RunHandle> {
  const filePath = path.join(seedDir, FILE_NAME);
  const csv = await readFile(filePath, 'utf8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as SeedRow[];

  const run = await startRun(client, SOURCE_SYSTEM, FILE_NAME);

  for (const row of rows) {
    const companyName = optional(row.company_name);
    if (!companyName) throw new Error(`${FILE_NAME}: a row is missing company_name`);

    const version = await recordVersion(client, run, companyName, {
      company_name: companyName,
      times_astrion_subbed_to_them: optionalInteger(row.times_astrion_subbed_to_them),
      times_they_subbed_to_astrion: optionalInteger(row.times_they_subbed_to_astrion),
      observed_relationship: optional(row.observed_relationship),
      watchlist_tier: optional(row.watchlist_tier),
      confirmed_by_bd_ops: optional(row.confirmed_by_bd_ops),
    });

    // Note the absence of an early `continue` on version.changed here. The seed
    // files are small, so these writes always run. Every one of them is an
    // idempotent upsert, so a second run still reports zero changes while the
    // rows are guaranteed present. The large FPDS loader keeps the hash skip,
    // where the saving actually matters.
    void version;

    const { rows: entityRows } = await client.query<{ entity_id: string }>(
      `insert into entity (canonical_name, entity_type)
       values ($1, 'watchlist')
       on conflict (cie_normalize_name(canonical_name)) do update
         set entity_type = case
               -- Never demote an Astrion family entity to watchlist.
               when entity.entity_type = 'astrion_family' then 'astrion_family'
               else 'watchlist'
             end
       returning entity_id`,
      [companyName],
    );
    const entityId = Number(entityRows[0]!.entity_id);

    const confirmed = isConfirmedFlag(row.confirmed_by_bd_ops);
    const { rows: aliasRows } = await client.query<{ alias_id: string }>(
      `insert into entity_alias (entity_id, alias_name, source_system, transaction_count, confirmed_by, confirmed_at)
       values ($1, $2, 'dacis_subcontract', null, $3, $4)
       on conflict (source_system, alias_name) do update
         set entity_id = excluded.entity_id
       returning alias_id`,
      [entityId, companyName, confirmed ? 'seed_file' : null, confirmed ? new Date() : null],
    );
    const aliasId = Number(aliasRows[0]!.alias_id);

    // The direction counts stay attached to the spelling that carried them.
    // watchlist_company rolls them up to the company. See 0010.
    await client.query(
      `insert into watchlist_seed_direction
         (alias_id, times_astrion_subbed_to_them, times_they_subbed_to_astrion,
          observed_relationship_stated, watchlist_tier)
       values ($1, $2, $3, $4, $5)
       on conflict (alias_id) do update
         set times_astrion_subbed_to_them = excluded.times_astrion_subbed_to_them,
             times_they_subbed_to_astrion = excluded.times_they_subbed_to_astrion,
             observed_relationship_stated = excluded.observed_relationship_stated,
             watchlist_tier = excluded.watchlist_tier`,
      [
        aliasId,
        optionalInteger(row.times_astrion_subbed_to_them) ?? 0,
        optionalInteger(row.times_they_subbed_to_astrion) ?? 0,
        optional(row.observed_relationship),
        optional(row.watchlist_tier),
      ],
    );
  }

  // Propose merge candidates. This is the only place the watchlist uses name
  // similarity, and it produces a proposal for a human, never a merge.
  const { rowCount: candidatesCreated } = await client.query(
    `insert into entity_merge_candidate (entity_id_a, entity_id_b, match_basis, match_detail)
     select least(a.entity_id, b.entity_id),
            greatest(a.entity_id, b.entity_id),
            'core_name',
            'Shared suffix-stripped name: ' || cie_core_name(a.canonical_name)
              || '. Spellings: ' || a.canonical_name || ' | ' || b.canonical_name
       from entity a
       join entity b
         on cie_core_name(a.canonical_name) = cie_core_name(b.canonical_name)
        and a.entity_id < b.entity_id
      where a.entity_type = 'watchlist'
        and b.entity_type = 'watchlist'
     on conflict (entity_id_a, entity_id_b, match_basis) do nothing`,
  );

  await finishRun(client, run);
  console.log(summarize(run, 'competitor watchlist'));
  if (candidatesCreated && candidatesCreated > 0) {
    console.log(
      `${''.padEnd(28)} ${String(candidatesCreated).padStart(6)} merge candidates proposed for BD Ops review`,
    );
  }
  return run;
}
