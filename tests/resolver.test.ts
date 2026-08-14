/**
 * Entity resolution. Spec section 8.
 *
 * These tests run against the real seed corpus loaded into a real database. The
 * fixtures are the 50 authored aliases and their observed UEI and CAGE values, so
 * a pass here is a statement about the actual data rather than about a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import { pool, query, closePool } from '../src/db/index.js';
import type { PoolClient } from 'pg';

let client: PoolClient;
let resolver: EntityResolver;

beforeAll(async () => {
  client = await pool.connect();
  resolver = await EntityResolver.load(client);
});

afterAll(async () => {
  client.release();
  await closePool();
});

async function entityName(entityId: number): Promise<string> {
  const rows = await query<{ canonical_name: string }>(
    'select canonical_name from entity where entity_id = $1',
    [entityId],
  );
  return rows[0]!.canonical_name;
}

describe('match order, spec 8.2', () => {
  it('step 1 resolves on an unambiguous UEI', async () => {
    // ZZ5TESTUEI05 belongs to Ridgeway Solutions alone.
    const result = resolver.resolve({ uei: 'ZZ5TESTUEI05', vendorName: 'SOMETHING ELSE ENTIRELY' });
    expect(result.method).toBe('uei');
    expect(result.confidence).toBe('confirmed');
    expect(result.ruleId).toBe('RESOLVE-01-UEI');
    expect(await entityName(result.entityId!)).toBe('Ridgeway Solutions');
  });

  it('step 2 resolves on CAGE when UEI is absent', async () => {
    // ZC005 belongs to Ridgeway Solutions alone.
    const result = resolver.resolve({ cage: 'ZC005' });
    expect(result.method).toBe('cage');
    expect(result.confidence).toBe('confirmed');
    expect(await entityName(result.entityId!)).toBe('Ridgeway Solutions');
  });

  it('step 3 resolves on the authored alias', async () => {
    const result = resolver.resolve({ vendorName: 'BEACON RES & CONSULTING' });
    expect(result.method).toBe('confirmed_alias');
    expect(await entityName(result.entityId!)).toBe('Beacon Research, Inc.');
  });

  it('never skips to step 4 while an earlier step can answer', () => {
    // A name that resolves, with no identifiers at all, must not reach the queue.
    const result = resolver.resolve({ vendorName: 'QUANTALYTIC INC' });
    expect(result.entityId).not.toBeNull();
    expect(result.method).not.toBe('unresolved');
    expect(result.method).not.toBe('candidate');
  });

  it('step 4 produces a candidate rather than a guess', () => {
    const result = resolver.resolve({ vendorName: 'A COMPANY THAT IS NOT IN THE MAP LLC' });
    expect(result.entityId).toBeNull();
    expect(result.method).toBe('unresolved');
    expect(result.confidence).toBe('unresolved');
    expect(result.furthestStep).toBe('no_match');
    expect(result.ruleId).toBe('RESOLVE-05-REVIEW-QUEUE');
  });
});

describe('acceptance test 3: MAR resolves to one entity', () => {
  it('resolves both spellings to the same entity', async () => {
    const withComma = resolver.resolve({ vendorName: 'LARKSPUR, INCORPORATED' });
    const without = resolver.resolve({ vendorName: 'LARKSPUR INCORPORATED' });

    expect(withComma.entityId).not.toBeNull();
    expect(withComma.entityId).toBe(without.entityId);
    expect(await entityName(withComma.entityId!)).toBe('Larkspur, Incorporated');
  });

  it('resolves all four MAR spellings in the corpus to one entity', async () => {
    const spellings = ['LARKSPUR, INCORPORATED', 'LARKSPUR INCORPORATED', 'LARKSPUR INC', 'LARKSPUR INCORORATED'];
    const ids = spellings.map((name) => resolver.resolve({ vendorName: name }).entityId);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(1);
  });

  it('keeps Larkspur Range Services separate from Larkspur, Incorporated', async () => {
    // Two different legacy entities with two different UEI values. Over-merging is
    // as much a defect as under-merging.
    const marInc = resolver.resolve({ vendorName: 'LARKSPUR, INCORPORATED' });
    const marRange = resolver.resolve({ vendorName: 'LARKSPUR RANGE SERVICES LLC' });
    expect(marInc.entityId).not.toBe(marRange.entityId);
    expect(await entityName(marRange.entityId!)).toBe('Larkspur Range Services, LLC');
  });
});

describe('the UEI collisions in the corpus', () => {
  it('finds exactly four colliding UEI values and four colliding CAGE values', async () => {
    const rows = await query<{ identifier_type: string; n: string }>(
      'select identifier_type, count(*)::text as n from identifier_collision group by identifier_type order by 1',
    );
    expect(rows).toEqual([
      { identifier_type: 'cage', n: '4' },
      { identifier_type: 'uei', n: '4' },
    ]);
  });

  it('every collision stays inside one family, so a UEI still identifies the family', async () => {
    const rows = await query<{ distinct_parent_count: string }>(
      'select distinct_parent_count::text from identifier_collision',
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.distinct_parent_count).toBe('1');
  });

  it('lets the alias step resolve the legacy entity that an ambiguous UEI cannot', async () => {
    // ZZ1TESTUEI01 belongs to both Northwind Group, LLC and Beacon Research, Inc. The identifier
    // alone cannot choose. The name can.
    const ambiguousOnly = resolver.resolve({ uei: 'ZZ1TESTUEI01' });
    expect(ambiguousOnly.method).toBe('parent_fallback');
    expect(ambiguousOnly.confidence).toBe('probable');
    expect(ambiguousOnly.candidateEntityIds.length).toBe(2);

    const withName = resolver.resolve({
      uei: 'ZZ1TESTUEI01',
      vendorName: 'BEACON RESEARCH AND CONSULTING, INC.',
    });
    expect(withName.method).toBe('confirmed_alias');
    expect(await entityName(withName.entityId!)).toBe('Beacon Research, Inc.');
  });

  it('falls back to the shared parent, never to an arbitrary pick', async () => {
    const result = resolver.resolve({ uei: 'ZZ4TESTUEI04', vendorName: 'UNKNOWN SPELLING XYZ' });
    expect(result.method).toBe('parent_fallback');
    expect(result.ruleId).toBe('RESOLVE-04-SHARED-PARENT');
    expect(await entityName(result.entityId!)).toBe('Astrion');
  });
});

describe('no probabilistic matching on the Astrion family, spec 8.1 and defect 9', () => {
  it('refuses a near miss that is not in the authored map', () => {
    // One character away from a real alias. A probabilistic matcher would take it.
    // This resolver must not.
    const result = resolver.resolve({ vendorName: 'QUANTALYTEK INC' });
    expect(result.entityId).toBeNull();
  });

  it('refuses a suffix variant that the map does not carry', () => {
    // 'QUANTALYTIC CORPORATION' shares a core name with QUANTALYTIC INC but is not an
    // authored alias. Resolution on core name alone is not permitted.
    const result = resolver.resolve({ vendorName: 'QUANTALYTIC CORPORATION' });
    expect(result.entityId).toBeNull();
    expect(result.method).toBe('unresolved');
  });
});

describe('confidence is three states, never a percentage, spec 14.6', () => {
  it('reports probable for an unconfirmed authored alias', () => {
    // Every seed row ships with confirmed_by_bd_ops = NO, so the authored map
    // resolves at probable until BD Ops confirms the row.
    const result = resolver.resolve({ vendorName: 'HALCYON SYSTEMS, INC.' });
    expect(result.method).toBe('confirmed_alias');
    expect(result.confidence).toBe('probable');
  });

  it('only ever returns one of the three permitted values', () => {
    const inputs = [
      { vendorName: 'LARKSPUR, INCORPORATED' },
      { uei: 'ZZ5TESTUEI05' },
      { uei: 'ZZ1TESTUEI01' },
      { vendorName: 'NOT IN THE MAP AT ALL' },
      {},
    ];
    for (const input of inputs) {
      expect(['confirmed', 'probable', 'unresolved']).toContain(resolver.resolve(input).confidence);
    }
  });
});

describe('requireConfirmedAlias, and why it defaults to false', () => {
  it('resolves nothing by name when confirmation is demanded on an unconfirmed corpus', async () => {
    const strict = await EntityResolver.load(client, { requireConfirmedAlias: true });
    // Names stop resolving, because no seed row is confirmed yet.
    expect(strict.resolve({ vendorName: 'LARKSPUR, INCORPORATED' }).entityId).toBeNull();
    // Identifiers still work, so the family is still reachable.
    expect(strict.resolve({ uei: 'ZZ5TESTUEI05' }).entityId).not.toBeNull();
  });
});

describe('family root traversal', () => {
  it('walks a legacy entity up to Astrion', async () => {
    const erc = resolver.resolve({ vendorName: 'B R C INC' });
    const root = resolver.familyRoot(erc.entityId!);
    expect(await entityName(root)).toBe('Astrion');
  });

  it('returns the entity itself when it has no parent', async () => {
    const rows = await query<{ entity_id: string }>(
      "select entity_id from entity where canonical_name = 'Astrion'",
    );
    const astrionId = Number(rows[0]!.entity_id);
    expect(resolver.familyRoot(astrionId)).toBe(astrionId);
  });
});
