/**
 * The handful of shapes every screen is built from: a tile, a table, a pager, a
 * search box, an empty state.
 *
 * The empty state carries more weight here than it usually does. No data lives in
 * this repository and none may (Gate A, 14 August 2026), so a fresh clone renders
 * every screen against an empty database. Each empty state names the command that
 * fills it rather than showing a blank panel.
 */
import { html, type Html } from './html.js';
import { ABSENT, count as fmtCount } from './format.js';

/* ------------------------------------------------------------------- tiles */

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly foot?: string;
  readonly href?: string;
}

export function tiles(items: readonly Tile[]): Html {
  return html`<div class="tiles">
    ${items.map(
      (tile) => html`<div class="tile">
        <div class="label">${tile.label}</div>
        <div class="value${tile.value === ABSENT ? ' absent' : ''}">${tile.value}</div>
        ${tile.foot ? html`<div class="foot">${tile.foot}</div>` : ''}
        ${tile.href ? html`<div class="foot"><a href="${tile.href}">Open</a></div>` : ''}
      </div>`,
    )}
  </div>`;
}

/* ------------------------------------------------------------------ tables */

export interface Column<Row> {
  readonly header: string;
  /** `num` right-aligns and uses tabular figures. Money and counts want it. */
  readonly align?: 'num';
  readonly cell: (row: Row) => Html | string;
}

export interface TableOptions<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  /** Shown in place of the table when there are no rows. */
  readonly empty: Html;
}

export function table<Row>(options: TableOptions<Row>): Html {
  const { columns, rows, empty } = options;
  if (rows.length === 0) return html`<div class="table-wrap"><div class="empty">${empty}</div></div>`;

  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${columns.map((c) => html`<th${c.align === 'num' ? html` class="num"` : ''}>${c.header}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map(
          (row) => html`<tr>
            ${columns.map((c) => {
              const value = c.cell(row);
              const isAbsent = value === ABSENT;
              const classes = [c.align === 'num' ? 'num' : '', isAbsent ? 'absent' : ''].filter(Boolean).join(' ');
              return html`<td${classes ? html` class="${classes}"` : ''}>${value}</td>`;
            })}
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/* ------------------------------------------------------------------ notices */

export function notice(kind: 'info' | 'warn' | 'alert', title: string, body: Html): Html {
  const cls = kind === 'warn' ? 'notice' : `notice ${kind}`;
  return html`<div class="${cls}"><h3>${title}</h3>${body}</div>`;
}

/**
 * The notice a screen shows when its table is empty because nothing has been
 * loaded. Naming the command is the point: an empty screen that does not say how to
 * fill it reads as a broken build.
 */
export function emptyBecauseNoData(what: string, command: string): Html {
  return html`<strong>No ${what} loaded.</strong><br>
    No data lives in this repository and none may. Load a corpus with
    <code>${command}</code>, or see <code>CONTRIBUTING.md</code>.`;
}

/* --------------------------------------------------------------- live status */

/**
 * How live the opportunities on this screen are, in one line.
 *
 * Added because the interface could not previously distinguish three situations that look identical
 * from a chair: nothing matched, no sync has ever run, and the key is missing so no sync can run. All
 * three render as a feed that never changes. For a tool whose premise is seeing a requirement before
 * anybody else, "how old is this" is the first thing somebody should be able to read — and if the
 * answer is bad, the line says which of the three it is and names the command that fixes it.
 *
 * Four states, each with a different action:
 *
 *   never run   No notice loader has ever finished. Nothing is wrong with the code; nothing has run.
 *   stale       It ran, but not lately, so the schedule is broken rather than the key.
 *   gap         It ran and reported a clamp, so a window was fetched by nobody.
 *   live        With how long ago, because "live" without a number is a claim rather than a fact.
 */
export interface LiveStatus {
  readonly last_success_at: Date | null;
  readonly age_seconds: number | null;
  readonly never_run: boolean;
  readonly landed_today: number;
  readonly cursor_clamped: boolean;
  readonly sources: readonly { source_system: string; age_seconds: number | null; notices: number }[];
}

/** Anything older than this is not an early-warning feed any more. */
const STALE_AFTER_SECONDS = 26 * 3600;

export function liveStatus(status: LiveStatus, ago: (at: Date) => string): Html {
  if (status.never_run) {
    return html`<div class="live none">
      <span class="dot"></span>
      <span><strong>No opportunity sync has run yet</strong>, so nothing on this screen came from a
        live feed. Check the key with <code>npm run load:govcon -- --probe</code>, then pull with
        <code>npm run load:govcon</code>. Until then the only requirements here are whatever
        <code>npm run signals</code> found in the loaded corpus.</span>
    </div>`;
  }

  const age = status.age_seconds ?? Infinity;
  const stamp = status.last_success_at === null ? 'an unrecorded time' : ago(status.last_success_at);

  if (age > STALE_AFTER_SECONDS) {
    return html`<div class="live stale">
      <span class="dot"></span>
      <span><strong>Opportunities last arrived ${stamp}.</strong> The sync is meant to run hourly, so
        this is the schedule rather than the key — the hourly job is not running. See the scheduled
        jobs table in <code>docs/DEPLOY.md</code>, or pull now with
        <code>npm run load:govcon</code>.</span>
    </div>`;
  }

  if (status.cursor_clamped) {
    return html`<div class="live stale">
      <span class="dot"></span>
      <span><strong>Live as of ${stamp}, but the last sync had a gap.</strong> It asked for a window
        wider than the delta endpoint serves, so an interval was fetched by nobody. Fill it with
        <code>npm run load:govcon -- --backfill --from &lt;yyyy-mm-dd&gt;</code>.</span>
    </div>`;
  }

  const arrivals =
    status.landed_today === 0
      ? 'nothing new in the last day, which is an ordinary day'
      : `${status.landed_today} arrived in the last day`;

  return html`<div class="live ok">
    <span class="dot"></span>
    <span>Live. Opportunities last arrived ${stamp}, ${arrivals}.</span>
  </div>`;
}

/* ------------------------------------------------------------------- chips */

export function chip(kind: 'pass' | 'fail' | 'blocked' | 'neutral' | 'sky', label: string): Html {
  return html`<span class="chip ${kind}">${label}</span>`;
}

/* ------------------------------------------------------------------ search */

export interface SearchField {
  readonly name: string;
  readonly placeholder: string;
  readonly value: string;
}

export function searchForm(action: string, fields: readonly SearchField[], extra?: Html): Html {
  const hasValue = fields.some((f) => f.value !== '');
  return html`<form class="search" method="get" action="${action}">
    ${fields.map(
      (field) =>
        html`<input type="search" name="${field.name}" value="${field.value}" placeholder="${field.placeholder}" aria-label="${field.placeholder}">`,
    )}
    ${extra ?? ''}
    <button type="submit">Search</button>
    ${hasValue ? html`<a class="clear" href="${action}">Clear</a>` : ''}
  </form>`;
}

/* --------------------------------------------------------------- pagination */

export interface PagerState {
  /** 1-based. */
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** Current path with its query string, minus `page`. */
  readonly baseQuery: string;
}

function href(base: string, page: number): string {
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}page=${page}`;
}

export function pager(state: PagerState): Html {
  const { page, pageSize, total, baseQuery } = state;
  if (total === 0) return html``;

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return html`<div class="pager">
    <div>
      Showing ${fmtCount(first)} to ${fmtCount(last)} of ${fmtCount(total)}
      ${total === 1 ? 'row' : 'rows'}
    </div>
    <div class="links">
      ${page > 1 ? html`<a href="${href(baseQuery, page - 1)}">Previous</a>` : html`<span>Previous</span>`}
      <span>Page ${fmtCount(page)} of ${fmtCount(pages)}</span>
      ${page < pages ? html`<a href="${href(baseQuery, page + 1)}">Next</a>` : html`<span>Next</span>`}
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ detail */

export interface Field {
  readonly label: string;
  readonly value: Html | string;
}

export function fields(items: readonly Field[]): Html {
  return html`<div class="detail-grid">
    ${items.map(
      (item) => html`<div class="field">
        <div class="label">${item.label}</div>
        <div class="value">${item.value}</div>
      </div>`,
    )}
  </div>`;
}

/* ------------------------------------------------------------------- cards */

export interface CardOptions {
  readonly title: string;
  readonly hint?: string;
  /** A link in the card header, for "see all of these". */
  readonly more?: { href: string; label: string };
  readonly body: Html;
  /** Card bodies are lists by default; set for prose or a form. */
  readonly plain?: boolean;
}

/**
 * A dashboard widget.
 *
 * Each card scrolls inside itself rather than growing the page, so a dashboard with a
 * hundred items in one queue still shows every other queue without scrolling past it.
 */
export function card(options: CardOptions): Html {
  return html`<section class="card">
    <header>
      <h3>${options.title}</h3>
      ${options.more
        ? html`<a class="hint" href="${options.more.href}">${options.more.label}</a>`
        : options.hint
          ? html`<span class="hint">${options.hint}</span>`
          : ''}
    </header>
    <div class="card-body${options.plain ? ' plain' : ''}">${options.body}</div>
  </section>`;
}

export function cards(items: readonly Html[]): Html {
  return html`<div class="cards">${items}</div>`;
}

export interface FeedItem {
  readonly href?: string;
  /** Chips shown before the headline: a band, a stage. */
  readonly lead?: Html;
  readonly headline: string;
  readonly meta?: readonly (string | Html)[];
  /** A figure aligned right: a score, a value, a count. */
  readonly figure?: string;
  /** 0 to 1. Draws a bar under the row. */
  readonly share?: number;
  readonly shareTone?: 'good' | 'warn' | 'sky';
}

export function feed(items: readonly FeedItem[], empty: Html): Html {
  if (items.length === 0) return html`<div class="empty">${empty}</div>`;

  return html`${items.map((item) => {
    const inner = html`<div class="top">
        ${item.lead ?? ''}
        <span class="headline">${item.headline}</span>
        ${item.figure ? html`<span class="num">${item.figure}</span>` : ''}
      </div>
      ${item.meta && item.meta.length > 0
        ? html`<div class="meta">${item.meta.map((m) => html`<span>${m}</span>`)}</div>`
        : ''}
      ${item.share === undefined
        ? ''
        : html`<div class="meter ${item.shareTone ?? 'sky'}">
            <span style="width:${Math.round(Math.max(0, Math.min(1, item.share)) * 100)}%"></span>
          </div>`}`;

    return item.href
      ? html`<a class="feed" href="${item.href}">${inner}</a>`
      : html`<div class="feed">${inner}</div>`;
  })}`;
}

/* ----------------------------------------------------------------- section */

export function section(title: string, body: Html, hint?: string): Html {
  return html`<div class="section">
    <div class="section-head">
      <h2>${title}</h2>
      ${hint ? html`<div class="hint">${hint}</div>` : ''}
    </div>
    ${body}
  </div>`;
}
