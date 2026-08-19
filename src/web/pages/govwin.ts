/**
 * GovWin early requirements.
 *
 * The one screen in this system that shows work before it has been advertised. Every other screen reads
 * something the government has already done: an award, a notice, a contract ending. These are
 * requirements an analyst is tracking, 769 of them with no solicitation to find yet, which is the whole
 * reason the source is worth a licence.
 *
 * Three things this screen has to be careful about, and they are all about not overstating what it
 * knows.
 *
 * **An estimated date is a month.** Rendering `2027-06-01` for "sometime in June 2027" would be a
 * fabrication, so a month-precision date is shown as its month and labelled with whose estimate it is.
 * The precision travels from the export through the database to here for exactly this reason.
 *
 * **It opens on the early slice, not everything.** The export carries 944 expired and 427 awarded rows.
 * A screen that opens on those buries what matters, so `all` is a click away rather than the default.
 *
 * **It says what it cannot reach.** GovWin names agencies rather than coding them, so an agency follow
 * may match nothing, and the export has no PSC at all, so a PSC follow cannot match by construction.
 * Both are stated on the screen rather than left to look like an empty market.
 *
 * The written analysis is not here because it is not stored: it is Deltek's licensed prose and this
 * system links out to it rather than re-hosting it. Decision D32.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, pager, searchForm, table, tiles } from '../components.js';
import { count, day, orAbsent, truncate, usd, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import {
  govwinCoverage,
  govwinLinkedPursuits,
  govwinOpportunities,
  govwinOpportunity,
  govwinStatuses,
  whyInGovwinPatch,
  type GovwinRow,
  type GovwinView,
} from '../queries.js';

const SORTS = ['soonest', 'value', 'watched', 'newest'] as const;

/**
 * A date at the precision the source claimed it.
 *
 * The point of the whole precision column. `June 2027` for an estimate, a full day for a published
 * date, and the basis named so a reader knows whose opinion they are looking at.
 */
export function expectedDate(
  date: Date | null,
  precision: string | null,
  basis: string | null,
): Html {
  if (date === null) return html`<span class="sub">${ABSENT}</span>`;

  const asMonth = new Date(date).toISOString().slice(0, 7);
  const shown = precision === 'month' ? asMonth : day(date);
  const label =
    basis === 'deltek_estimate'
      ? 'Deltek estimate'
      : basis === 'government_estimate'
        ? 'government estimate'
        : basis === 'actual'
          ? 'published'
          : null;

  return html`${shown}${label === null ? '' : html`<span class="sub">${label}</span>`}`;
}

/** GovWin's lifecycle stage, coloured by how early it is. Early is the interesting end. */
export function statusChip(status: string): Html {
  if (status === 'Forecast Pre-RFP') return chip('sky', status);
  if (status === 'Pre-RFP') return chip('sky', status);
  if (status === 'Source Selection' || status === 'Post-RFP') return chip('fail', status);
  if (status === 'Awarded' || status === 'Partial Award') return chip('pass', status);
  return chip('neutral', status);
}

export async function govwinScreen(ctx: Ctx): Promise<string> {
  const detailId = /^[A-Za-z0-9-]{1,64}$/.test(text(ctx.url, 'id')) ? text(ctx.url, 'id') : '';
  if (detailId !== '') return govwinDetail(ctx, detailId);

  const search = text(ctx.url, 'q');
  const status = text(ctx.url, 'status');
  const naics = text(ctx.url, 'naics');
  const rawSort = text(ctx.url, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort) ? rawSort : 'soonest';
  const view: GovwinView = text(ctx.url, 'view') === 'all' ? 'all' : 'early';

  const [result, coverage, statuses] = await Promise.all([
    govwinOpportunities(search, status, naics, view, sort, PAGE_SIZE, offset(ctx.url)),
    govwinCoverage(),
    govwinStatuses(),
  ]);

  const link = (param: string, value: string, label: string, current: string): Html => {
    const url = new URL(ctx.url);
    url.searchParams.delete('page');
    url.searchParams.set(param, value);
    return html`<a class="button quiet${current === value ? ' on' : ''}"
      href="${url.pathname}${url.search}"
      >${label}</a
    >`;
  };

  const statusSelect = html`<select name="status" aria-label="Stage">
    <option value=""${status === '' ? html` selected` : ''}>Every stage</option>
    ${statuses.map(
      (s) =>
        html`<option value="${s.status}"${status === s.status ? html` selected` : ''}>
          ${s.status} (${count(s.n)})
        </option>`,
    )}
  </select>`;

  const headline = tiles([
    {
      label: 'Requirements not yet advertised',
      value: count(coverage.early),
      foot: 'Pre-RFP and Forecast Pre-RFP. Nothing else here can see these.',
    },
    {
      label: 'With an expected date',
      value: count(coverage.early_with_expected_date),
      foot: 'The rest are tracked without a date, which is not a reason to invent one.',
    },
    {
      label: 'Matched by somebody’s follow',
      value: count(coverage.reachable_by_a_follow),
      foot: 'Reachable through a patch rather than only by browsing here.',
      href: '/follows',
    },
    {
      label: 'Loaded in total',
      value: count(coverage.loaded),
      foot: 'Including the awarded and expired rows, which are history.',
    },
  ]);

  const caveats: Html[] = [];
  if (coverage.agency_unresolved > 0) {
    caveats.push(html`<p>
        <strong>${count(coverage.agency_unresolved)} of ${count(coverage.loaded)} rows have no agency
        code.</strong>
        GovWin names agencies rather than coding them, and a name only resolves where the corpus has
        already observed that label. An <a href="/follows">agency or office follow</a> cannot match
        these rows, so browse or follow a NAICS code instead until more FPDS history is loaded.
      </p>`);
  }
  if (coverage.psc_follows_that_cannot_match > 0) {
    caveats.push(html`<p>
        <strong>${count(coverage.psc_follows_that_cannot_match)} PSC follow(s) cannot match anything
        here.</strong>
        The export carries no product or service code at all. That is a gap in the source rather than in
        the follow, and it is said here so an empty patch does not read as an empty market.
      </p>`);
  }
  if (coverage.company_follows_that_cannot_match > 0) {
    caveats.push(html`<p>
        <strong>${count(coverage.company_follows_that_cannot_match)} company follow(s) cannot match
        anything here yet.</strong>
        GovWin lists incumbents as one unparsed string, and splitting a list of company names on commas
        would attribute work to companies that are not on it. These names wait for the same entity
        resolution every other name in this system goes through.
      </p>`);
  }

  const body = html`
    ${headline}
    <div class="search">
      ${link('view', 'early', `Not yet advertised (${count(coverage.early)})`, view)}
      ${link('view', 'all', `Everything loaded (${count(coverage.loaded)})`, view)}
      <span class="clear">Sort</span>
      ${link('sort', 'soonest', 'Soonest expected', sort)}
      ${link('sort', 'value', 'Value', sort)}
      ${link('sort', 'watched', 'Most watched', sort)}
      ${link('sort', 'newest', 'Newest to us', sort)}
    </div>
    ${searchForm(
      '/govwin',
      [
        { name: 'q', placeholder: 'Programme, acronym, solicitation, agency or incumbent', value: search },
        { name: 'naics', placeholder: 'NAICS prefix', value: naics },
      ],
      statusSelect,
    )}
    ${caveats.length === 0
      ? ''
      : html`<div class="notice">
          <h3>What this source cannot reach</h3>
          ${caveats}
        </div>`}
    ${table({
      columns: [
        {
          header: 'Requirement',
          cell: (r: GovwinRow) =>
            html`<a class="headline" href="/govwin?id=${r.govwin_id}"
                >${truncate(r.program_name ?? `GovWin ${r.govwin_id}`, 68)}</a
              >
              ${r.acronym ? html`<span class="sub">${truncate(r.acronym, 30)}</span>` : ''}`,
        },
        { header: 'Stage', cell: (r: GovwinRow) => statusChip(r.status) },
        {
          header: 'Expected to solicit',
          cell: (r: GovwinRow) =>
            expectedDate(r.solicitation_date, r.solicitation_date_precision, r.solicitation_date_basis),
        },
        {
          header: 'Agency',
          cell: (r: GovwinRow) =>
            html`${truncate(r.agency_label ?? r.org_level_2 ?? r.org_level_1 ?? ABSENT, 30)}
              ${r.agency_code === null
                ? html`<span class="sub">no code, so follows cannot match</span>`
                : html`<span class="sub"><code>${r.agency_code}</code></span>`}`,
        },
        {
          header: 'NAICS',
          cell: (r: GovwinRow) =>
            r.naics_codes === null || r.naics_codes.length === 0
              ? ABSENT
              : html`<code>${r.naics_codes[0]}</code>${r.naics_codes.length > 1
                    ? html`<span class="sub">+${r.naics_codes.length - 1} more</span>`
                    : ''}`,
        },
        { header: 'Value', align: 'num', cell: (r: GovwinRow) => usd(r.value_usd) },
        {
          header: 'Watching',
          align: 'num',
          cell: (r: GovwinRow) =>
            r.advertised_interest === null ? ABSENT : count(r.advertised_interest),
        },
        {
          header: 'In this system',
          cell: (r: GovwinRow) =>
            r.linked_pursuits > 0
              ? chip('pass', `${r.linked_pursuits} requirement(s)`)
              : html`<span class="sub">not yet</span>`,
        },
      ],
      rows: result.rows,
      empty:
        search || status || naics
          ? html`<strong>Nothing matches this filter.</strong><br>
              The search covers the programme name, acronym, solicitation number, agency names and the
              incumbent string.`
          : html`<strong>No GovWin export is loaded.</strong><br>
              Load one with
              <code>npm run load:govwin -- --file &lt;export.xlsx&gt;</code>. The export is licensed
              Deltek data and must not be committed; keep it in <code>data/govwin/</code>, which is
              gitignored.`,
    })}
    ${pager({
      page: pageNumber(ctx.url),
      pageSize: PAGE_SIZE,
      total: result.total,
      baseQuery: baseQuery(ctx.url),
    })}
  `;

  return screen(ctx, {
    title: 'Early requirements',
    intro:
      'Requirements GovWin is tracking before they are advertised. An estimated date is a month, not ' +
      'a day, and is labelled with whose estimate it is. The written analysis stays at GovWin.',
    body,
    actions: html`<a class="button quiet" href="/forecast">Forecast</a>
      <a class="button quiet" href="/follows">Manage follows</a>`,
  });
}

/** One GovWin record: what is known, who else has it, and where to read the rest. */
async function govwinDetail(ctx: Ctx, govwinId: string): Promise<string> {
  const record = await govwinOpportunity(govwinId);
  if (record === undefined) {
    return screen(ctx, {
      title: 'Early requirements',
      intro: 'That GovWin record is not loaded.',
      body: html`<div class="empty">
        <strong>No record with that id.</strong><br>
        It may not have been in the last export. <a href="/govwin">Back to the list</a>.
      </div>`,
    });
  }

  const principal = ctx.user?.principalName ?? '';
  const [why, linked] = await Promise.all([
    principal === '' ? Promise.resolve([]) : whyInGovwinPatch(govwinId, principal),
    govwinLinkedPursuits(govwinId),
  ]);

  const rows: readonly (readonly [string, Html])[] = [
    ['Stage', statusChip(record.status)],
    ['Record type', html`${record.opp_type}`],
    [
      'Expected to solicit',
      expectedDate(record.solicitation_date, record.solicitation_date_precision, record.solicitation_date_basis),
    ],
    [
      'Projected award',
      // At the precision the source claimed, same as the solicitation date. GovWin writes most of
      // these as a month, and rendering 09/2026 as 2026-09-01 would invent a day the source never
      // named — which is the whole reason the precision is stored.
      expectedDate(record.projected_award_date, record.projected_award_date_precision, null),
    ],
    ['Solicitation number', record.solicitation_number ? html`<code>${record.solicitation_number}</code>` : html`<span class="sub">none yet, which is the point</span>`],
    ['Value', html`${usd(record.value_usd)}`],
    [
      'Agency',
      html`${orAbsent(record.agency_label ?? record.org_level_2 ?? record.org_level_1)}
        ${record.agency_code === null
          ? html`<span class="sub">GovWin named it but the corpus has no code for that name</span>`
          : html`<span class="sub"><code>${record.agency_code}</code></span>`}`,
    ],
    [
      'NAICS',
      record.naics_codes === null || record.naics_codes.length === 0
        ? html`<span class="sub">${ABSENT}</span>`
        : html`${record.naics_codes.map((c) => html`<code>${c}</code> `)}`,
    ],
    [
      'Incumbent, as GovWin wrote it',
      record.incumbent_names === null
        ? html`<span class="sub">${ABSENT}</span>`
        : html`${truncate(record.incumbent_names, 300)}
            <span class="sub">Unparsed on purpose: splitting a name list on commas attributes work to
            companies that are not on it.</span>`,
    ],
    [
      'Earliest contract expiry',
      record.earliest_expiration_date === null
        ? html`<span class="sub">${ABSENT}</span>`
        : html`${day(record.earliest_expiration_date)}`,
    ],
    [
      'Companies watching it on GovWin',
      record.advertised_interest === null
        ? html`<span class="sub">${ABSENT}</span>`
        : html`${count(record.advertised_interest)}`,
    ],
  ];

  const body = html`
    <div class="notice info">
      <h3>The analysis is at GovWin, not here</h3>
      GovWin's written summary and news are licensed Deltek content, so this system stores the
      structured fields and links out rather than re-hosting the prose.
      ${record.govwin_url
        ? html`<a href="${record.govwin_url}">Open this record in GovWin</a>.`
        : ''}
    </div>

    <table class="fields">
      ${rows.map(([label, value]) => html`<tr><th>${label}</th><td>${value}</td></tr>`)}
    </table>

    ${why.length > 0
      ? html`<div class="notice">
          <h3>Why this is in your patch</h3>
          ${why.map(
            (w) =>
              html`<p>
                ${w.follow_type} ${w.label ?? ''}
                ${w.matched_value === null ? '' : html`<span class="sub">via ${w.matched_field} ${w.matched_value}</span>`}
              </p>`,
          )}
        </div>`
      : ''}

    ${linked.length > 0
      ? html`<div class="notice">
          <h3>The same solicitation, elsewhere in this system</h3>
          <p>
            These share this record's solicitation number. They are kept separate rather than merged
            because the two sources are maintained on different cadences and disagree on purpose; the
            disagreement is often the first sign something has moved.
          </p>
          ${linked.map(
            (l) =>
              html`<p>
                <a href="/requirements/${l.pursuit_id}">Requirement ${l.pursuit_id}</a>
                <span class="sub">${l.signal_class} · from ${l.pursuit_source ?? 'an unrecorded source'}
                  ${l.pursuit_response_date === null ? '' : html`· responses due ${day(l.pursuit_response_date)}`}</span>
              </p>`,
          )}
        </div>`
      : ''}

    <p><a class="button quiet" href="/govwin">Back to early requirements</a></p>
  `;

  return screen(ctx, {
    title: truncate(record.program_name ?? `GovWin ${record.govwin_id}`, 70),
    intro: 'One GovWin record. Dates carry the precision the source claimed for them.',
    body,
  });
}
