/**
 * SAM.gov opportunities loader and the opportunity profile.
 *
 * No network and no API key. `loadSamOpportunities` takes its HTTP call as a parameter, so
 * these tests hand it recorded pages shaped exactly as the Get Opportunities v2 definition
 * describes, and assert on what reaches the database. The fake also records the URLs it was
 * given, which is how the targeting itself is tested: the interesting claim is not that a
 * notice lands correctly but that the loader never asks for notices outside the profile.
 *
 * Every notice here is invented. The NAICS and PSC codes are real code numbers, because
 * they are public classification codes rather than anything derived from the corpus.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  loadSamOpportunities,
  classify,
  DEFAULT_NOTICE_TYPES,
  SOURCE_SYSTEM,
  type SamOpportunity,
} from '../src/loaders/sam.js';
import { buildProfile } from '../src/signals/profile.js';

let client: PoolClient;

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from pursuit where signal_key like 'sam:%'`);
  await client.query(`delete from opportunity_profile where code_value like 'ZT%' or origin = 'manual'`);
  await client.query(`delete from source_version where source_system = '${SOURCE_SYSTEM}'`);
  await client.query(`delete from source_run where source_system = '${SOURCE_SYSTEM}'`);
}

beforeEach(cleanup);

function notice(overrides: Partial<SamOpportunity> = {}): SamOpportunity {
  return {
    noticeId: 'ZTNOTICE001',
    title: 'Test and evaluation engineering support',
    solicitationNumber: 'ZTSOL-26-R-0001',
    fullParentPathCode: '9700.5700.FA8601',
    office: 'FA8601',
    postedDate: '2026-07-15',
    type: 'Solicitation',
    typeOfSetAside: 'SBA',
    responseDeadLine: '2026-09-30T17:00:00-04:00',
    naicsCode: '541330',
    classificationCode: 'R425',
    placeOfPerformance: { state: { code: 'OH' } },
    uiLink: 'https://sam.gov/opp/ZTNOTICE001/view',
    ...overrides,
  };
}

/** A fake HTTP call that returns one page and records every URL it was asked for. */
function fake(pages: SamOpportunity[] | ((url: URL) => SamOpportunity[])) {
  const urls: URL[] = [];
  const fetchPage = async (url: URL) => {
    urls.push(new URL(url.toString()));
    const data = typeof pages === 'function' ? pages(url) : pages;
    // Offset beyond the first page returns nothing, which is how the loader stops.
    const offset = Number(url.searchParams.get('offset') ?? '0');
    return offset > 0
      ? { totalRecords: data.length, opportunitiesData: [] }
      : { totalRecords: data.length, opportunitiesData: data };
  };
  return { fetchPage, urls };
}

async function profileRows(): Promise<{ code_type: string; code_value: string }[]> {
  const { rows } = await client.query(
    `select code_type, code_value from opportunity_profile_effective
      where code_type in ('naics','psc') order by code_type, code_value`,
  );
  return rows as never;
}

describe('the opportunity profile', () => {
  it('builds from the capability taxonomy crosswalks', async () => {
    const result = await buildProfile(client, { taxonomyOnly: true });
    const taxonomy = result.counts.filter((c) => c.origin === 'taxonomy');
    expect(taxonomy.length).toBeGreaterThan(0);
    expect(taxonomy.some((c) => c.code_type === 'naics')).toBe(true);
    expect(taxonomy.some((c) => c.code_type === 'psc')).toBe(true);
  });

  it('is idempotent', async () => {
    await buildProfile(client, { taxonomyOnly: true });
    const first = await profileRows();
    await buildProfile(client, { taxonomyOnly: true });
    const second = await profileRows();
    expect(second).toEqual(first);
  });

  it('keeps one row per code per capability node, and one search term for both', async () => {
    // A NAICS code serves more than one capability. Both rows are kept as evidence, and
    // the effective view collapses them so the search asks once.
    await buildProfile(client, { taxonomyOnly: true });
    const { rows: raw } = await client.query<{ n: string }>(
      `select count(*)::text as n from opportunity_profile
        where code_type = 'naics' and origin = 'taxonomy'`,
    );
    const { rows: effective } = await client.query<{ n: string }>(
      `select count(*)::text as n from opportunity_profile_effective where code_type = 'naics'`,
    );
    expect(Number(raw[0]!.n)).toBeGreaterThanOrEqual(Number(effective[0]!.n));
  });

  it('does not turn a row back on that BD Ops turned off', async () => {
    await buildProfile(client, { taxonomyOnly: true });
    await client.query(
      `update opportunity_profile set active = false
        where code_type = 'naics' and origin = 'taxonomy'
          and code_value = (select min(code_value) from opportunity_profile
                             where code_type = 'naics' and origin = 'taxonomy')`,
    );
    const offBefore = await client.query<{ n: string }>(
      `select count(*)::text as n from opportunity_profile where not active`,
    );
    await buildProfile(client, { taxonomyOnly: true });
    const offAfter = await client.query<{ n: string }>(
      `select count(*)::text as n from opportunity_profile where not active`,
    );
    expect(offAfter.rows[0]!.n).toBe(offBefore.rows[0]!.n);
  });
});

describe('the SAM.gov search is targeted', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  it('asks only for codes on the profile', async () => {
    const { fetchPage, urls } = fake([]);
    await loadSamOpportunities(client, { fetchPage, dryRun: true, maxRequests: 500 });

    const asked = new Set(
      urls.flatMap((u) => [u.searchParams.get('ncode'), u.searchParams.get('ccode')].filter(Boolean) as string[]),
    );
    const onProfile = new Set((await profileRows()).map((r) => r.code_value));

    expect(asked.size).toBeGreaterThan(0);
    for (const code of asked) expect(onProfile.has(code)).toBe(true);
  });

  it('sends every parameter the v2 definition requires', async () => {
    const { fetchPage, urls } = fake([]);
    await loadSamOpportunities(client, { fetchPage, dryRun: true, maxRequests: 1 });

    const url = urls[0]!;
    // limit and offset are required, and postedFrom/postedTo are required whenever limit
    // is given. mm/dd/yyyy, per the definition.
    expect(url.searchParams.get('limit')).toBeTruthy();
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('postedFrom')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(url.searchParams.get('postedTo')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(url.searchParams.getAll('ptype').sort()).toEqual([...DEFAULT_NOTICE_TYPES].sort());
  });

  it('looks past the solicitation window by default', async () => {
    // The brief: more than 0 to 6 months, and targeted. Sources sought, special notices
    // and intent-to-bundle are the early types, and they are in the default pull.
    const { fetchPage, urls } = fake([]);
    await loadSamOpportunities(client, { fetchPage, dryRun: true, maxRequests: 1 });
    const types = urls[0]!.searchParams.getAll('ptype');
    expect(types).toContain('r'); // sources sought
    expect(types).toContain('s'); // special notice
    expect(types).toContain('i'); // intent to bundle
    expect(types).not.toContain('a'); // award notices are opt-in
  });

  it('honours an explicit code list instead of the profile', async () => {
    const { fetchPage, urls } = fake([]);
    await loadSamOpportunities(client, { fetchPage, dryRun: true, naics: ['999999'], psc: [] });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get('ncode')).toBe('999999');
  });

  it('stops at the request cap and says the run was incomplete', async () => {
    const { fetchPage } = fake([]);
    const result = await loadSamOpportunities(client, { fetchPage, dryRun: true, maxRequests: 2 });
    expect(result.requests).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('refuses a posted range wider than a year, as the API does', async () => {
    const { fetchPage } = fake([]);
    await expect(
      loadSamOpportunities(client, {
        fetchPage,
        postedFrom: new Date('2024-01-01'),
        postedTo: new Date('2026-01-01'),
      }),
    ).rejects.toThrow(/wider than a year/);
  });

  it('refuses to run with an empty profile rather than searching for everything', async () => {
    await client.query('update opportunity_profile set active = false');
    const { fetchPage } = fake([]);
    try {
      await expect(loadSamOpportunities(client, { fetchPage, dryRun: true })).rejects.toThrow(
        /profile is empty/,
      );
    } finally {
      await client.query('update opportunity_profile set active = true');
    }
  });
});

describe('what lands in the database', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  async function landed(noticeId: string) {
    const { rows } = await client.query(
      `select signal_class, title, notice_id, notice_type, naics_code, psc_code,
              set_aside_code, response_date, posted_date, notice_url, state,
              estimated_value::text, place_of_performance_state
         from pursuit where notice_id = $1`,
      [noticeId],
    );
    return rows[0] as never as Record<string, unknown> | undefined;
  }

  it('maps a notice onto a pursuit', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    const result = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });

    expect(result.written).toBe(1);
    const row = await landed('ZTNOTICE001');
    expect(row).toBeDefined();
    expect(row!.signal_class).toBe('active_solicitation');
    expect(row!.naics_code).toBe('541330');
    expect(row!.psc_code).toBe('R425');
    expect(row!.set_aside_code).toBe('SBA');
    expect(row!.state).toBe('open');
    expect(row!.notice_url).toBe('https://sam.gov/opp/ZTNOTICE001/view');
  });

  it('files an early notice as a shaping target, not an active solicitation', async () => {
    // The point of keeping the notice type: a sources sought is work that can still be
    // shaped, and collapsing it into "an opportunity" throws that away.
    const { fetchPage } = fake((url) =>
      url.searchParams.get('ncode') === '541330'
        ? [notice({ noticeId: 'ZTNOTICE002', type: 'Sources Sought', responseDeadLine: null })]
        : [],
    );
    await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });

    const row = await landed('ZTNOTICE002');
    expect(row!.signal_class).toBe('shaping_target');
    expect(row!.response_date).toBeNull();
  });

  it('leaves a solicitation with no value rather than inventing one', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    const row = await landed('ZTNOTICE001');
    expect(row!.estimated_value).toBeNull();
  });

  it('records which profile rows pulled the notice in', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });

    const { rows } = await client.query<{ matched_on: string; code_value: string }>(
      `select m.matched_on, p.code_value
         from pursuit_profile_match m
         join opportunity_profile p on p.profile_id = m.profile_id
         join pursuit pu on pu.pursuit_id = m.pursuit_id
        where pu.notice_id = 'ZTNOTICE001'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.code_value === '541330')).toBe(true);
    expect(rows.every((r) => r.matched_on === 'naics')).toBe(true);
  });

  it('writes one pursuit when a notice matches two codes', async () => {
    // The same notice comes back from a NAICS search and a PSC search. It is one
    // opportunity, and both matches are kept as the reason it is here.
    const both = notice({ noticeId: 'ZTNOTICE003' });
    const { fetchPage } = fake((url) =>
      url.searchParams.get('ncode') === '541330' || url.searchParams.get('ccode') === 'R425' ? [both] : [],
    );
    const result = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });

    expect(result.written).toBe(1);
    const { rows } = await client.query<{ n: string }>(
      `select count(distinct m.matched_on)::text as n
         from pursuit_profile_match m
         join pursuit p on p.pursuit_id = m.pursuit_id
        where p.notice_id = 'ZTNOTICE003'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('is idempotent', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    const first = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    expect(first.run!.inserted).toBe(1);

    const second = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    expect(second.run!.inserted).toBe(0);
    expect(second.run!.unchanged).toBe(second.run!.records);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from pursuit where notice_id = 'ZTNOTICE001'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('does not undo work a person has done', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    await client.query(
      `update pursuit set state = 'pursuing', owner = 'Capture' where notice_id = 'ZTNOTICE001'`,
    );
    await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });

    const row = await landed('ZTNOTICE001');
    expect(row!.state).toBe('pursuing');
  });

  it('skips a notice type it does not recognise instead of guessing', async () => {
    const { fetchPage } = fake((url) =>
      url.searchParams.get('ncode') === '541330'
        ? [notice({ noticeId: 'ZTNOTICE004', type: 'Some New Notice Type' })]
        : [],
    );
    const result = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    expect(result.skippedUnknownType).toBe(1);
    expect(await landed('ZTNOTICE004')).toBeUndefined();
  });

  it('skips a notice with no notice id', async () => {
    const { fetchPage } = fake((url) =>
      url.searchParams.get('ncode') === '541330' ? [notice({ noticeId: undefined })] : [],
    );
    const result = await loadSamOpportunities(client, { fetchPage, maxRequests: 500 });
    expect(result.skippedNoNoticeId).toBe(1);
    expect(result.written).toBe(0);
  });

  it('never lets the API key reach the archived payload', async () => {
    const { fetchPage } = fake((url) => (url.searchParams.get('ncode') === '541330' ? [notice()] : []));
    await loadSamOpportunities(client, { fetchPage, apiKey: 'ZTSECRETKEY', maxRequests: 500 });

    const { rows } = await client.query<{ payload: string }>(
      `select payload::text from source_version where source_system = $1`,
      [SOURCE_SYSTEM],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload).not.toContain('ZTSECRETKEY');
  });
});

describe('notice type classification', () => {
  it('reads both the abbreviation and the spelled-out type', () => {
    expect(classify('r')).toBe('shaping_target');
    expect(classify('Sources Sought')).toBe('shaping_target');
    expect(classify('o')).toBe('active_solicitation');
    expect(classify('Combined Synopsis/Solicitation')).toBe('active_solicitation');
    expect(classify('Award Notice')).toBe('market_movement');
  });

  it('returns null for anything it does not know', () => {
    expect(classify('')).toBeNull();
    expect(classify('Something Else Entirely')).toBeNull();
  });
});
