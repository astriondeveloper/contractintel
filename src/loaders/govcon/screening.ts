/**
 * Exclusions screening and entity lookup, one company at a time.
 *
 * This is the part of GovCon API that is genuinely new rather than cheaper. The corpus can say who
 * held a contract and what it was worth; it cannot say whether that company is currently debarred, or
 * what its UEI is, or whether its SAM.gov registration lapsed last month. Those are live facts about
 * a company's ability to receive an award, and they are exactly what somebody needs at the moment
 * they are about to hand a requirement to TechnoMile with an incumbent named on it.
 *
 * **Why on demand and never swept.** A sweep of the exclusion list or the entity registry would be
 * thousands of requests to pre-answer questions nobody asked, against an allowance shared with the
 * hourly notice sync. So nothing here runs on a schedule. A lookup happens when a person opens a
 * requirement, and the answer is cached; the next person to open the same requirement pays nothing.
 * That is the whole cost design: the expensive endpoints are only ever touched by a human action, and
 * only once per company per freshness window.
 *
 * **Why the cache has a clock.** An exclusion is a fact about today. A stale "not excluded" is the
 * single most dangerous thing this module could return, so `fetched_at` is checked on every read and a
 * screening result older than the window goes back to the API. The window is short for exclusions and
 * long for registrations, because a debarment can land any morning and a legal name cannot.
 *
 * **What this does not do.** It does not decide anything. A hit is shown with its dates, its agency
 * and its wording, and a person reads it. An exclusions match on a common company name is frequently
 * a different company, and a tool that quietly filtered on a name match would hide real opportunities
 * and be trusted while doing it.
 */
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion } from '../../lib/provenance.js';
import { GovconClient, type ClientOptions } from './client.js';

export const SOURCE_SYSTEM = 'govcon_screening';

/**
 * How long a cached answer stands.
 *
 * Exclusions: one day. A debarment is published when it is published and this is a
 * do-not-proceed signal, so the cache is a courtesy to the quota and nothing more.
 *
 * Registrations: seven days. A legal name, a CAGE code and a state do not move. The expiry *date* is
 * stored rather than evaluated, so an expiry that falls inside the window is still read correctly off
 * a cached row — it is a date comparison, not a fetch.
 */
export const EXCLUSION_TTL_HOURS = 24;
export const ENTITY_TTL_HOURS = 24 * 7;

export interface GovconEntity {
  uei?: string;
  cage_code?: string;
  cage?: string;
  legal_business_name?: string;
  legal_name?: string;
  name?: string;
  dba_name?: string;
  registration_status?: string;
  status?: string;
  registration_expiration_date?: string;
  expiration_date?: string;
  state?: string;
  physical_state?: string;
  city?: string;
  physical_city?: string;
  naics?: string[];
  naics_codes?: string[];
  certifications?: string[];
  business_types?: string[];
  [key: string]: unknown;
}

export interface GovconExclusion {
  id?: string;
  exclusion_id?: string;
  record_id?: string;
  uei?: string;
  cage_code?: string;
  name?: string;
  excluded_name?: string;
  classification?: string;
  exclusion_type?: string;
  excluding_agency?: string;
  agency?: string;
  active_date?: string;
  termination_date?: string | null;
  [key: string]: unknown;
}

export interface EntityRow {
  readonly uei: string;
  readonly cage_code: string | null;
  readonly legal_name: string | null;
  readonly dba_name: string | null;
  readonly registration_status: string | null;
  readonly registration_expires_on: Date | null;
  readonly physical_state: string | null;
  readonly physical_city: string | null;
  readonly naics_codes: string[] | null;
  readonly certifications: string[] | null;
  readonly fetched_at: Date;
}

export interface ExclusionRow {
  readonly exclusion_id: string;
  readonly source_record_id: string;
  readonly uei: string | null;
  readonly cage_code: string | null;
  readonly excluded_name: string;
  readonly classification: string | null;
  readonly exclusion_type: string | null;
  readonly excluding_agency: string | null;
  readonly active_date: Date | null;
  readonly termination_date: Date | null;
}

export interface ScreeningResult {
  readonly query: string;
  /** Rows in force today. Empty is a real answer; it is not the same as "not checked". */
  readonly exclusions: readonly ExclusionRow[];
  readonly entity: EntityRow | null;
  /** True when this answer came from the cache rather than the API. */
  readonly cached: boolean;
  readonly fetchedAt: Date | null;
  readonly requests: number;
  /**
   * What a person should read before acting on `exclusions`.
   *
   * Always populated. A screening result with no caveat would imply a determination, and this makes
   * none: the exclusion list matches on names, and names collide.
   */
  readonly caveats: readonly string[];
}

function first(...values: (string | undefined | null)[]): string | null {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) return trimmed;
  }
  return null;
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** A UEI is twelve alphanumeric characters. Used to route a query to the right endpoint. */
export function looksLikeUei(value: string): boolean {
  return /^[A-Za-z0-9]{12}$/.test(value.trim());
}

/** A CAGE code is five alphanumeric characters. */
export function looksLikeCage(value: string): boolean {
  return /^[A-Za-z0-9]{5}$/.test(value.trim());
}

async function cachedEntity(client: PoolClient, uei: string): Promise<EntityRow | null> {
  const { rows } = await client.query<EntityRow>(
    `select uei, cage_code, legal_name, dba_name, registration_status, registration_expires_on,
            physical_state, physical_city, naics_codes, certifications, fetched_at
       from vendor_entity
      where uei = $1 and fetched_at > now() - ($2 || ' hours')::interval`,
    [uei, String(ENTITY_TTL_HOURS)],
  );
  return rows[0] ?? null;
}

async function cachedExclusions(
  client: PoolClient,
  query: string,
): Promise<{ rows: ExclusionRow[]; fetchedAt: Date } | null> {
  // The freshness check is on the newest row for this query, not on each row. A query that returned
  // three hits an hour ago is fresh as a whole; treating rows individually would re-fetch whenever
  // one of them happened to be older.
  const { rows } = await client.query<ExclusionRow & { fetched_at: Date }>(
    `select e.exclusion_id, e.source_record_id, e.uei, e.cage_code, e.excluded_name,
            e.classification, e.exclusion_type, e.excluding_agency, e.active_date,
            e.termination_date, e.fetched_at
       from vendor_exclusion_current e
      where (e.uei = $1 or e.cage_code = $1 or lower(e.excluded_name) = lower($1))
        and e.fetched_at > now() - ($2 || ' hours')::interval`,
    [query, String(EXCLUSION_TTL_HOURS)],
  );
  if (rows.length === 0) return null;
  const fetchedAt = rows.reduce<Date>((newest, row) => (row.fetched_at > newest ? row.fetched_at : newest), rows[0]!.fetched_at);
  return { rows, fetchedAt };
}

/**
 * The caveats that always accompany a screening result.
 *
 * Written as a function of the result rather than a constant, because the "no hits" case needs a
 * different warning from the "hits" case and getting that backwards would be the harmful version:
 * "no hits" must not read as cleared, and "hits" must not read as disqualified.
 */
function caveatsFor(hits: number, entity: EntityRow | null): string[] {
  const caveats: string[] = [];

  if (hits === 0) {
    caveats.push(
      'No exclusion in force matched this query. That is not a clearance: the list matches on the ' +
        'name, UEI or CAGE as given, so a company excluded under a different legal name or a ' +
        'subsidiary will not appear here. Verify on SAM.gov before it matters.',
    );
  } else {
    caveats.push(
      `${hits} exclusion(s) in force matched. A name match is frequently a different company with a ` +
        'similar name; read the UEI and the excluding agency before concluding anything. This tool ' +
        'makes no determination.',
    );
  }

  if (entity === null) {
    caveats.push('No SAM.gov registration was found for this query, so nothing here confirms the identity.');
  } else if (entity.registration_status !== null && !/active/i.test(entity.registration_status)) {
    caveats.push(
      `The SAM.gov registration reads "${entity.registration_status}". An entity without an active ` +
        'registration cannot receive an award until it renews.',
    );
  }

  return caveats;
}

export interface ScreenOptions extends ClientOptions {
  /** Go to the API even if a fresh answer is cached. */
  readonly refresh?: boolean;
}

/**
 * Screen one company: is it excluded, and what does SAM.gov say about it.
 *
 * Accepts a UEI, a CAGE code or a name, and routes accordingly — `/entities/{uei}` is one request
 * where a name search is one request plus whatever the caller does with several candidates.
 *
 * Two requests at most, and zero when the cache is fresh.
 */
export async function screen(
  client: PoolClient,
  query: string,
  options: ScreenOptions = {},
): Promise<ScreeningResult> {
  const trimmed = query.trim();
  if (trimmed === '') throw new Error('Nothing to screen: pass a UEI, a CAGE code or a company name.');

  if (options.refresh !== true) {
    // Sequential, not Promise.all: a PoolClient is one connection and pg does not queue two queries
    // on it. Both reads are index lookups, so there is nothing to win by overlapping them anyway.
    const exclusions = await cachedExclusions(client, trimmed);
    const entity = looksLikeUei(trimmed) ? await cachedEntity(client, trimmed) : null;
    // A cached exclusion set is the expensive half. An entity miss on a name query is expected and
    // is not a reason to spend a request when the exclusion answer is already fresh.
    if (exclusions !== null) {
      return {
        query: trimmed,
        exclusions: exclusions.rows,
        entity,
        cached: true,
        fetchedAt: exclusions.fetchedAt,
        requests: 0,
        caveats: caveatsFor(exclusions.rows.length, entity),
      };
    }
  }

  const api = new GovconClient(options);
  const run = await startRun(client, SOURCE_SYSTEM, `screen ${trimmed}`);

  try {
    // Exclusions first. It is the answer somebody is actually waiting for, so if the second request
    // fails on the quota the useful half has already been stored.
    const exclusionEnvelope = await api.get<GovconExclusion>('/exclusions/search', {
      ...(looksLikeUei(trimmed) ? { uei: trimmed } : looksLikeCage(trimmed) ? { cage: trimmed } : { name: trimmed }),
      limit: 100,
    });

    for (const record of exclusionEnvelope?.data ?? []) {
      const sourceRecordId = first(record.id, record.exclusion_id, record.record_id);
      const name = first(record.excluded_name, record.name);
      // Without an identifier there is nothing to key on and a re-screen would accumulate
      // duplicates, and without a name there is nothing to show. Either one missing makes the row
      // unusable rather than partially usable.
      if (sourceRecordId === null || name === null) continue;

      const version = await recordVersion(client, run, `exclusion:${sourceRecordId}`, record as Record<string, unknown>);
      await client.query(
        `insert into vendor_exclusion (
           source_record_id, uei, cage_code, excluded_name, classification, exclusion_type,
           excluding_agency, active_date, termination_date, source_version_id, fetched_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, now())
         on conflict (source_record_id) do update set
           uei               = excluded.uei,
           cage_code         = excluded.cage_code,
           excluded_name     = excluded.excluded_name,
           classification    = excluded.classification,
           exclusion_type    = excluded.exclusion_type,
           excluding_agency  = excluded.excluding_agency,
           active_date       = excluded.active_date,
           termination_date  = excluded.termination_date,
           source_version_id = excluded.source_version_id,
           fetched_at        = now()`,
        [
          sourceRecordId,
          first(record.uei),
          first(record.cage_code),
          name,
          first(record.classification),
          first(record.exclusion_type),
          first(record.excluding_agency, record.agency),
          isoDate(record.active_date),
          isoDate(record.termination_date),
          version.sourceVersionId,
        ],
      );
    }

    // The registration, when there is a UEI to ask about. A name query would need a search and then
    // a choice between candidates, and choosing on the caller's behalf is how the wrong company ends
    // up on a hand-off.
    if (looksLikeUei(trimmed)) {
      const entityEnvelope = await api.get<GovconEntity>(`/entities/${encodeURIComponent(trimmed)}`);
      const record =
        entityEnvelope?.data?.[0] ?? (entityEnvelope as unknown as { entity?: GovconEntity })?.entity ?? null;

      if (record !== null) {
        const version = await recordVersion(client, run, `entity:${trimmed}`, record as Record<string, unknown>);
        await client.query(
          `insert into vendor_entity (
             uei, cage_code, legal_name, dba_name, registration_status, registration_expires_on,
             physical_state, physical_city, naics_codes, certifications, source_version_id, fetched_at
           ) values ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, now())
           on conflict (uei) do update set
             cage_code               = excluded.cage_code,
             legal_name              = excluded.legal_name,
             dba_name                = excluded.dba_name,
             registration_status     = excluded.registration_status,
             registration_expires_on = excluded.registration_expires_on,
             physical_state          = excluded.physical_state,
             physical_city           = excluded.physical_city,
             naics_codes             = excluded.naics_codes,
             certifications          = excluded.certifications,
             source_version_id       = excluded.source_version_id,
             fetched_at              = now()`,
          [
            trimmed,
            first(record.cage_code, record.cage),
            first(record.legal_business_name, record.legal_name, record.name),
            first(record.dba_name),
            first(record.registration_status, record.status),
            isoDate(record.registration_expiration_date ?? record.expiration_date),
            first(record.physical_state, record.state),
            first(record.physical_city, record.city),
            record.naics_codes ?? record.naics ?? null,
            record.certifications ?? record.business_types ?? null,
            version.sourceVersionId,
          ],
        );
      }
    }

    await finishRun(client, run);
  } catch (error) {
    await finishRun(client, run, 'failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  const fresh = await cachedExclusions(client, trimmed);
  const entity = looksLikeUei(trimmed) ? await cachedEntity(client, trimmed) : null;

  return {
    query: trimmed,
    exclusions: fresh?.rows ?? [],
    entity,
    cached: false,
    fetchedAt: new Date(),
    requests: api.requests,
    caveats: caveatsFor(fresh?.rows.length ?? 0, entity),
  };
}

/**
 * Find an entity by name, when the UEI is not known.
 *
 * Returns candidates rather than picking one. There is no reliable way to choose between "Astrion
 * Inc" and "Astrion Solutions LLC" from a name, and a tool that picked would be wrong quietly.
 *
 * Not cached, and so it takes no database client: a name search is a browse rather than a fact, and
 * caching a browse means caching a ranking the API may have improved since.
 */
export async function findEntities(
  name: string,
  options: ClientOptions = {},
): Promise<{ candidates: GovconEntity[]; requests: number }> {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new Error('An entity name search needs at least two characters.');

  const api = new GovconClient(options);
  const envelope = await api.get<GovconEntity>('/entities/search', { name: trimmed, limit: 20 });
  return { candidates: envelope?.data ?? [], requests: api.requests };
}
