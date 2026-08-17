/**
 * The pipeline: every pursuit, filtered the way business development asks for it.
 *
 * The four views along the top are the four questions anybody actually asks of a queue —
 * what is open, what is mine, what has nobody picked up, what is due — and they are saved
 * questions rather than column filters, so the dashboard card and this list are the same
 * definition rather than two that drift.
 *
 * Snoozed work is out of the way by default and reachable in one click. That is the
 * difference between a queue people use and one they abandon: if the only way to clear
 * something off the screen is to drop it, everything eventually gets dropped.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, pager, searchForm, table } from '../components.js';
import { count, day, truncate, usd, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { pipeline as pipelineRows, pipelineCounts } from '../queries.js';

const VIEWS = ['open', 'mine', 'unclaimed', 'due', 'snoozed', 'closed'] as const;
const SORTS = ['due', 'fit', 'value'] as const;

function bandChip(band: string | null) {
  if (band === 'pursue') return chip('pass', 'Pursue');
  if (band === 'review') return chip('blocked', 'Review');
  if (band === 'pass') return chip('neutral', 'Pass');
  if (band === 'blocked') return chip('fail', 'Blocked');
  if (band === 'insufficient_evidence') return chip('sky', 'No rank');
  return html`<span class="chip neutral">Unscored</span>`;
}

function stateChip(state: string) {
  if (state === 'won') return chip('pass', state);
  if (state === 'lost' || state === 'dropped') return chip('fail', state);
  if (state === 'open') return chip('neutral', state);
  return chip('sky', state);
}

function stageChip(signalClass: string) {
  if (signalClass === 'active_solicitation') return chip('fail', 'Out now');
  if (signalClass === 'recompete_window') return chip('blocked', 'Recompete');
  if (signalClass === 'shaping_target') return chip('sky', 'Shaping');
  return chip('neutral', signalClass);
}

export async function pipelineScreen(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const signalClass = text(ctx.url, 'class');
  const band = text(ctx.url, 'band');
  const rawView = text(ctx.url, 'view');
  const view = (VIEWS as readonly string[]).includes(rawView) ? rawView : 'open';
  const rawSort = text(ctx.url, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort) ? rawSort : 'due';
  const principal = ctx.user?.principalName ?? '';

  const [result, counts] = await Promise.all([
    pipelineRows(search, signalClass, band, view, principal, sort, PAGE_SIZE, offset(ctx.url)),
    pipelineCounts(principal),
  ]);

  const link = (param: string, value: string, label: string, current: string) => {
    const url = new URL(ctx.url);
    url.searchParams.delete('page');
    if (value) url.searchParams.set(param, value);
    else url.searchParams.delete(param);
    const isCurrent = current === value;
    return html`<a
      class="button quiet"
      href="${url.pathname}${url.search}"
      style="${isCurrent ? 'border-color:var(--astrion-sky);color:var(--alabaster)' : ''}"
      >${label}</a
    >`;
  };

  const viewLinks = html`<div class="search">
    ${link('view', 'open', `Open (${count(counts.open)})`, view)}
    ${link('view', 'mine', `Mine (${count(counts.mine)})`, view)}
    ${link('view', 'unclaimed', `Unclaimed (${count(counts.unclaimed)})`, view)}
    ${link('view', 'due', `Due (${count(counts.due_45)})`, view)}
    ${link('view', 'snoozed', `Snoozed (${count(counts.snoozed)})`, view)}
    ${link('view', 'closed', 'Closed', view)}
  </div>`;

  const refineLinks = html`<div class="search">
    <span class="clear">Stage</span>
    ${link('class', '', 'Any', signalClass)}
    ${link('class', 'active_solicitation', 'Out now', signalClass)}
    ${link('class', 'recompete_window', 'Recompete', signalClass)}
    ${link('class', 'shaping_target', 'Shaping', signalClass)}
    <span class="clear">Band</span>
    ${link('band', '', 'Any', band)}
    ${link('band', 'pursue', 'Pursue', band)}
    ${link('band', 'review', 'Review', band)}
    <span class="clear">Sort</span>
    ${link('sort', 'due', 'Due date', sort)}
    ${link('sort', 'fit', 'Fit', sort)}
    ${link('sort', 'value', 'Value', sort)}
  </div>`;

  const body = html`
    ${viewLinks}
    ${searchForm('/pipeline', [
      { name: 'q', placeholder: 'Title, solicitation, PIID or agency', value: search },
    ])}
    ${refineLinks}
    ${table({
      columns: [
        { header: 'Stage', cell: (r) => stageChip(r.signal_class) },
        { header: 'Fit', cell: (r) => bandChip(r.band) },
        {
          header: 'Opportunity',
          cell: (r) =>
            html`<a href="/pursuits/${r.pursuit_id}">${truncate(r.title, 58)}</a>
              <span class="sub"
                >${r.solicitation_number
                  ? html`<code>${r.solicitation_number}</code>`
                  : r.related_piid
                    ? html`<code>${r.related_piid}</code>`
                    : ''}
                ${Number(r.note_count) > 0 ? html` · ${r.note_count} note(s)` : ''}</span
              >`,
        },
        {
          header: 'Due',
          cell: (r) =>
            r.due_date === null
              ? ABSENT
              : html`${day(r.due_date)}
                  <span class="sub"
                    >${r.response_date !== null ? 'responses due' : 'contract ends'}</span
                  >`,
        },
        { header: 'Value', align: 'num', cell: (r) => usd(r.estimated_value) },
        {
          header: 'Score',
          align: 'num',
          cell: (r) => (r.strategic_fit === null ? ABSENT : Number(r.strategic_fit).toFixed(0)),
        },
        { header: 'State', cell: (r) => stateChip(r.state) },
        {
          header: 'Owner',
          cell: (r) =>
            r.owner === null
              ? html`<span class="sub">unclaimed</span>`
              : truncate(r.owner, 24),
        },
        { header: 'Agency', cell: (r) => truncate(r.agency_label ?? r.agency_code, 24) },
      ],
      rows: result.rows,
      empty:
        search || signalClass || band
          ? html`<strong>Nothing matches this filter.</strong>`
          : view === 'mine'
            ? html`<strong>Nothing is assigned to you.</strong><br>
                Claim something from the unclaimed queue.`
            : html`<strong>This queue is empty.</strong><br>
                Signals arrive from <code>npm run signals</code> and
                <code>npm run load:sam</code>.`,
    })}
    ${pager({
      page: pageNumber(ctx.url),
      pageSize: PAGE_SIZE,
      total: result.total,
      baseQuery: baseQuery(ctx.url),
    })}
  `;

  return screen(ctx, {
    title: 'Pipeline',
    intro:
      'Every pursuit, soonest first. Snoozed work is hidden by default and one click away, ' +
      'because a queue you can only clear by dropping things is a queue that ends up empty ' +
      'for the wrong reason.',
    body,
    suppressEmptyNotice: true,
  });
}

/** The signed-in person's own queue. The same list with the view fixed. */
export async function myWork(ctx: Ctx): Promise<string> {
  if (ctx.user === null) {
    return screen(ctx, {
      title: 'My work',
      body: html`<div class="notice">
        <h3>Not signed in</h3>
        This deployment cannot say who you are, so it has no queue to show you and refuses
        to write. <code>docs/DEPLOY.md</code> covers turning on Microsoft Entra sign-in.
      </div>`,
      suppressEmptyNotice: true,
    });
  }

  const url = new URL(ctx.url);
  url.searchParams.set('view', 'mine');
  return pipelineScreen({ ...ctx, url });
}
