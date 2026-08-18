/**
 * Opportunities from GovCon API, incrementally.
 *
 * This is the same data as `src/loaders/sam.ts` fetches — federal notices, published on SAM.gov —
 * arriving through a different door. It exists because of the access pattern, not the content.
 *
 * **The cost argument, stated plainly.** api.sam.gov has no way to ask "what changed". A run must
 * re-search every code on the opportunity profile over a posted-date window and re-read notices it
 * already has: seventeen requests on the profile this was built against, against a quota measured
 * per day. GovCon API has `/opportunities/delta?since=`, which returns only what was created or
 * modified since a timestamp, against a quota measured per hour. So the same coverage costs the same
 * number of requests but out of an allowance twenty-four times larger, which is what buys the thing
 * that actually matters for an early-warning tool: **the sync can run hourly instead of daily.** A
 * sources sought posted at 9am is in somebody's feed by 10 rather than tomorrow.
 *
 * **The non-redundancy argument.** Both loaders write through `writeNotice`, and `signal_key` is
 * `sam:<notice_id>` in both, so a notice that arrives from both converges on one `pursuit` row and
 * one feed item. Nothing is stored twice and nobody reconciles anything. Provenance still separates
 * them — `source_run.source_system` is `govcon_opportunity` here — so which API delivered which
 * version stays answerable. A test asserts the convergence.
 *
 * That makes the direct SAM.gov loader the fallback rather than the primary: keep it, because a
 * single commercial reseller should not be the only path to a public data source, and running it
 * weekly is a cheap check that the delta stream has not quietly gone stale.
 *
 * **The clamp.** The delta window is capped at 60 days independently of the plan's search window,
 * and a `since` older than that is clamped silently: the response succeeds, the records are correct,
 * and the interval nobody asked for was never fetched. The loader reads `sync.clamp_reason`, records
 * the clamp on the cursor, and says so. An unattended job that had a gap and reported success is the
 * failure this guards against.
 *
 * **The mapping.** GovCon API returns a flat, sensibly-named record, which is most of why it is worth
 * using. Field names below are from the published guide. Where a field could plausibly carry more
 * than one name, several are accepted, and `--sample` prints the keys of the first record returned so
 * the mapping can be confirmed against the live API on first contact rather than assumed. A record
 * whose notice type is unrecognised is counted and skipped, never guessed at.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun } from '../../lib/provenance.js';
import { writeNotice, isoDay, classify, type NormalizedNotice, type ProfileMatch } from '../notice.js';
import { profileCodes } from '../../signals/profile.js';
import { GovconClient, MAX_PAGE, type ClientOptions } from './client.js';

export const SOURCE_SYSTEM = 'govcon_opportunity';

/** The cursor's endpoint key. One cursor per endpoint, so awards can move independently. */
export const DELTA_ENDPOINT = '/opportunities/delta';

/** The endpoint's own cap on `since`, independent of the plan's search window. */
export const DELTA_MAX_DAYS = 60;

/** How far back a first sync reaches when there is no cursor yet. */
export const DEFAULT_FIRST_SYNC_DAYS = 30;

/**
 * A notice as GovCon API returns it.
 *
 * Optional throughout, because a loader that assumes a field is present is a loader that stops on
 * the first record where it is not. Aliases are declared where the guide and the endpoint could
 * reasonably differ; `--sample` is how the real names get confirmed.
 */
export interface GovconOpportunity {
  notice_id?: string;
  noticeId?: string;
  title?: string;
  solicitation_number?: string;
  agency?: string;
  agency_code?: string;
  department?: string;
  sub_agency?: string;
  office?: string;
  office_code?: string;
  posted_date?: string;
  response_deadline?: string | null;
  notice_type?: string;
  type?: string;
  set_aside_type?: string;
  set_aside_code?: string;
  naics?: string[];
  primary_naics?: string;
  naics_code?: string;
  psc?: string;
  psc_code?: string;
  classification_code?: string;
  performance_state?: string;
  performance_state_name?: string;
  performance_city?: string;
  url?: string;
  sam_url?: string;
  ui_link?: string;
  award_amount?: string | number;
  estimated_value?: string | number;
  [key: string]: unknown;
}

export interface SyncOptions extends ClientOptions {
  /** Pull changes since this instant instead of the stored cursor. For a re-pull. */
  readonly since?: Date;
  /** How far back a first sync reaches. Ignored once a cursor exists. */
  readonly firstSyncDays?: number;
  /**
   * Ask the API for the profile's codes (default), or pull the whole delta and filter here.
   *
   * Filtered is one request per code per sync and its cost is predictable. Unfiltered is one request
   * per hundred changed notices government-wide, which is cheaper on a quiet hour and much more
   * expensive on a busy one, and it is the only mode that can see a notice whose codes are missing
   * from the record. Filtered is the default because a scheduled job should have a bounded cost.
   */
  readonly mode?: 'filtered' | 'unfiltered';
  readonly pageSize?: number;
  /** Fetch and classify, write nothing, leave the cursor alone. */
  readonly dryRun?: boolean;
  /** Print the field names of the first record returned, to confirm the mapping. */
  readonly sample?: boolean;
}

export interface SyncResult {
  readonly requests: number;
  readonly fetched: number;
  readonly matched: number;
  readonly written: number;
  readonly skippedNoNoticeId: number;
  readonly skippedUnknownType: number;
  readonly skippedOffProfile: number;
  readonly byClass: Record<string, number>;
  readonly mode: 'filtered' | 'unfiltered';
  readonly since: Date;
  readonly cursorAdvancedTo: Date | null;
  readonly clamped: boolean;
  readonly clampNote: string | null;
  readonly stoppedEarly: string | null;
  readonly sampleKeys: string[] | null;
  readonly rateLimitRemaining: number | null;
}

export interface CursorRow {
  readonly cursor_at: Date;
  readonly last_since: Date | null;
  readonly last_clamped: boolean;
  readonly last_clamp_note: string | null;
  readonly records_seen: number;
  readonly updated_at: Date;
}

export async function readCursor(
  client: PoolClient,
  endpoint = DELTA_ENDPOINT,
  sourceSystem = SOURCE_SYSTEM,
): Promise<CursorRow | null> {
  const { rows } = await client.query<CursorRow>(
    `select cursor_at, last_since, last_clamped, last_clamp_note, records_seen, updated_at
       from sync_cursor where source_system = $1 and endpoint = $2`,
    [sourceSystem, endpoint],
  );
  return rows[0] ?? null;
}

/** ISO 8601 to the second, in UTC, which is the form the `since` parameter takes. */
export function sinceParam(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function first(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * A GovCon record as this system stores it.
 *
 * Two mappings are worth explaining.
 *
 * `agency_code` is what a person follows, and GovCon API returns the agency as a name
 * ("Department of Defense") rather than a code. The name is resolved against the agency labels the
 * corpus has already observed, and left blank when it cannot be — `agencyByLabel` below. Blank is
 * not zero: a wrong code puts a notice in the wrong person's feed, which is worse than a notice that
 * needs its agency filled in.
 *
 * The value is taken only from an award figure. A solicitation has no value until it is awarded and
 * inventing one would be worse than leaving it blank.
 */
export function normalize(
  record: GovconOpportunity,
  noticeId: string,
  agencyByLabel: Map<string, string>,
): NormalizedNotice {
  const agencyName = first(record.agency, record.department);
  return {
    noticeId,
    rawType: (record.notice_type ?? record.type ?? '').trim(),
    title: first(record.title),
    solicitationNumber: first(record.solicitation_number),
    agencyCode:
      first(record.agency_code) ??
      (agencyName === null ? null : agencyByLabel.get(agencyName.toLowerCase()) ?? null),
    officeCode: first(record.office_code, record.office),
    responseDate: isoDay(record.response_deadline),
    postedDate: isoDay(record.posted_date),
    naicsCode: first(record.primary_naics, record.naics_code, record.naics?.[0]),
    pscCode: first(record.psc_code, record.psc, record.classification_code),
    setAsideCode: first(record.set_aside_code, record.set_aside_type),
    placeOfPerformanceState: first(record.performance_state),
    noticeUrl:
      first(record.sam_url, record.url, record.ui_link) ?? `https://sam.gov/opp/${noticeId}/view`,
    estimatedValue:
      record.award_amount === undefined || record.award_amount === null
        ? record.estimated_value === undefined || record.estimated_value === null
          ? null
          : String(record.estimated_value)
        : String(record.award_amount),
  };
}

/**
 * Agency name to agency code, from labels the corpus has already observed.
 *
 * There is no crosswalk to buy here: the corpus is the only place this system has ever seen an
 * agency code and its name together, so it is the only place a name can be resolved from. An
 * unresolved name leaves the code blank, and the readiness report is where that shows up as a
 * number rather than as a surprise.
 */
async function agencyLabels(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ code_value: string; label: string }>(
    `select code_value, label from code_label_current where code_type = 'agency'`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.label) map.set(row.label.trim().toLowerCase(), row.code_value);
  }
  return map;
}

/** Every code on the profile, as a set, for the unfiltered mode's local filter. */
async function profileSets(client: PoolClient): Promise<{
  naics: Map<string, string[]>;
  psc: Map<string, string[]>;
}> {
  // Sequential, not Promise.all. A PoolClient is one connection and pg does not queue: two queries
  // in flight on it is a deprecation warning today and an error in pg 9.
  const naics = await profileCodes(client, 'naics');
  const psc = await profileCodes(client, 'psc');
  return {
    naics: new Map(naics.map((r) => [r.code_value, r.profile_ids])),
    psc: new Map(psc.map((r) => [r.code_value, r.profile_ids])),
  };
}

/**
 * Pull everything that changed since the cursor, and move the cursor.
 *
 * The cursor is advanced to the instant the run *started*, not to the newest record seen and not to
 * the instant it finished. Started, because a notice modified while the run was in flight must be
 * picked up by the next run rather than skipped; newest-record-seen would skip it, and finished would
 * skip anything modified during the run.
 *
 * The cursor is not advanced at all when the run stopped early on the request cap or the rate limit.
 * A partial run that advanced its cursor would lose whatever it did not reach, permanently and
 * silently. Re-fetching a window is cheap; a hole in an early-warning feed is not.
 */
export async function syncOpportunities(
  client: PoolClient,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const api = new GovconClient(options);
  const progress = options.onProgress ?? (() => {});
  const mode = options.mode ?? 'filtered';
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE, MAX_PAGE);

  const runStartedAt = new Date();

  const stored = await readCursor(client);
  const requested =
    options.since ??
    stored?.cursor_at ??
    new Date(runStartedAt.getTime() - (options.firstSyncDays ?? DEFAULT_FIRST_SYNC_DAYS) * 86_400_000);

  // The endpoint clamps silently, so say so before the request rather than discovering it after.
  const oldest = new Date(runStartedAt.getTime() - DELTA_MAX_DAYS * 86_400_000);
  let clamped = requested < oldest;
  let clampNote = clamped
    ? `Asked for changes since ${sinceParam(requested)}, which is older than the endpoint's ` +
      `${DELTA_MAX_DAYS}-day delta window. Anything modified before ${sinceParam(oldest)} was not ` +
      'returned. Backfill that interval with `--backfill` against /opportunities/search instead.'
    : null;
  const since = clamped ? oldest : requested;

  if (clamped) progress(clampNote!);
  progress(`Changes since ${sinceParam(since)}, ${mode}.`);

  const agencyByLabel = await agencyLabels(client);
  const profile = await profileSets(client);

  const searches: { param: 'naics' | 'psc'; code: string; profileIds: string[] }[] =
    mode === 'filtered'
      ? [
          ...[...profile.naics].map(([code, ids]) => ({ param: 'naics' as const, code, profileIds: ids })),
          ...[...profile.psc].map(([code, ids]) => ({ param: 'psc' as const, code, profileIds: ids })),
        ]
      : [];

  if (mode === 'filtered' && searches.length === 0) {
    throw new Error(
      'The opportunity profile is empty, so a filtered sync has nothing to ask for. Run ' +
        '`npm run profile` first, or use `--unfiltered` to pull the whole delta and filter locally.',
    );
  }

  const byClass: Record<string, number> = {};
  let fetched = 0;
  let skippedNoNoticeId = 0;
  let skippedUnknownType = 0;
  let skippedOffProfile = 0;
  let sampleKeys: string[] | null = null;

  // A notice matching two profile codes comes back from both searches. It is written once and both
  // matches are recorded, same as the direct SAM.gov loader.
  const seen = new Map<string, { record: GovconOpportunity; matches: ProfileMatch[] }>();

  const take = (record: GovconOpportunity, matches: ProfileMatch[]): void => {
    fetched += 1;
    if (sampleKeys === null && options.sample === true) sampleKeys = Object.keys(record).sort();

    const noticeId = first(record.notice_id, record.noticeId);
    if (noticeId === null) {
      skippedNoNoticeId += 1;
      return;
    }
    const existing = seen.get(noticeId);
    if (existing) existing.matches.push(...matches);
    else seen.set(noticeId, { record, matches: [...matches] });
  };

  if (mode === 'filtered') {
    for (const search of searches) {
      for await (const page of api.pages<GovconOpportunity>(
        DELTA_ENDPOINT,
        { since: sinceParam(since), [search.param]: search.code },
        pageSize,
      )) {
        for (const record of page) {
          take(record, [{ profileIds: search.profileIds, matchedOn: search.param }]);
        }
      }
      if (api.stoppedEarly !== null) break;
    }
  } else {
    for await (const page of api.pages<GovconOpportunity>(
      DELTA_ENDPOINT,
      { since: sinceParam(since) },
      pageSize,
    )) {
      for (const record of page) {
        // Off-profile notices are the whole reason the unfiltered mode is not the default: the
        // government publishes everything and this system exists to look at what Astrion competes
        // in. The filter is the same profile the other mode sends to the API.
        const codes = [
          ...(record.naics ?? []),
          ...(record.primary_naics === undefined ? [] : [record.primary_naics]),
          ...(record.naics_code === undefined ? [] : [record.naics_code]),
        ];
        const pscCodes = [record.psc_code, record.psc, record.classification_code].filter(
          (c): c is string => typeof c === 'string' && c !== '',
        );

        const matches: ProfileMatch[] = [];
        for (const code of codes) {
          const ids = profile.naics.get(code);
          if (ids !== undefined) matches.push({ profileIds: ids, matchedOn: 'naics' });
        }
        for (const code of pscCodes) {
          const ids = profile.psc.get(code);
          if (ids !== undefined) matches.push({ profileIds: ids, matchedOn: 'psc' });
        }

        if (matches.length === 0) {
          skippedOffProfile += 1;
          continue;
        }
        take(record, matches);
      }
    }
  }

  // The API also reports its own clamp, and the two reports are not interchangeable.
  //
  // The calculation above knows what was *asked for* — the cursor, or `--since` — and therefore knows
  // the size of the gap, which is the thing a person needs. The API only ever sees what was actually
  // sent, which is already clamped, so its `since_requested` describes the clamp rather than the gap.
  // Overwriting the local note with the API's would silently replace "you are missing April to June"
  // with "you asked for June and got June", which reads like nothing is wrong.
  //
  // So the local note stands when the clamp was predicted, and the API's is used only when it clamped
  // something the calculation did not expect — a window narrower than the documented 60 days, say.
  // That case is the one worth hearing about verbatim.
  const lastSync = api.lastSync;
  if (lastSync?.clamp_reason && !clamped) {
    clamped = true;
    clampNote =
      `GovCon API clamped a request this run did not expect to be clamped: ${lastSync.clamp_reason}. ` +
      `Asked for ${lastSync.since_requested ?? sinceParam(since)}, served from ` +
      `${lastSync.since_applied ?? 'an unreported instant'}. The delta window may be narrower than ` +
      `the documented ${DELTA_MAX_DAYS} days on this plan.`;
  }

  const matched = seen.size;

  if (options.dryRun === true) {
    for (const { record } of seen.values()) {
      const mapped = classify((record.notice_type ?? record.type ?? '').trim());
      if (mapped === null) skippedUnknownType += 1;
      else byClass[mapped] = (byClass[mapped] ?? 0) + 1;
    }
    return {
      requests: api.requests, fetched, matched, written: 0, skippedNoNoticeId, skippedUnknownType,
      skippedOffProfile, byClass, mode, since, cursorAdvancedTo: null, clamped, clampNote,
      stoppedEarly: api.stoppedEarly, sampleKeys, rateLimitRemaining: api.rateLimit.remaining,
    };
  }

  const run = await startRun(client, SOURCE_SYSTEM, `delta since ${sinceParam(since)}`);
  let written = 0;

  try {
    for (const [noticeId, { record, matches }] of seen) {
      const result = await writeNotice(
        client,
        run,
        normalize(record, noticeId, agencyByLabel),
        record as Record<string, unknown>,
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

  // Only a complete run moves the cursor. See the doc comment: a partial run that advanced would
  // lose what it never reached, permanently and without a trace.
  let cursorAdvancedTo: Date | null = null;
  if (api.stoppedEarly === null) {
    cursorAdvancedTo = runStartedAt;
    await client.query(
      `insert into sync_cursor (
         source_system, endpoint, cursor_at, last_since, last_clamped, last_clamp_note,
         last_run_id, records_seen, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (source_system, endpoint) do update set
         cursor_at       = excluded.cursor_at,
         last_since      = excluded.last_since,
         last_clamped    = excluded.last_clamped,
         last_clamp_note = excluded.last_clamp_note,
         last_run_id     = excluded.last_run_id,
         records_seen    = excluded.records_seen,
         updated_at      = now()`,
      [SOURCE_SYSTEM, DELTA_ENDPOINT, runStartedAt, since, clamped, clampNote, run.runId, fetched],
    );
  }

  return {
    requests: api.requests, fetched, matched, written, skippedNoNoticeId, skippedUnknownType,
    skippedOffProfile, byClass, mode, since, cursorAdvancedTo, clamped, clampNote,
    stoppedEarly: api.stoppedEarly, sampleKeys, rateLimitRemaining: api.rateLimit.remaining,
  };
}

export interface BackfillOptions extends ClientOptions {
  readonly postedFrom: Date;
  readonly postedTo?: Date;
  readonly pageSize?: number;
  readonly dryRun?: boolean;
  readonly sample?: boolean;
}

/**
 * The one-off historical pull, over `/opportunities/search`.
 *
 * This is the endpoint the delta endpoint is not: it takes a date range and no cursor, and it is
 * bounded by the plan's historical-search window rather than the delta's 60 days. It is the right
 * tool exactly twice — filling the corpus the first time, and filling an interval a clamp or an
 * outage left a hole in — and the wrong tool for everything else, because on a schedule it would
 * re-download a window it already had.
 *
 * It does not touch `sync_cursor`. A backfill covers the past; the cursor is a statement about the
 * present, and moving it here would tell the next delta run that the interval between the backfill
 * and now had been covered when it had not.
 *
 * `/opportunities/search` rejects a bare call with 400: at least one filter is required. The profile
 * codes are that filter, which is also what keeps a backfill from pulling the entire government.
 */
export async function backfillOpportunities(
  client: PoolClient,
  options: BackfillOptions,
): Promise<SyncResult> {
  const api = new GovconClient(options);
  const progress = options.onProgress ?? (() => {});
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE, MAX_PAGE);
  const postedTo = options.postedTo ?? new Date();

  if (options.postedFrom >= postedTo) {
    throw new Error('The backfill range is empty: --from must be before --to.');
  }

  const agencyByLabel = await agencyLabels(client);
  const profile = await profileSets(client);

  const searches = [
    ...[...profile.naics].map(([code, ids]) => ({ param: 'naics' as const, code, profileIds: ids })),
    ...[...profile.psc].map(([code, ids]) => ({ param: 'psc' as const, code, profileIds: ids })),
  ];

  if (searches.length === 0) {
    throw new Error(
      'The opportunity profile is empty, and /opportunities/search rejects a call with no filter. ' +
        'Run `npm run profile` first.',
    );
  }

  const day = (at: Date): string => at.toISOString().slice(0, 10);
  progress(`Backfilling ${day(options.postedFrom)} to ${day(postedTo)} over ${searches.length} code(s).`);

  const byClass: Record<string, number> = {};
  let fetched = 0;
  let skippedNoNoticeId = 0;
  let skippedUnknownType = 0;
  let sampleKeys: string[] | null = null;
  const seen = new Map<string, { record: GovconOpportunity; matches: ProfileMatch[] }>();

  for (const search of searches) {
    for await (const page of api.pages<GovconOpportunity>(
      '/opportunities/search',
      { date_from: day(options.postedFrom), date_to: day(postedTo), [search.param]: search.code },
      pageSize,
    )) {
      for (const record of page) {
        fetched += 1;
        if (sampleKeys === null && options.sample === true) sampleKeys = Object.keys(record).sort();

        const noticeId = first(record.notice_id, record.noticeId);
        if (noticeId === null) {
          skippedNoNoticeId += 1;
          continue;
        }
        const existing = seen.get(noticeId);
        const match: ProfileMatch = { profileIds: search.profileIds, matchedOn: search.param };
        if (existing) existing.matches.push(match);
        else seen.set(noticeId, { record, matches: [match] });
      }
    }
    if (api.stoppedEarly !== null) break;
  }

  const matched = seen.size;

  if (options.dryRun === true) {
    for (const { record } of seen.values()) {
      const mapped = classify((record.notice_type ?? record.type ?? '').trim());
      if (mapped === null) skippedUnknownType += 1;
      else byClass[mapped] = (byClass[mapped] ?? 0) + 1;
    }
    return {
      requests: api.requests, fetched, matched, written: 0, skippedNoNoticeId, skippedUnknownType,
      skippedOffProfile: 0, byClass, mode: 'filtered', since: options.postedFrom,
      cursorAdvancedTo: null, clamped: false, clampNote: null, stoppedEarly: api.stoppedEarly,
      sampleKeys, rateLimitRemaining: api.rateLimit.remaining,
    };
  }

  const run = await startRun(client, SOURCE_SYSTEM, `backfill ${day(options.postedFrom)}-${day(postedTo)}`);
  let written = 0;

  try {
    for (const [noticeId, { record, matches }] of seen) {
      const result = await writeNotice(
        client,
        run,
        normalize(record, noticeId, agencyByLabel),
        record as Record<string, unknown>,
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
    requests: api.requests, fetched, matched, written, skippedNoNoticeId, skippedUnknownType,
    skippedOffProfile: 0, byClass, mode: 'filtered', since: options.postedFrom,
    cursorAdvancedTo: null, clamped: false, clampNote: null, stoppedEarly: api.stoppedEarly,
    sampleKeys, rateLimitRemaining: api.rateLimit.remaining,
  };
}
