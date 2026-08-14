/**
 * Upcoming. What business development should be looking at, soonest first.
 *
 * This is the screen the rest of the build is for. Everything behind it — the corpus, the
 * entity resolution, the contract grouping in migration 0019 — exists so that this list
 * is about real contracts with real end dates rather than a spreadsheet somebody keeps.
 *
 * Three things it is careful about.
 *
 * **Position, not priority.** A recompete of work held as prime, one Astrion subs on, and
 * one a competitor holds are three different plays. The screen groups by that rather than
 * ranking across it, because ranking them against each other is the scoring engine's job
 * and it is not built yet. Nothing here pretends to be a score.
 *
 * **Blank is not zero.** A contract with no recorded value sorts with the unknowns and
 * shows a dash. Treating it as a small contract would push real work to the bottom of
 * the list.
 *
 * **The window is the database's, not the screen's.** The horizon comes from
 * `signal_class_threshold`, which BD Ops owns per spec section 13, and the screen says
 * what the window currently is instead of implying the list is everything.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, pager, searchForm, section, table, tiles } from '../components.js';
import { count, day, since, truncate, usd, usdCompact, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { upcomingSignals, upcomingSummary, signalThresholds } from '../queries.js';

const POSITION_LABEL: Record<string, string> = {
  prime_incumbent: 'We hold it as prime',
  subcontractor: 'We sub on it',
  none: 'No position',
};

function positionChip(position: string | null) {
  if (position === 'prime_incumbent') return chip('pass', 'Prime');
  if (position === 'subcontractor') return chip('sky', 'Sub');
  if (position === 'none') return chip('neutral', 'No position');
  return ABSENT;
}

/** How close the end date is. Colour is the point: red is not "bad", it is "soon". */
function urgency(endsOn: Date | string | null): ReturnType<typeof chip> | string {
  if (endsOn === null) return ABSENT;
  const date = endsOn instanceof Date ? endsOn : new Date(String(endsOn));
  if (Number.isNaN(date.getTime())) return ABSENT;
  const months = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months <= 15) return chip('fail', 'Under 15 months');
  if (months <= 24) return chip('blocked', 'Under 2 years');
  return chip('neutral', 'Over 2 years');
}

export async function upcoming(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const position = text(ctx.url, 'position');

  const [result, summary, thresholds] = await Promise.all([
    upcomingSignals(search, position, PAGE_SIZE, offset(ctx.url)),
    upcomingSummary(),
    signalThresholds(),
  ]);

  const recompete = thresholds.find((t) => t.signal_class === 'recompete_window');
  const detected = summary.detected_at;

  const positionLinks = html`<div class="search">
    ${[
      { value: '', label: 'Every position' },
      { value: 'prime_incumbent', label: POSITION_LABEL.prime_incumbent! },
      { value: 'subcontractor', label: POSITION_LABEL.subcontractor! },
      { value: 'none', label: POSITION_LABEL.none! },
    ].map((option) => {
      const url = new URL(ctx.url);
      url.searchParams.delete('page');
      if (option.value) url.searchParams.set('position', option.value);
      else url.searchParams.delete('position');
      const current = position === option.value;
      return html`<a
        class="clear"
        href="${url.pathname}${url.search}"
        style="${current ? 'color:var(--alabaster);font-weight:600' : ''}"
        >${option.label}</a
      >`;
    })}
  </div>`;

  const body = html`
    ${summary.total === 0
      ? html`<div class="notice">
          <h3>No signal has been detected yet</h3>
          Detection is a scheduled job, not something the interface does on a page load.
          Run <code>npm run signals -- --dry-run</code> to see what it would find, then
          <code>npm run signals</code> to write it. It needs a loaded FPDS corpus:
          <code>npm run load -- --dir &lt;directory&gt;</code>.
        </div>`
      : ''}
    ${tiles([
      {
        label: 'Signals in the window',
        value: count(summary.total),
        foot:
          recompete
            ? `Contracts ending ${recompete.horizon_months_from} to ${recompete.horizon_months_to} months out`
            : undefined,
      },
      {
        label: 'We hold as prime',
        value: count(summary.prime_incumbent),
        foot: 'Defend',
      },
      {
        label: 'We sub on',
        value: count(summary.subcontractor),
        foot: 'A position to build on',
      },
      { label: 'No position', value: count(summary.none), foot: 'Take' },
      {
        label: 'Value in the window',
        value: usdCompact(summary.estimated_value),
        foot: `${count(summary.without_value)} carry no known value`,
      },
      {
        label: 'Last detection',
        value: detected === null ? ABSENT : since(detected),
        foot: recompete ? `Rhythm: ${recompete.rhythm}` : undefined,
      },
    ])}
    ${section(
      'Ordered by when the contract ends',
      html`${searchForm('/upcoming', [
          { name: 'q', placeholder: 'Title, PIID, agency or incumbent', value: search },
        ])}
        ${positionLinks}
        ${table({
          columns: [
            {
              header: 'Ends',
              cell: (r) =>
                html`${day(r.period_end_date)}<span class="sub">${urgency(r.period_end_date)}</span>`,
            },
            {
              header: 'Contract',
              cell: (r) =>
                html`${truncate(r.title, 68)}
                  ${r.related_piid ? html`<span class="sub"><code>${r.related_piid}</code></span>` : ''}`,
            },
            {
              header: 'Incumbent',
              cell: (r) =>
                r.incumbent_entity_id
                  ? html`<a href="/entities/${r.incumbent_entity_id}">${r.incumbent_name}</a>
                      ${r.incumbent_confidence
                        ? html`<span class="sub">${r.incumbent_confidence}</span>`
                        : ''}`
                  : ABSENT,
            },
            { header: 'Position', cell: (r) => positionChip(r.astrion_position) },
            { header: 'Value', align: 'num', cell: (r) => usd(r.estimated_value) },
            {
              header: 'Solicits',
              align: 'num',
              cell: (r) => (r.expected_solicitation_fy === null ? ABSENT : `FY${r.expected_solicitation_fy}`),
            },
            { header: 'Agency', cell: (r) => truncate(r.agency_label ?? r.agency_code, 26) },
            {
              header: 'State',
              cell: (r) =>
                r.state === 'open'
                  ? chip('neutral', 'open')
                  : r.state === 'won'
                    ? chip('pass', r.state)
                    : r.state === 'lost' || r.state === 'dropped'
                      ? chip('fail', r.state)
                      : chip('sky', r.state),
            },
          ],
          rows: result.rows,
          empty:
            search || position
              ? html`<strong>No signal matches this filter.</strong>`
              : html`<strong>Nothing is in the window.</strong><br>
                  Either no contract in the corpus ends inside it, or detection has not run.`,
        })}
        ${pager({
          page: pageNumber(ctx.url),
          pageSize: PAGE_SIZE,
          total: result.total,
          baseQuery: baseQuery(ctx.url),
        })}`,
      'Soonest first. A blank value is unknown, never zero',
    )}
  `;

  return screen(ctx, {
    title: 'Upcoming',
    intro:
      'Contracts inside the recompete window, soonest first. Position is what Astrion holds on the ' +
      'contract today, not a judgement about whether to bid: ranking these against each other is the ' +
      'scoring engine’s job and it is not built yet.',
    body,
    suppressEmptyNotice: true,
  });
}

/** The same list as JSON, so a scheduled digest can be built without scraping. */
export async function upcomingJson(): Promise<unknown> {
  const [result, summary] = await Promise.all([
    upcomingSignals('', '', 500, 0),
    upcomingSummary(),
  ]);
  return { summary, signals: result.rows, returned: result.rows.length, total: result.total };
}
