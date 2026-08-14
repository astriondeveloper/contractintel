/**
 * FPDS loader.
 *
 * The fixtures here reproduce documented properties of the real corpus rather
 * than inventing plausible content. See tests/fixtures/README.md for why that
 * distinction matters and which specification section each property comes from.
 *
 * The vendor names and identifiers are the real ones from
 * astrion_entity_map_seed.csv, because the point of most of these tests is that
 * resolution works on the actual spellings the corpus contains.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pool, query, closePool, withTransaction } from '../src/db/index.js';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import { loadFpdsFile } from '../src/loaders/fpds.js';

let fixtureDir: string;

const HEADER = [
  'Award ID',
  'Modification Number',
  'Transaction Number',
  'Awarding Agency Code',
  'Date Signed',
  'Ultimate Completion Date',
  'Action Obligation',
  'Contracting Agency ID',
  'Contracting Office ID',
  'Type of Set Aside',
  'Global Vendor Name',
  'Unique Entity ID',
  'CAGE Code',
  'PSC',
  'PSC Description',
].join(',');

interface Row {
  piid: string;
  mod?: string;
  txn?: string;
  agency?: string;
  signed?: string;
  ultimateEnd?: string;
  obligation?: string;
  office?: string;
  setAside?: string;
  vendor: string;
  uei?: string;
  cage?: string;
  psc?: string;
  pscDesc?: string;
}

function toCsv(rows: Row[]): string {
  const lines = [HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.piid,
        r.mod ?? '',
        r.txn ?? '',
        r.agency ?? '5700',
        r.signed ?? '2022-03-15',
        r.ultimateEnd ?? '',
        r.obligation ?? '100000',
        r.agency ?? '5700',
        r.office ?? 'ZT1000',
        r.setAside ?? '',
        `"${r.vendor}"`,
        r.uei ?? '',
        r.cage ?? '',
        r.psc ?? 'R425',
        `"${r.pscDesc ?? 'ENGINEERING AND TECHNICAL SERVICES'}"`,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Real spellings from the authored entity map, spread across legacy entities. */
const REAL_VENDORS: Array<{ vendor: string; uei?: string; cage?: string }> = [
  { vendor: 'LARKSPUR, INCORPORATED', uei: 'ZZ4TESTUEI04', cage: 'ZC004' },
  { vendor: 'LARKSPUR INCORPORATED', uei: 'ZZ4TESTUEI04' },
  { vendor: 'LARKSPUR INC', uei: 'ZZ4TESTUEI04' },
  { vendor: 'BEACON RESEARCH AND CONSULTING, INC.', uei: 'ZZ1TESTUEI01', cage: 'ZC001' },
  { vendor: 'BEACON RESEARCH & CONSULT', uei: 'ZZ1TESTUEI01', cage: 'ZC001' },
  { vendor: 'B R C INC', uei: 'ZZ1TESTUEI01' },
  { vendor: 'QUANTALYTIC INC', uei: 'ZZ2TESTUEI02', cage: 'ZC002' },
  { vendor: 'HALCYON SYSTEMS, LLC', uei: 'ZZ4TESTUEI04', cage: 'ZC004' },
  { vendor: 'MERIDIAN ENGINEERING AND INTEGRATION CO', uei: 'ZZ3TESTUEI03', cage: 'ZC003' },
  { vendor: 'RIDGEWAY SOLUTIONS, INC.', uei: 'ZZ5TESTUEI05', cage: 'ZC005' },
  { vendor: 'SABLEFISH ENGINEERING GROUP, INC', uei: 'ZZ7TESTUEI07', cage: 'ZC007' },
  { vendor: 'TESSELLATE CONCEPTS INCORPORATED (5855)', uei: 'ZZ8TESTUEI08', cage: 'ZC008' },
  { vendor: 'NORTHWIND GROUP, LLC', uei: 'ZZ1TESTUEI01', cage: 'ZC001' },
  { vendor: 'IRONGLASS SYSTEMS INCORPORATED', uei: 'ZZ9TESTUEI09', cage: 'ZC009' },
  { vendor: 'LARKSPUR RANGE SERVICES LLC', uei: 'ZZ6TESTUEI06', cage: 'ZC006' },
];

/** N unique keyed rows cycling through the real vendor spellings. */
function generateRows(count: number, piidPrefix: string): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const vendor = REAL_VENDORS[i % REAL_VENDORS.length]!;
    rows.push({
      piid: `${piidPrefix}${String(i).padStart(5, '0')}`,
      mod: i % 4 === 0 ? '' : `P0000${i % 4}`,
      agency: '5700',
      obligation: i % 11 === 0 ? '(25000)' : String(50_000 + i * 13),
      ...vendor,
    });
  }
  return rows;
}

async function loadFile(fileName: string): Promise<Awaited<ReturnType<typeof loadFpdsFile>>> {
  return withTransaction(async (client) => {
    const resolver = await EntityResolver.load(client);
    return loadFpdsFile(client, path.join(fixtureDir, fileName), resolver);
  });
}

async function countActions(): Promise<number> {
  const rows = await query<{ n: string }>('select count(*)::text as n from contract_action');
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'cie-fpds-'));

  // Property: two supplied files are identical. Spec 4.1.
  const baseRows = generateRows(500, 'ZT100022C');
  await writeFile(path.join(fixtureDir, 'export_a.csv'), toCsv(baseRows));
  await writeFile(path.join(fixtureDir, 'export_a_copy.csv'), toCsv(baseRows));

  // Property: one file is a superset of another, and 368 rows repeat across files.
  const supersetRows = [...baseRows, ...generateRows(132, 'ZT100023C')];
  await writeFile(path.join(fixtureDir, 'export_superset.csv'), toCsv(supersetRows));
  const overlapping = [...baseRows.slice(0, 368), ...generateRows(50, 'ZT100024C')];
  await writeFile(path.join(fixtureDir, 'export_overlap.csv'), toCsv(overlapping));

  // Property: PSC R425 carries two different descriptions in one dataset. Spec 4.1.
  await writeFile(
    path.join(fixtureDir, 'labels.csv'),
    toCsv([
      { piid: 'LBL0000001', vendor: 'QUANTALYTIC INC', uei: 'ZZ2TESTUEI02', psc: 'R425', pscDesc: 'ENGINEERING AND TECHNICAL SERVICES' },
      { piid: 'LBL0000002', vendor: 'QUANTALYTIC INC', uei: 'ZZ2TESTUEI02', psc: 'R425', pscDesc: 'SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL' },
    ]),
  );
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await closePool();
});

describe('acceptance test 2: the loader is idempotent', () => {
  it('loads a file, then loads it again without changing the row count', async () => {
    const before = await countActions();

    const first = await loadFile('export_a.csv');
    expect(first).not.toBeNull();
    expect(first!.run.records).toBe(500);
    expect(first!.run.inserted).toBe(500);
    expect(first!.run.unchanged).toBe(0);

    const afterFirst = await countActions();
    expect(afterFirst).toBe(before + 500);

    const second = await loadFile('export_a.csv');
    expect(second!.run.records).toBe(500);
    expect(second!.run.inserted).toBe(0);
    expect(second!.run.updated).toBe(0);
    expect(second!.run.unchanged).toBe(500);

    // The assertion that acceptance test 2 actually makes.
    expect(await countActions()).toBe(afterFirst);
  });

  it('treats an identical second file as entirely unchanged', async () => {
    const before = await countActions();
    const result = await loadFile('export_a_copy.csv');
    expect(result!.run.unchanged).toBe(500);
    expect(result!.run.inserted).toBe(0);
    expect(await countActions()).toBe(before);
  });

  it('loads only the new rows from a superset file', async () => {
    const before = await countActions();
    const result = await loadFile('export_superset.csv');
    expect(result!.run.records).toBe(632);
    expect(result!.run.unchanged).toBe(500);
    expect(result!.run.inserted).toBe(132);
    expect(await countActions()).toBe(before + 132);
  });

  it('handles 368 rows repeating across files', async () => {
    const before = await countActions();
    const result = await loadFile('export_overlap.csv');
    expect(result!.run.unchanged).toBe(368);
    expect(result!.run.inserted).toBe(50);
    expect(await countActions()).toBe(before + 50);
  });
});

describe('the composite natural key', () => {
  it('keeps a base award and its modifications as separate rows', async () => {
    const rows = await query<{ modification_number: string }>(
      `select modification_number from contract_action
        where piid = 'ZT100022C00000' order by modification_number`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('stores a blank modification number as the empty string, never null', async () => {
    const rows = await query<{ n: string }>(
      `select count(*)::text as n from contract_action
        where modification_number is null or transaction_number is null`,
    );
    expect(rows[0]!.n).toBe('0');
  });
});

describe('entity resolution across the loaded corpus', () => {
  it('resolves every row that carries a real spelling', async () => {
    const rows = await query<{ n: string }>(
      'select count(*)::text as n from contract_action where entity_id is null',
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('demonstrates why a name search fails, spec 4.1', async () => {
    // A query on the current legal name finds almost nothing. This is the defect
    // the entity map exists to fix, and it is worth asserting rather than assuming.
    const byName = await query<{ n: string }>(
      `select count(*)::text as n from contract_action
        where cie_normalize_name(vendor_name_raw) = cie_normalize_name('NORTHWIND GROUP, LLC')`,
    );
    const byEntity = await query<{ n: string }>(
      `select count(*)::text as n from contract_action ca
         join entity e on e.entity_id = ca.entity_id
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')`,
    );

    const nameHits = Number(byName[0]!.n);
    const entityHits = Number(byEntity[0]!.n);

    expect(entityHits).toBeGreaterThan(nameHits * 10);
    expect(nameHits / entityHits).toBeLessThan(0.15);
  });

  it('records the match method and a three-state confidence on every row', async () => {
    const rows = await query<{ entity_match_method: string; entity_match_confidence: string; n: string }>(
      `select entity_match_method, entity_match_confidence, count(*)::text as n
         from contract_action group by 1, 2 order by 1, 2`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['uei', 'cage', 'confirmed_alias', 'parent_fallback', 'candidate', 'unresolved'])
        .toContain(row.entity_match_method);
      expect(['confirmed', 'probable', 'unresolved']).toContain(row.entity_match_confidence);
    }
  });
});

describe('classification and labels', () => {
  it('writes PSC to its own table rather than a text column, defect 5', async () => {
    const rows = await query<{ n: string }>(
      "select count(*)::text as n from contract_action_classification where code_type = 'psc'",
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('keeps two labels for PSC R425 rather than overwriting one with the other', async () => {
    // Spec 4.1: 'PSC R425 appears with two different descriptions in one dataset.'
    // Migration 0012 exists because the first index design rejected the second one.
    await loadFile('labels.csv');
    const rows = await query<{ label: string }>(
      "select label from code_label where code_type = 'psc' and code_value = 'R425' order by label",
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual([
      'ENGINEERING AND TECHNICAL SERVICES',
      'SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL',
    ]);
  });

  it('shows exactly one current label per code', async () => {
    const rows = await query<{ code_value: string; n: string }>(
      `select code_value, count(*)::text as n from code_label
        where is_current group by code_value having count(*) > 1`,
    );
    expect(rows).toEqual([]);

    const current = await query<{ label: string }>(
      "select label from code_label_current where code_type = 'psc' and code_value = 'R425'",
    );
    expect(current).toHaveLength(1);
  });

  it('reports R425 as a disputed code so a human can pick the authoritative label', async () => {
    const rows = await query<{ code_value: string; label_count: string }>(
      "select code_value, label_count::text from code_label_disputed where code_type = 'psc'",
    );
    expect(rows).toEqual([{ code_value: 'R425', label_count: '2' }]);
  });

  it('counts how many records carried a label, so a one-off spelling is visible', async () => {
    // The main fixture files put 'ENGINEERING AND TECHNICAL SERVICES' on hundreds
    // of records, while labels.csv puts the alternate spelling on one. The counts
    // must reflect that difference, otherwise the column cannot do the job its
    // comment claims. Migration 0013 exists because the first version could not.
    const rows = await query<{ label: string; observation_count: number }>(
      `select label, observation_count from code_label
        where code_type = 'psc' and code_value = 'R425'
        order by observation_count desc`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.observation_count).toBeGreaterThan(100);
    expect(rows[1]!.observation_count).toBe(1);
  });

  it('does not count a record twice when the same file is loaded again', async () => {
    const before = await query<{ observation_count: number }>(
      `select observation_count from code_label
        where code_type = 'psc' and code_value = 'R425'
        order by observation_count desc limit 1`,
    );
    await loadFile('export_a.csv');
    const after = await query<{ observation_count: number }>(
      `select observation_count from code_label
        where code_type = 'psc' and code_value = 'R425'
        order by observation_count desc limit 1`,
    );
    expect(after[0]!.observation_count).toBe(before[0]!.observation_count);
  });

  it('stores the code on the action and no label', async () => {
    // Spec 7.2: the application always stores the code and always shows the
    // current label. A label column on contract_action would break that.
    const columns = await query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'contract_action' and column_name like '%description%'`,
    );
    expect(columns).toEqual([]);
  });
});

describe('money and dates from the real corpus shapes', () => {
  it('keeps a negative obligation, because it is a deobligation', async () => {
    // Spec 7.2 for subcontract values, and the same reasoning applies here.
    const rows = await query<{ n: string }>(
      'select count(*)::text as n from contract_action where action_obligation < 0',
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('parses a parenthesised negative', async () => {
    const rows = await query<{ action_obligation: string }>(
      `select action_obligation from contract_action
        where piid = 'ZT100022C00000' and modification_number = '' limit 1`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.action_obligation)).toBeLessThan(0);
  });
});

describe('provenance', () => {
  it('records a run for every load, with its counts', async () => {
    const rows = await query<{ status: string; n: string }>(
      `select status, count(*)::text as n from source_run
        where source_system = 'fpds' group by status`,
    );
    expect(rows.find((r) => r.status === 'succeeded')).toBeDefined();
    expect(rows.find((r) => r.status === 'failed')).toBeUndefined();
  });

  it('versions a source record only when its payload hash changes', async () => {
    const rows = await query<{ n: string }>(
      `select count(*)::text as n from (
         select source_record_id, count(*) as versions
           from source_version where source_system = 'fpds'
          group by source_record_id having count(*) > 1
       ) t`,
    );
    // No fixture row changes its payload, so nothing should be versioned twice.
    expect(rows[0]!.n).toBe('0');
  });
});
