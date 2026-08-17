/**
 * A local stand-in for the SAM.gov Get Opportunities v2 endpoint.
 *
 *   npm run sam:stub                 # listens on 3999
 *   SAM_API_BASE=http://localhost:3999/opportunities/v2/search \
 *     SAM_API_KEY=stub npm run load:sam
 *
 * `CONTRIBUTING.md` has always said to point `SAM_API_BASE` at a local stub, and left the stub as an
 * exercise. This is it, because the exercise was the part that made the instruction useless: the
 * tests inject `fetchPage` and never touch `httpFetch`, so the one code path that actually talks to
 * SAM.gov was the one nothing exercised. Running the loader against this proves the real HTTP path,
 * the parameter shape, the pagination and the key handling, and leaves only the key itself untested.
 *
 * It is not a mock in the test sense. It answers the parameters the v2 definition specifies, pages
 * the way the real endpoint pages, and rejects a request the real one would reject:
 *
 *   no api_key                    401, as api.data.gov does
 *   missing postedFrom/postedTo    400, which the definition requires whenever limit is given
 *   a code nothing matches         an empty page rather than an error
 *
 * Every notice it returns is invented. The identifiers are ZSTUB-prefixed so one cannot be mistaken
 * for a real solicitation, and nothing here may be committed to `data/`.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.SAM_STUB_PORT ?? 3999);

/**
 * The notices the stub knows about, keyed by the code that finds them.
 *
 * Deliberately awkward in three ways, because a stub that only returns tidy notices proves the
 * loader handles tidy notices:
 *
 *   One title begins with '=', which Excel executes as a formula on export.
 *   One carries no response deadline, which a sources sought often does not.
 *   One is a notice type the loader does not recognise, so the skip-and-count path runs.
 */
interface StubNotice {
  readonly naics?: string;
  readonly psc?: string;
  readonly notice: Record<string, unknown>;
}

const NOTICES: readonly StubNotice[] = [
  {
    naics: '541330',
    notice: {
      noticeId: 'ZSTUB0000000000000000000000000001',
      title: 'Engineering and technical services for range instrumentation',
      solicitationNumber: 'ZSTUB-SOL-0001',
      fullParentPathName: 'EXAMPLE DEFENSE DEPARTMENT.EXAMPLE AIR SERVICE',
      fullParentPathCode: '5700.ZOFF02',
      postedDate: isoDaysAgo(3),
      type: 'Solicitation',
      typeOfSetAside: 'SBA',
      responseDeadLine: `${isoDaysAhead(28)}T17:00:00-05:00`,
      naicsCode: '541330',
      classificationCode: 'ZT2',
      office: 'ZOFF02',
      placeOfPerformance: { state: { code: 'CA', name: 'California' } },
      uiLink: 'https://sam.gov/opp/ZSTUB0000000000000000000000000001/view',
    },
  },
  {
    naics: '541330',
    notice: {
      // A title beginning with '=' is executed as a formula when a CSV export is opened in Excel.
      // Federal notice titles do this, so the stub does too.
      noticeId: 'ZSTUB0000000000000000000000000002',
      title: '=SUM Hypersonic test support, phase II',
      solicitationNumber: 'ZSTUB-SS-0002',
      fullParentPathCode: '9700.ZOFF01',
      postedDate: isoDaysAgo(1),
      type: 'Sources Sought',
      // No deadline. A sources sought often carries none, and the loader must not invent one.
      responseDeadLine: null,
      naicsCode: '541330',
      classificationCode: 'ZT1',
      office: 'ZOFF01',
      uiLink: 'https://sam.gov/opp/ZSTUB0000000000000000000000000002/view',
    },
  },
  {
    psc: 'ZT1',
    notice: {
      noticeId: 'ZSTUB0000000000000000000000000003',
      title: 'Justification and approval, sole source',
      fullParentPathCode: '9700.ZOFF01',
      postedDate: isoDaysAgo(5),
      // A type the loader does not map. It must be counted and skipped rather than guessed at.
      type: 'Justification',
      naicsCode: '541330',
      classificationCode: 'ZT1',
      office: 'ZOFF01',
    },
  },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoDaysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
  const parameters = url.searchParams;

  const send = (status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };

  // api.data.gov answers 401 without a key, whatever the endpoint. The loader has a message for
  // this case and it should be reachable.
  if ((parameters.get('api_key') ?? '') === '') {
    send(401, { error: { code: 'API_KEY_MISSING', message: 'No api_key supplied.' } });
    return;
  }

  // The v2 definition requires the posted range whenever limit is given. A loader that dropped one
  // would fail against the real endpoint and pass against a lenient stub, which is the failure a
  // stub is most likely to hide.
  if (parameters.get('limit') !== null) {
    for (const required of ['postedFrom', 'postedTo']) {
      if (parameters.get(required) === null) {
        send(400, { error: { message: `${required} is required when limit is given.` } });
        return;
      }
    }
    for (const dated of ['postedFrom', 'postedTo']) {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(parameters.get(dated) ?? '')) {
        send(400, { error: { message: `${dated} must be mm/dd/yyyy.` } });
        return;
      }
    }
  }

  const naics = parameters.get('ncode');
  const psc = parameters.get('ccode');
  const types = parameters.getAll('ptype');
  const limit = Number(parameters.get('limit') ?? 10);
  const offset = Number(parameters.get('offset') ?? 0);

  const matching = NOTICES.filter((entry) => {
    if (naics !== null) return entry.naics === naics;
    if (psc !== null) return entry.psc === psc;
    return true;
  }).map((entry) => entry.notice);

  const page = matching.slice(offset, offset + limit);

  console.log(
    `  ${request.method} ncode=${naics ?? '-'} ccode=${psc ?? '-'} ptype=${types.join('|') || '-'} ` +
      `offset=${offset} → ${page.length} of ${matching.length}`,
  );

  send(200, { totalRecords: matching.length, limit, offset, opportunitiesData: page });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SAM.gov stub on http://localhost:${PORT}/opportunities/v2/search`);
  console.log('');
  console.log('Point the loader at it:');
  console.log('');
  console.log(`  SAM_API_BASE=http://localhost:${PORT}/opportunities/v2/search \\`);
  console.log('    SAM_API_KEY=stub npm run load:sam');
  console.log('');
  console.log('Every notice it returns is invented. Ctrl-C to stop.');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
