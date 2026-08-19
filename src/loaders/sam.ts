/**
 * SAM.gov Get Opportunities v2 loader.
 *
 * Endpoint contract: `getopportunitiesv2`, the published API definition. Every parameter
 * used here is from it: `ptype` multi, `ncode`, `ccode`, `postedFrom`/`postedTo` in
 * mm/dd/yyyy and required whenever `limit` is given, `limit` and `offset` both required,
 * `api_key` required.
 *
 * Two things shape this loader, and both came from the brief rather than the API.
 *
 * **It is targeted, not a firehose.** SAM.gov publishes every federal notice. The search
 * is driven by `opportunity_profile`, which holds the NAICS, PSC and agency codes the
 * capability taxonomy crosswalks to and the ones the corpus shows Astrion working under.
 * One request per code, not one request for everything. A notice that matches nothing on
 * the profile is never fetched, and every notice that lands records which profile rows
 * pulled it in, so "why is this in my pipeline" has an answer.
 *
 * **It looks further out than a solicitation window.** Restricting to notices closing in
 * the next six months would find only work that is already too late to shape. The notice
 * type is what carries how early a thing is, so it is kept raw and it decides the signal
 * class: a sources sought or a special notice is a `shaping_target` on the 12-to-60 month
 * horizon, a solicitation is an `active_solicitation`, and an award notice is
 * `market_movement`. The default pull includes the early types, which is where the value
 * is.
 *
 * The API key is read from `SAM_API_KEY` and never leaves this file: it is not logged, not
 * written to `source_version`, and not part of anything provenance keeps. A test asserts
 * it never reaches an archived payload.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun, type RunHandle } from '../lib/provenance.js';
import { profileCodes } from '../signals/profile.js';
import {
  writeNotice,
  classify,
  isoDay,
  NOTICE_TYPES,
  DEFAULT_NOTICE_TYPES,
  type NoticeType,
  type NormalizedNotice,
} from './notice.js';

// Re-exported because these are part of this module's published surface and the CLI, the tests and
// the GovCon loader all reach for them here. The definitions live in notice.ts because both loaders
// need them and a second copy would drift.
export { classify, NOTICE_TYPES, DEFAULT_NOTICE_TYPES, type NoticeType };

export const SOURCE_SYSTEM = 'sam_opportunity';

const DEFAULT_BASE = 'https://api.sam.gov/opportunities/v2/search';

/** SAM.gov rejects a posted range wider than a year. */
const MAX_RANGE_DAYS = 365;

/** The API's own ceiling on `limit`. */
const MAX_PAGE = 1000;

export interface SamOpportunity {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  fullParentPathCode?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  typeOfSetAside?: string;
  typeOfSetAsideDescription?: string;
  responseDeadLine?: string | null;
  naicsCode?: string;
  classificationCode?: string;
  active?: string;
  organizationType?: string;
  officeAddress?: { city?: string; state?: string; zipcode?: string };
  placeOfPerformance?: { state?: { code?: string; name?: string }; city?: { name?: string } };
  award?: { amount?: string; date?: string };
  uiLink?: string;
  description?: string;
  department?: string;
  subTier?: string;
  office?: string;
}

interface SamPage {
  totalRecords?: number;
  limit?: number;
  offset?: number;
  opportunitiesData?: SamOpportunity[];
}

/** One HTTP call. Injected so the loader can be tested without a key or a network. */
export type FetchPage = (url: URL) => Promise<SamPage>;

export interface LoadSamOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Posted-from date. Defaults to `lookbackDays` before today. */
  readonly postedFrom?: Date;
  readonly postedTo?: Date;
  readonly lookbackDays?: number;
  readonly noticeTypes?: readonly NoticeType[];
  /** Search these codes instead of the profile. For a one-off look. */
  readonly naics?: readonly string[];
  readonly psc?: readonly string[];
  /** Stop after this many HTTP requests. The public key allows a limited daily quota. */
  readonly maxRequests?: number;
  readonly pageSize?: number;
  /** Fetch and classify, write nothing. */
  readonly dryRun?: boolean;
  /** Replaces the HTTP call. Tests pass a recorded page; nothing else should. */
  readonly fetchPage?: FetchPage;
  readonly onProgress?: (message: string) => void;
}

export interface LoadSamResult {
  readonly requests: number;
  readonly fetched: number;
  readonly matched: number;
  readonly written: number;
  readonly skippedNoNoticeId: number;
  readonly skippedUnknownType: number;
  readonly byClass: Record<string, number>;
  readonly codesSearched: number;
  readonly truncated: boolean;
  readonly run: RunHandle | null;
}

function mmddyyyy(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

/**
 * One SAM.gov notice as this system stores it.
 *
 * The response deadline carries a time and a zone; Postgres holds it as a date, so `isoDay` takes
 * the day off both it and the posted date.
 */
function normalize(noticeId: string, opportunity: SamOpportunity): NormalizedNotice {
  return {
    noticeId,
    rawType: (opportunity.type ?? opportunity.baseType ?? '').trim(),
    title: opportunity.title ?? null,
    solicitationNumber: opportunity.solicitationNumber ?? null,
    agencyCode: opportunity.fullParentPathCode?.split('.')[0] ?? null,
    officeCode: opportunity.office ?? null,
    responseDate: isoDay(opportunity.responseDeadLine),
    postedDate: isoDay(opportunity.postedDate),
    naicsCode: opportunity.naicsCode ?? null,
    pscCode: opportunity.classificationCode ?? null,
    setAsideCode: opportunity.typeOfSetAside ?? null,
    placeOfPerformanceState: opportunity.placeOfPerformance?.state?.code ?? null,
    noticeUrl: opportunity.uiLink ?? null,
    estimatedValue: opportunity.award?.amount ?? null,
  };
}

/**
 * Why a request failed, in words that name the thing to go and fix.
 *
 * Four causes are indistinguishable from the stack trace and need entirely different actions, and
 * the one that gets confused most is the first: on a corporate network `fetch` fails before it ever
 * reaches SAM.gov, and Node reports that as a bare `fetch failed` with no host and no reason. A
 * person seeing that will spend the afternoon on their key. So the network case is separated out and
 * says which host could not be reached, because "the key is wrong" and "your egress policy does not
 * allow api.sam.gov" look identical from here and are fixed in different buildings.
 */
function describeNetworkFailure(url: URL, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && 'cause' in error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : '';

  return new Error(
    `Could not reach ${url.host}: ${detail}${cause}. This failed before SAM.gov answered, so it is ` +
      'not the key. Usual causes, in order of likelihood on a corporate network: an egress policy ' +
      `that does not allow ${url.host}, a proxy that needs HTTPS_PROXY set for this process, or a ` +
      'TLS chain the process does not trust. Check the host is reachable at all with: curl -sS -o ' +
      `/dev/null -w '%{http_code}' https://${url.host}/`,
  );
}

async function httpFetch(url: URL): Promise<SamPage> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw describeNetworkFailure(url, error);
  }

  if (response.status === 429) {
    // The daily allowance depends on the *role* on the SAM.gov account, not on the key, and the
    // difference between the tiers decides whether this loader can complete a run at all:
    //
    //   non-federal, no role      10 requests/day    a run needs one per profile code, so 17. Unusable.
    //   non-federal, with a role  1,000 requests/day  comfortable
    //   federal system account    10,000 requests/day
    //
    // Somebody hitting this on the bottom tier will try shortening the date range forever, because
    // the range is not what is wrong: the number of *codes* is, and no narrowing gets 17 under 10.
    // Naming the tiers is the difference between a fix and an afternoon.
    throw new Error(
      'SAM.gov returned 429: over the daily rate limit.\n\n' +
        'The allowance depends on the role on the SAM.gov account rather than on the key: a ' +
        'non-federal user with no role gets 10 requests a day, one with a role gets 1,000, and a ' +
        'federal system account gets 10,000. This loader makes one request per code on the ' +
        'opportunity profile, so on the 10-a-day tier a complete run is not possible at any date ' +
        'range — request a role on the SAM.gov account. On the 1,000 tier, narrow the profile or ' +
        'wait for the reset.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    // The body carries which of the two it is, and they are different problems: the gateway says
    // API_KEY_INVALID for a bad key and API_KEY_UNAUTHORIZED for a key that exists but is not
    // entitled to this endpoint. Guessing between them sends somebody to the wrong screen.
    const body = await response.text().catch(() => '');
    throw new Error(
      `SAM.gov returned ${response.status}. ${body.slice(0, 300)}\n\n` +
        'The key for this API comes from SAM.gov itself, at ' +
        'https://sam.gov/workspace/profile/account-details under "Public API Key" — you have to ' +
        'enter your account password to reveal it. A key generated at api.data.gov/signup does not ' +
        'work here: both are GSA, but they are separate systems with separate authentication, which ' +
        'is the single most common reason for a 403 on this endpoint. If the key is right, the other ' +
        'cause is the role: the daily allowance is 10 requests without a role on the account and ' +
        '1,000 with one.',
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SAM.gov returned ${response.status}. ${body.slice(0, 300)}`);
  }

  return (await response.json()) as SamPage;
}

/** The verdict from {@link probeSam}: reachable or not, and why. */
export interface ProbeResult {
  readonly ok: boolean;
  readonly host: string;
  readonly detail: string;
  readonly totalRecords: number | null;
}

/**
 * One request, to answer "is my key good" without spending the day's quota finding out.
 *
 * A normal run makes one request per profile code, so a key problem costs seventeen requests to
 * discover on the corpus this was built against and more on a real one. The daily allowance is 10
 * requests without a role on the SAM.gov account, so on that tier a failed run costs the entire day's
 * budget and the probe would otherwise be unaffordable at exactly the moment it is most needed.
 *
 * It asks for a single notice over a week, which is the cheapest question the endpoint answers, and
 * reports what came back rather than throwing: the caller wants the verdict, not a stack trace.
 */
export async function probeSam(options: LoadSamOptions = {}): Promise<ProbeResult> {
  const apiKey = options.apiKey ?? process.env.SAM_API_KEY ?? '';
  const base = options.baseUrl ?? process.env.SAM_API_BASE ?? DEFAULT_BASE;
  const url = new URL(base);

  if (apiKey === '') {
    return {
      ok: false,
      host: url.host,
      detail: 'SAM_API_KEY is not set, so there is nothing to probe.',
      totalRecords: null,
    };
  }

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  url.searchParams.set('limit', '1');
  url.searchParams.set('offset', '0');
  url.searchParams.set('postedFrom', mmddyyyy(from));
  url.searchParams.set('postedTo', mmddyyyy(to));
  url.searchParams.set('api_key', apiKey);

  const fetchPage = options.fetchPage ?? httpFetch;
  try {
    const page = await fetchPage(url);
    return {
      ok: true,
      host: url.host,
      detail:
        `${url.host} answered. ${page.totalRecords ?? 0} notice(s) posted in the last seven days ` +
        'match an unfiltered search, which is only a reachability figure: a real run filters by the ' +
        'codes on the opportunity profile.',
      totalRecords: page.totalRecords ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      host: url.host,
      detail: error instanceof Error ? error.message : String(error),
      totalRecords: null,
    };
  }
}

export async function loadSamOpportunities(
  client: PoolClient,
  options: LoadSamOptions = {},
): Promise<LoadSamResult> {
  const fetchPage = options.fetchPage ?? httpFetch;
  const usingHttp = options.fetchPage === undefined;
  const apiKey = options.apiKey ?? process.env.SAM_API_KEY ?? '';
  const base = options.baseUrl ?? process.env.SAM_API_BASE ?? DEFAULT_BASE;
  const noticeTypes = options.noticeTypes ?? DEFAULT_NOTICE_TYPES;
  const pageSize = Math.min(options.pageSize ?? 200, MAX_PAGE);
  const maxRequests = options.maxRequests ?? 200;
  const progress = options.onProgress ?? (() => {});

  if (usingHttp && apiKey === '') {
    throw new Error(
      'SAM_API_KEY is not set. Get it from SAM.gov itself, at ' +
        'https://sam.gov/workspace/profile/account-details under "Public API Key" — not from ' +
        'api.data.gov, whose keys do not work against SAM.gov APIs. It is never committed: .env is ' +
        'gitignored and .env.example carries the name only.',
    );
  }

  const postedTo = options.postedTo ?? new Date();
  const postedFrom =
    options.postedFrom ??
    new Date(postedTo.getTime() - (options.lookbackDays ?? 90) * 24 * 60 * 60 * 1000);

  const rangeDays = (postedTo.getTime() - postedFrom.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new Error(
      `SAM.gov rejects a posted range wider than a year; this one is ${Math.round(rangeDays)} ` +
        'days. Run it in slices.',
    );
  }

  // The search list. An explicit --naics or --psc overrides the profile, which is for a
  // one-off look rather than the scheduled run.
  const naicsRows = options.naics
    ? options.naics.map((code) => ({ code_value: code, profile_ids: [] as string[] }))
    : (await profileCodes(client, 'naics')).map((r) => ({ code_value: r.code_value, profile_ids: r.profile_ids }));
  const pscRows = options.psc
    ? options.psc.map((code) => ({ code_value: code, profile_ids: [] as string[] }))
    : (await profileCodes(client, 'psc')).map((r) => ({ code_value: r.code_value, profile_ids: r.profile_ids }));

  const searches: { param: 'ncode' | 'ccode'; matchedOn: 'naics' | 'psc'; code: string; profileIds: string[] }[] = [
    ...naicsRows.map((r) => ({ param: 'ncode' as const, matchedOn: 'naics' as const, code: r.code_value, profileIds: r.profile_ids })),
    ...pscRows.map((r) => ({ param: 'ccode' as const, matchedOn: 'psc' as const, code: r.code_value, profileIds: r.profile_ids })),
  ];

  if (searches.length === 0) {
    throw new Error(
      'The opportunity profile is empty, so there is nothing to search for. Run ' +
        '`npm run profile` first: it builds the profile from the capability taxonomy ' +
        'crosswalks and, if a corpus is loaded, from the codes Astrion works under.',
    );
  }

  const byClass: Record<string, number> = {};
  let requests = 0;
  let fetched = 0;
  let matched = 0;
  let written = 0;
  let skippedNoNoticeId = 0;
  let skippedUnknownType = 0;
  let truncated = false;

  // Notices arrive once per matching code, so the same notice can come back from a NAICS
  // search and a PSC search. It is written once and both matches are recorded.
  const seen = new Map<string, { opportunity: SamOpportunity; matches: { profileIds: string[]; matchedOn: 'naics' | 'psc' }[] }>();

  outer: for (const search of searches) {
    let offset = 0;

    for (;;) {
      if (requests >= maxRequests) {
        truncated = true;
        progress(`Stopped at the ${maxRequests}-request cap. Not every code was searched.`);
        break outer;
      }

      const url = new URL(base);
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('postedFrom', mmddyyyy(postedFrom));
      url.searchParams.set('postedTo', mmddyyyy(postedTo));
      url.searchParams.set(search.param, search.code);
      for (const type of noticeTypes) url.searchParams.append('ptype', type);
      if (apiKey !== '') url.searchParams.set('api_key', apiKey);

      const page = await fetchPage(url);
      requests += 1;

      const data = page.opportunitiesData ?? [];
      fetched += data.length;

      for (const opportunity of data) {
        const noticeId = opportunity.noticeId?.trim();
        if (!noticeId) {
          skippedNoNoticeId += 1;
          continue;
        }
        const existing = seen.get(noticeId);
        if (existing) {
          existing.matches.push({ profileIds: search.profileIds, matchedOn: search.matchedOn });
        } else {
          seen.set(noticeId, {
            opportunity,
            matches: [{ profileIds: search.profileIds, matchedOn: search.matchedOn }],
          });
        }
      }

      progress(
        `  ${search.matchedOn} ${search.code}  offset ${offset}  ${data.length} notice(s)` +
          (page.totalRecords === undefined ? '' : ` of ${page.totalRecords}`),
      );

      const total = page.totalRecords ?? data.length;
      offset += pageSize;
      if (data.length === 0 || offset >= total) break;
    }
  }

  matched = seen.size;

  if (options.dryRun === true) {
    for (const { opportunity } of seen.values()) {
      const type = (opportunity.type ?? opportunity.baseType ?? '').trim();
      const mapped = classify(type);
      if (mapped === null) {
        skippedUnknownType += 1;
        continue;
      }
      byClass[mapped] = (byClass[mapped] ?? 0) + 1;
    }
    return {
      requests, fetched, matched, written: 0, skippedNoNoticeId, skippedUnknownType,
      byClass, codesSearched: searches.length, truncated, run: null,
    };
  }

  const run = await startRun(client, SOURCE_SYSTEM, `${mmddyyyy(postedFrom)}-${mmddyyyy(postedTo)}`);

  try {
    for (const [noticeId, { opportunity, matches }] of seen) {
      // The raw notice is archived as SAM.gov returned it, so a mapping bug found later can be
      // re-derived from what was stored rather than re-fetched against the quota.
      const result = await writeNotice(
        client,
        run,
        normalize(noticeId, opportunity),
        opportunity as Record<string, unknown>,
        matches,
      );

      if (result === null) {
        skippedUnknownType += 1;
        continue;
      }

      byClass[result.signalClass] = (byClass[result.signalClass] ?? 0) + 1;
      written += 1;
    }

    await finishRun(client, run);
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  return {
    requests, fetched, matched, written, skippedNoNoticeId, skippedUnknownType,
    byClass, codesSearched: searches.length, truncated, run,
  };
}
