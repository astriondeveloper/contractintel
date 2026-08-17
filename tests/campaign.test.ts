/**
 * Campaign sizing and the gap report. Migration 0024 and src/campaign/.
 * Spec section 11, acceptance tests 9 and 10.
 *
 * Four properties carry the weight here, and each is a place where a plausible wrong number could
 * be produced instead:
 *
 *   An award matching several of a campaign's codes counts once. Joining the codes instead of
 *   testing them would multiply the obligation and give a TAM several times the truth, at exactly
 *   the moment nobody would notice because the shape of the number stays sensible.
 *
 *   A campaign that names no offices gets no SAM. Falling back to TAM there would report an
 *   addressable figure under a served label.
 *
 *   The capture rate is measured, and it never exists without its sample size. Acceptance test 9.
 *
 *   Blank is not zero. A served market obligating nothing recorded has an undefined rate, not a
 *   rate of nought.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  assignMatching,
  createCampaign,
  defaultWindow,
  sizeAll,
  sizeCampaign,
  type SizingWindow,
} from '../src/campaign/sizing.js';

let client: PoolClient;

const PREFIX = 'ZCM';
const ACTOR = 'zcm-bdops@example.test';
const WINDOW: SizingWindow = { fyFrom: 2020, fyTo: 2024 };

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

/**
 * Order matters here. `pursuit.campaign_id` is a foreign key without a cascade, so a requirement
 * this file assigned to one of its campaigns has to go before the campaign does. Deleting in the
 * other order fails on the constraint, and the failure lands in the next test rather than this one.
 */
async function cleanup(): Promise<void> {
  await client.query(`delete from audit_log where actor = '${ACTOR}'`);
  await client.query(`delete from pursuit where signal_key like '${PREFIX}%'`);
  await client.query(`delete from campaign where campaign_name like '${PREFIX}%'`);
  await client.query(
    `delete from contract_action_classification
      where contract_action_id in (select contract_action_id from contract_action
                                    where piid like '${PREFIX}%')`,
  );
  await client.query(`delete from contract_action where piid like '${PREFIX}%'`);
  await client.query(`delete from node_crosswalk where crosswalk_value like '${PREFIX}%'`);
  await client.query(`delete from taxonomy_node where node_key like '${PREFIX}%'`);
}

beforeEach(cleanup);

/**
 * A capability node carrying exactly the codes a test needs.
 *
 * Built rather than borrowed from the seed taxonomy: the seeded nodes carry real-looking codes that
 * other fixtures also use, and a sizing test that shared them would measure the other tests.
 */
async function node(key: string, codes: readonly { type: 'naics' | 'psc'; value: string }[]): Promise<string> {
  const { rows } = await client.query<{ node_id: string }>(
    `insert into taxonomy_node (node_key, node_name, node_type, version, active)
     values ($1, $1 || ' capability', 'capability',
             (select version from taxonomy_version where is_current limit 1), true)
     returning node_id::text`,
    [key],
  );
  const nodeId = rows[0]!.node_id;
  for (const code of codes) {
    await client.query(
      `insert into node_crosswalk (node_id, crosswalk_type, crosswalk_value)
       values ($1::bigint, $2, $3)`,
      [nodeId, code.type, code.value],
    );
  }
  return nodeId;
}

interface AwardFixture {
  piid: string;
  fy: number;
  obligation?: number | null;
  office?: string;
  agency?: string;
  naics?: string | null;
  psc?: string | null;
  astrion?: boolean;
}

async function award(fixture: AwardFixture): Promise<void> {
  const entityId = fixture.astrion === true ? await astrionEntity() : await outsideEntity();
  // Signed in the middle of the given fiscal year: January is safely inside FY(year).
  const { rows } = await client.query<{ contract_action_id: string }>(
    `insert into contract_action (
       awarding_agency_code, piid, modification_number, transaction_number,
       signed_date, ultimate_completion_date, action_obligation, base_and_all_options,
       entity_id, contracting_agency_code, contracting_office_code, vendor_name_raw,
       entity_match_method, entity_match_confidence
     ) values ($1, $2, '0', '', $3::date, ($3::date + 1000), $4, $4, $5::bigint, $1, $6,
               'SYNTHETIC', 'confirmed_alias', 'confirmed')
     returning contract_action_id`,
    [
      fixture.agency ?? '9700',
      fixture.piid,
      `${fixture.fy}-01-15`,
      fixture.obligation === undefined ? 1_000_000 : fixture.obligation,
      entityId,
      fixture.office ?? `${PREFIX}OFF`,
    ],
  );
  const actionId = rows[0]!.contract_action_id;
  if (fixture.naics !== null) {
    await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1::bigint, 'naics', $2, true)`,
      [actionId, fixture.naics ?? `${PREFIX}100`],
    );
  }
  if (fixture.psc != null) {
    await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1::bigint, 'psc', $2, true)`,
      [actionId, fixture.psc],
    );
  }
}

async function astrionEntity(): Promise<number> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select entity_id from entity where canonical_name = 'Astrion'`,
  );
  return Number(rows[0]!.entity_id);
}

async function outsideEntity(): Promise<number> {
  const { rows } = await client.query<{ entity_id: string }>(
    `select e.entity_id from entity e
      where coalesce(e.ultimate_parent_id, e.entity_id) <>
            (select entity_id from entity where canonical_name = 'Astrion')
      order by e.entity_id limit 1`,
  );
  return Number(rows[0]!.entity_id);
}

async function makeCampaign(
  name: string,
  nodeKeys: readonly string[],
  offices: readonly string[],
): Promise<string> {
  const result = await createCampaign(client, {
    name,
    nodeKeys,
    offices,
    actor: ACTOR,
  });
  return result.campaignId;
}

/* ==================================================================== scope */

describe('defining a campaign', () => {
  it('attaches its nodes and offices, and names a node key that did not resolve', async () => {
    await node(`${PREFIX}-01`, [{ type: 'naics', value: `${PREFIX}100` }]);

    const result = await createCampaign(client, {
      name: `${PREFIX} flight test`,
      nodeKeys: [`${PREFIX}-01`, `${PREFIX}-NOPE`],
      offices: [`9700/${PREFIX}OFF`],
      actor: ACTOR,
    });

    expect(result.nodesAttached).toBe(1);
    expect(result.officesAttached).toBe(1);
    // A campaign quietly missing half its capability areas sizes small for the wrong reason.
    expect(result.unknownNodes).toEqual([`${PREFIX}-NOPE`]);
  });

  it('refuses a second campaign with the same name', async () => {
    await makeCampaign(`${PREFIX} duplicate`, [], []);
    await expect(makeCampaign(`${PREFIX} DUPLICATE`, [], [])).rejects.toThrow(/already exists/);
  });

  it('refuses an office that is not written as agency/office', async () => {
    await expect(
      createCampaign(client, { name: `${PREFIX} bad office`, nodeKeys: [], offices: ['ZOFF'], actor: ACTOR }),
    ).rejects.toThrow(/agency\/office/);
  });

  it('writes an audit row naming the actor', async () => {
    await makeCampaign(`${PREFIX} audited`, [], []);
    const { rows } = await client.query<{ actor: string; reason: string }>(
      `select actor, reason from audit_log where actor = $1 and object_type = 'campaign'`,
      [ACTOR],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toContain(`${PREFIX} audited`);
  });

  it('takes only the NAICS and PSC crosswalks, never the agency one', async () => {
    // An agency is not a code, and sizing against one would count everything that agency bought.
    const nodeId = await node(`${PREFIX}-02`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await client.query(
      `insert into node_crosswalk (node_id, crosswalk_type, crosswalk_value)
       values ($1::bigint, 'agency', '9700'), ($1::bigint, 'office_freetext', 'Test wings')`,
      [nodeId],
    );

    const id = await makeCampaign(`${PREFIX} codes only`, [`${PREFIX}-02`], []);
    const { rows } = await client.query<{ code_type: string; code_value: string }>(
      'select code_type, code_value from campaign_code where campaign_id = $1::bigint',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_type).toBe('naics');
  });
});

/* =================================================================== sizing */

describe('sizing', () => {
  it('counts an award once however many of the campaign codes it matches', async () => {
    // The trap: joining the codes rather than testing them multiplies the obligation by the number
    // of matching codes. The result stays a plausible-looking number, which is why it is asserted
    // against the exact figure and not against "greater than zero".
    await node(`${PREFIX}-03`, [
      { type: 'naics', value: `${PREFIX}100` },
      { type: 'psc', value: `${PREFIX}P1` },
    ]);
    await award({
      piid: `${PREFIX}A1`, fy: 2022, obligation: 1_000_000,
      naics: `${PREFIX}100`, psc: `${PREFIX}P1`,
    });

    const id = await makeCampaign(`${PREFIX} one award`, [`${PREFIX}-03`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(result.tamAwards).toBe(1);
    expect(Number(result.tamUsd)).toBe(1_000_000);
  });

  it('matches a code as a prefix, so a group covers its children', async () => {
    await node(`${PREFIX}-04`, [{ type: 'naics', value: `${PREFIX}1` }]);
    await award({ piid: `${PREFIX}A2`, fy: 2022, naics: `${PREFIX}100` });
    await award({ piid: `${PREFIX}A3`, fy: 2022, naics: `${PREFIX}199` });
    await award({ piid: `${PREFIX}A4`, fy: 2022, naics: `${PREFIX}900` });

    const id = await makeCampaign(`${PREFIX} prefix`, [`${PREFIX}-04`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);
    expect(result.tamAwards).toBe(2);
  });

  it('restricts the served market to the offices the campaign names', async () => {
    await node(`${PREFIX}-05`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}A5`, fy: 2022, obligation: 3_000_000, office: `${PREFIX}IN` });
    await award({ piid: `${PREFIX}A6`, fy: 2022, obligation: 7_000_000, office: `${PREFIX}OUT` });

    const id = await makeCampaign(`${PREFIX} scoped`, [`${PREFIX}-05`], [`9700/${PREFIX}IN`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(Number(result.tamUsd)).toBe(10_000_000);
    expect(Number(result.samUsd)).toBe(3_000_000);
  });

  it('gives a campaign with no offices no served market, rather than falling back to TAM', async () => {
    await node(`${PREFIX}-06`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}A7`, fy: 2022, obligation: 5_000_000 });

    const id = await makeCampaign(`${PREFIX} unscoped`, [`${PREFIX}-06`], []);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(Number(result.tamUsd)).toBe(5_000_000);
    expect(result.samUsd).toBeNull();
    expect(result.somUsd).toBeNull();
    expect(result.captureRate).toBeNull();
    expect(result.caveats.join(' ')).toMatch(/names no offices/);
  });

  it('measures the capture rate from the corpus and reports its sample size', async () => {
    await node(`${PREFIX}-07`, [{ type: 'naics', value: `${PREFIX}100` }]);
    // Astrion holds one of four awards by value: 250k of 1m.
    await award({ piid: `${PREFIX}B1`, fy: 2022, obligation: 250_000, astrion: true });
    await award({ piid: `${PREFIX}B2`, fy: 2022, obligation: 250_000 });
    await award({ piid: `${PREFIX}B3`, fy: 2022, obligation: 250_000 });
    await award({ piid: `${PREFIX}B4`, fy: 2022, obligation: 250_000 });

    const id = await makeCampaign(`${PREFIX} measured`, [`${PREFIX}-07`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(result.captureRate).toBeCloseTo(0.25, 5);
    expect(result.captureRateSampleSize).toBe(4);
    expect(Number(result.somUsd)).toBeCloseTo(250_000, 0);
  });

  it('never stores a capture rate apart from its sample size', async () => {
    // Acceptance test 9's actual property, asserted against the view both the screen and the CLI
    // read. A rate without a sample is a percentage nobody can weigh.
    await node(`${PREFIX}-08`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}C1`, fy: 2022, astrion: true });
    await makeCampaign(`${PREFIX} paired`, [`${PREFIX}-08`], [`9700/${PREFIX}OFF`]);
    await sizeAll(client, WINDOW, ACTOR);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from campaign_summary
        where (capture_rate is not null and capture_rate_sample_size is null)
           or (capture_rate_sample_size is not null and capture_rate is null)`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('always caveats TAM as a floor, and the caveat cannot be absent', async () => {
    await node(`${PREFIX}-09`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}D1`, fy: 2022 });

    const id = await makeCampaign(`${PREFIX} caveated`, [`${PREFIX}-09`], [`9700/${PREFIX}OFF`]);
    await sizeCampaign(client, id, WINDOW, ACTOR);

    const { rows } = await client.query<{ rule_id: string }>(
      `select rule_id from campaign_sizing_evidence
        where campaign_id = $1::bigint and figure = 'tam' and not supports`,
      [id],
    );
    expect(rows.map((r) => r.rule_id)).toContain('corpus_is_not_the_market');
  });

  it('flags a sample too small to be a rate', async () => {
    await node(`${PREFIX}-10`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}E1`, fy: 2022, astrion: true });
    await award({ piid: `${PREFIX}E2`, fy: 2022 });

    const id = await makeCampaign(`${PREFIX} thin`, [`${PREFIX}-10`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(result.caveats.join(' ')).toMatch(/is not a sample/);

    const { rows } = await client.query<{ capture_rate_standing: string }>(
      'select capture_rate_standing from campaign_summary where campaign_id = $1::bigint',
      [id],
    );
    expect(rows[0]!.capture_rate_standing).toBe('too few awards to be a rate');
  });

  it('respects the fiscal-year window', async () => {
    await node(`${PREFIX}-11`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}F1`, fy: 2019 });
    await award({ piid: `${PREFIX}F2`, fy: 2022 });
    await award({ piid: `${PREFIX}F3`, fy: 2026 });

    const id = await makeCampaign(`${PREFIX} windowed`, [`${PREFIX}-11`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, { fyFrom: 2021, fyTo: 2024 }, ACTOR);
    expect(result.tamAwards).toBe(1);
  });

  it('records the window it was sized over, so the figure can be reproduced', async () => {
    await node(`${PREFIX}-12`, [{ type: 'naics', value: `${PREFIX}100` }]);
    const id = await makeCampaign(`${PREFIX} reproducible`, [`${PREFIX}-12`], []);
    await sizeCampaign(client, id, WINDOW, ACTOR);

    const { rows } = await client.query<{ sizing_fy_from: number; sizing_fy_to: number }>(
      'select sizing_fy_from, sizing_fy_to from campaign where campaign_id = $1::bigint',
      [id],
    );
    expect(rows[0]!.sizing_fy_from).toBe(2020);
    expect(rows[0]!.sizing_fy_to).toBe(2024);
  });

  it('says nothing to size against when the nodes carry no codes', async () => {
    await node(`${PREFIX}-13`, []);
    const id = await makeCampaign(`${PREFIX} codeless`, [`${PREFIX}-13`], [`9700/${PREFIX}OFF`]);
    const result = await sizeCampaign(client, id, WINDOW, ACTOR);

    expect(result.tamUsd).toBeNull();
    expect(result.caveats.join(' ')).toMatch(/crosswalks to a NAICS or PSC code/);
  });

  it('rewrites its evidence rather than accumulating it', async () => {
    await node(`${PREFIX}-14`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await award({ piid: `${PREFIX}G1`, fy: 2022 });
    const id = await makeCampaign(`${PREFIX} rewritten`, [`${PREFIX}-14`], [`9700/${PREFIX}OFF`]);

    await sizeCampaign(client, id, WINDOW, ACTOR);
    const first = await client.query<{ n: string }>(
      'select count(*)::text as n from campaign_sizing_evidence where campaign_id = $1::bigint',
      [id],
    );
    await sizeCampaign(client, id, WINDOW, ACTOR);
    const second = await client.query<{ n: string }>(
      'select count(*)::text as n from campaign_sizing_evidence where campaign_id = $1::bigint',
      [id],
    );
    expect(second.rows[0]!.n).toBe(first.rows[0]!.n);
  });

  it('excludes the current fiscal year from the default window', async () => {
    // A partial year in the denominator moves the capture rate for reasons about the calendar.
    const window = await defaultWindow(client);
    const { rows } = await client.query<{ fy: number }>('select cie_fiscal_year(current_date) as fy');
    expect(window.fyTo).toBe(rows[0]!.fy - 1);
    expect(window.fyFrom).toBeLessThan(window.fyTo);
  });
});

/* ================================================================ gap report */

describe('the gap report', () => {
  async function requirement(key: string, naics: string | null): Promise<string> {
    const { rows } = await client.query<{ pursuit_id: string }>(
      `insert into pursuit (signal_class, title, naics_code, signal_key, generated_by)
       values ('active_solicitation', $1, $2, $1, 'test')
       returning pursuit_id::text`,
      [`${PREFIX}${key}`, naics],
    );
    return rows[0]!.pursuit_id;
  }

  it('lists a requirement no campaign claims', async () => {
    await requirement('GAP1', `${PREFIX}100`);
    const { rows } = await client.query<{ title: string }>(
      `select title from campaign_gap where title = $1`,
      [`${PREFIX}GAP1`],
    );
    expect(rows).toHaveLength(1);
  });

  it('names the campaign whose codes it would match', async () => {
    await node(`${PREFIX}-20`, [{ type: 'naics', value: `${PREFIX}100` }]);
    await makeCampaign(`${PREFIX} claimant`, [`${PREFIX}-20`], []);
    await requirement('GAP2', `${PREFIX}100`);

    const { rows } = await client.query<{ would_match: string | null }>(
      'select would_match from campaign_gap where title = $1',
      [`${PREFIX}GAP2`],
    );
    expect(rows[0]!.would_match).toContain(`${PREFIX} claimant`);
  });

  it('marks a requirement no campaign could claim on codes alone', async () => {
    await requirement('GAP3', null);
    const { rows } = await client.query<{ uncodeable: boolean; would_match: string | null }>(
      'select uncodeable, would_match from campaign_gap where title = $1',
      [`${PREFIX}GAP3`],
    );
    expect(rows[0]!.uncodeable).toBe(true);
    expect(rows[0]!.would_match).toBeNull();
  });

  it('leaves the report once a campaign claims it', async () => {
    await node(`${PREFIX}-21`, [{ type: 'naics', value: `${PREFIX}100` }]);
    const id = await makeCampaign(`${PREFIX} assigner`, [`${PREFIX}-21`], []);
    await requirement('GAP4', `${PREFIX}100`);

    const result = await assignMatching(client, id, ACTOR);
    expect(result.assigned).toBeGreaterThan(0);

    const { rows } = await client.query(
      'select 1 from campaign_gap where title = $1',
      [`${PREFIX}GAP4`],
    );
    expect(rows).toHaveLength(0);
  });

  it('never reassigns a requirement somebody already put in a campaign', async () => {
    // A code match is weaker evidence than a person.
    await node(`${PREFIX}-22`, [{ type: 'naics', value: `${PREFIX}100` }]);
    const first = await makeCampaign(`${PREFIX} first`, [`${PREFIX}-22`], []);
    const second = await makeCampaign(`${PREFIX} second`, [`${PREFIX}-22`], []);
    const pursuitId = await requirement('GAP5', `${PREFIX}100`);

    await assignMatching(client, first, ACTOR);
    await assignMatching(client, second, ACTOR);

    const { rows } = await client.query<{ campaign_id: string }>(
      'select campaign_id::text from pursuit where pursuit_id = $1::bigint',
      [pursuitId],
    );
    expect(rows[0]!.campaign_id).toBe(first);
  });

  it('writes an audit row per assignment', async () => {
    await node(`${PREFIX}-23`, [{ type: 'naics', value: `${PREFIX}100` }]);
    const id = await makeCampaign(`${PREFIX} audited assign`, [`${PREFIX}-23`], []);
    await requirement('GAP6', `${PREFIX}100`);
    await assignMatching(client, id, ACTOR);

    const { rows } = await client.query<{ reason: string }>(
      `select reason from audit_log
        where actor = $1 and object_type = 'pursuit' and reason like '%code match%'`,
      [ACTOR],
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('leaves market movement out, because a finished award is a different report', async () => {
    await client.query(
      `insert into pursuit (signal_class, title, naics_code, signal_key, generated_by)
       values ('market_movement', $1, $2, $1, 'test')`,
      [`${PREFIX}GAP7`, `${PREFIX}100`],
    );
    const { rows } = await client.query('select 1 from campaign_gap where title = $1', [`${PREFIX}GAP7`]);
    expect(rows).toHaveLength(0);
  });
});
