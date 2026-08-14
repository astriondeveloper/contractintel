/**
 * What every screen shares: the request context, the masthead line that reports the
 * state of the database, and the notice that appears when a screen is empty because
 * nothing has been loaded rather than because something is wrong.
 */
import { html, type Html } from './html.js';
import { page } from './layout.js';
import { count } from './format.js';
import type { DatabaseState } from './queries.js';

export interface Ctx {
  readonly url: URL;
  readonly state: DatabaseState;
}

/** The right-hand masthead line: schema version and whether a corpus is present. */
export function meta(state: DatabaseState): Html {
  if (state.migrationsApplied === 0) {
    return html`<strong>Not migrated.</strong><br>Run <code>npm run migrate</code>`;
  }
  return html`<strong>${count(state.migrationsApplied)}</strong> migrations applied<br>
    ${state.hasCorpus ? 'Corpus loaded' : 'No corpus loaded'} ·
    ${state.hasSeeds ? 'seeds present' : 'no seeds'}`;
}

/**
 * Shown above every screen when the database has a schema but no corpus.
 *
 * This is the expected state of a fresh clone, not a fault: Gate A came back no on
 * 14 August 2026, so no data lives in this repository and none may. The notice says
 * that plainly, because an interface full of empty tables otherwise reads as broken.
 */
export function emptyCorpusNotice(state: DatabaseState): Html | undefined {
  if (state.migrationsApplied === 0) {
    return html`<div class="notice alert">
      <h3>The database has no schema yet</h3>
      Run <code>npm run migrate</code> to apply the 18 forward-only migrations, then
      <code>npm run seed</code>. <code>CONTRIBUTING.md</code> has the full sequence.
    </div>`;
  }
  if (state.hasCorpus) return undefined;
  return html`<div class="notice">
    <h3>No corpus is loaded, which is the expected state of a fresh clone</h3>
    No data lives in this repository and none may: Gate A came back no on 14 August 2026, so
    the DACIS-derived exports and the three authored seed files reach a running system through
    <code>CIE_SEED_DIR</code> and <code>CIE_DROP_DIR</code> and are never committed. Load a
    corpus with <code>npm run load -- --dir &lt;directory of exports&gt;</code>. Every screen
    below is live; they are empty because the database is.
  </div>`;
}

export interface ScreenOptions {
  readonly title: string;
  readonly intro?: string;
  readonly body: Html;
  /** Set when the screen handles its own empty state and wants no banner. */
  readonly suppressEmptyNotice?: boolean;
}

/** Render a screen inside the standard chrome. */
export function screen(ctx: Ctx, options: ScreenOptions): string {
  return page({
    title: options.title,
    intro: options.intro,
    path: ctx.url.pathname,
    meta: meta(ctx.state),
    notice: options.suppressEmptyNotice ? undefined : emptyCorpusNotice(ctx.state),
    body: options.body,
  });
}
