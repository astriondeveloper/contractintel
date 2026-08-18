/**
 * A local stand-in for GovCon API.
 *
 *   npm run govcon:stub              # listens on 3998
 *   GOVCON_API_BASE=http://localhost:3998/api/v1 \
 *     GOVCON_API_KEY=stub npm run load:govcon -- --probe
 *
 * Same reason as `sam-stub.ts`: the tests inject the fetch function and never touch `httpFetchJson`,
 * so without this the one code path that actually talks to GovCon API is the one nothing exercises.
 * Running the loader against this proves the bearer header, the envelope shape, the pagination, the
 * rate-limit headers and the cursor arithmetic, and leaves only the live key untested.
 *
 * It is not a mock in the test sense. It answers the documented parameters, pages the way a
 * limit/offset endpoint pages, and reproduces the behaviours that are easy to get wrong:
 *
 *   no bearer token           401, as the real API does
 *   /opportunities/search     400 with no filter, which the guide says it requires
 *   /opportunities/delta      clamps `since` older than 60 days and reports clamp_reason
 *   X-RateLimit-Remaining     counts down, so the reserve logic runs
 *
 * Every record it returns is invented. The identifiers are ZGCON-prefixed so one cannot be mistaken
 * for a real solicitation or a real company, and nothing here may be committed to `data/`.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.GOVCON_STUB_PORT ?? 3998);

/** The endpoint's own cap on `since`, which the loader is expected to notice. */
const DELTA_MAX_DAYS = 60;

/** The documented hourly allowance. Counted down so the client's reserve logic actually fires. */
const RATE_LIMIT = 1000;
let requestsServed = 0;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function isoDaysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

interface StubNotice {
  readonly naics: string;
  readonly psc: string;
  readonly record: Record<string, unknown>;
}

/**
 * Deliberately awkward in four ways, because a stub that returns only tidy records proves the loader
 * handles tidy records:
 *
 *   One title begins with '=', which Excel executes as a formula on export.
 *   One carries no response deadline, as a sources sought often does not.
 *   One is a notice type the loader does not recognise, so the skip-and-count path runs.
 *   One names an agency by a name the corpus has never seen, so the unresolved-agency path runs.
 */
const NOTICES: readonly StubNotice[] = [
  {
    naics: '541330',
    psc: 'ZT2',
    record: {
      notice_id: 'ZGCON000000000000000000000000001',
      title: 'Engineering and technical services for range instrumentation',
      solicitation_number: 'ZGCON-SOL-0001',
      agency: 'Example Defense Department',
      department: 'Example Defense Department',
      sub_agency: 'Example Air Service',
      office: 'ZOFF02',
      posted_date: isoDaysAgo(2),
      response_deadline: `${isoDaysAhead(28)}T17:00:00-05:00`,
      notice_type: 'Solicitation',
      set_aside_type: 'Small Business Set-Aside',
      set_aside_code: 'SBA',
      naics: ['541330'],
      primary_naics: '541330',
      psc_code: 'ZT2',
      performance_state: 'CA',
      performance_city: 'Example City',
      sam_url: 'https://sam.gov/opp/ZGCON000000000000000000000000001/view',
    },
  },
  {
    naics: '541330',
    psc: 'ZT2',
    record: {
      notice_id: 'ZGCON000000000000000000000000002',
      // Excel executes a leading '=' on a CSV export. The hand-off guard is what stops it.
      title: '=SUM(A1:A9) sustainment engineering sources sought',
      solicitation_number: 'ZGCON-SOL-0002',
      agency: 'Example Defense Department',
      office: 'ZOFF02',
      posted_date: isoDaysAgo(1),
      // A sources sought often has no deadline. Blank is not zero.
      response_deadline: null,
      notice_type: 'Sources Sought',
      naics: ['541330'],
      primary_naics: '541330',
      psc_code: 'ZT2',
      performance_state: 'OH',
    },
  },
  {
    naics: '541512',
    psc: 'ZT7',
    record: {
      notice_id: 'ZGCON000000000000000000000000003',
      title: 'Enterprise systems integration support',
      solicitation_number: 'ZGCON-SOL-0003',
      // An agency name the corpus has no label for, so agency_code stays blank rather than wrong.
      agency: 'Example Bureau Of Nothing In Particular',
      office: 'ZOFF07',
      posted_date: isoDaysAgo(4),
      response_deadline: `${isoDaysAhead(45)}T14:00:00-04:00`,
      notice_type: 'Presolicitation',
      naics: ['541512'],
      primary_naics: '541512',
      psc_code: 'ZT7',
      performance_state: 'VA',
    },
  },
  {
    naics: '541512',
    psc: 'ZT7',
    record: {
      notice_id: 'ZGCON000000000000000000000000004',
      title: 'A notice of a kind this build has never heard of',
      agency: 'Example Defense Department',
      office: 'ZOFF07',
      posted_date: isoDaysAgo(1),
      // Unrecognised on purpose: the loader must count and skip it, not guess.
      notice_type: 'Interpretive Dance Notice',
      naics: ['541512'],
      primary_naics: '541512',
      psc_code: 'ZT7',
    },
  },
  {
    naics: '541330',
    psc: 'ZT2',
    record: {
      // Deliberately the same notice id the SAM.gov stub serves, because the convergence claim is
      // the one that matters most and a check that cannot fail is not a check. Run both loaders
      // against both stubs and this notice must produce exactly one pursuit, updated rather than
      // duplicated, with a source_version under each source system. Change this id only together
      // with the matching one in scripts/sam-stub.ts.
      notice_id: 'ZSTUB0000000000000000000000000001',
      title: 'Engineering and technical services for range instrumentation',
      solicitation_number: 'ZSTUB-SOL-0001',
      agency: 'Example Defense Department',
      sub_agency: 'Example Air Service',
      office: 'ZOFF02',
      posted_date: isoDaysAgo(3),
      response_deadline: `${isoDaysAhead(28)}T17:00:00-05:00`,
      notice_type: 'Solicitation',
      set_aside_code: 'SBA',
      naics: ['541330'],
      primary_naics: '541330',
      psc_code: 'ZT2',
      performance_state: 'CA',
      sam_url: 'https://sam.gov/opp/ZSTUB0000000000000000000000000001/view',
    },
  },
];

const ENTITIES: readonly Record<string, unknown>[] = [
  {
    uei: 'ZGCONUEI0001',
    cage_code: 'ZG001',
    legal_business_name: 'Example Systems Incorporated',
    dba_name: 'Example Systems',
    registration_status: 'Active',
    registration_expiration_date: isoDaysAhead(200),
    physical_state: 'VA',
    physical_city: 'Example City',
    naics_codes: ['541330', '541512'],
    certifications: ['Small Business'],
  },
  {
    uei: 'ZGCONUEI0002',
    cage_code: 'ZG002',
    legal_business_name: 'Example Holdings LLC',
    // Expired on purpose: an entity that cannot receive an award is the interesting case.
    registration_status: 'Expired',
    registration_expiration_date: isoDaysAgo(30),
    physical_state: 'MD',
    naics_codes: ['541330'],
  },
];

const EXCLUSIONS: readonly Record<string, unknown>[] = [
  {
    id: 'ZGCONEXCL0001',
    uei: 'ZGCONUEI0002',
    cage_code: 'ZG002',
    excluded_name: 'Example Holdings LLC',
    classification: 'Ineligible (Proceedings Completed)',
    exclusion_type: 'Reciprocal',
    excluding_agency: 'Example Defense Department',
    active_date: isoDaysAgo(400),
    // Indefinite on purpose. Null must not read as "not excluded".
    termination_date: null,
  },
  {
    id: 'ZGCONEXCL0002',
    excluded_name: 'Example Systems Of Somewhere Else',
    classification: 'Ineligible (Proceedings Completed)',
    excluding_agency: 'Example Civil Agency',
    active_date: isoDaysAgo(100),
    termination_date: isoDaysAhead(300),
  },
];

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

function page<T>(all: readonly T[], limit: number, offset: number, extra: Record<string, unknown> = {}): Answer {
  const slice = all.slice(offset, offset + limit);
  return {
    status: 200,
    body: {
      data: slice,
      pagination: {
        limit,
        offset,
        total: all.length,
        has_next: offset + limit < all.length,
      },
      filters_applied: extra.filters_applied ?? {},
      _sources: ['sam_opportunities', 'usaspending_fpds'],
      ...extra,
    },
  };
}

function route(pathname: string, params: URLSearchParams): Answer {
  const limit = Math.min(Number(params.get('limit') ?? '100') || 100, 100);
  const offset = Number(params.get('offset') ?? '0') || 0;

  if (pathname === '/api/v1/me') {
    return {
      status: 200,
      body: {
        email: 'stub@example.invalid',
        plan: 'stub',
        rate_limit: RATE_LIMIT,
        search_window_days: 365,
      },
    };
  }

  if (pathname === '/api/v1/status') {
    return { status: 200, body: { status: 'ok', stub: true } };
  }

  if (pathname === '/api/v1/opportunities/delta') {
    const since = params.get('since');
    if (since === null) {
      return { status: 400, body: { error: 'since is required', message: 'GET /opportunities/delta?since=<iso8601>' } };
    }

    // The real endpoint clamps a since older than its own window and reports the clamp in a sync
    // block. This is the behaviour most likely to be missed, so the stub reproduces it exactly.
    const requested = new Date(since);
    const oldest = new Date(Date.now() - DELTA_MAX_DAYS * 86_400_000);
    const clamped = Number.isFinite(requested.getTime()) && requested < oldest;
    const applied = clamped ? oldest : requested;

    const naics = params.get('naics');
    const psc = params.get('psc');
    const matching = NOTICES.filter(
      (n) => (naics === null || n.naics === naics) && (psc === null || n.psc === psc),
    ).map((n) => n.record);

    return page(matching, limit, offset, {
      sync: {
        since_requested: since,
        since_applied: applied.toISOString().slice(0, 19) + 'Z',
        clamp_reason: clamped
          ? `since older than the ${DELTA_MAX_DAYS}-day delta window; clamped`
          : null,
      },
      filters_applied: { since, naics, psc },
    });
  }

  if (pathname === '/api/v1/opportunities/search') {
    // The guide is explicit that a bare call is a 400. Reproduced so the loader never relies on one.
    const filters = [...params.keys()].filter((k) => !['limit', 'offset'].includes(k));
    if (filters.length === 0) {
      return {
        status: 400,
        body: { error: 'at least one filter is required', message: 'try naics=541512' },
      };
    }
    const naics = params.get('naics');
    const psc = params.get('psc');
    const matching = NOTICES.filter(
      (n) => (naics === null || n.naics === naics) && (psc === null || n.psc === psc),
    ).map((n) => n.record);
    return page(matching, limit, offset, { filters_applied: Object.fromEntries(params) });
  }

  if (pathname === '/api/v1/exclusions/search') {
    const uei = params.get('uei');
    const cage = params.get('cage');
    const name = params.get('name');
    const matching = EXCLUSIONS.filter((e) => {
      if (uei !== null) return e.uei === uei;
      if (cage !== null) return e.cage_code === cage;
      if (name !== null) return String(e.excluded_name).toLowerCase().includes(name.toLowerCase());
      return false;
    });
    return page(matching, limit, offset, { filters_applied: { uei, cage, name } });
  }

  if (pathname === '/api/v1/entities/search') {
    const name = params.get('name') ?? '';
    const matching = ENTITIES.filter((e) =>
      String(e.legal_business_name).toLowerCase().includes(name.toLowerCase()),
    );
    return page(matching, limit, offset, { filters_applied: { name } });
  }

  const byUei = /^\/api\/v1\/entities\/([A-Za-z0-9]{12})$/.exec(pathname);
  if (byUei !== null) {
    const entity = ENTITIES.find((e) => e.uei === byUei[1]);
    if (entity === undefined) return { status: 404, body: { error: 'not found' } };
    return { status: 200, body: { data: [entity], _sources: ['sam_entities'] } };
  }

  const byCage = /^\/api\/v1\/entities\/by-cage\/([A-Za-z0-9]{5})$/.exec(pathname);
  if (byCage !== null) {
    const entity = ENTITIES.find((e) => e.cage_code === byCage[1]);
    if (entity === undefined) return { status: 404, body: { error: 'not found' } };
    return { status: 200, body: { data: [entity], _sources: ['sam_entities'] } };
  }

  return { status: 404, body: { error: `no stub route for ${pathname}` } };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  // Authentication before routing, as the real API does. A loader that forgot the bearer header
  // should fail here rather than get data.
  const authorization = request.headers.authorization ?? '';
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'missing or malformed Authorization: Bearer <key>' }));
    console.log(`401  ${url.pathname}  no bearer token`);
    return;
  }

  requestsServed += 1;
  const answer = route(url.pathname, url.searchParams);

  response.writeHead(answer.status, {
    'content-type': 'application/json',
    'x-ratelimit-limit': String(RATE_LIMIT),
    'x-ratelimit-remaining': String(Math.max(0, RATE_LIMIT - requestsServed)),
  });
  response.end(JSON.stringify(answer.body));

  const count = (answer.body as { data?: unknown[] }).data?.length;
  console.log(
    `${answer.status}  ${url.pathname}${url.search}` + (count === undefined ? '' : `  ${count} record(s)`),
  );
});

server.listen(PORT, () => {
  console.log(`GovCon API stub on http://localhost:${PORT}/api/v1`);
  console.log('');
  console.log('  GOVCON_API_BASE=http://localhost:' + PORT + '/api/v1 \\');
  console.log('    GOVCON_API_KEY=stub npm run load:govcon -- --probe');
  console.log('');
  console.log(`  ${NOTICES.length} notices, ${ENTITIES.length} entities, ${EXCLUSIONS.length} exclusions. All invented.`);
});
