/**
 * GovCon API transport. One place that knows the base URL, the bearer token and the envelope.
 *
 * Endpoint contract, from https://govconapi.com/api-guide:
 *
 *   base            https://govconapi.com/api/v1
 *   auth            Authorization: Bearer <key>
 *   list envelope   { data: [...], pagination: { limit, offset, total, has_next },
 *                     filters_applied: {...}, _sources: [...] }
 *   pagination      limit and offset, max 100 per page on the paginated searches
 *   rate limit      1,000 requests per hour across the whole API, with X-RateLimit-Limit and
 *                   X-RateLimit-Remaining on every response
 *   /me             plan, rate limit and search window. The free call, and so the probe target.
 *
 * Two things this module is responsible for beyond making the request.
 *
 * **Pacing.** The limit is per hour across every endpoint, so a delta sync and a screening sweep
 * share it. `X-RateLimit-Remaining` is read off every response and a run stops itself with a clear
 * message while there are still requests left for whatever else is scheduled, rather than spending
 * the last one and leaving the next job to discover the wall.
 *
 * **Telling apart the failures that look alike.** A blocked host, a wrong key, a key on the wrong
 * plan and an exhausted quota all surface as "it didn't work", and they are fixed by four different
 * people. Each gets its own message naming the thing to go and do. This is the same discipline as
 * the SAM.gov loader, for the same reason: the afternoon somebody spends on the wrong theory is the
 * real cost of a vague error.
 *
 * The key is read from `GOVCON_API_KEY` and never leaves this file. It is not logged and not written
 * to `source_version`; a test asserts it never reaches an archived payload.
 */

export const DEFAULT_BASE = 'https://govconapi.com/api/v1';

/** The API's own ceiling on `limit` for the paginated searches. */
export const MAX_PAGE = 100;

/**
 * Stop with this many requests still on the clock.
 *
 * The hourly allowance is shared by every job. A sync that drains it to zero has not failed, but it
 * has taken the screening lookups and the on-demand entity calls down with it, and those are the
 * ones a person is waiting on. Leaving a margin costs a few notices on a very busy hour and buys
 * every interactive lookup for the rest of it.
 */
export const RESERVE_REQUESTS = 50;

export interface Pagination {
  readonly limit?: number;
  readonly offset?: number;
  readonly total?: number;
  readonly has_next?: boolean;
}

/**
 * The sync block on a delta response.
 *
 * `clamp_reason` is the field that matters. The delta window is capped at 60 days independently of
 * the plan's historical-search window, and a `since` older than that is clamped silently. Silently
 * is the problem: the response is a success, the records are correct, and the interval between what
 * was asked for and what was served was never fetched by anybody. The loader treats a clamp as a
 * gap and records it on the cursor.
 */
export interface SyncBlock {
  readonly since_requested?: string;
  readonly since_applied?: string;
  readonly clamp_reason?: string | null;
}

export interface Envelope<T> {
  readonly data?: T[];
  readonly pagination?: Pagination;
  readonly filters_applied?: Record<string, unknown>;
  readonly _sources?: string[];
  readonly sync?: SyncBlock;
  /** Present on an error response. */
  readonly error?: string;
  readonly message?: string;
}

/** What the transport learned from the response headers, which is not part of the body. */
export interface RateLimit {
  readonly limit: number | null;
  readonly remaining: number | null;
}

export interface Fetched<T> {
  readonly envelope: Envelope<T>;
  readonly rateLimit: RateLimit;
}

/** One HTTP call. Injected so every loader above this can be tested without a key or a network. */
export type FetchJson = <T>(url: URL, apiKey: string) => Promise<Fetched<T>>;

export interface ClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Replaces the HTTP call. Tests pass recorded pages; nothing else should. */
  readonly fetchJson?: FetchJson;
  /** Stop after this many requests in one run. Defaults to the hourly limit less the reserve. */
  readonly maxRequests?: number;
  readonly onProgress?: (message: string) => void;
}

export function resolveKey(options: ClientOptions): string {
  return (options.apiKey ?? process.env.GOVCON_API_KEY ?? '').trim();
}

export function resolveBase(options: ClientOptions): string {
  return (options.baseUrl ?? process.env.GOVCON_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, '');
}

export function requireKey(options: ClientOptions): string {
  const key = resolveKey(options);
  if (key === '') {
    throw new Error(
      'GOVCON_API_KEY is not set. Get a key at https://govconapi.com and put it in the ' +
        'environment. It is never committed: .env is gitignored and .env.example carries the name ' +
        'only. Check the key works with `npm run load:govcon -- --probe`, which spends one request.',
    );
  }
  return key;
}

/**
 * Why a request failed, in words that name the thing to go and fix.
 *
 * `fetch` reports a network failure as a bare "fetch failed" with no host and no reason, which on a
 * corporate network is what an egress policy looks like from inside the process. That is
 * indistinguishable from an authentication problem here and is fixed in a different building, so the
 * network case says which host could not be reached and says explicitly that it is not the key.
 */
function describeNetworkFailure(url: URL, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && 'cause' in error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : '';

  return new Error(
    `Could not reach ${url.host}: ${detail}${cause}. This failed before GovCon API answered, so it ` +
      'is not the key. Usual causes, in order of likelihood on a corporate network: an egress ' +
      `policy that does not allow ${url.host}, a proxy that needs HTTPS_PROXY set for this ` +
      'process, or a TLS chain the process does not trust. Check the host is reachable at all ' +
      `with: curl -sS -o /dev/null -w '%{http_code}' https://${url.host}/`,
  );
}

function readRateLimit(response: Response): RateLimit {
  const read = (header: string): number | null => {
    const raw = response.headers.get(header);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return { limit: read('x-ratelimit-limit'), remaining: read('x-ratelimit-remaining') };
}

export const httpFetchJson: FetchJson = async <T>(url: URL, apiKey: string): Promise<Fetched<T>> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw describeNetworkFailure(url, error);
  }

  const rateLimit = readRateLimit(response);

  if (response.status === 429) {
    throw new Error(
      'GovCon API returned 429: over the rate limit. The allowance is 1,000 requests per hour ' +
        'across the whole API, shared by every job, and it resets on the hour. If a scheduled sync ' +
        'is hitting this, it is pulling a window it already has: check `select * from sync_cursor` ' +
        'and make sure the cursor is being written.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => '');
    // 401 and 403 are different problems here. 401 is a key the API does not recognise. 403 is a key
    // it recognises on a plan that does not include this endpoint — several are Pro-only — and no
    // amount of checking the key will fix that one.
    throw new Error(
      `GovCon API returned ${response.status} for ${url.pathname}. ${body.slice(0, 300)}\n\n` +
        (response.status === 401
          ? 'The key was not recognised. It goes in GOVCON_API_KEY and is sent as ' +
            '`Authorization: Bearer <key>`. Confirm it with `npm run load:govcon -- --probe`, ' +
            'which calls /me.'
          : 'The key was recognised but is not entitled to this endpoint or this date range. Some ' +
            'endpoints are Pro-tier, and each plan has its own historical-search window. ' +
            '`npm run load:govcon -- --probe` prints the plan and the window this key actually has.'),
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GovCon API returned ${response.status} for ${url.pathname}. ${body.slice(0, 300)}`);
  }

  return { envelope: (await response.json()) as Envelope<T>, rateLimit };
};

/**
 * A run's worth of requests, counted and paced.
 *
 * Every loader goes through this rather than calling `fetchJson` directly, so the request count, the
 * reserve and the rate-limit headers are enforced in one place and a new endpoint cannot forget
 * them.
 */
export class GovconClient {
  private readonly key: string;
  private readonly base: string;
  private readonly fetchJson: FetchJson;
  private readonly maxRequests: number;
  private readonly progress: (message: string) => void;

  requests = 0;
  rateLimit: RateLimit = { limit: null, remaining: null };
  /** Set when the run stopped itself rather than finishing. A caller must report this. */
  stoppedEarly: string | null = null;
  /**
   * The most recent response's `sync` block, if it had one.
   *
   * Held on the client rather than returned, because it arrives on a delta page and is a statement
   * about the whole run: the caller needs it after the loop, not inside it.
   */
  lastSync: SyncBlock | null = null;

  constructor(options: ClientOptions = {}) {
    this.key = options.fetchJson === undefined ? requireKey(options) : resolveKey(options);
    this.base = resolveBase(options);
    this.fetchJson = options.fetchJson ?? httpFetchJson;
    this.maxRequests = options.maxRequests ?? 1000 - RESERVE_REQUESTS;
    this.progress = options.onProgress ?? (() => {});
  }

  url(path: string, params: Record<string, string | number | undefined> = {}): URL {
    const url = new URL(`${this.base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url;
  }

  /** True when this run should stop. Checked before each request, not after. */
  get exhausted(): boolean {
    if (this.requests >= this.maxRequests) return true;
    return this.rateLimit.remaining !== null && this.rateLimit.remaining <= RESERVE_REQUESTS;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<Envelope<T> | null> {
    if (this.exhausted) {
      this.stoppedEarly =
        this.requests >= this.maxRequests
          ? `Stopped at the ${this.maxRequests}-request cap for this run.`
          : `Stopped with ${this.rateLimit.remaining} hourly requests left, holding ` +
            `${RESERVE_REQUESTS} back for the interactive lookups. This run is incomplete; the ` +
            'cursor was not advanced past what it fetched, so the next run resumes rather than skips.';
      return null;
    }

    const url = this.url(path, params);
    const { envelope, rateLimit } = await this.fetchJson<T>(url, this.key);
    this.requests += 1;
    // A test-injected fetch reports no headers. Keep the last real reading rather than clearing it.
    if (rateLimit.limit !== null || rateLimit.remaining !== null) this.rateLimit = rateLimit;
    if (envelope.sync !== undefined) this.lastSync = envelope.sync;
    this.progress(
      `  ${path}  ${(envelope.data ?? []).length} record(s)` +
        (envelope.pagination?.total === undefined ? '' : ` of ${envelope.pagination.total}`),
    );
    return envelope;
  }

  /**
   * Every page of a paginated endpoint, stopping when the API says there are no more.
   *
   * `has_next` is trusted when present and the offset is compared against `total` when it is not,
   * because a loop that trusts neither runs until the quota is gone.
   */
  async *pages<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    pageSize = MAX_PAGE,
  ): AsyncGenerator<T[]> {
    const limit = Math.min(pageSize, MAX_PAGE);
    let offset = 0;

    for (;;) {
      const envelope = await this.get<T>(path, { ...params, limit, offset });
      if (envelope === null) return;

      const data = envelope.data ?? [];
      if (data.length > 0) yield data;

      const pagination = envelope.pagination;
      offset += limit;

      if (data.length === 0) return;
      if (pagination?.has_next === false) return;
      if (pagination?.has_next === undefined && pagination?.total !== undefined && offset >= pagination.total) return;
      if (pagination === undefined) return;
    }
  }
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly host: string;
  readonly detail: string;
  readonly plan: string | null;
  readonly rateLimit: number | null;
  readonly searchWindow: string | null;
}

interface MeResponse {
  plan?: string;
  plan_name?: string;
  tier?: string;
  rate_limit?: number;
  rate_limit_per_hour?: number;
  search_window?: string;
  search_window_days?: number;
  historical_window_days?: number;
  email?: string;
}

/**
 * One request, to answer "is my key good and what does it get me" without spending anything.
 *
 * `/me` is the right probe target for two reasons beyond being cheap. It answers the plan and the
 * historical-search window, which decide what the other endpoints will and will not return — a 403
 * from a Pro-only endpoint is a plan problem wearing an authentication problem's clothes, and this
 * is where you find that out. And it reports the rate limit, so the pacing above has a real number
 * rather than the documented one.
 *
 * It returns its verdict rather than throwing. The caller wants something to print; somebody running
 * a probe is already looking at a failure and does not need a stack trace on top of it.
 */
export async function probeGovcon(options: ClientOptions = {}): Promise<ProbeResult> {
  const base = resolveBase(options);
  const host = new URL(base).host;
  const key = resolveKey(options);

  if (key === '' && options.fetchJson === undefined) {
    return {
      ok: false,
      host,
      detail: 'GOVCON_API_KEY is not set, so there is nothing to probe.',
      plan: null,
      rateLimit: null,
      searchWindow: null,
    };
  }

  try {
    const fetchJson = options.fetchJson ?? httpFetchJson;
    const { envelope, rateLimit } = await fetchJson<never>(new URL(`${base}/me`), key);
    // /me answers with the account object, which may sit at the top level or under `data`.
    const me = ((envelope as unknown as { data?: MeResponse[] }).data?.[0] ??
      (envelope as unknown as MeResponse)) as MeResponse;

    const plan = me.plan ?? me.plan_name ?? me.tier ?? null;
    const hourly = me.rate_limit ?? me.rate_limit_per_hour ?? rateLimit.limit ?? null;
    const windowDays = me.search_window_days ?? me.historical_window_days;
    const searchWindow = me.search_window ?? (windowDays === undefined ? null : `${windowDays} days`);

    return {
      ok: true,
      host,
      detail:
        `${host} answered. ` +
        `plan ${plan ?? 'not reported'}, ` +
        `${hourly ?? 'unreported'} requests/hour, ` +
        `search window ${searchWindow ?? 'not reported'}. ` +
        'The delta window is a separate 60-day cap and is not this figure.',
      plan,
      rateLimit: hourly,
      searchWindow,
    };
  } catch (error) {
    return {
      ok: false,
      host,
      detail: error instanceof Error ? error.message : String(error),
      plan: null,
      rateLimit: null,
      searchWindow: null,
    };
  }
}
