/**
 * The interface.
 *
 *   npm run web        http://localhost:3000
 *
 * A `node:http` server that renders strings. No framework, no build step, no client bundle, and no
 * dependency that is not already in the lockfile, because spec section 16 asks for one container
 * configured by environment variables and every layer added here is a layer that has to be deployed
 * and patched.
 *
 * **Writing is answered on three shapes of path and nowhere else.** Not as a routing convenience:
 * spec section 20 requires an audit row on every change, and a single narrow set of write endpoints
 * is what makes "the audit trail cannot be bypassed" a property of the router rather than a habit of
 * whoever wrote the last handler. Every one of them refuses without a signed-in principal.
 *
 *   POST /requirements/<id>/<action>   track, dismiss, clear, sent, unsent, note
 *   POST /follows/<action>             follow, unfollow
 *   POST /feed/mark-read               move the read mark
 *
 * Everything else is GET or HEAD. The CSV export is a GET because it writes nothing: it is a
 * different rendering of rows the requester can already read on screen.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool, pool } from '../db/index.js';
import { databaseState, feedCounts, handoffRows, watermarkFor } from './queries.js';
import { page } from './layout.js';
import { html } from './html.js';
import type { Ctx } from './shell.js';
import { currentUser, whyNoWrite } from './auth.js';
import {
  isFollowAction,
  isPursuitAction,
  performFollowAction,
  performPursuitAction,
  readForm,
  touchUser,
} from './actions.js';
import { csvFilename, handoffCsv } from './handoff.js';

import { dashboard, dashboardJson } from './pages/dashboard.js';
import { feedScreen, feedJson } from './pages/feed.js';
import { follows } from './pages/follows.js';
import { forecast, forecastDetail, forecastJson } from './pages/forecast.js';
import { handoffs, handoffsJson } from './pages/handoffs.js';
import { campaignDetail, campaignsJson, campaignsScreen } from './pages/campaigns.js';
import { govwinScreen } from './pages/govwin.js';
import { requirement, requirementFields } from './pages/requirement.js';
import { overview, overviewJson } from './pages/overview.js';
import { entityDetail, entityList } from './pages/entities.js';
import { contracts } from './pages/contracts.js';
import { subcontracts } from './pages/subcontracts.js';
import { customers } from './pages/customers.js';
import { programs } from './pages/programs.js';
import { dacis } from './pages/dacis.js';
import { taxonomy } from './pages/taxonomy.js';
import { watchlist } from './pages/watchlist.js';
import { review } from './pages/review.js';
import { quality, qualityJson } from './pages/quality.js';
import { acceptance, acceptanceJson } from './pages/acceptance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/* ------------------------------------------------------------ static assets */

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Serve a file from `public/`, or answer null so the router can try a page.
 *
 * The resolved path is checked to be inside `public/` rather than the request path being checked
 * for `..`: encodings of `..` are easy to miss and a resolved-prefix check cannot be talked around.
 */
async function staticAsset(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const extension = path.extname(pathname);
  const type = CONTENT_TYPES[extension];
  if (!type) return null;

  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return null;

  try {
    return { body: await readFile(resolved), type };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ routing */

type Handler = (ctx: Ctx) => Promise<string>;

const ROUTES: Record<string, Handler> = {
  '/': dashboard,
  '/feed': feedScreen,
  '/follows': follows,
  '/forecast': forecast,
  '/handoffs': handoffs,
  '/campaigns': campaignsScreen,
  '/govwin': govwinScreen,
  // Kept and unlisted. The corpus overview answers "what is loaded", which is a question for
  // whoever maintains the system rather than the first thing BD should see.
  '/overview': overview,
  '/entities': entityList,
  '/contracts': contracts,
  '/subcontracts': subcontracts,
  '/customers': customers,
  '/programs': programs,
  '/dacis-contracts': dacis,
  '/taxonomy': taxonomy,
  '/watchlist': watchlist,
  '/review': review,
  '/quality': quality,
  '/acceptance': acceptance,
};

/**
 * The old pipeline URLs.
 *
 * Kept working rather than 404ing somebody's bookmark. The pipeline, my-work and upcoming screens
 * were the ownership model this build replaced; the feed answers what all three were for.
 */
const MOVED: Record<string, string> = {
  '/pipeline': '/feed',
  '/my-work': '/feed?view=tracked',
  '/upcoming': '/feed',
};

const JSON_ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/dashboard': dashboardJson,
  '/api/feed': feedJson,
  '/api/forecast': forecastJson,
  '/api/handoffs': handoffsJson,
  '/api/campaigns': campaignsJson,
  '/api/overview': overviewJson,
  '/api/acceptance': acceptanceJson,
  '/api/quality': qualityJson,
};

function errorPage(pathname: string, status: number, title: string, detail: string): string {
  return page({
    title,
    path: pathname,
    body: html`<div class="notice alert">
        <h3>${title}</h3>
        ${detail}
      </div>
      <p><a href="/">Back to the dashboard</a></p>`,
    meta: html`<strong>${status}</strong>`,
  });
}

/* ---------------------------------------------------------------------- POST */

const REQUIREMENT_ACTION = /^\/requirements\/(\d{1,19})\/([a-z-]+)$/;
const FOLLOW_ACTION = /^\/follows\/([a-z-]+)$/;

/**
 * Handle a write.
 *
 * Answers 404 on anything that is not one of the three known shapes, and 403 on all of them when
 * the platform has not vouched for anyone. The order matters: an unrecognised path is not a write
 * at all, so it 404s before identity is considered.
 */
async function handleWrite(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const requirementMatch = REQUIREMENT_ACTION.exec(pathname);
  const followMatch = FOLLOW_ACTION.exec(pathname);
  const isMarkRead = pathname === '/feed/mark-read';

  const known =
    (requirementMatch !== null && isPursuitAction(requirementMatch[2]!)) ||
    (followMatch !== null && isFollowAction(followMatch[1]!)) ||
    isMarkRead;

  if (!known) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('No such action.\n');
    return;
  }

  // No signed-in user, no write. Not a fallback to a default actor: an audit trail full of names
  // that mean nothing is worse than no audit trail, because it looks like one.
  const user = currentUser(request);
  if (user === null) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`${whyNoWrite()}\n`);
    return;
  }

  // Before the write, not only on a page view: `follow`, `feed_watermark` and `pursuit_action` all
  // carry a foreign key to `app_user`, so a person's first action would otherwise fail on the key.
  await touchUser(user);

  const form = await readForm(request);
  const result = isMarkRead
    ? await performFollowAction('mark-read', form, user)
    : requirementMatch !== null
      ? await performPursuitAction(
          requirementMatch[2]! as Parameters<typeof performPursuitAction>[0],
          requirementMatch[1]!,
          form,
          user,
        )
      : await performFollowAction(
          followMatch![1]! as Parameters<typeof performFollowAction>[0],
          form,
          user,
        );

  const target = result.ok
    ? result.redirectTo
    : `${result.redirectTo}${result.redirectTo.includes('?') ? '&' : '?'}problem=${encodeURIComponent(
        result.message ?? 'That did not work.',
      )}`;

  // Redirect after post, so a refresh does not repeat the action.
  response.writeHead(303, { location: target });
  response.end();
}

/* ----------------------------------------------------------------- CSV export */

/**
 * The spreadsheet export.
 *
 * A GET, because it writes nothing and produces no audit row: it is a different rendering of rows
 * the requester can already read. The id list is capped, because an unbounded export is a way to
 * ask one request to assemble the whole corpus in memory.
 */
const MAX_EXPORT_ROWS = 500;

async function handleExport(url: URL, response: ServerResponse, isHead: boolean): Promise<void> {
  const ids = url.searchParams.getAll('id').filter((id) => /^\d{1,19}$/.test(id));

  if (ids.length === 0) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(
      'Nothing selected. Tick the rows you want on the feed and press Export, or ' +
        'call this with ?id=<requirement id>.\n',
    );
    return;
  }

  const capped = ids.slice(0, MAX_EXPORT_ROWS);
  const rows = await handoffRows(capped);
  const csv = handoffCsv(rows);

  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${csvFilename(rows.length)}"`,
    // Never cached. A person who exports twice in an afternoon has changed something in between.
    'cache-control': 'no-store',
  });
  response.end(isHead ? undefined : csv);
}

/* ---------------------------------------------------------------------- main */

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (request.method === 'POST') {
    await handleWrite(request, response, pathname);
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, {
      'content-type': 'text/plain; charset=utf-8',
      allow: 'GET, HEAD, POST',
    });
    response.end('Only GET, HEAD and POST are answered, and POST only on an action path.\n');
    return;
  }

  const asset = await staticAsset(pathname);
  if (asset) {
    response.writeHead(200, {
      'content-type': asset.type,
      // The fonts and the logo never change within a deployment; the stylesheet does during
      // development, so nothing here is cached for longer than an hour.
      'cache-control': 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
    return;
  }

  // Liveness and readiness. A container orchestrator needs an answer that does not depend on the
  // corpus being loaded, so this asks the database for the time and nothing else.
  if (pathname === '/healthz') {
    try {
      await pool.query('select 1');
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', database: 'reachable' }));
    } catch (error) {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      response.end(
        JSON.stringify({
          status: 'unavailable',
          database: 'unreachable',
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return;
  }

  if (pathname === '/export.csv') {
    await handleExport(url, response, request.method === 'HEAD');
    return;
  }

  const json = JSON_ROUTES[pathname];
  if (json) {
    const payload = await json();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload, null, 2));
    return;
  }

  const moved = MOVED[pathname];
  if (moved) {
    const [target, query] = moved.split('?');
    const search = url.search === '' ? (query ? `?${query}` : '') : url.search;
    response.writeHead(302, { location: `${target}${search}` });
    response.end();
    return;
  }

  const state = await databaseState();
  const user = currentUser(request);
  if (user !== null) await touchUser(user);

  // Rail badges. The number beside the link is why a feed gets read: a count is seen, a screen
  // behind a link is not.
  const badges = await railBadges(state.migrationsApplied === 0 ? null : user?.principalName ?? '');

  const ctx: Ctx = { url, state, user, badges };

  const route = ROUTES[pathname];
  if (route) {
    const body = await route(ctx);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  // /requirements/<id>
  const requirementMatch = /^\/requirements\/(\d{1,19})$/.exec(pathname);
  if (requirementMatch) {
    const body = await requirement(ctx, requirementMatch[1]!);
    if (body === null) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        errorPage(pathname, 404, 'No such requirement', `Requirement ${requirementMatch[1]} is not in this database.`),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  // /requirements/<id>/fields, the field block on its own, for a person who wants only that.
  const fieldsMatch = /^\/requirements\/(\d{1,19})\/fields$/.exec(pathname);
  if (fieldsMatch) {
    const text = await requirementFields(fieldsMatch[1]!);
    if (text === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('No such requirement.\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : text);
    return;
  }

  // The old pursuit URLs, kept working.
  const pursuitMatch = /^\/pursuits\/(\d{1,19})$/.exec(pathname);
  if (pursuitMatch) {
    response.writeHead(301, { location: `/requirements/${pursuitMatch[1]}` });
    response.end();
    return;
  }

  // /campaigns/<id>
  const campaignMatch = /^\/campaigns\/(\d{1,19})$/.exec(pathname);
  if (campaignMatch) {
    const body = await campaignDetail(ctx, campaignMatch[1]!);
    if (body === null) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        errorPage(pathname, 404, 'No such campaign', `Campaign ${campaignMatch[1]} is not in this database.`),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  // /forecast/<id>
  const forecastMatch = /^\/forecast\/(\d{1,19})$/.exec(pathname);
  if (forecastMatch) {
    const body = await forecastDetail(ctx, forecastMatch[1]!);
    if (body === null) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        errorPage(pathname, 404, 'No such projection', `Projection ${forecastMatch[1]} is not in this database.`),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  // /entities/<id>
  const entityMatch = /^\/entities\/(\d{1,19})$/.exec(pathname);
  if (entityMatch) {
    const body = await entityDetail(ctx, entityMatch[1]!);
    if (body === null) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        errorPage(pathname, 404, 'No such entity', `Entity ${entityMatch[1]} is not in this database.`),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  response.end(errorPage(pathname, 404, 'No such screen', `Nothing is served at ${pathname}.`));
}

/**
 * The numbers beside the rail links.
 *
 * Cheap enough to compute on every render, and null-tolerant: a database with no schema answers no
 * badges rather than throwing, because that is the state of a fresh clone and it is not an error.
 */
async function railBadges(principal: string | null): Promise<Record<string, number>> {
  if (principal === null) return {};
  try {
    const mark = await watermarkFor(principal);
    const counts = await feedCounts(principal, mark.seen_through);
    return { '/feed': counts.new_since, '/follows': counts.follows };
  } catch {
    return {};
  }
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${request.method} ${request.url} failed: ${message}`);
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      errorPage(
        new URL(request.url ?? '/', 'http://localhost').pathname,
        500,
        'That screen could not be rendered',
        `${message}. If the database has no schema yet, run npm run migrate.`,
      ),
    );
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Contract Intelligence Engine interface on http://localhost:${PORT}`);
  console.log('Ctrl-C to stop.');
});

/**
 * Stop cleanly. The Dockerfile runs tini as pid 1 so a container stop arrives here as SIGTERM
 * rather than being dropped, and an in-flight query gets to finish.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing.`);
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
    // Do not wait forever on a hung connection.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
