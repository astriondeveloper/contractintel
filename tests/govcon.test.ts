/**
 * The GovCon API integration: the client, the delta cursor, and screening.
 *
 * No network and no API key. Every loader takes its HTTP call as a parameter, so these tests hand it
 * recorded envelopes shaped as the published guide describes and assert on what reaches the database.
 * The URLs are recorded too, which is how the cost claims are tested: the interesting assertions here
 * are not that a notice lands correctly but that the loader asks for the right window, asks once, and
 * moves its cursor only when it is entitled to.
 *
 * The load-bearing test in this file is 'one notice from two APIs is one pursuit'. The whole
 * non-redundancy design rests on it, and it is the assertion that would fail first if somebody
 * reintroduced a second write path.
 *
 * Every record here is invented. The identifiers are ZG-prefixed and file-private so that another
 * test file writing to the same tables cannot make these assertions flap.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  GovconClient,
  probeGovcon,
  resolveBase,
  DEFAULT_BASE,
  RESERVE_REQUESTS,
  type Envelope,
  type Fetched,
  type FetchJson,
} from '../src/loaders/govcon/client.js';
import {
  syncOpportunities,
  backfillOpportunities,
  readCursor,
  normalize,
  sinceParam,
  DELTA_MAX_DAYS,
  SOURCE_SYSTEM as GOVCON_SOURCE,
  type GovconOpportunity,
} from '../src/loaders/govcon/opportunities.js';
import {
  screen,
  looksLikeUei,
  looksLikeCage,
  SOURCE_SYSTEM as SCREEN_SOURCE,
} from '../src/loaders/govcon/screening.js';
import { loadSamOpportunities, SOURCE_SYSTEM as SAM_SOURCE } from '../src/loaders/sam.js';
import { buildProfile } from '../src/signals/profile.js';

let client: PoolClient;

/** File-private so another test file's rows cannot be mistaken for these. */
const NOTICE_A = 'ZGTEST00000000000000000000000001';
const NOTICE_B = 'ZGTEST00000000000000000000000002';
const UEI_A = 'ZGTESTUEI001';

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from pursuit where signal_key like 'sam:ZGTEST%'`);
  await client.query(`delete from vendor_exclusion where source_record_id like 'ZGTEST%'`);
  await client.query(`delete from vendor_entity where uei like 'ZGTEST%'`);
  await client.query(`delete from sync_cursor where source_system in ($1, $2)`, [GOVCON_SOURCE, SCREEN_SOURCE]);
  await client.query(`delete from source_version where source_system in ($1, $2, $3)`, [
    GOVCON_SOURCE,
    SCREEN_SOURCE,
    SAM_SOURCE,
  ]);
  await client.query(`delete from source_run where source_system in ($1, $2, $3)`, [
    GOVCON_SOURCE,
    SCREEN_SOURCE,
    SAM_SOURCE,
  ]);
}

beforeEach(cleanup);

function opportunity(overrides: Partial<GovconOpportunity> = {}): GovconOpportunity {
  return {
    notice_id: NOTICE_A,
    title: 'Test and evaluation engineering support',
    solicitation_number: 'ZGTEST-26-R-0001',
    agency: 'Example Defense Department',
    office: 'ZOFF01',
    posted_date: '2026-08-10',
    response_deadline: '2026-09-30T17:00:00-04:00',
    notice_type: 'Solicitation',
    set_aside_type: 'Small Business Set-Aside',
    set_aside_code: 'SBA',
    naics: ['541330'],
    primary_naics: '541330',
    psc_code: 'R425',
    performance_state: 'OH',
    sam_url: `https://sam.gov/opp/${NOTICE_A}/view`,
    ...overrides,
  };
}

/**
 * A fake transport that returns one envelope per call and records every URL.
 *
 * `pages` may be a function of the URL, which is how the per-code filtering is tested: the fake can
 * answer differently for `naics=541330` than for anything else.
 */
function fake<T>(
  pages: T[] | ((url: URL) => T[]),
  extra: Partial<Envelope<T>> = {},
  headers: { limit?: number; remaining?: number } = {},
): { fetchJson: FetchJson; urls: URL[] } {
  const urls: URL[] = [];
  const fetchJson = (async <R>(url: URL): Promise<Fetched<R>> => {
    urls.push(new URL(url.toString()));
    const data = typeof pages === 'function' ? pages(url) : pages;
    // Offset beyond the first page returns nothing, which is how the client stops.
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const served = offset > 0 ? [] : data;
    return {
      envelope: {
        data: served,
        pagination: { limit: 100, offset, total: data.length, has_next: false },
        ...extra,
      } as unknown as Envelope<R>,
      rateLimit: { limit: headers.limit ?? null, remaining: headers.remaining ?? null },
    };
  }) as FetchJson;
  return { fetchJson, urls };
}

describe('the client', () => {
  it('sends the key as a bearer token and nothing else', async () => {
    // The transport is what holds the header, so this asserts the client never puts the key in the
    // query string where it would land in an access log.
    const seen: { url: URL; key: string }[] = [];
    const fetchJson = (async <R>(url: URL, apiKey: string): Promise<Fetched<R>> => {
      seen.push({ url, key: apiKey });
      return { envelope: { data: [] } as Envelope<R>, rateLimit: { limit: null, remaining: null } };
    }) as FetchJson;

    const api = new GovconClient({ apiKey: 'ZGTESTKEY', fetchJson });
    await api.get('/opportunities/delta', { since: '2026-08-01T00:00:00Z' });

    expect(seen[0]!.key).toBe('ZGTESTKEY');
    expect(seen[0]!.url.toString()).not.toContain('ZGTESTKEY');
  });

  it('stops while there are still hourly requests left for the interactive lookups', async () => {
    // The allowance is shared by every job. A sync that drains it takes the screening lookups down
    // with it, and those are the ones somebody is waiting on.
    const { fetchJson, urls } = fake([opportunity()], {}, { limit: 1000, remaining: RESERVE_REQUESTS });

    const api = new GovconClient({ apiKey: 'ZGTESTKEY', fetchJson });
    await api.get('/opportunities/delta', { since: '2026-08-01T00:00:00Z' });
    const second = await api.get('/opportunities/delta', { since: '2026-08-01T00:00:00Z' });

    expect(second).toBeNull();
    expect(urls.length).toBe(1);
    expect(api.stoppedEarly).toContain('holding');
  });

  it('stops at its own request cap', async () => {
    const { fetchJson, urls } = fake([opportunity()]);
    const api = new GovconClient({ apiKey: 'ZGTESTKEY', fetchJson, maxRequests: 2 });

    await api.get('/status');
    await api.get('/status');
    const third = await api.get('/status');

    expect(third).toBeNull();
    expect(urls.length).toBe(2);
    expect(api.stoppedEarly).toContain('2-request cap');
  });
});

describe('the endpoint', () => {
  // `.env.example` ships `GOVCON_API_BASE=` with "leave empty for the real API" beside it, so a
  // person following the documented first step has an empty string in the environment. `??` reads
  // that as the answer, and every request then dies in `new URL('')` with `Invalid URL` and no
  // mention of the variable that caused it. Empty means unset, as it already does for the key.
  const withBase = async (value: string | undefined, run: () => void): Promise<void> => {
    const before = process.env.GOVCON_API_BASE;
    if (value === undefined) delete process.env.GOVCON_API_BASE;
    else process.env.GOVCON_API_BASE = value;
    try {
      run();
    } finally {
      if (before === undefined) delete process.env.GOVCON_API_BASE;
      else process.env.GOVCON_API_BASE = before;
    }
  };

  it('falls back to the real API when the override is empty', async () => {
    await withBase('', () => {
      expect(resolveBase({})).toBe(DEFAULT_BASE);
      expect(() => new URL(`${resolveBase({})}/opportunities`)).not.toThrow();
    });
  });

  it('falls back when the override is whitespace', async () => {
    await withBase('   ', () => expect(resolveBase({})).toBe(DEFAULT_BASE));
  });

  it('still honours a real override, trailing slash and all', async () => {
    await withBase('http://localhost:3998/api/v1/', () =>
      expect(resolveBase({})).toBe('http://localhost:3998/api/v1'),
    );
  });
});

describe('the probe', () => {
  it('spends one request and reports the plan and the window', async () => {
    const urls: URL[] = [];
    const fetchJson = (async <R>(url: URL): Promise<Fetched<R>> => {
      urls.push(url);
      return {
        envelope: { plan: 'developer', rate_limit: 1000, search_window_days: 365 } as unknown as Envelope<R>,
        rateLimit: { limit: 1000, remaining: 999 },
      };
    }) as FetchJson;

    const result = await probeGovcon({ apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.ok).toBe(true);
    expect(result.plan).toBe('developer');
    expect(result.rateLimit).toBe(1000);
    expect(result.searchWindow).toBe('365 days');
    expect(urls.length).toBe(1);
    expect(urls[0]!.pathname).toContain('/me');
  });

  it('says the search window is not the delta window, because they are different caps', async () => {
    const fetchJson = (async <R>(): Promise<Fetched<R>> => ({
      envelope: { plan: 'developer', search_window_days: 365 } as unknown as Envelope<R>,
      rateLimit: { limit: null, remaining: null },
    })) as FetchJson;

    const result = await probeGovcon({ apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.detail).toContain('60-day');
  });

  it('returns the failure rather than throwing it', async () => {
    const fetchJson = (async () => {
      throw new Error('GovCon API returned 403 for /me. plan does not include this endpoint');
    }) as FetchJson;

    const result = await probeGovcon({ apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('403');
  });

  it('reports a missing key without making a request', async () => {
    const result = await probeGovcon({ apiKey: '' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('GOVCON_API_KEY');
  });
});

describe('the field mapping', () => {
  const noAgencies = new Map<string, string>();

  it('reads the flat GovCon names', () => {
    const mapped = normalize(opportunity(), NOTICE_A, noAgencies);

    expect(mapped.noticeId).toBe(NOTICE_A);
    expect(mapped.title).toBe('Test and evaluation engineering support');
    expect(mapped.solicitationNumber).toBe('ZGTEST-26-R-0001');
    expect(mapped.naicsCode).toBe('541330');
    expect(mapped.pscCode).toBe('R425');
    expect(mapped.postedDate).toBe('2026-08-10');
    expect(mapped.responseDate).toBe('2026-09-30');
    expect(mapped.placeOfPerformanceState).toBe('OH');
  });

  it('resolves an agency name against the labels the corpus has observed', () => {
    const agencies = new Map([['example defense department', '9700']]);
    expect(normalize(opportunity(), NOTICE_A, agencies).agencyCode).toBe('9700');
  });

  it('leaves the agency code blank when the name resolves to nothing', () => {
    // A wrong code puts a notice in the wrong person's feed, which is worse than a blank one.
    const mapped = normalize(opportunity({ agency: 'Bureau Of Nothing In Particular' }), NOTICE_A, noAgencies);
    expect(mapped.agencyCode).toBeNull();
  });

  it('prefers an explicit agency code over resolving the name', () => {
    const agencies = new Map([['example defense department', '9700']]);
    const mapped = normalize(opportunity({ agency_code: '5700' }), NOTICE_A, agencies);
    expect(mapped.agencyCode).toBe('5700');
  });

  it('leaves the value blank on a solicitation', () => {
    // A solicitation has no value until it is awarded. Inventing one would be worse than blank.
    expect(normalize(opportunity(), NOTICE_A, noAgencies).estimatedValue).toBeNull();
  });

  it('takes the value from an award figure when there is one', () => {
    const mapped = normalize(opportunity({ award_amount: 4_200_000 }), NOTICE_A, noAgencies);
    expect(mapped.estimatedValue).toBe('4200000');
  });

  it('falls back to a constructed SAM.gov link rather than no link', () => {
    // The hand-off panel's whole job is to get somebody to the notice. A missing url field is a
    // reason to construct the canonical one, not a reason to hand over a dead panel.
    const mapped = normalize(opportunity({ sam_url: undefined }), NOTICE_A, noAgencies);
    expect(mapped.noticeUrl).toBe(`https://sam.gov/opp/${NOTICE_A}/view`);
  });

  it('keeps a blank deadline blank', () => {
    const mapped = normalize(opportunity({ response_deadline: null }), NOTICE_A, noAgencies);
    expect(mapped.responseDate).toBeNull();
  });
});

describe('the delta sync', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  it('asks for changes since a timestamp, not for a date range', async () => {
    const { fetchJson, urls } = fake([opportunity()]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered', dryRun: true });

    expect(urls[0]!.pathname).toContain('/opportunities/delta');
    expect(urls[0]!.searchParams.get('since')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('spends one request in unfiltered mode regardless of how many codes are on the profile', async () => {
    // This is the cost claim. A per-code search is bounded and predictable; the unfiltered pull is
    // one request per hundred changed notices, and on a quiet window that is one request total.
    const { fetchJson, urls } = fake([opportunity()]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered', dryRun: true });

    expect(urls.length).toBe(1);
  });

  it('asks once per profile code in filtered mode', async () => {
    const { fetchJson, urls } = fake([]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'filtered', dryRun: true });

    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) {
      const hasCode = url.searchParams.has('naics') || url.searchParams.has('psc');
      expect(hasCode).toBe(true);
    }
  });

  it('drops a notice matching no profile code in unfiltered mode', async () => {
    const { fetchJson } = fake([opportunity({ naics: ['999999'], primary_naics: '999999', psc_code: 'ZZZZ' })]);
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      dryRun: true,
    });

    expect(result.skippedOffProfile).toBe(1);
    expect(result.matched).toBe(0);
  });

  it('writes a notice and moves the cursor', async () => {
    const { fetchJson } = fake([opportunity()]);
    const result = await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    expect(result.written).toBe(1);
    expect(result.cursorAdvancedTo).not.toBeNull();

    const cursor = await readCursor(client);
    expect(cursor).not.toBeNull();
    expect(cursor!.cursor_at.getTime()).toBe(result.cursorAdvancedTo!.getTime());
  });

  it('asks the next run for changes since the stored cursor', async () => {
    const { fetchJson } = fake([opportunity()]);
    const first = await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    const second = fake([opportunity()]);
    await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson: second.fetchJson,
      mode: 'unfiltered',
    });

    expect(second.urls[0]!.searchParams.get('since')).toBe(sinceParam(first.cursorAdvancedTo!));
  });

  it('does not move the cursor on a dry run', async () => {
    const { fetchJson } = fake([opportunity()]);
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      dryRun: true,
    });

    expect(result.cursorAdvancedTo).toBeNull();
    expect(await readCursor(client)).toBeNull();
  });

  it('does not move the cursor when the run stopped early', async () => {
    // A partial run that advanced its cursor would lose whatever it never reached, permanently and
    // without a trace. This is the assertion that keeps a hole out of the feed.
    const { fetchJson } = fake([opportunity()], {}, { limit: 1000, remaining: RESERVE_REQUESTS });
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'filtered',
    });

    expect(result.stoppedEarly).not.toBeNull();
    expect(result.cursorAdvancedTo).toBeNull();
    expect(await readCursor(client)).toBeNull();
  });

  it('reports a gap when the requested window is older than the delta cap', async () => {
    const { fetchJson, urls } = fake([opportunity()]);
    const tooOld = new Date(Date.now() - (DELTA_MAX_DAYS + 30) * 86_400_000);
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      since: tooOld,
      dryRun: true,
    });

    expect(result.clamped).toBe(true);
    expect(result.clampNote).toContain('backfill');
    // And it clamped before spending the request rather than after.
    expect(new Date(urls[0]!.searchParams.get('since')!).getTime()).toBeGreaterThan(tooOld.getTime());
  });

  it('names the interval that was missed, not the interval that was served', async () => {
    // The API only ever sees the already-clamped since, so its own clamp report describes the clamp
    // rather than the gap. Substituting it would turn "you are missing three months" into "you asked
    // for June and got June", which reads like nothing is wrong.
    const { fetchJson } = fake([opportunity()], {
      sync: { since_requested: '2026-06-19T00:00:00Z', since_applied: '2026-06-19T00:00:00Z', clamp_reason: 'clamped' },
    });
    const tooOld = new Date(Date.now() - (DELTA_MAX_DAYS + 90) * 86_400_000);
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      since: tooOld,
      dryRun: true,
    });

    expect(result.clampNote).toContain(sinceParam(tooOld));
  });

  it('reports a clamp the calculation did not predict', async () => {
    // A window narrower than the documented 60 days on this plan. Worth hearing verbatim.
    const { fetchJson } = fake([opportunity()], {
      sync: { since_requested: '2026-08-01T00:00:00Z', since_applied: '2026-08-15T00:00:00Z', clamp_reason: 'plan window is 14 days' },
    });
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      since: new Date(Date.now() - 20 * 86_400_000),
      dryRun: true,
    });

    expect(result.clamped).toBe(true);
    expect(result.clampNote).toContain('plan window is 14 days');
    expect(result.clampNote).toContain('narrower');
  });

  it('records the clamp on the cursor, so an unattended run cannot look clean', async () => {
    const { fetchJson } = fake([opportunity()]);
    await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      since: new Date(Date.now() - (DELTA_MAX_DAYS + 30) * 86_400_000),
    });

    const cursor = await readCursor(client);
    expect(cursor!.last_clamped).toBe(true);
    expect(cursor!.last_clamp_note).toContain('delta window');
  });

  it('counts an unrecognised notice type rather than guessing at it', async () => {
    const { fetchJson } = fake([opportunity({ notice_type: 'Interpretive Dance Notice' })]);
    const result = await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    expect(result.skippedUnknownType).toBe(1);
    expect(result.written).toBe(0);
  });

  it('counts a record with no notice id rather than inventing one', async () => {
    const { fetchJson } = fake([opportunity({ notice_id: undefined })]);
    const result = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      dryRun: true,
    });

    expect(result.skippedNoNoticeId).toBe(1);
  });

  it('writes one pursuit for a notice that matches two codes', async () => {
    const { fetchJson } = fake([opportunity()]);
    const result = await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    expect(result.written).toBe(1);
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from pursuit where signal_key = $1`,
      [`sam:${NOTICE_A}`],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('is idempotent: an unchanged notice adds no pursuit and no version', async () => {
    const { fetchJson } = fake([opportunity()]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    const counts = async (): Promise<{ pursuits: string; versions: string }> => {
      const pursuits = await client.query<{ n: string }>(
        `select count(*)::text as n from pursuit where signal_key like 'sam:ZGTEST%'`,
      );
      const versions = await client.query<{ n: string }>(
        `select count(*)::text as n from source_version where source_system = $1`,
        [GOVCON_SOURCE],
      );
      return { pursuits: pursuits.rows[0]!.n, versions: versions.rows[0]!.n };
    };
    const before = await counts();

    const second = await syncOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      mode: 'unfiltered',
      since: new Date(Date.now() - 86_400_000),
    });

    // The notice is written again — the upsert is unconditional — but the payload hash is unchanged,
    // so no new version is archived and no second pursuit appears. That is what idempotent means
    // here: re-running changes no row counts.
    expect(second.written).toBe(1);
    expect(await counts()).toEqual(before);
    expect(before.pursuits).toBe('1');
  });

  it('never lets the API key reach the archived payload', async () => {
    const { fetchJson } = fake([opportunity()]);
    await syncOpportunities(client, { apiKey: 'ZGTESTSECRET', fetchJson, mode: 'unfiltered' });

    const { rows } = await client.query<{ payload: string }>(
      `select payload::text from source_version where source_system = $1`,
      [GOVCON_SOURCE],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload).not.toContain('ZGTESTSECRET');
  });

  it('records its own source system, so which API delivered a version stays answerable', async () => {
    const { fetchJson } = fake([opportunity()]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson, mode: 'unfiltered' });

    const { rows } = await client.query<{ source_system: string }>(
      `select distinct source_system from source_run where source_system = $1`,
      [GOVCON_SOURCE],
    );
    expect(rows.length).toBe(1);
  });
});

describe('the backfill', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  it('uses the search endpoint with a date range, not the delta endpoint', async () => {
    const { fetchJson, urls } = fake([opportunity()]);
    await backfillOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      postedFrom: new Date('2026-01-01T00:00:00Z'),
      postedTo: new Date('2026-06-30T00:00:00Z'),
      dryRun: true,
    });

    expect(urls[0]!.pathname).toContain('/opportunities/search');
    expect(urls[0]!.searchParams.get('date_from')).toBe('2026-01-01');
    expect(urls[0]!.searchParams.get('date_to')).toBe('2026-06-30');
    expect(urls[0]!.searchParams.has('since')).toBe(false);
  });

  it('always sends a filter, because a bare search is a 400', async () => {
    const { fetchJson, urls } = fake([]);
    await backfillOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      postedFrom: new Date('2026-01-01T00:00:00Z'),
      dryRun: true,
    });

    for (const url of urls) {
      expect(url.searchParams.has('naics') || url.searchParams.has('psc')).toBe(true);
    }
  });

  it('does not touch the cursor', async () => {
    // A backfill covers the past. Moving the cursor would tell the next delta run that the interval
    // between the backfill and now had been covered when it had not.
    const { fetchJson } = fake([opportunity()]);
    const result = await backfillOpportunities(client, {
      apiKey: 'ZGTESTKEY',
      fetchJson,
      postedFrom: new Date('2026-01-01T00:00:00Z'),
    });

    expect(result.cursorAdvancedTo).toBeNull();
    expect(await readCursor(client)).toBeNull();
  });

  it('refuses an empty range', async () => {
    const { fetchJson } = fake([]);
    await expect(
      backfillOpportunities(client, {
        apiKey: 'ZGTESTKEY',
        fetchJson,
        postedFrom: new Date('2026-06-30T00:00:00Z'),
        postedTo: new Date('2026-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/empty/);
  });
});

describe('two APIs, one pursuit', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  it('is one pursuit when the same notice arrives from both loaders', async () => {
    // The load-bearing test for the whole non-redundancy design. Both loaders key on
    // sam:<notice_id>, so a notice delivered twice converges rather than duplicating. If somebody
    // reintroduces a second write path, this is what fails.
    const govcon = fake([opportunity({ notice_id: NOTICE_B, primary_naics: '541330', naics: ['541330'] })]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson: govcon.fetchJson, mode: 'unfiltered' });

    const samPage = async (url: URL) => ({
      totalRecords: 1,
      opportunitiesData:
        url.searchParams.get('ncode') === '541330' && Number(url.searchParams.get('offset')) === 0
          ? [
              {
                noticeId: NOTICE_B,
                title: 'Test and evaluation engineering support',
                solicitationNumber: 'ZGTEST-26-R-0001',
                fullParentPathCode: '9700.5700.ZOFF01',
                office: 'ZOFF01',
                postedDate: '2026-08-10',
                type: 'Solicitation',
                naicsCode: '541330',
                classificationCode: 'R425',
                responseDeadLine: '2026-09-30T17:00:00-04:00',
                uiLink: `https://sam.gov/opp/${NOTICE_B}/view`,
              },
            ]
          : [],
    });
    await loadSamOpportunities(client, { apiKey: 'ZGTESTKEY', fetchPage: samPage, maxRequests: 500 });

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from pursuit where signal_key = $1`,
      [`sam:${NOTICE_B}`],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('keeps both source systems in provenance, so the convergence is not a loss of information', async () => {
    const govcon = fake([opportunity({ notice_id: NOTICE_B })]);
    await syncOpportunities(client, { apiKey: 'ZGTESTKEY', fetchJson: govcon.fetchJson, mode: 'unfiltered' });

    const samPage = async (url: URL) => ({
      totalRecords: 1,
      opportunitiesData:
        url.searchParams.get('ncode') === '541330' && Number(url.searchParams.get('offset')) === 0
          ? [{ noticeId: NOTICE_B, title: 'Same notice', type: 'Solicitation', naicsCode: '541330', postedDate: '2026-08-10' }]
          : [],
    });
    await loadSamOpportunities(client, { apiKey: 'ZGTESTKEY', fetchPage: samPage, maxRequests: 500 });

    const { rows } = await client.query<{ source_system: string }>(
      `select distinct source_system from source_version where source_record_id = $1 order by source_system`,
      [NOTICE_B],
    );
    expect(rows.map((r) => r.source_system)).toEqual([GOVCON_SOURCE, SAM_SOURCE]);
  });
});

describe('screening', () => {
  it('tells a UEI from a CAGE code from a name', () => {
    expect(looksLikeUei('ZGTESTUEI001')).toBe(true);
    expect(looksLikeUei('ZG001')).toBe(false);
    expect(looksLikeCage('ZG001')).toBe(true);
    expect(looksLikeCage('Example Systems')).toBe(false);
  });

  function exclusion(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ZGTESTEXCL1',
      uei: UEI_A,
      cage_code: 'ZG001',
      excluded_name: 'Example Holdings LLC',
      classification: 'Ineligible (Proceedings Completed)',
      excluding_agency: 'Example Defense Department',
      active_date: '2025-01-01',
      termination_date: null,
      ...overrides,
    };
  }

  function entity(overrides: Record<string, unknown> = {}) {
    return {
      uei: UEI_A,
      cage_code: 'ZG001',
      legal_business_name: 'Example Holdings LLC',
      registration_status: 'Active',
      registration_expiration_date: '2027-01-01',
      physical_state: 'VA',
      naics_codes: ['541330'],
      ...overrides,
    };
  }

  /** Answers the exclusions endpoint and the entity endpoint differently, as the API does. */
  function screeningFake(exclusions: unknown[], entities: unknown[]): { fetchJson: FetchJson; urls: URL[] } {
    const urls: URL[] = [];
    const fetchJson = (async <R>(url: URL): Promise<Fetched<R>> => {
      urls.push(new URL(url.toString()));
      const data = url.pathname.includes('/exclusions/') ? exclusions : entities;
      return {
        envelope: { data, pagination: { has_next: false, total: data.length } } as unknown as Envelope<R>,
        rateLimit: { limit: 1000, remaining: 900 },
      };
    }) as FetchJson;
    return { fetchJson, urls };
  }

  it('finds an exclusion in force and stores it', async () => {
    const { fetchJson } = screeningFake([exclusion()], [entity()]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.exclusions.length).toBe(1);
    expect(result.exclusions[0]!.excluded_name).toBe('Example Holdings LLC');
    expect(result.entity!.registration_status).toBe('Active');
  });

  it('treats a null termination date as an exclusion in force, not an absent one', async () => {
    const { fetchJson } = screeningFake([exclusion({ termination_date: null })], []);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.exclusions.length).toBe(1);
    expect(result.exclusions[0]!.termination_date).toBeNull();
  });

  it('excludes an exclusion that has already terminated', async () => {
    const { fetchJson } = screeningFake(
      [exclusion({ active_date: '2020-01-01', termination_date: '2021-01-01' })],
      [],
    );
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.exclusions.length).toBe(0);
  });

  it('says a clean result is not a clearance', async () => {
    // The most dangerous thing this module could return is a confident "no". The caveat is what
    // stops it reading as one.
    const { fetchJson } = screeningFake([], [entity()]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.exclusions.length).toBe(0);
    expect(result.caveats.join(' ')).toContain('not a clearance');
  });

  it('says a hit is not a determination', async () => {
    const { fetchJson } = screeningFake([exclusion()], [entity()]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.caveats.join(' ')).toContain('makes no determination');
  });

  it('flags a registration that is not active', async () => {
    const { fetchJson } = screeningFake([], [entity({ registration_status: 'Expired' })]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.caveats.join(' ')).toContain('cannot receive an award');
  });

  it('spends nothing on a repeat lookup inside the freshness window', async () => {
    const first = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: first.fetchJson });

    const second = screeningFake([exclusion()], [entity()]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: second.fetchJson });

    expect(result.cached).toBe(true);
    expect(result.requests).toBe(0);
    expect(second.urls.length).toBe(0);
  });

  it('goes back to the API when asked to refresh', async () => {
    const first = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: first.fetchJson });

    const second = screeningFake([exclusion()], [entity()]);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: second.fetchJson, refresh: true });

    expect(result.cached).toBe(false);
    expect(second.urls.length).toBeGreaterThan(0);
  });

  it('does not accumulate duplicates when the same exclusion is screened twice', async () => {
    const first = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: first.fetchJson });
    const second = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson: second.fetchJson, refresh: true });

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from vendor_exclusion where source_record_id = 'ZGTESTEXCL1'`,
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('skips an exclusion record with no identifier rather than accumulating it', async () => {
    const { fetchJson } = screeningFake([exclusion({ id: undefined })], []);
    const result = await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(result.exclusions.length).toBe(0);
  });

  it('asks the exclusions endpoint before the entity endpoint', async () => {
    // The exclusions answer is the one somebody is waiting on. If the quota runs out on the second
    // request, the useful half has already been stored.
    const { fetchJson, urls } = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTKEY', fetchJson });

    expect(urls[0]!.pathname).toContain('/exclusions/');
    expect(urls[1]!.pathname).toContain('/entities/');
  });

  it('does not spend a request on an entity lookup for a name query', async () => {
    // A name search would need a choice between candidates, and choosing on the caller's behalf is
    // how the wrong company ends up on a hand-off.
    const { fetchJson, urls } = screeningFake([], []);
    await screen(client, 'Example Holdings LLC', { apiKey: 'ZGTESTKEY', fetchJson });

    expect(urls.length).toBe(1);
    expect(urls[0]!.pathname).toContain('/exclusions/');
    expect(urls[0]!.searchParams.get('name')).toBe('Example Holdings LLC');
  });

  it('refuses an empty query', async () => {
    const { fetchJson } = screeningFake([], []);
    await expect(screen(client, '   ', { apiKey: 'ZGTESTKEY', fetchJson })).rejects.toThrow();
  });

  it('never lets the API key reach the archived payload', async () => {
    const { fetchJson } = screeningFake([exclusion()], [entity()]);
    await screen(client, UEI_A, { apiKey: 'ZGTESTSECRET', fetchJson });

    const { rows } = await client.query<{ payload: string }>(
      `select payload::text from source_version where source_system = $1`,
      [SCREEN_SOURCE],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload).not.toContain('ZGTESTSECRET');
  });
});
