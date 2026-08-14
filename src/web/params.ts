/**
 * Reading the query string.
 *
 * Everything here clamps rather than throws. A hand-edited `?page=0` or `?page=abc`
 * should show page one, not a stack trace: the URL is user input and the interface is
 * read only, so there is nothing to protect beyond the shape of the value.
 */

export const PAGE_SIZE = 50;

/** A trimmed string parameter. Absent and blank are the same thing. */
export function text(url: URL, name: string): string {
  return (url.searchParams.get(name) ?? '').trim();
}

/** A digits-only parameter, for an id coming from a link this interface wrote. */
export function id(value: string | undefined): string | null {
  if (!value) return null;
  return /^\d{1,19}$/.test(value) ? value : null;
}

/** 1-based page number, clamped to at least 1. */
export function pageNumber(url: URL): number {
  const raw = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
}

export function offset(url: URL, pageSize = PAGE_SIZE): number {
  return (pageNumber(url) - 1) * pageSize;
}

/**
 * The current path and query with `page` removed, so the pager can append its own
 * without the old one winning or accumulating.
 */
export function baseQuery(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete('page');
  const rest = params.toString();
  return rest ? `${url.pathname}?${rest}` : url.pathname;
}
