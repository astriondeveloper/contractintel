/**
 * Recompete detection and contract identity. Spec section 9.1, migration 0019.
 *
 * The fixtures here are built to reproduce properties rather than to look plausible.
 * The one that matters most is the short-PIID collision: agency 9700 PIID '0001' is the
 * first task order under one vehicle and also the first under another, and grouping by
 * PIID alone would merge them and take an end date from the wrong contract. That is the
 * trap docs/BACKLOG.md item 3 names, and it is the first thing asserted here.
 *
 * Every row these tests write is removed afterwards, because the file shares its database
 * with the loader and resolver tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import { detectRecompetes, SOURCE_SYSTEM } from '../src/signals/recompete.js';

let client: PoolClient;

/** Everything these tests insert is tagged so cleanup cannot miss it. */
const PIID_PREFIX = 'ZTEST';

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from pursuit where signal_key like 'recompete:%' or title like '%${PIID_PREFIX}%'`);
  await client.query(`delete from contract_action where piid like '${PIID_PREFIX}%'`);
  await client.query(`delete from subcontract_edge where prime_piid like '${PIID_PREFIX}%'`);
  await client.query(`delete from source_version where source_system = '${SOURCE_SYSTEM}'`);
  await client.query(`delete from source_run where source_system = '${SOURCE_SYSTEM}'`);
}

beforeEach(cleanup);

interface ActionFixture {
  piid: string;
  idv?: string | null;
  mod?: string;
  txn?: string;
  agency?: string;
  /** Months from today. Positive is the future. */
  endsInMonths?: number | null;
  signed?: string;
  obligation?: number | null;
  ceiling?: number | null;
  entityId?: number | null;
  office?: string;
  confidence?: 'confirmed' | 'probable' | 'unresolved';
}

async function insertAction(fixture: ActionFixture): Promise<void> {
  await client.query(
    `insert into contract_action (
       awarding_agency_code, piid, modification_number, transaction_number,
       idv_piid, signed_date, ultimate_completion_date, action_obligation,
       base_and_all_options, entity_id, contracting_office_code, vendor_name_raw,
       entity_match_method, entity_match_confidence
     ) values (
       $1, $2, $3, $4, $5, $6::date,
       case when $7::int is null then null else (current_date + ($7 || ' months')::interval)::date end,
       $8, $9, $10, $11, $12, 'confirmed_alias', $13
     )`,
    [
      fixture.agency ?? '9700',
      fixture.piid,
      fixture.mod ?? '0',
      fixture.txn ?? '',
      fixture.idv ?? null,
      fixture.signed ?? '2024-01-15',
      fixture.endsInMonths === undefined ? 24 : fixture.endsInMonths,
      fixture.obligation === undefined ? 100000 : fixture.obligation,
      fixture.ceiling === undefined ? 500000 : fixture.ceiling,
      fixture.entityId ?? null,
      fixture.office ?? 'FA1234',
      `VENDOR FOR ${fixture.piid}`,
      fixture.confidence ?? 'probable',
    ],
  );
}

async function astrionFamilyEntity(): Promise<number> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select e.entity_id from entity e
      where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')
        and e.canonical_name <> 'Astrion'
      order by e.entity_id limit 1`,
  );
  return Number(rows[0]!.entity_id);
}

/** An entity outside the Astrion family, so a "no position" signal can be built. */
async function outsideEntity(): Promise<number> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select e.entity_id from entity e
      where coalesce(e.ultimate_parent_id, e.entity_id) <>
            (select entity_id from entity where canonical_name = 'Astrion')
      order by e.entity_id limit 1`,
  );
  return Number(rows[0]!.entity_id);
}

async function groupsFor(piid: string): Promise<{ idv_piid_key: string; ends_on: Date; distinct_awardees: number }[]> {
  const { rows } = await client.query(
    `select idv_piid_key, ends_on, distinct_awardees::int
       from contract_group where piid = $1 order by idv_piid_key`,
    [piid],
  );
  return rows as never;
}

describe('contract identity, migration 0019', () => {
  it('separates task orders that share a PIID under different vehicles', async () => {
    // The trap: '0001' is the first task order under each of two unrelated IDVs.
    // Grouping by PIID alone would make these one contract and take the later end date.
    //
    // The distinct transaction numbers are not decoration. contract_action's primary key
    // is spec 7.2's natural key and the vehicle is not in it, so without them these two
    // task orders collide on the key itself and one overwrites the other. That is what
    // decision D3's content-derived surrogate transaction number produces on a real load,
    // and it is the only reason these are two rows to group in the first place.
    await insertAction({ piid: `${PIID_PREFIX}0001`, idv: 'ZIDVAAA', txn: 'H:aaa1', endsInMonths: 18 });
    await insertAction({ piid: `${PIID_PREFIX}0001`, idv: 'ZIDVBBB', txn: 'H:bbb2', endsInMonths: 30 });

    const groups = await groupsFor(`${PIID_PREFIX}0001`);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.idv_piid_key)).toEqual(['ZIDVAAA', 'ZIDVBBB']);
  });

  it('keeps modifications of one award together and takes the latest end date', async () => {
    // A modification extends the period of performance. The contract ends when the last
    // modification says it does, not when the base award did.
    await insertAction({ piid: `${PIID_PREFIX}0002`, idv: 'ZIDVAAA', mod: '0', endsInMonths: 14 });
    await insertAction({ piid: `${PIID_PREFIX}0002`, idv: 'ZIDVAAA', mod: 'P00001', endsInMonths: 26 });

    const groups = await groupsFor(`${PIID_PREFIX}0002`);
    expect(groups).toHaveLength(1);

    const monthsOut = Math.round(
      (groups[0]!.ends_on.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44),
    );
    expect(monthsOut).toBeGreaterThan(24);
  });

  it('flags a short PIID carrying two awards with no vehicle to separate them', async () => {
    // No IDV, different awardee, different office. This is what a merge of unrelated
    // awards looks like from outside, and the diagnostic exists to count it rather than
    // to pretend the key is safe.
    const inside = await astrionFamilyEntity();
    const outside = await outsideEntity();
    await insertAction({ piid: `${PIID_PREFIX}0003`, idv: null, entityId: inside, office: 'FA1111' });
    await insertAction({
      piid: `${PIID_PREFIX}0003`,
      idv: null,
      mod: 'P00001',
      entityId: outside,
      office: 'FA2222',
    });

    const { rows } = await client.query<{ ambiguity: string }>(
      `select ambiguity from contract_group_ambiguous where piid = $1`,
      [`${PIID_PREFIX}0003`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ambiguity).toBe('likely_unrelated_awards');
  });

  it('reads the incumbent from the most recently signed action, not the first', async () => {
    // A novation moves the contract to another company. The recompete is against
    // whoever holds it now.
    const first = await astrionFamilyEntity();
    const second = await outsideEntity();
    await insertAction({
      piid: `${PIID_PREFIX}0004`, idv: 'ZIDVAAA', mod: '0',
      signed: '2021-03-01', entityId: first,
    });
    await insertAction({
      piid: `${PIID_PREFIX}0004`, idv: 'ZIDVAAA', mod: 'P00009',
      signed: '2025-06-01', entityId: second,
    });

    const { rows } = await client.query<{ incumbent_entity_id: string; distinct_awardees: number }>(
      `select incumbent_entity_id::text, distinct_awardees::int from contract_group where piid = $1`,
      [`${PIID_PREFIX}0004`],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.incumbent_entity_id)).toBe(second);
    expect(rows[0]!.distinct_awardees).toBe(2);
  });
});

describe('recompete detection, spec 9.1', () => {
  async function signals(): Promise<
    { signal_key: string; astrion_position: string; state: string; estimated_value: string | null; title: string }[]
  > {
    const { rows } = await client.query(
      `select signal_key, astrion_position, state, estimated_value::text, title
         from pursuit where signal_key like 'recompete:%' order by signal_key`,
    );
    return rows as never;
  }

  it('detects a contract inside the window and ignores ones outside it', async () => {
    await insertAction({ piid: `${PIID_PREFIX}1001`, idv: 'ZIDVAAA', endsInMonths: 24 });  // inside
    await insertAction({ piid: `${PIID_PREFIX}1002`, idv: 'ZIDVAAA', endsInMonths: 3 });   // too soon
    await insertAction({ piid: `${PIID_PREFIX}1003`, idv: 'ZIDVAAA', endsInMonths: 60 });  // too far
    await insertAction({ piid: `${PIID_PREFIX}1004`, idv: 'ZIDVAAA', endsInMonths: null }); // no end date

    const result = await detectRecompetes(client);
    expect(result.horizonFrom).toBe(12);
    expect(result.horizonTo).toBe(36);

    const written = (await signals()).filter((s) => s.title.includes(PIID_PREFIX));
    expect(written).toHaveLength(1);
    expect(written[0]!.title).toContain(`${PIID_PREFIX}1001`);
  });

  it('takes the window from the database rather than from the code', async () => {
    await insertAction({ piid: `${PIID_PREFIX}1005`, idv: 'ZIDVAAA', endsInMonths: 48 });

    // Outside the seeded 12-36 window.
    let result = await detectRecompetes(client, { dryRun: true });
    let mine = result.candidates;
    expect(mine).toBe(0);

    // BD Ops widens it. Spec section 13 makes this their row to edit.
    await client.query(
      `update signal_class_threshold set horizon_months_to = 60 where signal_class = 'recompete_window'`,
    );
    try {
      result = await detectRecompetes(client, { dryRun: true });
      expect(result.horizonTo).toBe(60);
      expect(result.candidates).toBeGreaterThan(mine);
    } finally {
      await client.query(
        `update signal_class_threshold set horizon_months_to = 36 where signal_class = 'recompete_window'`,
      );
    }
  });

  it('is idempotent: a second run changes nothing and duplicates nothing', async () => {
    await insertAction({ piid: `${PIID_PREFIX}1006`, idv: 'ZIDVAAA', endsInMonths: 20 });

    const first = await detectRecompetes(client);
    expect(first.run!.inserted).toBeGreaterThan(0);
    const afterFirst = await signals();

    const second = await detectRecompetes(client);
    expect(second.run!.inserted).toBe(0);
    expect(second.run!.updated).toBe(0);
    expect(second.run!.unchanged).toBe(second.run!.records);

    const afterSecond = await signals();
    expect(afterSecond).toHaveLength(afterFirst.length);
  });

  it('does not undo work a person has done on a generated pursuit', async () => {
    await insertAction({ piid: `${PIID_PREFIX}1007`, idv: 'ZIDVAAA', endsInMonths: 20 });
    await detectRecompetes(client);

    // BD picks it up and starts working it.
    await client.query(
      `update pursuit set state = 'pursuing', owner = 'BD Ops'
        where signal_key like 'recompete:%' and title like $1`,
      [`%${PIID_PREFIX}1007%`],
    );

    await detectRecompetes(client);

    const { rows } = await client.query<{ state: string; owner: string }>(
      `select state, owner from pursuit where title like $1`,
      [`%${PIID_PREFIX}1007%`],
    );
    expect(rows[0]!.state).toBe('pursuing');
    expect(rows[0]!.owner).toBe('BD Ops');
  });

  it('never touches a pursuit somebody created by hand', async () => {
    const { rows } = await client.query<{ pursuit_id: string }>(
      `insert into pursuit (signal_class, title, state)
       values ('recompete_window', '${PIID_PREFIX} hand written pursuit', 'qualifying')
       returning pursuit_id`,
    );
    const id = rows[0]!.pursuit_id;

    await insertAction({ piid: `${PIID_PREFIX}1008`, idv: 'ZIDVAAA', endsInMonths: 20 });
    await detectRecompetes(client);

    const after = await client.query<{ state: string; signal_key: string | null; generated_by: string | null }>(
      `select state, signal_key, generated_by from pursuit where pursuit_id = $1`,
      [id],
    );
    expect(after.rows[0]!.state).toBe('qualifying');
    expect(after.rows[0]!.signal_key).toBeNull();
    expect(after.rows[0]!.generated_by).toBeNull();
  });

  it('marks the position Astrion holds on each contract', async () => {
    const inside = await astrionFamilyEntity();
    const outside = await outsideEntity();

    await insertAction({ piid: `${PIID_PREFIX}1009`, idv: 'ZIDVAAA', endsInMonths: 20, entityId: inside });
    await insertAction({ piid: `${PIID_PREFIX}1010`, idv: 'ZIDVBBB', endsInMonths: 20, entityId: outside });

    // A contract a competitor holds as prime, with Astrion on it as a sub.
    await insertAction({ piid: `${PIID_PREFIX}1011`, idv: 'ZIDVCCC', endsInMonths: 20, entityId: outside });
    await client.query(
      `insert into subcontract_edge (prime_entity_id, sub_entity_id, prime_name_raw, sub_name_raw,
                                     prime_piid, value_usd, source_system, source_record_id)
       values ($1, $2, 'PRIME', 'SUB', $3, 1000, 'dacis_subcontract', $4)`,
      [outside, inside, `${PIID_PREFIX}1011`, `${PIID_PREFIX}-edge-1`],
    );

    await detectRecompetes(client);
    const written = await signals();
    const position = (piid: string) =>
      written.find((s) => s.title.includes(piid))?.astrion_position;

    expect(position(`${PIID_PREFIX}1009`)).toBe('prime_incumbent');
    expect(position(`${PIID_PREFIX}1010`)).toBe('none');
    expect(position(`${PIID_PREFIX}1011`)).toBe('subcontractor');
  });

  it('filters by position without losing the others from the count', async () => {
    const inside = await astrionFamilyEntity();
    const outside = await outsideEntity();
    await insertAction({ piid: `${PIID_PREFIX}1012`, idv: 'ZIDVAAA', endsInMonths: 20, entityId: inside });
    await insertAction({ piid: `${PIID_PREFIX}1013`, idv: 'ZIDVBBB', endsInMonths: 20, entityId: outside });

    const result = await detectRecompetes(client, { positions: ['prime_incumbent'], dryRun: true });
    expect(result.byPosition.none).toBe(0);
    expect(result.skippedByPosition).toBeGreaterThan(0);
    expect(result.candidates).toBeGreaterThan(result.written);
  });

  it('a value floor drops a known small contract but never an unknown one', async () => {
    // Blank is not zero. A contract with no value is not a small contract; it is a
    // contract whose value nobody has recorded, and a floor must not silently bin it.
    await insertAction({
      piid: `${PIID_PREFIX}1014`, idv: 'ZIDVAAA', endsInMonths: 20,
      obligation: 1000, ceiling: 5000,
    });
    await insertAction({
      piid: `${PIID_PREFIX}1015`, idv: 'ZIDVBBB', endsInMonths: 20,
      obligation: null, ceiling: null,
    });

    await detectRecompetes(client, { minValueUsd: 1_000_000 });
    const written = await signals();

    expect(written.some((s) => s.title.includes(`${PIID_PREFIX}1014`))).toBe(false);
    expect(written.some((s) => s.title.includes(`${PIID_PREFIX}1015`))).toBe(true);
  });

  it('records the incumbent as a per-pursuit role, not a label on the company', async () => {
    const inside = await astrionFamilyEntity();
    await insertAction({ piid: `${PIID_PREFIX}1016`, idv: 'ZIDVAAA', endsInMonths: 20, entityId: inside });
    await detectRecompetes(client);

    const { rows } = await client.query<{ role: string }>(
      `select per.role
         from pursuit_entity_role per
         join pursuit p on p.pursuit_id = per.pursuit_id
        where p.title like $1`,
      [`%${PIID_PREFIX}1016%`],
    );
    expect(rows.map((r) => r.role)).toContain('incumbent');
  });
});
