/**
 * The interface.
 *
 *   npm run web        http://localhost:3000
 *
 * A `node:http` server that renders strings. No framework, no build step, no client
 * bundle, and no dependency that is not already in the lockfile, because spec section
 * 16 asks for one container configured by environment variables and every layer added
 * here is a layer that has to be deployed and patched.
 *
 * Read only, and structurally so: the router answers GET and HEAD and nothing else.
 * Confirming a seed row or merging two entities writes to the corpus and needs the
 * audit trail spec section 20 describes, so those are a later phase rather than a
 * button that quietly bypasses it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closePool, pool } from '../db/index.js';
import { databaseState } from './queries.js';
import { page } from './layout.js';
import { html } from './html.js';
import type { Ctx } from './shell.js';

import { overview, overviewJson } from './pages/overview.js';
import { upcoming, upcomingJson } from './pages/upcoming.js';
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
 * The resolved path is checked to be inside `public/` rather than the request path
 * being checked for `..`: encodings of `..` are easy to miss and a resolved-prefix
 * check cannot be talked around.
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
  '/': overview,
  '/upcoming': upcoming,
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

const JSON_ROUTES: Record<string, () => Promise<unknown>> = {
  '/api/overview': overviewJson,
  '/api/upcoming': upcomingJson,
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
      <p><a href="/">Back to the overview</a></p>`,
    meta: html`<strong>${status}</strong>`,
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  // Read only, enforced at the door rather than by the absence of forms.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
    response.end('This interface is read only. Only GET and HEAD are answered.\n');
    return;
  }

  const asset = await staticAsset(pathname);
  if (asset) {
    response.writeHead(200, {
      'content-type': asset.type,
      // The fonts and the logo never change within a deployment; the stylesheet does
      // during development, so nothing here is cached for longer than an hour.
      'cache-control': 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
    return;
  }

  // Liveness and readiness. A container orchestrator needs an answer that does not
  // depend on the corpus being loaded, so this asks the database for the time and
  // nothing else.
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

  const json = JSON_ROUTES[pathname];
  if (json) {
    const payload = await json();
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload, null, 2));
    return;
  }

  const state = await databaseState();
  const ctx: Ctx = { url, state };

  const route = ROUTES[pathname];
  if (route) {
    const body = await route(ctx);
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
  console.log('Read only. Ctrl-C to stop.');
});

/**
 * Stop cleanly. The Dockerfile runs tini as pid 1 so a container stop arrives here as
 * SIGTERM rather than being dropped, and an in-flight query gets to finish.
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
