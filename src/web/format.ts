/**
 * Presentation of the four value types this corpus argues about: money, counts,
 * dates and fiscal years.
 *
 * One rule runs through all of it, and it is a spec rule rather than a taste one:
 * **blank is not zero**. A null obligation renders as an em space and a dash, never
 * as $0. The loaders are careful about this distinction and the interface would throw
 * it away by formatting null as zero.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const USD_EXACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNT = new Intl.NumberFormat('en-US');

/** What a null renders as, everywhere. Never "0", never "$0.00", never blank. */
export const ABSENT = '—';

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Money, rounded to the dollar. `pg` returns `numeric` as a string to avoid the
 * precision loss of a float, so this accepts strings and does not parse them
 * until it has established the value is present.
 */
export function usd(value: string | number | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const n = Number(value);
  if (!Number.isFinite(n)) return ABSENT;
  return USD.format(n);
}

/** Money to the cent. For a single record, where the rounding would be a lie. */
export function usdExact(value: string | number | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const n = Number(value);
  if (!Number.isFinite(n)) return ABSENT;
  return USD_EXACT.format(n);
}

/** A money figure compressed for a headline tile: $1.5bn, $22.4m, $915k. */
export function usdCompact(value: string | number | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const n = Number(value);
  if (!Number.isFinite(n)) return ABSENT;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return USD.format(n);
}

/** A count. Thousands separated, absent stays absent. */
export function count(value: string | number | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const n = Number(value);
  if (!Number.isFinite(n)) return ABSENT;
  return COUNT.format(n);
}

/**
 * A date, as the ISO day. `pg` hands back a `Date` in the server's zone for a
 * `date` column, so this reads the UTC parts: rendering the local day would shift
 * an award date across a boundary depending on where the container runs.
 */
export function day(value: Date | string | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return ABSENT;
  return date.toISOString().slice(0, 10);
}

/** A timestamp, to the minute, in UTC. Freshness is read across time zones. */
export function moment(value: Date | string | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return ABSENT;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;
}

/** How long ago, in the coarsest unit that is still true. For freshness columns. */
export function since(value: Date | string | null | undefined): string {
  if (isAbsent(value)) return ABSENT;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return ABSENT;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 90) return 'just now';
  // Singular where the number is one. The bands overlap deliberately — 90 minutes rather than 60,
  // 36 hours rather than 24 — so the unit changes once the smaller one has stopped being readable,
  // and that overlap is what makes "1 hour ago" and "1 day ago" reachable at all.
  const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 36) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 60) return plural(days, 'day');
  const months = Math.floor(days / 30);
  if (months < 24) return plural(months, 'month');
  return plural(Math.floor(days / 365), 'year');
}

/** A percentage to one decimal. Absent when the denominator is zero. */
export function percent(numerator: number, denominator: number): string {
  if (!denominator) return ABSENT;
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Shorten for a table cell, on a word boundary where one is near enough. */
export function truncate(value: string | null | undefined, limit = 90): string {
  if (isAbsent(value)) return ABSENT;
  const text = String(value).trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit - 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A value that is present but empty reads better as absent than as nothing at all. */
export function orAbsent(value: string | null | undefined): string {
  return isAbsent(value) ? ABSENT : String(value);
}
