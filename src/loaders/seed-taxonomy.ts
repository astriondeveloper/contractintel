/**
 * Loader for capability_taxonomy_seed.csv. 14 draft capability nodes.
 *
 * Spec section 20: the growth priority column is empty and Gavin fills it. It
 * loads as null. Three nodes carry no obligations figure. Those load as null too.
 * Null is unknown. Null is not zero. Spec 10.5.
 *
 * customer_offices_freetext loads as crosswalk_type = 'office_freetext'. Those
 * strings are not office codes. BD Ops resolves them through the admin screen,
 * which writes crosswalk_type = 'office'. Market sizing counts only 'office'.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, optionalNumber, splitMulti, isConfirmedFlag } from '../lib/normalize.js';

const SOURCE_SYSTEM = 'seed_taxonomy';
const FILE_NAME = 'capability_taxonomy_seed.csv';

interface SeedRow {
  node_id: string;
  node_name: string;
  node_type: string;
  psc_crosswalk: string;
  agency_crosswalk: string;
  naics_crosswalk: string;
  customer_offices_freetext: string;
  fy19plus_obligations_musd: string;
  growth_priority_TBD: string;
  confirmed_by_bd_ops: string;
}

/** The freetext office cell is a comma-separated list of informal names. */
function splitOfficeFreetext(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function loadTaxonomy(client: PoolClient, seedDir: string): Promise<RunHandle> {
  const filePath = path.join(seedDir, FILE_NAME);
  const csv = await readFile(filePath, 'utf8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, bom: true }) as SeedRow[];

  const run = await startRun(client, SOURCE_SYSTEM, FILE_NAME);

  const { rows: versionRows } = await client.query<{ version: number }>(
    'select version from taxonomy_version where is_current',
  );
  if (versionRows.length !== 1) {
    throw new Error('Exactly one taxonomy_version must be current. Check migration 0009.');
  }
  const version = versionRows[0]!.version;

  for (const row of rows) {
    const nodeKey = optional(row.node_id);
    const nodeName = optional(row.node_name);
    if (!nodeKey || !nodeName) {
      throw new Error(`${FILE_NAME}: a row is missing node_id or node_name`);
    }

    const nodeType = (optional(row.node_type) ?? 'capability') as
      | 'capability'
      | 'growth_priority'
      | 'solution_offering';

    const version_ = await recordVersion(client, run, `${nodeKey}@v${version}`, {
      node_key: nodeKey,
      node_name: nodeName,
      node_type: nodeType,
      psc_crosswalk: optional(row.psc_crosswalk),
      agency_crosswalk: optional(row.agency_crosswalk),
      naics_crosswalk: optional(row.naics_crosswalk),
      customer_offices_freetext: optional(row.customer_offices_freetext),
      // Empty for CAP-12, CAP-13, CAP-14. Loads as null, not as zero.
      fy19plus_obligations_musd: optionalNumber(row.fy19plus_obligations_musd),
      // A single space in every row of the seed file. Loads as null. Gavin fills it.
      growth_priority: optional(row.growth_priority_TBD),
      confirmed_by_bd_ops: optional(row.confirmed_by_bd_ops),
    });

    if (!version_.changed) continue;

    const confirmed = isConfirmedFlag(row.confirmed_by_bd_ops);
    const { rows: nodeRows } = await client.query<{ node_id: string }>(
      `insert into taxonomy_node
         (node_key, node_name, node_type, version, active,
          fy19plus_obligations_musd, growth_priority, confirmed_by, confirmed_at)
       values ($1, $2, $3, $4, true, $5, $6, $7, $8)
       on conflict (node_key, version) do update
         set node_name = excluded.node_name,
             node_type = excluded.node_type,
             fy19plus_obligations_musd = excluded.fy19plus_obligations_musd,
             growth_priority = coalesce(excluded.growth_priority, taxonomy_node.growth_priority)
       returning node_id`,
      [
        nodeKey,
        nodeName,
        nodeType,
        version,
        optionalNumber(row.fy19plus_obligations_musd),
        optional(row.growth_priority_TBD),
        confirmed ? 'seed_file' : null,
        confirmed ? new Date() : null,
      ],
    );
    const nodeId = Number(nodeRows[0]!.node_id);

    const crosswalks: Array<[string, string]> = [
      ...splitMulti(row.psc_crosswalk).map((v) => ['psc', v] as [string, string]),
      ...splitMulti(row.naics_crosswalk).map((v) => ['naics', v] as [string, string]),
      ...splitMulti(row.agency_crosswalk).map((v) => ['agency', v] as [string, string]),
      ...splitOfficeFreetext(optional(row.customer_offices_freetext)).map(
        (v) => ['office_freetext', v] as [string, string],
      ),
    ];

    for (const [crosswalkType, crosswalkValue] of crosswalks) {
      await client.query(
        `insert into node_crosswalk (node_id, crosswalk_type, crosswalk_value)
         values ($1, $2, $3)
         on conflict (node_id, crosswalk_type, crosswalk_value) do nothing`,
        [nodeId, crosswalkType, crosswalkValue],
      );
    }
  }

  await finishRun(client, run);
  console.log(summarize(run, 'capability taxonomy'));
  return run;
}
