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

const CLASS_LABEL: Record<string, string> = {
  active_solicitation: 'Out now',
  recompete_window: 'Recompete',
  shaping_target: 'Shaping',
};

function classChip(signalClass: string | null) {
  if (signalClass === 'active_solicitation') return chip('fail', 'Out now');
  if (signalClass === 'recompete_window') return chip('blocked', 'Recompete');
  if (signalClass === 'shaping_target') return chip('sky', 'Shaping');
  return ABSENT;
}

export async function upcoming(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const position = text(ctx.url, 'position');
  const signalClass = text(ctx.url, 'class');

  const [result, summary, thresholds] = await Promise.all([
    upcomingSignals(search, position, signalClass, PAGE_SIZE, offset(ctx.url)),
    upcomingSummary(),
    signalThresholds(),
  ]);

  const recompete = thresholds.find((t) => t.signal_class === 'recompete_window');
  const detected = summary.detected_at;

  /** A row of filter links that keeps every other filter in the URL. */
  const filterLinks = (
    param: string,
    current: string,
    options: readonly { value: string; label: string }[],
  ) =>
    html`<div class="search">
      ${options.map((option) => {
        const url = new URL(ctx.url);
        url.searchParams.delete('page');
        if (option.value) url.searchParams.set(param, option.value);
        else url.searchParams.delete(param);
        const isCurrent = current === option.value;
        return html`<a
          class="clear"
          href="${url.pathname}${url.search}"
          style="${isCurrent ? 'color:var(--alabaster);font-weight:600' : ''}"
          >${option.label}</a
        >`;
      })}
    </div>`;

  const classLinks = filterLinks('class', signalClass, [
    { value: '', label: 'Every stage' },
    { value: 'active_solicitation', label: `${CLASS_LABEL.active_solicitation!} (${count(summary.active_solicitation)})` },
    { value: 'recompete_window', label: `${CLASS_LABEL.recompete_window!} (${count(summary.recompete_window)})` },
    { value: 'shaping_target', label: `${CLASS_LABEL.shaping_target!} (${count(summary.shaping_target)})` },
  ]);

  const positionLinks = filterLinks('position', position, [
    { value: '', label: 'Every position' },
    { value: 'prime_incumbent', label: POSITION_LABEL.prime_incumbent! },
    { value: 'subcontractor', label: POSITION_LABEL.subcontractor! },
    { value: 'none', label: POSITION_LABEL.none! },
  ]);

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
        label: 'In the pipeline',
        value: count(summary.total),
        foot: 'Every stage, soonest first',
      },
      {
        label: 'Out now',
        value: count(summary.active_solicitation),
        foot: 'Solicitations open for response',
      },
      {
        label: 'Recompete',
        value: count(summary.recompete_window),
        foot:
          recompete
            ? `Ending ${recompete.horizon_months_from} to ${recompete.horizon_months_to} months out`
            : undefined,
      },
      {
        label: 'Shaping',
        value: count(summary.shaping_target),
        foot: 'Sources sought and special notices',
      },
      {
        label: 'Value in the window',
        value: usdCompact(summary.estimated_value),
        foot: `${count(summary.without_value)} carry no known value`,
      },
      {
        label: 'Last detection',
        value: detected === null ? ABSENT : since(detected),
        // Each class has its own rhythm in signal_class_threshold -- daily for a
        // solicitation, monthly for a recompete -- so naming one of them here would be
        // wrong about the others.
        foot: thresholds.length > 0 ? 'Each stage runs on its own rhythm' : undefined,
      },
    ])}
    ${section(
      'Ordered by when it matters',
      html`${searchForm('/upcoming', [
          {
            name: 'q',
            placeholder: 'Title, solicitation, PIID, NAICS, PSC, agency or incumbent',
            value: search,
          },
        ])}
        ${classLinks}
        ${positionLinks}
        ${table({
          columns: [
            { header: 'Stage', cell: (r) => classChip(r.signal_class) },
            {
              // A solicitation is timed by its response deadline and a recompete by the
              // end of the period of performance. Showing one column labelled for the
              // other would be wrong on half the rows, so the column says which it is.
              header: 'When',
              cell: (r) =>
                r.response_date !== null
                  ? html`${day(r.response_date)}<span class="sub">responses due</span>`
                  : r.period_end_date !== null
                    ? html`${day(r.period_end_date)}<span class="sub">${urgency(r.period_end_date)}</span>`
                    : html`${ABSENT}<span class="sub">no date given</span>`,
            },
            {
              header: 'Opportunity',
              cell: (r) =>
                html`${r.notice_url
                    ? html`<a href="${r.notice_url}" rel="noreferrer">${truncate(r.title, 66)}</a>`
                    : truncate(r.title, 66)}
                  <span class="sub"
                    >${r.solicitation_number
                      ? html`<code>${r.solicitation_number}</code>`
                      : r.related_piid
                        ? html`<code>${r.related_piid}</code>`
                        : ''}${r.notice_type ? html` · ${r.notice_type}` : ''}</span
                  >`,
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
              header: 'Codes',
              cell: (r) =>
                r.naics_code || r.psc_code
                  ? html`<code>${[r.naics_code, r.psc_code].filter(Boolean).join(' · ')}</code>
                      ${r.set_aside_code ? html`<span class="sub">${r.set_aside_code}</span>` : ''}`
                  : r.expected_solicitation_fy === null
                    ? ABSENT
                    : html`<span class="sub">solicits FY${r.expected_solicitation_fy}</span>`,
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
      'A solicitation by its response date, a recompete by when the contract ends',
    )}
  `;

  return screen(ctx, {
    title: 'Upcoming',
    intro:
      'Everything in front of business development, soonest first: solicitations open now, contracts ' +
      'coming up for recompete, and work still early enough to shape. Position is what Astrion holds ' +
      'today, not a judgement about whether to bid — ranking these against each other is the scoring ' +
      'engine’s job and it is not built yet.',
    body,
    suppressEmptyNotice: true,
  });
}

/** The same list as JSON, so a scheduled digest can be built without scraping. */
export async function upcomingJson(): Promise<unknown> {
  const [result, summary] = await Promise.all([
    upcomingSignals('', '', '', 500, 0),
    upcomingSummary(),
  ]);
  return { summary, signals: result.rows, returned: result.rows.length, total: result.total };
}
