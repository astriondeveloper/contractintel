/**
 * The application shell: a fixed left rail, a top bar, and a working surface.
 *
 * The rail is grouped by what a person is doing rather than by where the data came from.
 * Sell comes first because that is the job; Intelligence is what you check while doing it;
 * Reference is looked up rather than worked; System is for the person keeping the thing
 * honest. A menu ordered by table name would have been easier and would have made the
 * pipeline the fourth thing anybody saw.
 *
 * Astrion 2026 Brand Evolution. The white logo on Midnight, the gradient only as the thin
 * rule at the top edge, and the slogan in the rail foot verbatim.
 */
import { html, type Html } from './html.js';
import type { User } from './auth.js';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** A text glyph rather than an icon font, so nothing is fetched to render the shell. */
  readonly glyph: string;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  {
    label: 'Sell',
    items: [
      { href: '/', label: 'Dashboard', glyph: '◧' },
      { href: '/pipeline', label: 'Pipeline', glyph: '≡' },
      { href: '/my-work', label: 'My work', glyph: '◆' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { href: '/entities', label: 'Companies', glyph: '⬡' },
      { href: '/contracts', label: 'Contract actions', glyph: '▤' },
      { href: '/subcontracts', label: 'Teaming', glyph: '⇄' },
      { href: '/watchlist', label: 'Watchlist', glyph: '◎' },
    ],
  },
  {
    label: 'Reference',
    items: [
      { href: '/customers', label: 'Customers', glyph: '◉' },
      { href: '/programs', label: 'Programs', glyph: '◈' },
      { href: '/dacis-contracts', label: 'DACIS contracts', glyph: '▥' },
      { href: '/taxonomy', label: 'Capabilities', glyph: '⌗' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/review', label: 'Review queue', glyph: '⚑' },
      { href: '/quality', label: 'Data quality', glyph: '◐' },
      { href: '/acceptance', label: 'Acceptance', glyph: '✓' },
    ],
  },
];

/** Counts shown as a badge beside a rail item, so the queue is visible without opening it. */
export interface RailBadges {
  readonly [href: string]: number | undefined;
}

export interface PageOptions {
  readonly title: string;
  readonly intro?: string;
  readonly path: string;
  /** Buttons and links that act on whatever the page is about. */
  readonly actions?: Html;
  readonly notice?: Html;
  readonly body: Html;
  readonly user?: User | null;
  readonly badges?: RailBadges;
  /** Right-hand top bar text: the state of the database. */
  readonly meta?: Html;
}

function isCurrent(itemHref: string, path: string): boolean {
  if (itemHref === '/') return path === '/';
  return path === itemHref || path.startsWith(`${itemHref}/`);
}

function initials(user: User): string {
  const source = user.displayName.trim() || user.principalName;
  const parts = source.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function page(options: PageOptions): string {
  const { title, intro, path, actions, notice, body, user, badges, meta } = options;

  const document = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Contract Intelligence Engine</title>
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><rect width=%2216%22 height=%2216%22 fill=%22%23101820%22/><rect x=%222%22 y=%227%22 width=%2212%22 height=%222%22 fill=%22%2329AAE1%22/></svg>">
<meta name="robots" content="noindex, nofollow">
</head>
<body>
<div class="app">
  <nav class="rail" aria-label="Sections">
    <div class="rail-brand">
      <img src="/astrion-logo-white.png" alt="Astrion">
      <div class="product">Contract Intelligence</div>
    </div>
    ${NAV.map(
      (group) => html`<div class="rail-group">
        <div class="label">${group.label}</div>
        ${group.items.map((item) => {
          const badge = badges?.[item.href];
          return html`<a href="${item.href}"${isCurrent(item.href, path) ? html` class="current"` : ''}
            ><span class="glyph" aria-hidden="true">${item.glyph}</span>${item.label}${badge !== undefined &&
            badge > 0
              ? html`<span class="badge">${badge}</span>`
              : ''}</a
          >`;
        })}
      </div>`,
    )}
    <div class="rail-foot">
      <div class="slogan">Defend This World. Build the Next.</div>
      <div>Built to <code>CIE_Build_Spec_v1.0</code></div>
    </div>
  </nav>

  <div class="surface">
    <header class="topbar">
      <div class="topbar-inner">
        <form class="find" method="get" action="/pipeline" role="search">
          <input type="search" name="q" placeholder="Search the pipeline: title, solicitation, PIID, agency" aria-label="Search the pipeline">
          <button type="submit">Search</button>
        </form>
        <div class="who">
          ${meta ? html`<span class="state-pill">${meta}</span>` : ''}
          ${user
            ? html`<span class="avatar" title="${user.principalName}">${initials(user)}</span
                ><span>${user.displayName}</span>`
            : html`<span class="state-pill">Read only · not signed in</span>`}
        </div>
      </div>
    </header>

    <main>
      ${notice ?? ''}
      <div class="page-head">
        <div>
          <h1>${title}</h1>
          ${intro ? html`<p>${intro}</p>` : ''}
        </div>
        ${actions ? html`<div class="actions">${actions}</div>` : ''}
      </div>
      ${body}
    </main>
  </div>
</div>
</body>
</html>`;

  return document.__html;
}
