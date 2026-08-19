/**
 * GovWin reaching a person: the follow matching, the early view, and the screen.
 *
 * Migration 0027 loaded the data and gave it nowhere to appear, which was an omission rather than a
 * staged rollout — a requirement nobody can see is worth nothing. These assert the path from a follow to
 * a screen, and the two ways this source silently cannot reach somebody.
 *
 * No GovWin data is committed: every row here is invented and ZGF-prefixed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import { touchUser } from '../src/web/actions.js';
import type { User } from '../src/web/auth.js';
import {
  govwinCoverage,
  govwinForFollows,
  govwinOpportunities,
  govwinOpportunity,
  govwinPatchCount,
  whyInGovwinPatch,
} from '../src/web/queries.js';
import { expectedDate } from '../src/web/pages/govwin.js';
import { toString as htmlToString } from '../src/web/html.js';

let client: PoolClient;

const PREFIX = 'ZGF';
const ALICE: User = { principalName: 'zgf-alice@example.test', displayName: 'Alice', email: null };
const BOB: User = { principalName: 'zgf-bob@example.test', displayName: 'Bob', email: null };

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from follow where principal_name like 'zgf-%'`);
  await client.query(`delete from app_user where principal_name like 'zgf-%'`);
  await client.query(`delete from govwin_opportunity where govwin_id like '${PREFIX}%'`);
}

beforeEach(async () => {
  await cleanup();
  await touchUser(ALICE);
  await touchUser(BOB);
});

interface Fixture {
  id: string;
  status?: string;
  program?: string;
  agencyCode?: string | null;
  naics?: readonly string[];
  expected?: string | null;
  precision?: 'day' | 'month';
  basis?: string | null;
  value?: number | null;
}

async function govwin(f: Fixture): Promise<void> {
  await client.query(
    `insert into govwin_opportunity (
       govwin_id, opp_type, status, program_name, agency_code, value_usd,
       solicitation_date, solicitation_date_precision, solicitation_date_basis, govwin_url
     ) values ($1, 'Tracked Opportunities', $2, $3, $4, $5::numeric, $6::date, $7, $8, $9)`,
    [
      f.id,
      f.status ?? 'Pre-RFP',
      f.program ?? `${PREFIX} example requirement ${f.id}`,
      f.agencyCode === undefined ? null : f.agencyCode,
      f.value === undefined ? 50_000_000 : f.value,
      f.expected === undefined ? '2027-06-01' : f.expected,
      f.precision ?? 'month',
      f.basis === undefined ? 'deltek_estimate' : f.basis,
      `https://iq.govwin.com/neo/opportunity/view/${f.id}`,
    ],
  );
  for (const [index, code] of (f.naics ?? ['541330']).entries()) {
    await client.query(
      `insert into govwin_opportunity_naics (govwin_id, naics_code, is_primary) values ($1,$2,$3)`,
      [f.id, code, index === 0],
    );
  }
}

async function follow(user: User, type: string, target: string, extra: Record<string, string> = {}): Promise<void> {
  await client.query(
    `insert into follow (principal_name, follow_type, target, label, agency_code, office_code)
     values ($1, $2, $3, $4, $5, $6)`,
    [user.principalName, type, target, target, extra.agency_code ?? null, extra.office_code ?? null],
  );
}

describe('a follow reaches a GovWin record', () => {
  it('matches a raw NAICS follow as a prefix', async () => {
    await govwin({ id: `${PREFIX}1`, naics: ['541330'] });
    await govwin({ id: `${PREFIX}2`, naics: ['236220'] });
    await follow(ALICE, 'naics', '5413');

    const rows = await govwinForFollows(ALICE.principalName, 20);
    const ids = rows.map((r) => r.govwin_id).filter((id) => id.startsWith(PREFIX));
    expect(ids).toContain(`${PREFIX}1`);
    expect(ids).not.toContain(`${PREFIX}2`);
  });

  it('matches an agency follow through the resolved code', async () => {
    await govwin({ id: `${PREFIX}3`, agencyCode: 'ZG97' });
    await govwin({ id: `${PREFIX}4`, agencyCode: 'ZG57' });
    await follow(ALICE, 'agency', 'ZG97', { agency_code: 'ZG97' });

    const ids = (await govwinForFollows(ALICE.principalName, 20))
      .map((r) => r.govwin_id)
      .filter((id) => id.startsWith(PREFIX));
    expect(ids).toContain(`${PREFIX}3`);
    expect(ids).not.toContain(`${PREFIX}4`);
  });

  it('matches a keyword follow against the programme name', async () => {
    await govwin({ id: `${PREFIX}5`, program: `${PREFIX} hypersonic test support` });
    await govwin({ id: `${PREFIX}6`, program: `${PREFIX} facilities maintenance` });
    await follow(ALICE, 'keyword', 'hypersonic');

    const ids = (await govwinForFollows(ALICE.principalName, 20))
      .map((r) => r.govwin_id)
      .filter((id) => id.startsWith(PREFIX));
    expect(ids).toContain(`${PREFIX}5`);
    expect(ids).not.toContain(`${PREFIX}6`);
  });

  it('says which follow put it there', async () => {
    await govwin({ id: `${PREFIX}7`, naics: ['541330'] });
    await follow(ALICE, 'naics', '5413');

    const why = await whyInGovwinPatch(`${PREFIX}7`, ALICE.principalName);
    expect(why.length).toBeGreaterThan(0);
    expect(why[0]!.matched_field).toBe('naics');
  });

  it('scopes per person', async () => {
    await govwin({ id: `${PREFIX}8`, naics: ['541330'] });
    await follow(ALICE, 'naics', '5413');
    await follow(BOB, 'naics', '9999');

    const alice = await govwinPatchCount(ALICE.principalName);
    const bob = await govwinPatchCount(BOB.principalName);
    expect(alice).toBeGreaterThan(0);
    expect(bob).toBe(0);
  });

  it('shows the early slice unscoped to somebody with no follows', async () => {
    // Same fallback the feed makes for requirements: an empty screen on day one is how a tool gets
    // written off before it is ever configured.
    await govwin({ id: `${PREFIX}9` });
    const ids = (await govwinForFollows(ALICE.principalName, 20)).map((r) => r.govwin_id);
    expect(ids).toContain(`${PREFIX}9`);
  });

  it('carries only what is not advertised yet', async () => {
    await govwin({ id: `${PREFIX}A`, status: 'Pre-RFP' });
    await govwin({ id: `${PREFIX}B`, status: 'Forecast Pre-RFP' });
    await govwin({ id: `${PREFIX}C`, status: 'Awarded' });
    await govwin({ id: `${PREFIX}D`, status: 'Expired/Archived' });

    const ids = (await govwinForFollows(ALICE.principalName, 50))
      .map((r) => r.govwin_id)
      .filter((id) => id.startsWith(PREFIX));
    expect(ids.sort()).toEqual([`${PREFIX}A`, `${PREFIX}B`]);
  });
});

describe('what this source cannot reach, counted rather than hidden', () => {
  it('counts a PSC follow as unable to match, because the export has no PSC', async () => {
    await govwin({ id: `${PREFIX}E` });
    await follow(ALICE, 'psc', 'R4');

    const coverage = await govwinCoverage();
    expect(coverage.psc_follows_that_cannot_match).toBeGreaterThan(0);
    // And it genuinely matches nothing, rather than matching by accident.
    expect(await govwinPatchCount(ALICE.principalName)).toBe(0);
  });

  it('counts a company follow as unable to match, because incumbents are unparsed', async () => {
    await govwin({ id: `${PREFIX}F` });
    const { rows } = await client.query<{ entity_id: string }>(`select entity_id from entity limit 1`);
    await client.query(
      `insert into follow (principal_name, follow_type, target, label, entity_id)
       values ($1, 'company', 'Example', 'Example', $2::bigint)`,
      [ALICE.principalName, rows[0]!.entity_id],
    );

    const coverage = await govwinCoverage();
    expect(coverage.company_follows_that_cannot_match).toBeGreaterThan(0);
  });

  it('counts a row with no agency code as unreachable by an agency follow', async () => {
    await govwin({ id: `${PREFIX}G`, agencyCode: null });
    await follow(ALICE, 'agency', 'ZG97', { agency_code: 'ZG97' });

    expect(await govwinPatchCount(ALICE.principalName)).toBe(0);
    const coverage = await govwinCoverage();
    expect(coverage.agency_unresolved).toBeGreaterThan(0);
  });
});

describe('the screen', () => {
  it('opens on the early slice rather than on everything', async () => {
    await govwin({ id: `${PREFIX}H`, status: 'Pre-RFP' });
    await govwin({ id: `${PREFIX}I`, status: 'Expired/Archived' });

    const early = await govwinOpportunities('', '', '', 'early', 'soonest', 50, 0);
    const ids = early.rows.map((r) => r.govwin_id).filter((id) => id.startsWith(PREFIX));
    expect(ids).toContain(`${PREFIX}H`);
    expect(ids).not.toContain(`${PREFIX}I`);
  });

  it('shows everything when asked', async () => {
    await govwin({ id: `${PREFIX}J`, status: 'Expired/Archived' });
    const all = await govwinOpportunities('', '', '', 'all', 'soonest', 50, 0);
    expect(all.rows.map((r) => r.govwin_id)).toContain(`${PREFIX}J`);
  });

  it('sorts a row with no expected date last rather than first', async () => {
    // Soonest-first with nulls first would say an undated requirement was imminent.
    await govwin({ id: `${PREFIX}K`, expected: null, precision: 'month' });
    await govwin({ id: `${PREFIX}L`, expected: '2027-01-01' });

    const rows = (await govwinOpportunities('', '', '', 'early', 'soonest', 50, 0)).rows
      .filter((r) => r.govwin_id.startsWith(PREFIX))
      .map((r) => r.govwin_id);
    expect(rows.indexOf(`${PREFIX}L`)).toBeLessThan(rows.indexOf(`${PREFIX}K`));
  });

  it('filters by NAICS prefix', async () => {
    await govwin({ id: `${PREFIX}M`, naics: ['541330'] });
    await govwin({ id: `${PREFIX}N`, naics: ['236220'] });

    const rows = (await govwinOpportunities('', '', '5413', 'early', 'soonest', 50, 0)).rows
      .map((r) => r.govwin_id)
      .filter((id) => id.startsWith(PREFIX));
    expect(rows).toEqual([`${PREFIX}M`]);
  });

  it('searches the programme name', async () => {
    await govwin({ id: `${PREFIX}O`, program: `${PREFIX} hypersonic wind tunnel` });
    const rows = (await govwinOpportunities('hypersonic', '', '', 'early', 'soonest', 50, 0)).rows;
    expect(rows.map((r) => r.govwin_id)).toContain(`${PREFIX}O`);
  });

  it('reports how many requirements share a solicitation number', async () => {
    await client.query(
      `insert into govwin_opportunity (govwin_id, opp_type, status, program_name, solicitation_number)
       values ($1, 'Tracked Opportunities', 'Pre-RFP', 'Example', $2)`,
      [`${PREFIX}P`, `${PREFIX}-SOL-1`],
    );
    await client.query(
      `insert into pursuit (signal_class, title, solicitation_number, signal_key, generated_by, generated_at)
       values ('active_solicitation', 'Example', $1, $2, 'test', now())`,
      [`${PREFIX}-SOL-1`, `${PREFIX}PUR1`],
    );

    const record = await govwinOpportunity(`${PREFIX}P`);
    expect(record!.linked_pursuits).toBe(1);
    await client.query(`delete from pursuit where signal_key = $1`, [`${PREFIX}PUR1`]);
  });
});

describe('a date is rendered at the precision it was claimed at', () => {
  const render = (h: Parameters<typeof htmlToString>[0]): string =>
    htmlToString(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  it('shows a month-precision estimate as a month, never as the first', async () => {
    // The whole reason the precision is stored. 2027-06-01 on screen would be a claim the source did
    // not make.
    const out = render(expectedDate(new Date('2027-06-01T00:00:00Z'), 'month', 'deltek_estimate'));
    expect(out).toContain('2027-06');
    expect(out).not.toContain('2027-06-01');
    expect(out).toContain('Deltek estimate');
  });

  it('shows a day-precision published date as a day', async () => {
    const out = render(expectedDate(new Date('2025-09-10T00:00:00Z'), 'day', 'actual'));
    expect(out).toContain('2025-09-10');
    expect(out).toContain('published');
  });

  it('names a government estimate as one', async () => {
    const out = render(expectedDate(new Date('2027-06-01T00:00:00Z'), 'month', 'government_estimate'));
    expect(out).toContain('government estimate');
  });

  it('shows an absent date as absent rather than as today', async () => {
    expect(render(expectedDate(null, null, null))).not.toMatch(/\d{4}/);
  });
});
