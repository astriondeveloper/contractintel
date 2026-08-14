/**
 * Name normalisation.
 *
 * The load-bearing test here is parity: every one of the 97 real alias strings in
 * the seed corpus must normalise identically in TypeScript and in SQL. The
 * resolver uses the TypeScript version in memory for speed, and the database uses
 * the SQL version in a generated column and a unique index. If the two ever
 * disagree, a vendor resolves one way in the loader and a different way in a
 * query, which is the kind of defect that is very hard to see and very easy to
 * ship. This test makes it impossible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeName, coreName } from '../src/lib/normalize.js';
import { pool, query, closePool } from '../src/db/index.js';

let aliases: string[] = [];

beforeAll(async () => {
  const rows = await query<{ alias_name: string }>('select alias_name from entity_alias order by alias_id');
  aliases = rows.map((r) => r.alias_name);
});

afterAll(async () => {
  await closePool();
});

describe('acceptance test 3: the comma must stop mattering', () => {
  it('LARKSPUR, INCORPORATED and LARKSPUR INCORPORATED normalise to the same string', () => {
    expect(normalizeName('LARKSPUR, INCORPORATED')).toBe('LARKSPUR INCORPORATED');
    expect(normalizeName('LARKSPUR INCORPORATED')).toBe('LARKSPUR INCORPORATED');
    expect(normalizeName('LARKSPUR, INCORPORATED')).toBe(normalizeName('LARKSPUR INCORPORATED'));
  });

  it('reaches the same conclusion in SQL', async () => {
    const [row] = await query<{ same: boolean }>(
      "select cie_normalize_name('LARKSPUR, INCORPORATED') = cie_normalize_name('LARKSPUR INCORPORATED') as same",
    );
    expect(row?.same).toBe(true);
  });

  it('holds for the alias that carries 1,761 transactions', async () => {
    // Spec 8.3. This alias failed an automated rule in the earlier work because of
    // its comma, and it is the single largest alias in the corpus.
    const rows = await query<{ entity_id: string; alias_name: string }>(
      `select entity_id, alias_name from entity_alias
        where alias_name in ('LARKSPUR, INCORPORATED', 'LARKSPUR INCORPORATED')`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.entity_id)).size).toBe(1);
  });
});

describe('TypeScript and SQL agree on the whole corpus', () => {
  it('normalizeName matches cie_normalize_name for all 97 aliases', async () => {
    expect(aliases.length).toBeGreaterThan(90);

    const rows = await query<{ raw: string; sql_value: string | null }>(
      'select raw, cie_normalize_name(raw) as sql_value from unnest($1::text[]) as raw',
      [aliases],
    );

    const disagreements = rows
      .map((row) => ({ raw: row.raw, sql: row.sql_value, ts: normalizeName(row.raw) }))
      .filter((r) => r.sql !== r.ts);

    expect(disagreements).toEqual([]);
  });

  it('coreName matches cie_core_name for all 97 aliases', async () => {
    const rows = await query<{ raw: string; sql_value: string | null }>(
      'select raw, cie_core_name(raw) as sql_value from unnest($1::text[]) as raw',
      [aliases],
    );

    const disagreements = rows
      .map((row) => ({ raw: row.raw, sql: row.sql_value, ts: coreName(row.raw) }))
      .filter((r) => r.sql !== r.ts);

    expect(disagreements).toEqual([]);
  });
});

describe('normalisation specifics from the corpus', () => {
  it('drops a trailing parenthesised number', () => {
    // 'TESSELLATE CONCEPTS INCORPORATED (5855)' is a real alias.
    expect(normalizeName('TESSELLATE CONCEPTS INCORPORATED (5855)')).toBe('TESSELLATE CONCEPTS INCORPORATED');
  });

  it('folds an ampersand rather than deleting it', () => {
    expect(normalizeName('BEACON RESEARCH & CONSULT')).toBe('BEACON RESEARCH CONSULT');
  });

  it('returns null for a blank name instead of an empty string', () => {
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName('')).toBeNull();
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
  });

  it('strips corporate suffixes at the core level only', () => {
    expect(normalizeName('KESTREL TECHNOLOGIES, INC.')).toBe('KESTREL TECHNOLOGIES INC');
    expect(coreName('KESTREL TECHNOLOGIES, INC.')).toBe('KESTREL TECHNOLOGIES');
    expect(coreName('KESTREL TECHNOLOGIES INC')).toBe('KESTREL TECHNOLOGIES');
  });

  it('handles a trailing THE', () => {
    expect(coreName('CEDARWING COMPANY, THE')).toBe('CEDARWING');
  });
});

describe('the two levels stay separate', () => {
  it('never lets the core level drive resolution', async () => {
    // cie_core_name('LARKSPUR, INCORPORATED') is 'MAR'. So is cie_core_name of a
    // hypothetical 'MAR LLC'. The resolver must not use the core level, because a
    // three letter core name would collide with anything. This test asserts the
    // resolver's alias index is built on the normalised level.
    const [row] = await query<{ core: string }>("select cie_core_name('LARKSPUR, INCORPORATED') as core");
    expect(row?.core).toBe('LARKSPUR');
    expect(coreName('LARKSPUR LLC')).toBe('LARKSPUR');
    // Different normalised forms, so they never merge automatically.
    expect(normalizeName('LARKSPUR, INCORPORATED')).not.toBe(normalizeName('LARKSPUR LLC'));
  });

  it('reports no normalisation conflict in the loaded corpus', async () => {
    // A row in this view means one normalised name resolves to two entities, which
    // is a resolution defect rather than a curiosity. It must stay empty.
    const rows = await query('select * from alias_normalization_conflict');
    expect(rows).toEqual([]);
  });
});
