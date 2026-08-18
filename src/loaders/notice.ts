/**
 * One federal notice, one row, however many APIs delivered it.
 *
 * There are two ways into this system's notices now. `sam.ts` asks api.sam.gov directly, one
 * request per code on the opportunity profile. `govcon/opportunities.ts` asks GovCon API's delta
 * endpoint, which is one request for everything that changed. Both return SAM.gov notices, because
 * SAM.gov is where federal notices are published and GovCon API is a reseller of that same data
 * with a better shape and a cheaper access pattern.
 *
 * So they overlap, and overlap is the thing to get right rather than the thing to avoid. The rule
 * here is that **the notice id is the identity, not the API that delivered it**. `signal_key` is
 * `sam:<notice_id>` in both loaders, so a notice that arrives from both converges on one `pursuit`
 * row: whichever loader saw it second updates the row instead of creating a second one. A person
 * following that agency sees one item in their feed, not two, and nobody has to reconcile anything.
 *
 * That guarantee only holds while both loaders write through the same code, which is why this module
 * exists and why neither loader has an `insert into pursuit` of its own. Provenance still records
 * which API delivered which version — `source_run.source_system` differs, and `source_version` keeps
 * the raw payload in whatever shape that API returned it — so "where did this come from" is
 * answerable per version even though the pursuit is shared.
 *
 * A test asserts the convergence directly: the same notice through both loaders is one pursuit.
 */
import type { PoolClient } from 'pg';
import { recordVersion, type RunHandle } from '../lib/provenance.js';

/**
 * SAM.gov notice types, and what each one means for how early the work is.
 *
 * The codes are the `ptype` values from the Get Opportunities v2 definition. The signal class is
 * this system's reading of them, and it is the whole reason the type is kept rather than flattened:
 * collapsing a sources sought into "an opportunity" throws away the only field that says there is
 * still time to shape it.
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
 * Award notices are excluded: they are the largest type by volume and they describe work that is
 * finished, so they are competitive intelligence rather than pipeline. `--include-awards` turns them
 * on when that is what is wanted.
 */
export const DEFAULT_NOTICE_TYPES: readonly NoticeType[] = ['r', 's', 'i', 'p', 'o', 'k'];

/**
 * The notice type as a signal class.
 *
 * SAM.gov spells the type out in `type` ("Sources Sought") and abbreviates it in `ptype` ("r"), and
 * which one arrives depends on the endpoint, so both are accepted. GovCon API passes the spelled-out
 * form through in `notice_type`, which is why the substring arm matters as much as the code arm.
 *
 * An unrecognised type is skipped and counted rather than guessed at: a new notice type is a thing
 * to look at, not a thing to file under whatever is nearest.
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

/** Dates arrive as a day or as a date-time. Only the day is stored. */
export function isoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * A notice reduced to the fields this system stores, with the source API's naming gone.
 *
 * Each loader maps its own response into this and nothing downstream knows which API it came from.
 * Every field but `noticeId` and `rawType` is nullable on purpose: blank is not zero, and a
 * solicitation genuinely has no value until it is awarded.
 */
export interface NormalizedNotice {
  readonly noticeId: string;
  readonly rawType: string;
  readonly title: string | null;
  readonly solicitationNumber: string | null;
  readonly agencyCode: string | null;
  readonly officeCode: string | null;
  readonly responseDate: string | null;
  readonly postedDate: string | null;
  readonly naicsCode: string | null;
  readonly pscCode: string | null;
  readonly setAsideCode: string | null;
  readonly placeOfPerformanceState: string | null;
  readonly noticeUrl: string | null;
  /** Only an award notice carries a figure. Inventing one for a solicitation would be worse than blank. */
  readonly estimatedValue: string | null;
}

/** Which profile row pulled a notice in, so "why is this in my feed" has a second answer. */
export interface ProfileMatch {
  readonly profileIds: readonly string[];
  readonly matchedOn: 'naics' | 'psc';
}

export interface WriteNoticeResult {
  readonly pursuitId: string | null;
  readonly signalClass: string;
}

/**
 * The signal key for a notice. `sam:` regardless of which API delivered it, because the notice is
 * a SAM.gov notice either way and the key is what makes the two loaders converge.
 */
export function signalKeyFor(noticeId: string): string {
  return `sam:${noticeId}`;
}

/**
 * Write one notice, and the profile matches that explain it.
 *
 * Returns null for `pursuitId` when the type was unrecognised — the caller counts that rather than
 * failing, because one strange notice should not abandon a run.
 *
 * The `raw` payload is archived under the run's own source system, keyed by hash, so a re-run over
 * unchanged notices reports unchanged and a corrected notice arrives as a new version. Pass the
 * payload exactly as the API returned it: the archive is meant to be the API's answer, not this
 * system's reading of it, so that a mapping bug found later can be re-derived from what was stored.
 */
export async function writeNotice(
  client: PoolClient,
  run: RunHandle,
  notice: NormalizedNotice,
  raw: Record<string, unknown>,
  matches: readonly ProfileMatch[] = [],
): Promise<WriteNoticeResult | null> {
  const signalClass = classify(notice.rawType);
  if (signalClass === null) return null;

  const version = await recordVersion(client, run, notice.noticeId, raw);

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
      (notice.title ?? `SAM.gov notice ${notice.noticeId}`).slice(0, 500),
      notice.noticeId,
      notice.solicitationNumber,
      notice.agencyCode,
      notice.officeCode,
      notice.responseDate,
      notice.postedDate,
      notice.rawType.trim() || null,
      notice.naicsCode,
      notice.pscCode,
      notice.setAsideCode,
      notice.placeOfPerformanceState,
      notice.noticeUrl,
      notice.estimatedValue,
      signalKeyFor(notice.noticeId),
      run.sourceSystem,
      version.sourceVersionId,
    ],
  );

  const pursuitId = rows[0]?.pursuit_id ?? null;
  if (pursuitId !== null) {
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

  return { pursuitId, signalClass };
}
