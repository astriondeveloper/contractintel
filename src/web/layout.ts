/**
 * Page chrome: masthead, navigation, footer.
 *
 * Astrion 2026 Brand Evolution. The white logo on Astrion Black is the default
 * treatment, the gradient appears only as the thin rule at the top edge, and the
 * slogan sits in the footer verbatim.
 */
import { html, type Html } from './html.js';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * Every screen in the build. Order is roughly the order the data flows: what was
 * loaded, who it resolved to, what it says, then what still needs a human.
 */
export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/upcoming', label: 'Upcoming' },
  { href: '/entities', label: 'Entities' },
  { href: '/contracts', label: 'Contract actions' },
  { href: '/subcontracts', label: 'Subcontracts' },
  { href: '/customers', label: 'Customers' },
  { href: '/programs', label: 'Programs' },
  { href: '/dacis-contracts', label: 'DACIS contracts' },
  { href: '/taxonomy', label: 'Taxonomy' },
  { href: '/watchlist', label: 'Watchlist' },
  { href: '/review', label: 'Review queue' },
  { href: '/quality', label: 'Data quality' },
  { href: '/acceptance', label: 'Acceptance' },
];

export interface PageOptions {
  /** Browser title and the h1 on the page. */
  readonly title: string;
  /** One or two sentences under the h1 saying what the screen is for. */
  readonly intro?: string;
  /** Path of the current screen, so the nav can mark itself. */
  readonly path: string;
  /** Right-hand masthead line. Usually the database state. */
  readonly meta?: Html;
  /** Anything above the h1: an empty-database notice, a warning. */
  readonly notice?: Html;
  readonly body: Html;
}

function isCurrent(itemHref: string, path: string): boolean {
  if (itemHref === '/') return path === '/';
  return path === itemHref || path.startsWith(`${itemHref}/`);
}

export function page(options: PageOptions): string {
  const { title, intro, path, meta, notice, body } = options;

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
<header class="masthead">
  <div class="masthead-inner">
    <div class="brand">
      <img src="/astrion-logo-white.png" alt="Astrion">
      <div class="brand-divider"></div>
      <div>
        <div class="brand-title">Contract Intelligence + Integration Engine</div>
        <div class="brand-sub">Phase 1 · Data foundation</div>
      </div>
    </div>
    <div class="masthead-meta">${meta ?? ''}</div>
  </div>
  <nav class="nav">
    ${NAV.map(
      (item) => html`<a href="${item.href}"${isCurrent(item.href, path) ? html` class="current"` : ''}>${item.label}</a>`,
    )}
  </nav>
</header>
<main>
  ${notice ?? ''}
  <div class="page-head">
    <h1>${title}</h1>
    ${intro ? html`<p>${intro}</p>` : ''}
  </div>
  ${body}
</main>
<footer class="foot">
  <div class="foot-inner">
    <div>
      <div class="slogan">Defend This World. Build the Next.</div>
      <div>Read only. This interface never writes to the database.</div>
    </div>
    <div>
      Built to <code>CIE_Build_Spec_v1.0</code>. Departures are recorded in
      <code>docs/DECISIONS.md</code>.
    </div>
  </div>
</footer>
</body>
</html>`;

  return document.__html;
}
