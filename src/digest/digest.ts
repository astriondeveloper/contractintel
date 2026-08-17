/**
 * The digest. What one person's patch has done since they last looked, rendered for delivery.
 *
 * The spec put email and Teams out of scope and in-app first was right: a notification nobody asked
 * for trains people to ignore notifications. But nothing in this system reaches anybody until they
 * sign in, and with 20-odd people checking occasionally that is the main risk to the whole thing
 * being used. The feed can be perfect and unread.
 *
 * So this renders the digest and stops short of sending it. `render` is pure and testable, the CLI
 * prints or writes files, and wiring a transport is one function nobody has had to guess at. That
 * split is deliberate: the hard part of a digest is what it says, and the easy part is SMTP.
 *
 * Four rules, each from a way digests fail.
 *
 * **It is per person.** `/api/feed` is scoped to nobody on purpose, because an unauthenticated
 * endpoint returning one person's patch would be an authorisation bug. A digest reads each
 * principal's own follows, so what somebody receives is what they would see on their own feed.
 *
 * **Nothing goes out when there is nothing.** Most weeks in most patches are quiet, and an empty
 * digest every Monday is how a digest gets filtered into a folder nobody opens. `render` returns
 * null rather than a cheerful nothing.
 *
 * **The subject line carries the content.** "3 new in your patch: two recompetes at EXAMPLE RANGE
 * OPERATIONS and one sources sought" gets read. "Your weekly Contract Intelligence digest" does not.
 *
 * **It never moves the read mark.** A digest is a copy, not a visit. Advancing the watermark because
 * an email was generated would empty the feed the person came to read, which is the one thing worse
 * than not sending it at all.
 */
import type { PoolClient } from 'pg';

/** How far back a digest looks for somebody who has never marked their feed read. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * How many requirements to name individually before summarising the rest.
 *
 * Five. A digest is a prompt to open the tool, not a replacement for it, and a list of thirty
 * titles in an email is a list nobody finishes. The remainder is counted, and the link does the
 * rest of the work.
 */
export const NAMED_ITEMS = 5;

export interface DigestItem {
  readonly pursuitId: string;
  readonly title: string;
  readonly signalClass: string;
  readonly agency: string | null;
  readonly office: string | null;
  readonly estimatedValue: string | null;
  readonly responseDate: Date | null;
  readonly periodEndDate: Date | null;
  readonly matchedBy: string;
  readonly noticeUrl: string | null;
  readonly firstSeenAt: Date;
}

export interface DigestQuarter {
  readonly quarterLabel: string;
  readonly items: number;
  readonly valueFloorUsd: string | null;
}

export interface Digest {
  readonly principalName: string;
  readonly displayName: string;
  readonly since: Date;
  readonly follows: number;
  readonly newCount: number;
  readonly items: readonly DigestItem[];
  /** How many were new beyond the ones named. */
  readonly remainder: number;
  /** The next two projected quarters in this person's patch, for context rather than urgency. */
  readonly quarters: readonly DigestQuarter[];
  /** Requirements this person is tracking whose response date is close. */
  readonly closingSoon: readonly DigestItem[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const STAGE_WORDS: Record<string, string> = {
  active_solicitation: 'open solicitation',
  recompete_window: 'recompete',
  shaping_target: 'sources sought',
  market_movement: 'market movement',
};

/** Plural without the "(s)" that makes generated prose read as generated. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many}`;
}

function iso(date: Date | null): string | null {
  return date === null ? null : new Date(date).toISOString().slice(0, 10);
}

function money(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}bn`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/* ---------------------------------------------------------------- the subject */

/**
 * The subject line, built from what is actually in the digest.
 *
 * It names the count, the dominant kind of work, and where it is, in that order, because that is
 * the order somebody reads a subject line in a crowded inbox. Where one office dominates it is
 * named; where the work is spread out the count of offices is more informative than any one of them.
 */
export function subjectFor(items: readonly DigestItem[], total: number): string {
  if (items.length === 0) return '';

  const byClass = new Map<string, number>();
  for (const item of items) byClass.set(item.signalClass, (byClass.get(item.signalClass) ?? 0) + 1);
  const classes = [...byClass.entries()].sort((a, b) => b[1] - a[1]);

  const byOffice = new Map<string, number>();
  for (const item of items) {
    const where = item.office ?? item.agency;
    if (where !== null) byOffice.set(where, (byOffice.get(where) ?? 0) + 1);
  }
  const offices = [...byOffice.entries()].sort((a, b) => b[1] - a[1]);

  const kinds = classes
    .slice(0, 2)
    .map(([signalClass, n]) => plural(n, STAGE_WORDS[signalClass] ?? signalClass, `${STAGE_WORDS[signalClass] ?? signalClass}s`))
    .join(' and ');

  const where =
    offices.length === 0
      ? ''
      : offices[0]![1] >= Math.max(2, Math.ceil(items.length / 2))
        ? ` at ${offices[0]![0]}`
        : offices.length > 1
          ? ` across ${plural(offices.length, 'office', 'offices')}`
          : ` at ${offices[0]![0]}`;

  return `${total} new in your patch: ${kinds}${where}`;
}

/* ------------------------------------------------------------------- reading */

interface Row {
  pursuit_id: string;
  title: string;
  signal_class: string;
  agency: string | null;
  office: string | null;
  estimated_value: string | null;
  response_date: Date | null;
  period_end_date: Date | null;
  matched_by: string;
  notice_url: string | null;
  first_seen_at: Date;
}

function toItem(row: Row): DigestItem {
  return {
    pursuitId: row.pursuit_id,
    title: row.title,
    signalClass: row.signal_class,
    agency: row.agency,
    office: row.office,
    estimatedValue: row.estimated_value,
    responseDate: row.response_date,
    periodEndDate: row.period_end_date,
    matchedBy: row.matched_by,
    noticeUrl: row.notice_url,
    firstSeenAt: row.first_seen_at,
  };
}

export interface DigestOptions {
  /** Base URL every link points at. Without one the digest carries paths and says so. */
  readonly baseUrl?: string;
  /** Look back this far for somebody with no read mark. */
  readonly windowDays?: number;
  readonly namedItems?: number;
}

/**
 * Build one person's digest, or null when there is nothing to send.
 *
 * The window is the person's own read mark where they have one, so a digest and their feed agree
 * about what "new" means. Reading it here rather than passing it in is deliberate: two definitions
 * of new is how a digest starts contradicting the screen it is advertising.
 */
export async function render(
  client: PoolClient,
  principalName: string,
  options: DigestOptions = {},
): Promise<Digest | null> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const named = options.namedItems ?? NAMED_ITEMS;
  const base = (options.baseUrl ?? '').replace(/\/$/, '');

  const { rows: person } = await client.query<{
    display_name: string | null;
    seen_through: Date | null;
    follows: number;
  }>(
    `select u.display_name,
            w.seen_through,
            (select count(*)::int from follow f where f.principal_name = u.principal_name) as follows
       from app_user u
       left join feed_watermark w on w.principal_name = u.principal_name
      where u.principal_name = $1 and u.active`,
    [principalName],
  );

  if (person[0] === undefined) return null;

  // Somebody with no follows has no patch, so there is nothing personal to send. The right nudge
  // for them is a person, not an email from a system they have not set up.
  if (person[0].follows === 0) return null;

  const since =
    person[0].seen_through ?? new Date(Date.now() - windowDays * 86_400_000);

  const { rows } = await client.query<Row>(
    `with matches as (
       select fp.pursuit_id,
              string_agg(distinct fp.follow_type || ' ' || coalesce(f.label, f.target), ', ') as matched_by
         from follow_pursuit fp
         join follow f on f.follow_id = fp.follow_id
        where fp.principal_name = $1
        group by fp.pursuit_id
     ),
     mine as (
       select pa.pursuit_id, bool_or(pa.action = 'dismiss') as dismissed
         from pursuit_action pa where pa.principal_name = $1 group by pa.pursuit_id
     )
     select i.pursuit_id::text, i.title, i.signal_class,
            coalesce(al.label, i.agency_code)  as agency,
            coalesce(ol.label, i.office_code)  as office,
            i.estimated_value::text, i.response_date, i.period_end_date,
            m.matched_by, i.notice_url, i.first_seen_at
       from feed_item i
       join matches m on m.pursuit_id = i.pursuit_id
       left join mine on mine.pursuit_id = i.pursuit_id
       left join code_label_current al on al.code_type = 'agency' and al.code_value = i.agency_code
       left join code_label_current ol on ol.code_type = 'office' and ol.code_value = i.office_code
      where i.first_seen_at > $2::timestamptz
        and not coalesce(mine.dismissed, false)
      order by i.first_seen_at desc, i.pursuit_id`,
    [principalName, since],
  );

  // Tracked work whose deadline is close. Not "new", so it is a separate section: a digest that
  // mixed them would bury a deadline under an announcement.
  const { rows: closing } = await client.query<Row>(
    `select i.pursuit_id::text, i.title, i.signal_class,
            coalesce(al.label, i.agency_code) as agency,
            coalesce(ol.label, i.office_code) as office,
            i.estimated_value::text, i.response_date, i.period_end_date,
            'you are tracking this'::text     as matched_by,
            i.notice_url, i.first_seen_at
       from feed_item i
       join pursuit_action pa
         on pa.pursuit_id = i.pursuit_id and pa.principal_name = $1 and pa.action = 'track'
       left join code_label_current al on al.code_type = 'agency' and al.code_value = i.agency_code
       left join code_label_current ol on ol.code_type = 'office' and ol.code_value = i.office_code
      where i.response_date is not null
        and i.response_date between current_date and current_date + 21
        and not exists (
          select 1 from pursuit_action sent
           where sent.pursuit_id = i.pursuit_id and sent.principal_name = $1 and sent.action = 'sent'
        )
      order by i.response_date`,
    [principalName],
  );

  const { rows: quarters } = await client.query<{
    quarter_label: string;
    items: number;
    value_floor_usd: string | null;
  }>(
    `select cie_fiscal_quarter_label(f.projected_fy, f.projected_quarter) as quarter_label,
            count(*)::int                                                as items,
            sum(f.estimated_value)::text                                 as value_floor_usd
       from forecast_item f
      where exists (select 1 from follow_forecast ff
                     where ff.forecast_id = f.forecast_id and ff.principal_name = $1)
        and f.projected_solicitation_date >= current_date
      group by f.projected_fy, f.projected_quarter
      order by f.projected_fy, f.projected_quarter
      limit 2`,
    [principalName],
  );

  // Nothing new and nothing closing means nothing to say. The forecast alone is not news: it is the
  // same two quarters it was last week, and sending it weekly is how a digest becomes wallpaper.
  if (rows.length === 0 && closing.length === 0) return null;

  const items = rows.slice(0, named).map(toItem);
  const closingItems = closing.map(toItem);
  const digestQuarters = quarters.map((q) => ({
    quarterLabel: q.quarter_label,
    items: q.items,
    valueFloorUsd: q.value_floor_usd,
  }));

  const subject =
    rows.length > 0
      ? subjectFor(items, rows.length)
      : `${plural(closingItems.length, 'thing you are tracking closes', 'things you are tracking close')} soon`;

  const shape = {
    principalName,
    displayName: person[0].display_name ?? principalName,
    since,
    follows: person[0].follows,
    newCount: rows.length,
    items,
    remainder: Math.max(0, rows.length - items.length),
    quarters: digestQuarters,
    closingSoon: closingItems,
    subject,
  };

  return { ...shape, text: asText(shape, base), html: asHtml(shape, base) };
}

/* ------------------------------------------------------------------ renderers */

type Shape = Omit<Digest, 'text' | 'html'>;

function link(base: string, path: string): string {
  return base === '' ? path : `${base}${path}`;
}

function whenLine(item: DigestItem): string {
  if (item.responseDate !== null) return `responses due ${iso(item.responseDate)}`;
  if (item.periodEndDate !== null) return `contract ends ${iso(item.periodEndDate)}`;
  return 'no date recorded';
}

/**
 * The plain-text digest.
 *
 * Plain text first rather than as a fallback. It is what a Teams message and an SMS carry, it is
 * what survives a mail client that strips styling, and writing it first stops the digest depending
 * on layout to make sense.
 */
export function asText(digest: Shape, base = ''): string {
  const lines: string[] = [];

  lines.push(digest.subject);
  lines.push('');

  if (digest.newCount > 0) {
    lines.push(
      `New on your ${plural(digest.follows, 'follow', 'follows')} since ${iso(digest.since)}:`,
    );
    lines.push('');
    for (const item of digest.items) {
      lines.push(`  ${item.title}`);
      const facts = [
        item.office ?? item.agency,
        whenLine(item),
        money(item.estimatedValue) ?? 'value not recorded',
      ].filter((f): f is string => f !== null);
      lines.push(`    ${facts.join('  ·  ')}`);
      lines.push(`    followed because: ${item.matchedBy}`);
      lines.push(`    ${link(base, `/requirements/${item.pursuitId}`)}`);
      lines.push('');
    }
    if (digest.remainder > 0) {
      lines.push(`  and ${plural(digest.remainder, 'more', 'more')} in your patch.`);
      lines.push(`  ${link(base, '/feed')}`);
      lines.push('');
    }
  }

  if (digest.closingSoon.length > 0) {
    lines.push('Closing soon, from what you are tracking:');
    lines.push('');
    for (const item of digest.closingSoon) {
      lines.push(`  ${iso(item.responseDate)}  ${item.title}`);
      lines.push(`    ${link(base, `/requirements/${item.pursuitId}`)}`);
    }
    lines.push('');
  }

  if (digest.quarters.length > 0) {
    lines.push('Coming up in your patch:');
    for (const quarter of digest.quarters) {
      const value = money(quarter.valueFloorUsd);
      lines.push(
        `  ${quarter.quarterLabel}  ${plural(quarter.items, 'projection', 'projections')}` +
          (value === null ? '' : `, ${value} floor`),
      );
    }
    lines.push(`  ${link(base, '/forecast')}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Astrion Contract Intelligence, created by Gavin Taylor.');
  lines.push('This is a copy of your feed, so nothing here is marked as read.');
  lines.push(`Change what you follow: ${link(base, '/follows')}`);
  if (base === '') {
    lines.push('(Paths rather than links: no base URL was configured for this run.)');
  }

  return lines.join('\n');
}

/**
 * The HTML digest.
 *
 * Inline styles and a table-free layout, because a mail client is not a browser: it strips a
 * stylesheet, ignores a class, and half of them still do not do flexbox. Astrion 2026 colours,
 * light ground rather than the interface's dark one, because a dark email in a light inbox reads as
 * a phishing attempt.
 */
export function asHtml(digest: Shape, base = ''): string {
  const sky = '#1c7fa8';
  const ink = '#101820';
  const muted = '#5a6472';
  const rule = '#dfe3e8';

  const item = (row: DigestItem, showReason: boolean): string => {
    const facts = [
      row.office ?? row.agency,
      whenLine(row),
      money(row.estimatedValue) ?? 'value not recorded',
    ].filter((f): f is string => f !== null);

    return `
      <div style="padding:14px 0;border-bottom:1px solid ${rule}">
        <a href="${escapeHtml(link(base, `/requirements/${row.pursuitId}`))}"
           style="color:${ink};font-size:16px;font-weight:600;text-decoration:none">${escapeHtml(row.title)}</a>
        <div style="color:${muted};font-size:14px;margin-top:4px">${escapeHtml(facts.join('  ·  '))}</div>
        ${
          showReason
            ? `<div style="color:${muted};font-size:13px;margin-top:3px">Followed because: ${escapeHtml(row.matchedBy)}</div>`
            : ''
        }
      </div>`;
  };

  return `<div style="font-family:Archivo,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:${ink};background:#ffffff">
  <div style="height:3px;background:linear-gradient(90deg,#1ed872 0%,#4dd3f7 50%,#9382f9 100%)"></div>
  <h1 style="font-size:20px;font-weight:700;margin:20px 0 4px">${escapeHtml(digest.subject)}</h1>
  <div style="color:${muted};font-size:14px;margin-bottom:20px">
    On your ${plural(digest.follows, 'follow', 'follows')}, since ${escapeHtml(iso(digest.since) ?? '')}.
  </div>
${
  digest.newCount > 0
    ? digest.items.map((row) => item(row, true)).join('') +
      (digest.remainder > 0
        ? `<div style="padding:14px 0"><a href="${escapeHtml(link(base, '/feed'))}" style="color:${sky};font-size:15px">and ${digest.remainder} more in your patch</a></div>`
        : '')
    : ''
}
${
  digest.closingSoon.length > 0
    ? `<h2 style="font-size:16px;font-weight:600;margin:26px 0 0">Closing soon, from what you are tracking</h2>` +
      digest.closingSoon.map((row) => item(row, false)).join('')
    : ''
}
${
  digest.quarters.length > 0
    ? `<h2 style="font-size:16px;font-weight:600;margin:26px 0 8px">Coming up in your patch</h2>` +
      digest.quarters
        .map((q) => {
          const value = money(q.valueFloorUsd);
          return `<div style="font-size:15px;padding:4px 0"><strong>${escapeHtml(q.quarterLabel)}</strong> — ${plural(q.items, 'projection', 'projections')}${value === null ? '' : `, ${escapeHtml(value)} floor`}</div>`;
        })
        .join('') +
      `<div style="padding:8px 0"><a href="${escapeHtml(link(base, '/forecast'))}" style="color:${sky};font-size:14px">Open the forecast</a></div>`
    : ''
}
  <div style="margin-top:28px;padding-top:14px;border-top:1px solid ${rule};color:${muted};font-size:13px">
    Astrion Contract Intelligence, created by Gavin Taylor.<br>
    This is a copy of your feed, so nothing here has been marked as read.
    <a href="${escapeHtml(link(base, '/follows'))}" style="color:${sky}">Change what you follow</a>.
  </div>
</div>`;
}

/* ---------------------------------------------------------------- everybody */

/**
 * Every digest worth sending.
 *
 * Runs per principal rather than assembling one list and slicing it, because a follow is per person
 * and the whole point is that two people get different mail. People with nothing to say are absent
 * from the result rather than present and empty.
 */
export async function renderAll(
  client: PoolClient,
  options: DigestOptions = {},
): Promise<Digest[]> {
  const { rows } = await client.query<{ principal_name: string }>(
    `select u.principal_name
       from app_user u
      where u.active
        and exists (select 1 from follow f where f.principal_name = u.principal_name)
      order by u.principal_name`,
  );

  const digests: Digest[] = [];
  for (const row of rows) {
    const digest = await render(client, row.principal_name, options);
    if (digest !== null) digests.push(digest);
  }
  return digests;
}
