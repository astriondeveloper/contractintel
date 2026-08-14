/**
 * Subcontract edge loader.
 *
 * The fixtures use real spellings from the authored entity map and the seeded
 * watchlist, because the whole point of the loader is what resolution does to a row.
 * A fixture with invented company names would test the CSV parser and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import { query, closePool, withTransaction } from '../src/db/index.js';
import { loadSubcontractFile } from '../src/loaders/subcontract.js';
import { buildSubcontractColumnMap } from '../src/loaders/subcontract-columns.js';

let fixtureDir: string;

const HEADER = [
  'ID', 'Award Number', 'Description', 'Value', 'Date',
  'Prime Name', 'Prime PIID', 'Prime IDVPIID', 'Cage Code',
  'Sub Name', 'Sub Cage Code',
  'Agency Name', 'Office Name', 'Customer Name',
].join(',');

interface Row {
  id: string;
  award?: string;
  value?: string;
  date?: string;
  prime: string;
  primeCage?: string;
  sub: string;
  subCage?: string;
}

function toCsv(rows: Row[]): string {
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([
      r.id,
      r.award ?? 'PO0001',
      '"SERVICES"',
      r.value ?? '100000',
      r.date ?? '2025-06-02',
      `"${r.prime}"`,
      'ZT100022C0001',
      '',
      r.primeCage ?? '',
      `"${r.sub}"`,
      r.subCage ?? '',
      '"Department of Example (DOE)"',
      '"ZT8721  DISTRICT OFFICE"',
      '"Northern Sustainment Center"',
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/** Astrion legacy entities and a seeded watchlist company, spelled as the data spells them. */
const ERC = { name: 'BEACON RESEARCH AND CONSULTING, INC.', cage: 'ZC001' };
const CARDINAL = { name: 'CARDINAL LLC', cage: 'ZC002' };
const MILLENNIUM = { name: 'MERIDIAN ENGINEERING AND INTEGRATION CO', cage: 'ZC003' };
const KESTREL = { name: 'KESTREL TECHNOLOGIES INC', cage: '' };
const OUTSIDER = { name: 'THORNFIELD MACHINE WORKS, INC.', cage: 'ZC101' };
const OUTSIDER_2 = { name: 'GRAYLING FABRICATION, LLC', cage: 'ZC102' };

async function load(
  fileName: string,
  options: Parameters<typeof loadSubcontractFile>[3] = {},
): Promise<NonNullable<Awaited<ReturnType<typeof loadSubcontractFile>>>> {
  const result = await withTransaction(async (client) => {
    const resolver = await EntityResolver.load(client);
    return loadSubcontractFile(client, path.join(fixtureDir, fileName), resolver, options);
  });
  if (result === null) throw new Error('loader returned null outside header-report mode');
  return result;
}

async function edgeByRecordId(id: string): Promise<{
  prime_entity_id: number | null;
  sub_entity_id: number | null;
  prime_cage_code: string | null;
  sub_cage_code: string | null;
  value_usd: string | null;
  customer_name: string | null;
} | undefined> {
  const rows = await query<{
    prime_entity_id: string | null;
    sub_entity_id: string | null;
    prime_cage_code: string | null;
    sub_cage_code: string | null;
    value_usd: string | null;
    customer_name: string | null;
  }>(
    `select prime_entity_id, sub_entity_id, prime_cage_code, sub_cage_code, value_usd, customer_name
       from subcontract_edge where source_record_id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    prime_entity_id: row.prime_entity_id === null ? null : Number(row.prime_entity_id),
    sub_entity_id: row.sub_entity_id === null ? null : Number(row.sub_entity_id),
    prime_cage_code: row.prime_cage_code,
    sub_cage_code: row.sub_cage_code,
    value_usd: row.value_usd,
    customer_name: row.customer_name,
  };
}

async function countEdges(): Promise<number> {
  const rows = await query<{ n: string }>('select count(*)::text as n from subcontract_edge');
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'cie-subs-'));

  // Astrion is the prime, counterparty outside the map. The out-file shape.
  await writeFile(path.join(fixtureDir, 'out.csv'), toCsv([
    { id: 'S1', prime: ERC.name, primeCage: ERC.cage, sub: OUTSIDER.name, subCage: OUTSIDER.cage },
    { id: 'S2', prime: ERC.name, primeCage: ERC.cage, sub: KESTREL.name, value: '250000' },
  ]));

  // Astrion is the sub. The in-file shape.
  await writeFile(path.join(fixtureDir, 'in.csv'), toCsv([
    { id: 'S3', prime: KESTREL.name, sub: CARDINAL.name, subCage: CARDINAL.cage },
  ]));

  // The same record supplied in both an in-file and an out-file. Must land once.
  await writeFile(path.join(fixtureDir, 'overlap.csv'), toCsv([
    { id: 'S3', prime: KESTREL.name, sub: CARDINAL.name, subCage: CARDINAL.cage },
    { id: 'S4', prime: MILLENNIUM.name, primeCage: MILLENNIUM.cage, sub: CARDINAL.name, subCage: CARDINAL.cage },
  ]));

  // Value edge cases and an edge with no Astrion party at all.
  await writeFile(path.join(fixtureDir, 'edges.csv'), toCsv([
    { id: 'S5', prime: ERC.name, primeCage: ERC.cage, sub: OUTSIDER.name, value: '' },
    { id: 'S6', prime: ERC.name, primeCage: ERC.cage, sub: OUTSIDER.name, value: '-603705.86' },
    { id: 'S7', prime: OUTSIDER.name, primeCage: OUTSIDER.cage, sub: OUTSIDER_2.name, subCage: OUTSIDER_2.cage },
  ]));

  // A row with no sub name. Skipped, not guessed.
  await writeFile(path.join(fixtureDir, 'nameless.csv'), toCsv([
    { id: 'S8', prime: ERC.name, primeCage: ERC.cage, sub: '' },
  ]));

  // A DACIS contract export, which is a different shape with no prime and sub pair.
  await writeFile(
    path.join(fixtureDir, 'contracts.csv'),
    'DACIS Link,Title,Value ($M),Award Date,Contract #,Companies,Other Bidders\n' +
      'http://x,"SOME CONTRACT",1.5,2025-01-01,FA0001,"ERC, INC.","KESTREL"\n',
  );
});

afterAll(async () => {
  await closePool();
});

describe('column mapping', () => {
  it("gives the unprefixed 'Cage Code' to the prime, not the sub", () => {
    // The trap. Nothing in the header says whose CAGE it is, and reading it as the
    // sub's would invert every edge in the corpus.
    const map = buildSubcontractColumnMap(HEADER.split(','));
    expect(map.mapped.get('prime_cage_code')).toBe('Cage Code');
    expect(map.mapped.get('sub_cage_code')).toBe('Sub Cage Code');
  });

  it('maps all fourteen columns of the real export and leaves nothing unclaimed', () => {
    const map = buildSubcontractColumnMap(HEADER.split(','));
    expect(map.unmappedFields).toEqual([]);
    expect(map.unclaimedHeaders).toEqual([]);
  });

  it('gives the prime no CAGE rather than stealing the sub\'s when only one column exists', () => {
    const map = buildSubcontractColumnMap(['Prime Name', 'Sub Name', 'Sub Cage Code']);
    expect(map.mapped.get('sub_cage_code')).toBe('Sub Cage Code');
    expect(map.mapped.has('prime_cage_code')).toBe(false);
  });
});

describe('loading edges', () => {
  it('resolves an Astrion prime and keeps an unresolved counterparty', async () => {
    const result = await load('out.csv');
    expect(result.astrionIsPrime).toBe(2);
    expect(result.astrionIsSub).toBe(0);

    // One counterparty is on the watchlist, one is outside it. Both edges are kept.
    const outside = await edgeByRecordId('S1');
    expect(outside?.prime_entity_id).not.toBeNull();
    expect(outside?.sub_entity_id).toBeNull();

    const watchlisted = await edgeByRecordId('S2');
    expect(watchlisted?.sub_entity_id).not.toBeNull();
  });

  it('keeps both CAGE codes and the customer name on the edge', async () => {
    const edge = await edgeByRecordId('S1');
    expect(edge?.prime_cage_code).toBe(ERC.cage);
    expect(edge?.sub_cage_code).toBe(OUTSIDER.cage);
    expect(edge?.customer_name).toBe('Northern Sustainment Center');
  });

  it('does not send a single unresolved counterparty to the review queue', async () => {
    // 936 distinct sub names against a 45 company watchlist. Queueing every external
    // company would make the queue useless for the thing it exists for.
    const rows = await query<{ n: string }>(
      `select count(*)::text as n from vendor_review_queue
        where source_system = 'dacis_subcontract' and vendor_name_raw = $1`,
      [OUTSIDER.name],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('derives Astrion as the sub from the data, not from the file name', async () => {
    const result = await load('in.csv');
    expect(result.astrionIsSub).toBe(1);
    expect(result.astrionIsPrime).toBe(0);
  });

  it('lands a record supplied in both an in-file and an out-file exactly once', async () => {
    const before = await countEdges();
    const result = await load('overlap.csv');

    // S3 was already loaded from in.csv, S4 is new.
    expect(result.run.unchanged).toBe(1);
    expect(result.run.inserted).toBe(1);
    expect(await countEdges()).toBe(before + 1);
  });

  it('counts an edge with Astrion on both sides as internal, and keeps it out of teaming_direction', async () => {
    // Meridian subbing to Cardinal is intra-family after the rollup. It is a real
    // record and is kept, but it is not a teaming relationship with anyone.
    const edge = await edgeByRecordId('S4');
    expect(edge?.prime_entity_id).not.toBeNull();
    expect(edge?.sub_entity_id).not.toBeNull();

    const rows = await query<{ n: string }>(
      `select count(*)::text as n from teaming_direction
        where canonical_name in ('Cardinal LLC', 'CARDINAL LLC')`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('the Value column', () => {
  beforeAll(async () => {
    await load('edges.csv');
  });

  it('stores a blank Value as null, never as zero', async () => {
    // Zero would be summed as if the subcontract were worth nothing. Null means
    // 'not supplied', which is what the export means, and aggregates skip it.
    const edge = await edgeByRecordId('S5');
    expect(edge?.value_usd).toBeNull();
  });

  it('keeps a negative Value, because a deobligation is real', async () => {
    const edge = await edgeByRecordId('S6');
    expect(Number(edge?.value_usd)).toBeCloseTo(-603705.86, 2);
  });

  it('reports blank and negative counts so neither is invisible', async () => {
    const result = await load('edges.csv');
    // Second pass: all unchanged, but the row-level counts are still reported.
    expect(result.blankValues).toBe(1);
    expect(result.negativeValues).toBe(1);
  });
});

describe('rows that cannot become edges', () => {
  it('sends an edge with neither side resolved to the review queue', async () => {
    // edges.csv held one: two companies with no Astrion party. This edge cannot be
    // placed relative to Astrion at all, which is the case worth a person's time.
    const rows = await query<{ n: string }>(
      `select count(*)::text as n from subcontract_edge_unplaced where source_record_id = 'S7'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const queued = await query<{ n: string }>(
      `select count(*)::text as n from vendor_review_queue
        where source_system = 'dacis_subcontract' and vendor_name_raw = $1`,
      [OUTSIDER_2.name],
    );
    expect(Number(queued[0]!.n)).toBe(1);
  });

  it('skips a row with no sub name rather than guessing one', async () => {
    const result = await load('nameless.csv');
    expect(result.skippedUnkeyable).toBe(1);
    expect(await edgeByRecordId('S8')).toBeUndefined();
  });

  it('refuses a DACIS contract export by name, and writes nothing from it', async () => {
    const before = await countEdges();
    await expect(load('contracts.csv')).rejects.toThrow(/no edge without both sides/);
    expect(await countEdges()).toBe(before);
  });
});
