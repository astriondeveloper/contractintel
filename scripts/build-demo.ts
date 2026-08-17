/**
 * Render the whole interface to one self-contained HTML file.
 *
 *   npm run demo -- --out dist/demo.html
 *
 * The point is a link. Deploying the real thing needs a database and a container, and
 * neither is a reasonable thing to ask of someone who wants to look at a screen and say
 * what is wrong with it. This produces a file that opens anywhere, with no server, no
 * network and no database, and shows every screen against whatever corpus it was built
 * from.
 *
 * It is a snapshot and it says so on the page. Nothing in it is live: the numbers are
 * from the moment it was built, the search boxes filter the rows that were exported
 * rather than querying, and each list carries one page of rows rather than all of them.
 *
 * There is no second implementation of the interface here. Each screen is rendered by
 * the same page function the server calls, and this file takes what came back, lifts
 * the <main> out of it, and stitches the results together behind a client-side router.
 * A screen that changes changes here too, which is the only way a demo stays honest.
 *
 * Build it from a synthetic corpus unless you mean to hand someone the real one. The
 * output embeds every row it renders.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool } from '../src/db/index.js';
import { databaseState, entities, feed, forecastItems, watermarkFor } from '../src/web/queries.js';
import type { Ctx } from '../src/web/shell.js';
import { escape } from '../src/web/html.js';
import { NAV } from '../src/web/layout.js';

import { overview } from '../src/web/pages/overview.js';
import { dashboard } from '../src/web/pages/dashboard.js';
import { feedScreen } from '../src/web/pages/feed.js';
import { forecast, forecastDetail } from '../src/web/pages/forecast.js';
import { handoffs } from '../src/web/pages/handoffs.js';
import { requirement } from '../src/web/pages/requirement.js';
import { entityDetail, entityList } from '../src/web/pages/entities.js';
import { contracts } from '../src/web/pages/contracts.js';
import { subcontracts } from '../src/web/pages/subcontracts.js';
import { customers } from '../src/web/pages/customers.js';
import { programs } from '../src/web/pages/programs.js';
import { dacis } from '../src/web/pages/dacis.js';
import { taxonomy } from '../src/web/pages/taxonomy.js';
import { watchlist } from '../src/web/pages/watchlist.js';
import { review } from '../src/web/pages/review.js';
import { quality } from '../src/web/pages/quality.js';
import { acceptance } from '../src/web/pages/acceptance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'src', 'web', 'public');

interface Screen {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly render: (ctx: Ctx) => Promise<string>;
}

const SCREENS: readonly Screen[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', render: dashboard },
  { key: 'feed', label: 'Feed', path: '/feed', render: feedScreen },
  { key: 'forecast', label: 'Forecast', path: '/forecast', render: forecast },
  { key: 'handoffs', label: 'Hand-offs', path: '/handoffs', render: handoffs },
  // Follows belongs to a person and a snapshot has no signed-in person, so it is not carried.
  // The rail link falls back to the feed, which is where a follow would take effect.
  { key: 'overview', label: 'Corpus overview', path: '/overview', render: overview },
  { key: 'entities', label: 'Entities', path: '/entities', render: entityList },
  { key: 'contracts', label: 'Contract actions', path: '/contracts', render: contracts },
  { key: 'subcontracts', label: 'Subcontracts', path: '/subcontracts', render: subcontracts },
  { key: 'customers', label: 'Customers', path: '/customers', render: customers },
  { key: 'programs', label: 'Programs', path: '/programs', render: programs },
  { key: 'dacis-contracts', label: 'DACIS contracts', path: '/dacis-contracts', render: dacis },
  { key: 'taxonomy', label: 'Taxonomy', path: '/taxonomy', render: taxonomy },
  { key: 'watchlist', label: 'Watchlist', path: '/watchlist', render: watchlist },
  { key: 'review', label: 'Review queue', path: '/review', render: review },
  { key: 'quality', label: 'Data quality', path: '/quality', render: quality },
  { key: 'acceptance', label: 'Acceptance', path: '/acceptance', render: acceptance },
];

/** How many entity detail screens to carry, so the links out of the list go somewhere. */
const ENTITY_DETAILS = 24;

/** How many requirement screens to carry. The rule trace is the most worth clicking through to. */
const REQUIREMENT_DETAILS = 24;

/** How many forecast projections to carry, so the bars open onto something. */
const FORECAST_DETAILS = 16;

/** The screen key a rail href points at, so the rail and the sections agree. */
function keyFor(href: string): string {
  const screen = SCREENS.find((s) => s.path === href);
  if (screen) return screen.key;
  // A rail entry the snapshot does not carry -- Follows needs a signed-in person -- goes to the
  // feed rather than nowhere.
  return 'feed';
}

function mainOf(document: string): string {
  const match = /<main>([\s\S]*?)<\/main>/.exec(document);
  if (match === null) throw new Error('A page rendered without a <main>. The layout changed.');
  return match[1]!;
}

/**
 * Point every link at a screen in this file.
 *
 * A link to something the export does not carry -- an entity past the cut, a filtered
 * list -- goes to the nearest screen that does exist rather than nowhere. A dead link is
 * worse than an approximate one when the whole point is to click around.
 */
function rewriteLinks(
  html: string,
  renderedEntities: ReadonlySet<string>,
  renderedRequirements: ReadonlySet<string>,
  renderedForecasts: ReadonlySet<string>,
): string {
  return html.replace(/href="\/([^"]*)"/g, (_match, rest: string) => {
    const [pathname = ''] = rest.split('?');

    const entity = /^entities\/(\d+)$/.exec(pathname);
    if (entity) {
      const id = entity[1]!;
      return renderedEntities.has(id) ? `href="#entity-${id}"` : 'href="#entities"';
    }

    const requirementLink = /^requirements\/(\d+)$/.exec(pathname);
    if (requirementLink) {
      const id = requirementLink[1]!;
      return renderedRequirements.has(id) ? `href="#requirement-${id}"` : 'href="#feed"';
    }

    const forecastLink = /^forecast\/(\d+)$/.exec(pathname);
    if (forecastLink) {
      const id = forecastLink[1]!;
      return renderedForecasts.has(id) ? `href="#forecast-${id}"` : 'href="#forecast"';
    }

    // The spreadsheet export needs a server to assemble the file, so it goes nowhere here.
    if (pathname === 'export.csv') return 'href="#feed"';

    if (pathname === '') return 'href="#dashboard"';

    const screen = SCREENS.find((s) => s.path === `/${pathname}`);
    return screen ? `href="#${screen.key}"` : `href="#${escape(pathname)}"`;
  });
}

/**
 * Strip what cannot work without a server, so nothing on the page lies about being
 * interactive. The pager pages a query that is not there, and a select filters a column
 * the table renders truncated. The text search stays and is wired to filter rows.
 */
function stripDeadControls(html: string): string {
  return html
    .replace(/<div class="pager">[\s\S]*?<\/div>\s*<\/div>/g, '')
    .replace(/<select[\s\S]*?<\/select>/g, '')
    .replace(/<input type="hidden"[^>]*>/g, '');
}

async function fontFace(): Promise<string> {
  const weights = ['Regular', 'Medium', 'SemiBold', 'Bold'] as const;
  const encoded = await Promise.all(
    weights.map(async (weight) => {
      const file = await readFile(path.join(publicDir, 'fonts', `Archivo-${weight}.woff2`));
      return [weight, file.toString('base64')] as const;
    }),
  );
  return Object.fromEntries(encoded) as unknown as string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex === -1 ? 'dist/demo.html' : (argv[outIndex + 1] ?? 'dist/demo.html');

  const state = await databaseState();
  if (state.migrationsApplied === 0) {
    throw new Error('The database has no schema. Run npm run migrate first.');
  }

  // The entities the list screen shows first, so its links land somewhere.
  const top = await entities('', '', ENTITY_DETAILS, 0);
  const renderedEntities = new Set<string>(top.rows.map((row) => row.entity_id));

  // The requirements the feed shows first, so its links land somewhere. Scoped to nobody, so the
  // snapshot carries the whole picture rather than an empty patch.
  const mark = await watermarkFor('');
  const topRequirements = await feed(
    '', mark.seen_through, 'everything', '', '', '', 'newest', REQUIREMENT_DETAILS, 0,
  );
  const renderedRequirements = new Set<string>(topRequirements.rows.map((row) => row.pursuit_id));

  const topForecasts = await forecastItems('', 'everything', null, null, '', FORECAST_DETAILS, 0);
  const renderedForecasts = new Set<string>(topForecasts.rows.map((row) => row.forecast_id));

  process.stdout.write('Rendering screens\n');

  const bodies: { key: string; label: string | null; html: string }[] = [];

  for (const screen of SCREENS) {
    const ctx: Ctx = { url: new URL(`http://demo${screen.path}`), state, user: null };
    const rendered = await screen.render(ctx);
    bodies.push({
      key: screen.key,
      label: screen.label,
      html: stripDeadControls(
        rewriteLinks(mainOf(rendered), renderedEntities, renderedRequirements, renderedForecasts),
      ),
    });
    process.stdout.write(`  ${screen.path}\n`);
  }

  for (const row of top.rows) {
    const ctx: Ctx = { url: new URL(`http://demo/entities/${row.entity_id}`), state, user: null };
    const rendered = await entityDetail(ctx, row.entity_id);
    if (rendered === null) continue;
    bodies.push({
      key: `entity-${row.entity_id}`,
      label: null,
      html: stripDeadControls(
        rewriteLinks(mainOf(rendered), renderedEntities, renderedRequirements, renderedForecasts),
      ),
    });
  }
  process.stdout.write(`  ${top.rows.length} entity detail screen(s)\n`);

  for (const row of topRequirements.rows) {
    const ctx: Ctx = { url: new URL(`http://demo/requirements/${row.pursuit_id}`), state, user: null };
    const rendered = await requirement(ctx, row.pursuit_id);
    if (rendered === null) continue;
    bodies.push({
      key: `requirement-${row.pursuit_id}`,
      label: null,
      html: stripDeadControls(
        rewriteLinks(mainOf(rendered), renderedEntities, renderedRequirements, renderedForecasts),
      ),
    });
  }
  process.stdout.write(`  ${topRequirements.rows.length} requirement screen(s)\n`);

  for (const row of topForecasts.rows) {
    const ctx: Ctx = { url: new URL(`http://demo/forecast/${row.forecast_id}`), state, user: null };
    const rendered = await forecastDetail(ctx, row.forecast_id);
    if (rendered === null) continue;
    bodies.push({
      key: `forecast-${row.forecast_id}`,
      label: null,
      html: stripDeadControls(
        rewriteLinks(mainOf(rendered), renderedEntities, renderedRequirements, renderedForecasts),
      ),
    });
  }
  process.stdout.write(`  ${topForecasts.rows.length} projection screen(s)\n`);

  // The stylesheet, with the fonts inlined. A published page cannot reach a font CDN and
  // a silent fallback to Arial would break the thing acceptance test 12 is about.
  const fonts = (await fontFace()) as unknown as Record<string, string>;
  const css = (await readFile(path.join(publicDir, 'app.css'), 'utf8')).replace(
    /url\('\/fonts\/Archivo-(\w+)\.woff2'\)/g,
    (_m, weight: string) => `url('data:font/woff2;base64,${fonts[weight]}')`,
  );

  const logo = (await readFile(path.join(publicDir, 'astrion-logo-white.png'))).toString('base64');

  const built = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const document = `<title>Contract Intelligence Engine</title>
<meta name="robots" content="noindex, nofollow">
<style>
${css}

/* ---- the demo shell, which the served interface has no need of ---- */
[data-screen] { display: none; }
[data-screen].current { display: block; }

.demo-banner {
  background: var(--midnight);
  border-bottom: 1px solid var(--rule);
  font-size: 13px;
  color: var(--silver);
}

/* The snapshot cannot act on anything, so nothing in it should look as though it can. */
.card-body form,
.actions form,
.page-head .actions { display: none; }

.demo-banner-inner {
  max-width: var(--shell);
  margin: 0 auto;
  padding: 10px 24px;
  display: flex;
  gap: 10px 18px;
  align-items: baseline;
  flex-wrap: wrap;
}

.demo-banner strong { color: var(--supernova); font-weight: 600; }

.filter-count {
  font-size: 13px;
  color: var(--silver);
  margin: -6px 0 12px;
}
</style>

<div class="app">
  <nav class="rail" aria-label="Sections">
    <div class="rail-brand">
      <img src="data:image/png;base64,${logo}" alt="Astrion">
      <div class="product">Contract Intelligence</div>
    </div>
${NAV.map(
  (group) => `    <div class="rail-group">
      <div class="label">${group.label}</div>
${group.items.map((item) => `      <a href="#${keyFor(item.href)}" data-nav="${keyFor(item.href)}"><span class="glyph">${item.glyph}</span>${item.label}</a>`).join('\n')}
    </div>`,
).join('\n')}
    <div class="rail-foot">
      <div class="slogan">Defend This World. Build the Next.</div>
      <div>Static snapshot, built ${built} UTC</div>
    </div>
  </nav>

  <div class="surface">
    <div class="demo-banner">
      <div class="demo-banner-inner">
        <strong>Static snapshot</strong>
        <span>Built ${built} UTC from a synthetic corpus. Every company here is invented.</span>
        <span>Nothing is live: search filters the exported rows, and no action can be taken.</span>
      </div>
    </div>

    <main>
${bodies.map((b) => `<section data-screen="${b.key}">${b.html}</section>`).join('\n')}
    </main>
  </div>
</div>

<script>
(function () {
  'use strict';

  var screens = Array.prototype.slice.call(document.querySelectorAll('[data-screen]'));
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('[data-nav]'));

  function show(key) {
    var found = false;
    screens.forEach(function (section) {
      var match = section.getAttribute('data-screen') === key;
      section.classList.toggle('current', match);
      if (match) found = true;
    });
    if (!found) return show('dashboard');

    // An entity detail screen keeps Entities marked, since that is where it came from.
    var navKey = key.indexOf('entity-') === 0 ? 'entities'
      : key.indexOf('requirement-') === 0 ? 'feed'
      : key.indexOf('forecast-') === 0 ? 'forecast'
      : key;
    navLinks.forEach(function (link) {
      link.classList.toggle('current', link.getAttribute('data-nav') === navKey);
    });
    window.scrollTo(0, 0);
  }

  function fromHash() {
    show((window.location.hash || '#dashboard').slice(1));
  }

  window.addEventListener('hashchange', fromHash);
  fromHash();

  // The search boxes filter the rows that were exported. Every column counts, which is
  // broader than the served interface's SQL and is the honest thing to do when the query
  // that produced these rows is not available to re-run.
  Array.prototype.forEach.call(document.querySelectorAll('form.search'), function (form) {
    var section = form.closest('[data-screen]');
    if (!section) return;

    var bodies = Array.prototype.slice.call(section.querySelectorAll('tbody'));
    var count = document.createElement('div');
    count.className = 'filter-count';
    form.parentNode.insertBefore(count, form.nextSibling);

    function apply() {
      var terms = Array.prototype.slice
        .call(form.querySelectorAll('input[type=search]'))
        .map(function (input) { return input.value.trim().toLowerCase(); })
        .filter(Boolean);

      var shown = 0;
      var total = 0;
      bodies.forEach(function (body) {
        Array.prototype.forEach.call(body.rows, function (row) {
          total += 1;
          var hay = row.textContent.toLowerCase();
          var match = terms.every(function (term) { return hay.indexOf(term) !== -1; });
          row.hidden = !match;
          if (match) shown += 1;
        });
      });

      count.textContent = terms.length
        ? shown + ' of ' + total + ' exported row' + (total === 1 ? '' : 's') + ' match'
        : total + ' exported row' + (total === 1 ? '' : 's') + '. Filtering happens in the page.';
    }

    form.addEventListener('submit', function (event) { event.preventDefault(); apply(); });
    form.addEventListener('input', apply);
    Array.prototype.forEach.call(form.querySelectorAll('a.clear'), function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        Array.prototype.forEach.call(form.querySelectorAll('input'), function (i) { i.value = ''; });
        apply();
      });
    });
    apply();
  });
})();
</script>
`;

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, document, 'utf8');

  const kb = Math.round(Buffer.byteLength(document) / 1024);
  process.stdout.write(`\nWrote ${out} (${kb} KB, ${bodies.length} screens).\n`);
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exit(1);
  });
