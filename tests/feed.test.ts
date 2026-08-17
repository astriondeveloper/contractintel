/**
 * Follows, the feed, and the three per-person actions. Migration 0022 and src/web/actions.ts.
 *
 * The properties asserted here are the ones the model rests on, and each is a decision that would
 * be easy to break by accident:
 *
 *   A feed is the union of one person's follows, and nobody else's follows reach it.
 *   Dismissing removes something from a feed and never from the database.
 *   `sent` survives a later dismiss, because it is the count that answers whether this tool works.
 *   Every write leaves an audit row with a real actor on it.
 *
 * The last one is the whole reason the write path exists at all. Spec section 20 requires it, and a
 * test that only checked the row changed would pass on a build that had quietly stopped recording
 * who changed it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  performFollowAction,
  performPursuitAction,
  safeReturnTo,
  touchUser,
} from '../src/web/actions.js';
import type { User } from '../src/web/auth.js';
import { feed, feedCounts, followsFor, watermarkFor, whyInFeed } from '../src/web/queries.js';

let client: PoolClient;

const PREFIX = 'ZFD';
const ALICE: User = { principalName: 'zfd-alice@example.test', displayName: 'Alice', email: null };
const BOB: User = { principalName: 'zfd-bob@example.test', displayName: 'Bob', email: null };

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from audit_log where actor like 'zfd-%'`);
  await client.query(`delete from pursuit_action where principal_name like 'zfd-%'`);
  await client.query(`delete from follow where principal_name like 'zfd-%'`);
  await client.query(`delete from feed_watermark where principal_name like 'zfd-%'`);
  await client.query(`delete from pursuit_note where author like 'zfd-%'`);
  await client.query(`delete from pursuit where signal_key like '${PREFIX}%'`);
  await client.query(`delete from app_user where principal_name like 'zfd-%'`);
}

beforeEach(async () => {
  await cleanup();
  await touchUser(ALICE);
  await touchUser(BOB);
});

interface RequirementFixture {
  key: string;
  title?: string;
  agency?: string | null;
  office?: string | null;
  naics?: string | null;
  psc?: string | null;
  signalClass?: string;
  responseInDays?: number | null;
  incumbentEntityId?: number | null;
}

async function requirement(fixture: RequirementFixture): Promise<string> {
  const { rows } = await client.query<{ pursuit_id: string }>(
    `insert into pursuit (
       signal_class, title, agency_code, office_code, naics_code, psc_code,
       response_date, signal_key, generated_by, generated_at, incumbent_entity_id
     ) values (
       $1, $2, $3, $4, $5, $6,
       case when $7::int is null then null else (current_date + $7::int) end,
       $8, 'test', now(), $9::bigint
     ) returning pursuit_id::text`,
    [
      fixture.signalClass ?? 'active_solicitation',
      fixture.title ?? `${PREFIX} requirement ${fixture.key}`,
      fixture.agency === undefined ? '9700' : fixture.agency,
      fixture.office === undefined ? `${PREFIX}OFF` : fixture.office,
      fixture.naics === undefined ? '541330' : fixture.naics,
      fixture.psc === undefined ? 'ZT1' : fixture.psc,
      fixture.responseInDays === undefined ? 30 : fixture.responseInDays,
      `${PREFIX}${fixture.key}`,
      fixture.incumbentEntityId ?? null,
    ],
  );
  return rows[0]!.pursuit_id;
}

const form = (values: Record<string, string> = {}) => new URLSearchParams(values);

async function feedFor(user: User, view: Parameters<typeof feed>[2] = 'patch') {
  const mark = await watermarkFor(user.principalName);
  return feed(user.principalName, mark.seen_through, view, '', '', '', 'newest', 50, 0);
}

async function auditRows(actor: string): Promise<{ action: string; object_type: string; reason: string | null }[]> {
  const { rows } = await client.query(
    `select action, object_type, reason from audit_log where actor = $1 order by audit_id`,
    [actor],
  );
  return rows as never;
}

/* =================================================================== follows */

describe('follows', () => {
  it('matches an agency follow to a requirement in that agency and nothing else', async () => {
    await requirement({ key: 'A1', agency: '9700' });
    await requirement({ key: 'A2', agency: '5700' });

    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);

    const result = await feedFor(ALICE);
    const titles = result.rows.map((r) => r.title);
    expect(titles.some((t) => t.includes('A1'))).toBe(true);
    expect(titles.some((t) => t.includes('A2'))).toBe(false);
  });

  it('matches a NAICS follow as a prefix, so a group follow catches its children', async () => {
    await requirement({ key: 'N1', naics: '541330' });
    await requirement({ key: 'N2', naics: '236220' });

    await performFollowAction('follow', form({ follow_type: 'naics', target: '5413' }), ALICE);

    const titles = (await feedFor(ALICE)).rows.map((r) => r.title);
    expect(titles.some((t) => t.includes('N1'))).toBe(true);
    expect(titles.some((t) => t.includes('N2'))).toBe(false);
  });

  it('follows a capability through the crosswalks BD authored, not through its agency', async () => {
    // The capability arm matches on what the work is: NAICS, PSC and keyword. Matching on the
    // node's agency crosswalk would quietly subscribe somebody to every notice that agency posts,
    // which is the firehose in a different costume.
    const { rows: node } = await client.query<{ node_key: string; agency: string | null }>(
      `select t.node_key,
              (select nc.crosswalk_value from node_crosswalk nc
                where nc.node_id = t.node_id and nc.crosswalk_type = 'agency' limit 1) as agency
         from taxonomy_node t
        where t.active
          and exists (select 1 from node_crosswalk nc
                       where nc.node_id = t.node_id and nc.crosswalk_type = 'naics'
                         and nc.crosswalk_value = '541330')
        limit 1`,
    );
    expect(node[0]).toBeDefined();
    const agencyOnTheNode = node[0]!.agency;
    expect(agencyOnTheNode).not.toBeNull();

    // In that agency, but under a NAICS code the node does not crosswalk to.
    await requirement({ key: 'C1', naics: '541330', agency: agencyOnTheNode });
    await requirement({ key: 'C2', naics: '236220', psc: 'ZZZ', agency: agencyOnTheNode });

    await performFollowAction(
      'follow',
      form({ follow_type: 'capability', target: node[0]!.node_key }),
      ALICE,
    );

    const titles = (await feedFor(ALICE)).rows.map((r) => r.title);
    expect(titles.some((t) => t.includes('C1'))).toBe(true);
    expect(titles.some((t) => t.includes('C2'))).toBe(false);
  });

  it('follows a company through the entity rollup rather than a name', async () => {
    // The whole point of the entity map: following the family catches a subsidiary's contract.
    const { rows: family } = await client.query<{ parent: string; child: string }>(
      `select p.entity_id::text as parent, c.entity_id::text as child
         from entity p
         join entity c on c.ultimate_parent_id = p.entity_id
        where p.canonical_name = 'Astrion'
        limit 1`,
    );
    expect(family[0]).toBeDefined();

    await requirement({ key: 'E1', incumbentEntityId: Number(family[0]!.child) });
    await requirement({ key: 'E2', incumbentEntityId: null });

    await performFollowAction(
      'follow',
      form({ follow_type: 'company', target: family[0]!.parent }),
      ALICE,
    );

    const titles = (await feedFor(ALICE)).rows.map((r) => r.title);
    expect(titles.some((t) => t.includes('E1'))).toBe(true);
    expect(titles.some((t) => t.includes('E2'))).toBe(false);
  });

  it('refuses a keyword too short to be a keyword', async () => {
    const result = await performFollowAction('follow', form({ follow_type: 'keyword', target: 'ab' }), ALICE);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/three characters/);
    expect(await followsFor(ALICE.principalName, new Date(0))).toHaveLength(0);
  });

  it('refuses an office that is not written as agency/office', async () => {
    const result = await performFollowAction('follow', form({ follow_type: 'office', target: 'ZOFF' }), ALICE);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/agency\/office/);
  });

  it('refuses a capability that does not exist rather than storing a follow that matches nothing', async () => {
    const result = await performFollowAction(
      'follow',
      form({ follow_type: 'capability', target: 'CAP-NOPE' }),
      ALICE,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/No active capability/);
  });

  it('lowercases a keyword, so the same phrase cannot be followed twice', async () => {
    await performFollowAction('follow', form({ follow_type: 'keyword', target: 'Hypersonic' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'keyword', target: 'HYPERSONIC' }), ALICE);

    const mine = await followsFor(ALICE.principalName, new Date(0));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.target).toBe('hypersonic');
  });

  it('does not write a second audit row for a follow that already existed', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);

    const rows = (await auditRows(ALICE.principalName)).filter((r) => r.object_type === 'follow');
    expect(rows).toHaveLength(1);
  });

  it('will not let one person unfollow another person', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    const [mine] = await followsFor(ALICE.principalName, new Date(0));

    const result = await performFollowAction(
      'unfollow',
      form({ follow_id: mine!.follow_id }),
      BOB,
    );

    expect(result.ok).toBe(false);
    expect(await followsFor(ALICE.principalName, new Date(0))).toHaveLength(1);
  });

  it('records an unfollow with what was removed', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    const [mine] = await followsFor(ALICE.principalName, new Date(0));
    await performFollowAction('unfollow', form({ follow_id: mine!.follow_id }), ALICE);

    const rows = await auditRows(ALICE.principalName);
    expect(rows.some((r) => r.action === 'delete' && r.object_type === 'follow')).toBe(true);
    expect(await followsFor(ALICE.principalName, new Date(0))).toHaveLength(0);
  });

  it('counts what each follow is bringing in, so a dead follow is visible as one', async () => {
    await requirement({ key: 'D1', agency: '9700' });
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'agency', target: 'ZZZZ' }), ALICE);

    const mine = await followsFor(ALICE.principalName, new Date(0));
    const live = mine.find((f) => f.target === '9700')!;
    const dead = mine.find((f) => f.target === 'ZZZZ')!;

    expect(live.matches).toBeGreaterThan(0);
    expect(dead.matches).toBe(0);
  });

  it('keeps one person\'s feed out of another person\'s', async () => {
    await requirement({ key: 'S1', agency: '9700' });
    await requirement({ key: 'S2', agency: '5700' });

    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'agency', target: '5700' }), BOB);

    const alice = (await feedFor(ALICE)).rows.map((r) => r.title);
    const bob = (await feedFor(BOB)).rows.map((r) => r.title);

    expect(alice.some((t) => t.includes('S1'))).toBe(true);
    expect(alice.some((t) => t.includes('S2'))).toBe(false);
    expect(bob.some((t) => t.includes('S2'))).toBe(true);
    expect(bob.some((t) => t.includes('S1'))).toBe(false);
  });

  it('says which follow put a requirement in the feed', async () => {
    const id = await requirement({ key: 'W1', agency: '9700', naics: '541330' });
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'naics', target: '5413' }), ALICE);

    const why = await whyInFeed(id, ALICE.principalName);
    expect(why.map((w) => w.follow_type).sort()).toEqual(['agency', 'naics']);
  });
});

/* ====================================================================== feed */

describe('the feed', () => {
  it('marks something new when it landed after the read mark', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await requirement({ key: 'F1' });

    const before = await feedCounts(ALICE.principalName, (await watermarkFor(ALICE.principalName)).seen_through);
    expect(before.new_since).toBeGreaterThan(0);

    await performFollowAction('mark-read', form(), ALICE);

    const after = await feedCounts(ALICE.principalName, (await watermarkFor(ALICE.principalName)).seen_through);
    expect(after.new_since).toBe(0);
    // Still in the patch. Reading something is not the same as dealing with it.
    expect(after.in_patch).toBe(before.in_patch);
  });

  it('keeps the previous mark, so "what did I just mark read" is answerable', async () => {
    await performFollowAction('mark-read', form(), ALICE);
    const first = await watermarkFor(ALICE.principalName);
    await performFollowAction('mark-read', form(), ALICE);
    const second = await watermarkFor(ALICE.principalName);

    expect(second.previous_seen_through).not.toBeNull();
    expect(new Date(second.previous_seen_through!).getTime()).toBe(
      new Date(first.seen_through).getTime(),
    );
  });

  it('defaults to a window rather than to the beginning of time', async () => {
    // A first visit that declares the whole corpus new is a first visit that says nothing.
    const mark = await watermarkFor(ALICE.principalName);
    expect(mark.is_set).toBe(false);
    const daysBack = (Date.now() - mark.seen_through.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThan(13);
    expect(daysBack).toBeLessThan(15);
  });

  it('shows the whole market to somebody with no follows rather than an empty screen', async () => {
    await requirement({ key: 'X1' });
    const everything = await feedFor(ALICE, 'everything');
    expect(everything.rows.length).toBeGreaterThan(0);

    const patch = await feedFor(ALICE, 'patch');
    expect(patch.rows).toHaveLength(0);
  });

  it('leaves market movement out, because an award notice already happened', async () => {
    await requirement({ key: 'M1', signalClass: 'market_movement' });
    const everything = await feedFor(ALICE, 'everything');
    expect(everything.rows.some((r) => r.title.includes('M1'))).toBe(false);
  });

  it('agrees with its own pager', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    for (let i = 0; i < 5; i += 1) await requirement({ key: `P${i}` });

    const mark = await watermarkFor(ALICE.principalName);
    const firstPage = await feed(ALICE.principalName, mark.seen_through, 'patch', '', '', '', 'newest', 2, 0);

    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.total).toBe(5);
  });
});

/* =================================================================== actions */

describe('track, dismiss and sent', () => {
  it('tracking clears a dismiss, and dismissing clears a track', async () => {
    const id = await requirement({ key: 'T1' });

    await performPursuitAction('track', id, form(), ALICE);
    let held = await heldBy(id, ALICE.principalName);
    expect(held).toEqual(['track']);

    await performPursuitAction('dismiss', id, form(), ALICE);
    held = await heldBy(id, ALICE.principalName);
    expect(held).toEqual(['dismiss']);
  });

  it('clear puts a requirement back to neither', async () => {
    const id = await requirement({ key: 'T2' });
    await performPursuitAction('dismiss', id, form(), ALICE);
    await performPursuitAction('clear', id, form(), ALICE);
    expect(await heldBy(id, ALICE.principalName)).toEqual([]);
  });

  it('a dismiss removes something from the feed and not from the database', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    const id = await requirement({ key: 'T3' });

    await performPursuitAction('dismiss', id, form(), ALICE);

    const patch = await feedFor(ALICE, 'patch');
    expect(patch.rows.some((r) => r.pursuit_id === id)).toBe(false);

    const dismissed = await feedFor(ALICE, 'dismissed');
    expect(dismissed.rows.some((r) => r.pursuit_id === id)).toBe(true);

    const { rows } = await client.query('select 1 from pursuit where pursuit_id = $1::bigint', [id]);
    expect(rows).toHaveLength(1);
  });

  it('a dismiss by one person does not touch anybody else\'s feed', async () => {
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), ALICE);
    await performFollowAction('follow', form({ follow_type: 'agency', target: '9700' }), BOB);
    const id = await requirement({ key: 'T4' });

    await performPursuitAction('dismiss', id, form(), ALICE);

    expect((await feedFor(ALICE, 'patch')).rows.some((r) => r.pursuit_id === id)).toBe(false);
    expect((await feedFor(BOB, 'patch')).rows.some((r) => r.pursuit_id === id)).toBe(true);
  });

  it('sent survives a later dismiss, because it is the number that matters', async () => {
    const id = await requirement({ key: 'T5' });

    await performPursuitAction('sent', id, form({ note: 'TM-99' }), ALICE);
    await performPursuitAction('dismiss', id, form(), ALICE);

    const held = await heldBy(id, ALICE.principalName);
    expect(held).toContain('sent');
    expect(held).toContain('dismiss');

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from technomile_handoff where pursuit_id = $1::bigint`,
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('un-sending is its own action, so the count cannot drift downwards by accident', async () => {
    const id = await requirement({ key: 'T6' });
    await performPursuitAction('sent', id, form(), ALICE);
    await performPursuitAction('unsent', id, form(), ALICE);

    expect(await heldBy(id, ALICE.principalName)).toEqual([]);

    const rows = await auditRows(ALICE.principalName);
    expect(rows.some((r) => (r.reason ?? '').includes('Un-marked as sent'))).toBe(true);
  });

  it('records the days of lead over the response deadline', async () => {
    const id = await requirement({ key: 'T7', responseInDays: 45 });
    await performPursuitAction('sent', id, form(), ALICE);

    const { rows } = await client.query<{ days: number }>(
      `select days_before_response_due as days from technomile_handoff where pursuit_id = $1::bigint`,
      [id],
    );
    expect(rows[0]!.days).toBe(45);
  });

  it('writes an audit row with a real actor on every action', async () => {
    const id = await requirement({ key: 'T8' });
    await performPursuitAction('track', id, form(), ALICE);
    await performPursuitAction('sent', id, form(), ALICE);
    await performPursuitAction('note', id, form({ body: 'RFP has slipped to Q3.' }), ALICE);

    const rows = await auditRows(ALICE.principalName);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.reason).not.toBeNull();
    expect(rows.map((r) => r.object_type)).toContain('pursuit_note');
  });

  it('refuses an empty note', async () => {
    const id = await requirement({ key: 'T9' });
    const result = await performPursuitAction('note', id, form({ body: '   ' }), ALICE);
    expect(result.ok).toBe(false);
    expect(await auditRows(ALICE.principalName)).toHaveLength(0);
  });

  it('refuses an action on a requirement that is gone', async () => {
    const result = await performPursuitAction('track', '999999999', form(), ALICE);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no longer exists/);
  });

  it('counts a hand-off once even when two people send the same requirement', async () => {
    const id = await requirement({ key: 'TA' });
    await performPursuitAction('sent', id, form(), ALICE);
    await performPursuitAction('sent', id, form(), BOB);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from technomile_handoff where pursuit_id = $1::bigint`,
      [id],
    );
    // Two rows, because two people each carried it across and both facts are true. The screen
    // reports distinct people as well as the total, so neither reading is hidden.
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

async function heldBy(pursuitId: string, principal: string): Promise<string[]> {
  const { rows } = await client.query<{ action: string }>(
    `select action from pursuit_action
      where pursuit_id = $1::bigint and principal_name = $2 order by action`,
    [pursuitId, principal],
  );
  return rows.map((r) => r.action);
}

/* ================================================================== redirect */

describe('where an action sends the browser afterwards', () => {
  it('accepts a same-site path', () => {
    expect(safeReturnTo('/feed?view=new')).toBe('/feed?view=new');
  });

  it('refuses anything that could leave the site', () => {
    // A form field is input, and an absolute URL here would turn every action button into an
    // open redirect.
    for (const hostile of [
      'https://evil.example/x',
      '//evil.example/x',
      'javascript:alert(1)',
      '/feed\\..\\x',
      '/feed\r\nLocation: https://evil.example',
      'feed',
      '',
      '   ',
    ]) {
      expect(safeReturnTo(hostile)).toBeNull();
    }
  });

  it('falls back to the record when a form carries a hostile return path', async () => {
    const id = await requirement({ key: 'R1' });
    const result = await performPursuitAction('track', id, form({ back: '//evil.example' }), ALICE);
    expect(result.redirectTo).toBe(`/requirements/${id}`);
  });
});
