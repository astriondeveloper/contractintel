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
import { startRun, finishRun, recordVersion, type RunHandle } from '../lib/provenance.js';
import { profileCodes } from '../signals/profile.js';

export const SOURCE_SYSTEM = 'sam_opportunity';

const DEFAULT_BASE = 'https://api.sam.gov/opportunities/v2/search';

/**
 * SAM.gov notice types, and what each one means for how early the work is.
 *
 * The codes are the `ptype` values from the API definition. The signal class is this
 * system's reading of them, and it is the whole reason the type is kept rather than
 * flattened: collapsing a sources sought into "an opportunity" throws away the only field
 * that says there is still time to shape it.
 */
export const NOTICE_TYPES = {
  r: { label: 'Sources sought', signalClass: 'shaping_target' },
  s: { label: 'Special notice', signalClass: 'shaping_target' },
  i: { label: 'Intent to bundle', signalClass: 'shaping_target' },
  p: { label: 'Presolicitation', signalClass: 'active_solicitation' },
  o: { label: 'Solicitation', signalClass: 'active_solicitation' },
  k: { label: 'Combined synopsis/solicitation', signalClass: 'active_solicitation' },
  a: { label: 'Award notice', signalClass: 'market_movement' },
} as const;

export type NoticeType = keyof typeof NOTICE_TYPES;

/**
 * What a default run asks for.
 *
 * Award notices are excluded: they are the largest type by volume and they describe work
 * that is finished, so they are competitive intelligence rather than pipeline. `--include-awards`
 * turns them on when that is what is wanted.
 */
export const DEFAULT_NOTICE_TYPES: readonly NoticeType[] = ['r', 's', 'i', 'p', 'o', 'k'];

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

/** SAM.gov dates arrive as ISO or as a date-time. Only the day is stored. */
function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** A response deadline carries a time and a zone. Postgres holds it as a date. */
function deadlineDay(value: string | null | undefined): string | null {
  return isoDay(value);
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
    throw new Error(
      'SAM.gov returned 429: the API key is over its rate limit. A public key allows a ' +
        'limited number of requests per day. Narrow the profile, shorten the date range, ' +
        'or wait for the quota to reset.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    // The body carries which of the two it is, and they are different problems: api.data.gov says
    // API_KEY_INVALID for a bad key and API_KEY_UNAUTHORIZED for a key that exists but is not
    // registered for this endpoint. Guessing between them sends somebody to the wrong screen.
    const body = await response.text().catch(() => '');
    throw new Error(
      `SAM.gov returned ${response.status}. ${body.slice(0, 300)}\n\n` +
        'A key must be an api.data.gov key registered for the Opportunities API specifically; a key ' +
        'that works against another api.data.gov endpoint returns 403 here. api.data.gov keys are 40 ' +
        'characters of letters and digits with no punctuation, so a value that looks like anything ' +
        'else is probably a different kind of credential. Get one at https://api.data.gov/signup/ ' +
        'and put it in SAM_API_KEY.',
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
 * discover on the corpus this was built against and more on a real one. A public api.data.gov key
 * allows a limited number per day, so the diagnosis should not eat the budget it is diagnosing.
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
      'SAM_API_KEY is not set. Get a key from api.data.gov, register it for the ' +
        'Opportunities API, and put it in the environment. It is never committed: .env is ' +
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
      const rawType = (opportunity.type ?? opportunity.baseType ?? '').trim();
      const signalClass = classify(rawType);
      if (signalClass === null) {
        skippedUnknownType += 1;
        continue;
      }

      // The whole notice is archived, keyed by hash, so a re-run over unchanged notices
      // reports unchanged and a corrected notice arrives as a new version.
      const version = await recordVersion(client, run, noticeId, opportunity as Record<string, unknown>);

      const posted = isoDay(opportunity.postedDate);
      const deadline = deadlineDay(opportunity.responseDeadLine);

      const { rows } = await client.query<{ pursuit_id: string }>(
        `insert into pursuit (
           signal_class, title, notice_id, solicitation_number, agency_code, office_code,
           response_date, posted_date, notice_type, naics_code, psc_code, set_aside_code,
           place_of_performance_state, notice_url, estimated_value,
           signal_key, generated_by, generated_at, source_version_id, state
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7::date, $8::date, $9, $10, $11, $12,
           $13, $14, $15::numeric,
           $16, $17, now(), $18, 'open'
         )
         on conflict (signal_key) where signal_key is not null do update set
           signal_class               = excluded.signal_class,
           title                      = excluded.title,
           notice_id                  = excluded.notice_id,
           solicitation_number        = excluded.solicitation_number,
           agency_code                = excluded.agency_code,
           office_code                = excluded.office_code,
           response_date              = excluded.response_date,
           posted_date                = excluded.posted_date,
           notice_type                = excluded.notice_type,
           naics_code                 = excluded.naics_code,
           psc_code                   = excluded.psc_code,
           set_aside_code             = excluded.set_aside_code,
           place_of_performance_state = excluded.place_of_performance_state,
           notice_url                 = excluded.notice_url,
           estimated_value            = excluded.estimated_value,
           generated_by               = excluded.generated_by,
           generated_at               = excluded.generated_at,
           source_version_id          = excluded.source_version_id
         where pursuit.signal_key is not null
         returning pursuit_id`,
        [
          signalClass,
          (opportunity.title ?? `SAM.gov notice ${noticeId}`).slice(0, 500),
          noticeId,
          opportunity.solicitationNumber ?? null,
          opportunity.fullParentPathCode?.split('.')[0] ?? null,
          opportunity.office ?? null,
          deadline,
          posted,
          rawType || null,
          opportunity.naicsCode ?? null,
          opportunity.classificationCode ?? null,
          opportunity.typeOfSetAside ?? null,
          opportunity.placeOfPerformance?.state?.code ?? null,
          opportunity.uiLink ?? null,
          // Only an award notice carries a figure. A solicitation has no value until it is
          // awarded, and inventing one would be worse than leaving it blank.
          opportunity.award?.amount ?? null,
          `sam:${noticeId}`,
          SOURCE_SYSTEM,
          version.sourceVersionId,
        ],
      );

      const pursuitId = rows[0]?.pursuit_id;
      if (pursuitId !== undefined) {
        for (const match of matches) {
          for (const profileId of match.profileIds) {
            await client.query(
              `insert into pursuit_profile_match (pursuit_id, profile_id, matched_on)
               values ($1::bigint, $2::bigint, $3)
               on conflict do nothing`,
              [pursuitId, profileId, match.matchedOn],
            );
          }
        }
      }

      byClass[signalClass] = (byClass[signalClass] ?? 0) + 1;
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

/**
 * The notice type as a signal class.
 *
 * SAM.gov spells the type out in `type` ("Sources Sought") and abbreviates it in `ptype`
 * ("r"), and which one arrives depends on the endpoint, so both are accepted. An
 * unrecognised type is skipped and counted rather than guessed at: a new notice type is a
 * thing to look at, not a thing to file under whatever is nearest.
 */
export function classify(rawType: string): string | null {
  const value = rawType.trim().toLowerCase();
  if (value === '') return null;

  const single = NOTICE_TYPES[value as NoticeType];
  if (single) return single.signalClass;

  if (value.includes('sources sought')) return 'shaping_target';
  if (value.includes('special notice')) return 'shaping_target';
  if (value.includes('intent to bundle')) return 'shaping_target';
  if (value.includes('combined synopsis')) return 'active_solicitation';
  if (value.includes('presolicitation') || value.includes('pre-solicitation')) return 'active_solicitation';
  if (value.includes('solicitation')) return 'active_solicitation';
  if (value.includes('award')) return 'market_movement';

  return null;
}
