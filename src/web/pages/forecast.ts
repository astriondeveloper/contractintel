/**
 * The forecast. What is coming in your patch, by quarter.
 *
 * The one screen here that makes a claim about the future, which makes it the most valuable and
 * the easiest to be quietly wrong about. Everything on it is arranged so a reader can tell how
 * much to believe it:
 *
 * **Every bar opens.** A quarter shows its volume and its value, and clicking it lists the
 * specific contracts behind it. A bar nobody can open is a picture rather than intelligence, and
 * a picture is what gets shown to leadership and then quoted back six months later.
 *
 * **The confidence band is on every row, and the weak rows are shown.** A quarter with four
 * low-confidence projections and a quarter with nothing in it are different facts. Hiding the
 * weak ones makes them look the same and makes the forecast look better than it is.
 *
 * **The value is labelled a floor.** Contracts with no recorded ceiling reach the volume of a
 * quarter and not its value, and each quarter says how many did that. A total that treated
 * unknown as zero would be wrong in the direction nobody checks.
 *
 * **The accuracy is on the screen, not in a log.** The backtest panel shows what the projection
 * scored against history, by confidence band. If the bands do not separate, the reader can see
 * that they do not separate, which is the only honest way to ship a confidence chip.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, pager, table, tiles } from '../components.js';
import { ABSENT, count, day, moment, percent, truncate, usd, usdCompact } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import {
  backtests,
  cadenceEvidence,
  forecastEvidence,
  forecastItem,
  forecastItems,
  forecastQuarters,
  forecastState,
} from '../queries.js';
import { positionChip } from './feed.js';

function confidenceChip(confidence: string): Html {
  if (confidence === 'high') return chip('pass', 'high');
  if (confidence === 'medium') return chip('blocked', 'medium');
  return chip('fail', 'low');
}

function leadSourceLabel(source: string): string {
  if (source === 'observed_notice_lag') return 'measured from this office';
  if (source === 'office_cadence') return 'inferred from its recompete rhythm';
  return 'an assumption, decision D13';
}

export async function forecast(ctx: Ctx): Promise<string> {
  const principal = ctx.user?.principalName ?? '';
  const scope = text(ctx.url, 'scope') === 'everything' || principal === '' ? 'everything' : 'patch';
  const confidence = ['high', 'medium', 'low'].includes(text(ctx.url, 'confidence'))
    ? text(ctx.url, 'confidence')
    : '';
  const fy = /^\d{4}$/.test(text(ctx.url, 'fy')) ? Number(text(ctx.url, 'fy')) : null;
  const quarter = /^[1-4]$/.test(text(ctx.url, 'q')) ? Number(text(ctx.url, 'q')) : null;

  const [quarters, state, runs, cadences, items] = await Promise.all([
    forecastQuarters(principal, scope, confidence),
    forecastState(),
    backtests(6),
    cadenceEvidence(12),
    forecastItems(principal, scope, fy, quarter, confidence, PAGE_SIZE, offset(ctx.url)),
  ]);

  const totalItems = quarters.reduce((sum, q) => sum + q.items, 0);
  const totalValue = quarters.reduce((sum, q) => sum + Number(q.value_floor_usd ?? 0), 0);
  const withoutValue = quarters.reduce((sum, q) => sum + q.items_without_value, 0);
  const busiest = Math.max(1, ...quarters.map((q) => q.items));
  const measured =
    state.by_lead_source.find((s) => s.lead_source === 'observed_notice_lag')?.n ?? 0;
  const inferred = state.by_lead_source.find((s) => s.lead_source === 'office_cadence')?.n ?? 0;
  const assumed = state.by_lead_source.find((s) => s.lead_source === 'default')?.n ?? 0;

  const link = (param: string, value: string, label: string, current: string) => {
    const url = new URL(ctx.url);
    url.searchParams.delete('page');
    if (value) url.searchParams.set(param, value);
    else url.searchParams.delete(param);
    return html`<a class="button quiet${current === value ? ' on' : ''}"
      href="${url.pathname}${url.search}"
      >${label}</a
    >`;
  };

  const quarterHref = (row: { projected_fy: number; projected_quarter: number }) => {
    const url = new URL(ctx.url);
    url.searchParams.set('fy', String(row.projected_fy));
    url.searchParams.set('q', String(row.projected_quarter));
    url.searchParams.delete('page');
    return `${url.pathname}${url.search}`;
  };

  const nowFy = new Date().getUTCMonth() + 1 >= 10
    ? new Date().getUTCFullYear() + 1
    : new Date().getUTCFullYear();

  /**
   * The bars.
   *
   * Stacked by confidence rather than shown as one block per quarter, because the composition is
   * the interesting part: eleven projections in a quarter of which one is high confidence is a
   * different quarter from eleven of which nine are.
   */
  const bars =
    quarters.length === 0
      ? html`<div class="empty">
          <strong>Nothing is projected.</strong><br>
          The forecast is a scheduled job rather than something a page load computes. Run
          <code>npm run forecast</code>. It needs the FPDS corpus loaded, because every projection
          starts from a contract end date.
        </div>`
      : html`<div class="quarters">
          ${quarters.map((q) => {
            const isPast = q.projected_fy < nowFy;
            return html`<a class="quarter${isPast ? ' past' : ''}" href="${quarterHref(q)}">
              <div class="bar-frame" title="${q.items} projection(s)">
                <span class="bar high" style="height:${(q.high_confidence / busiest) * 100}%"></span>
                <span class="bar medium" style="height:${(q.medium_confidence / busiest) * 100}%"></span>
                <span class="bar low" style="height:${(q.low_confidence / busiest) * 100}%"></span>
              </div>
              <div class="quarter-label">${q.quarter_label}</div>
              <div class="quarter-figure">${count(q.items)}</div>
              <div class="quarter-value">
                ${q.value_floor_usd === null ? ABSENT : usdCompact(q.value_floor_usd)}
              </div>
              ${q.items_without_value > 0
                ? html`<div class="quarter-caveat">+${q.items_without_value} unpriced</div>`
                : ''}
            </a>`;
          })}
        </div>`;

  const headline = tiles([
    {
      label: scope === 'patch' ? 'Projected in your patch' : 'Projected, whole market',
      value: count(totalItems),
      foot: `${count(quarters.length)} quarter(s) with something in them`,
    },
    {
      label: 'Value floor',
      value: totalValue === 0 ? ABSENT : usdCompact(totalValue),
      foot:
        withoutValue === 0
          ? 'Every projection carries a figure'
          : `A floor: ${count(withoutValue)} projection(s) carry no recorded value`,
    },
    {
      label: 'Resting on a measurement',
      value: `${count(measured + inferred)}`,
      foot: `${count(measured)} measured, ${count(inferred)} inferred, ${count(assumed)} assumed`,
    },
    {
      label: 'Last projected',
      value: state.generated_at === null ? ABSENT : moment(state.generated_at),
      foot: `${count(state.offices_with_cadence)} office(s) have a learned rhythm`,
    },
  ]);

  const itemTable = table({
    columns: [
      { header: 'Confidence', cell: (r) => confidenceChip(r.confidence) },
      {
        header: 'What',
        cell: (r) =>
          html`<a href="/forecast/${r.forecast_id}">${truncate(r.title, 64)}</a>
            <span class="sub"
              >${r.basis === 'vehicle_expiry' ? 'vehicle on-ramp' : 'contract recompete'}
              ${r.incumbent_name ? html` · held by ${truncate(r.incumbent_name, 34)}` : ''}</span
            >`,
      },
      {
        header: 'Expected',
        cell: (r) =>
          html`${r.quarter_label}
            <span class="sub">${day(r.projected_solicitation_date)}</span>`,
      },
      {
        header: 'Because',
        cell: (r) =>
          html`ends ${day(r.period_end_date)}
            <span class="sub">less ${count(r.lead_days)} days, ${leadSourceLabel(r.lead_source)}</span>`,
      },
      { header: 'Value', align: 'num', cell: (r) => usd(r.estimated_value) },
      { header: 'Position', cell: (r) => positionChip(r.astrion_position) },
      {
        header: 'Office',
        cell: (r) =>
          html`${truncate(r.agency_label ?? r.agency_code, 26)}
            ${r.office_code ? html`<span class="sub"><code>${r.office_code}</code></span>` : ''}`,
      },
      {
        header: 'Status',
        cell: (r) =>
          r.pursuit_id !== null
            ? html`<a href="/requirements/${r.pursuit_id}">It has arrived</a>`
            : html`<span class="sub">not yet seen</span>`,
      },
    ],
    rows: items.rows,
    empty:
      fy !== null
        ? html`<strong>Nothing projected in that quarter.</strong>`
        : html`<strong>Nothing projected.</strong><br>Run <code>npm run forecast</code>.`,
  });

  const latest = runs[0];
  const accuracyCard = card({
    title: 'How accurate has this been',
    hint: latest === undefined ? 'Never scored' : `Scored as of ${day(latest.as_of_date)}`,
    plain: true,
    body:
      latest === undefined
        ? html`<p>
              The forecast has never been scored, so nothing on this screen has a known accuracy.
              That is the honest state of it and not a missing feature: scoring needs history on
              both sides of an as-of date.
            </p>
            <p>
              <code>npm run forecast:backtest -- --sweep 2021,2022,2023</code> recomputes the
              projection as it would have stood on each of those dates, using only what was
              knowable then, and checks it against what the corpus says happened next.
            </p>`
        : html`<p>
              As of <strong>${day(latest.as_of_date)}</strong>, projecting
              ${count(latest.horizon_months)} months out with a ${count(latest.tolerance_days)}-day
              tolerance: <strong>${count(latest.hits)} of ${count(latest.projected)}</strong>
              projections had a follow-on award land where they said it would
              (${latest.hit_rate === null ? ABSENT : percent(Number(latest.hit_rate), 1)}).
              ${latest.unforecast === null || latest.unforecast === 0
                ? ''
                : html`${count(latest.unforecast)} recompete(s) happened in that window that this
                    method had no candidate for.`}
            </p>
            ${table({
              columns: [
                { header: 'Band', cell: (r) => r.band },
                { header: 'Hit rate', align: 'num', cell: (r) => r.rate },
              ],
              rows: [
                { band: 'high', rate: latest.hit_rate_high === null ? ABSENT : percent(Number(latest.hit_rate_high), 1) },
                { band: 'medium', rate: latest.hit_rate_medium === null ? ABSENT : percent(Number(latest.hit_rate_medium), 1) },
                { band: 'low', rate: latest.hit_rate_low === null ? ABSENT : percent(Number(latest.hit_rate_low), 1) },
              ],
              empty: html``,
            })}
            <p class="sub">${latest.notes ?? ''}</p>
            <p class="sub">${latest.method}</p>`,
  });

  const cadenceCard = card({
    title: 'Offices whose rhythm this has learned',
    hint: 'Strongest evidence first',
    body:
      cadences.length === 0
        ? html`<div class="empty">
            No office in the corpus has been seen re-letting the same kind of work, so every lead
            time on this screen is the 365-day assumption. That is the expected state on a corpus
            that does not reach back far enough, and every row says so.
          </div>`
        : html`${cadences.map(
            (c) => html`<div class="feed">
              <div class="top">
                <span class="headline"
                  >${truncate(c.office_label ?? c.office_code, 38)} · ${c.psc_code}</span
                >
                <span class="num"
                  >${c.median_interval_days === null
                    ? ABSENT
                    : `${Math.round(c.median_interval_days / 30.44)} mo`}</span
                >
              </div>
              <div class="meta">
                <span>${count(c.chains_observed)} chain(s) observed</span>
                <span>${count(c.chains_across_vehicles)} across vehicles</span>
                <span>incumbent kept it ${count(c.chains_incumbent_retained)} time(s)</span>
              </div>
            </div>`,
          )}`,
  });

  const body = html`
    ${assumed > 0 && measured + inferred === 0
      ? html`<div class="notice">
          <h3>Every projection here rests on an assumption rather than a measurement</h3>
          No office in the corpus has enough observed history for a rhythm to be inferred, and
          SAM.gov has not been running long enough to measure a notice-to-award lag. The dates are
          contract end dates minus 365 days, which is decision D13. They are a starting point and
          the rows say so; the figure improves without any code changing as the corpus deepens.
        </div>`
      : ''}
    ${headline}
    <div class="search">
      ${principal === ''
        ? html`<span class="clear">Sign in to scope this to your patch</span>`
        : html`<span class="clear">Scope</span>
            ${link('scope', '', 'My patch', scope === 'patch' ? '' : 'everything')}
            ${link('scope', 'everything', 'Whole market', scope === 'patch' ? '' : 'everything')}`}
      <span class="clear">Confidence</span>
      ${link('confidence', '', 'Any', confidence)}
      ${link('confidence', 'high', 'High', confidence)}
      ${link('confidence', 'medium', 'Medium', confidence)}
      ${link('confidence', 'low', 'Low', confidence)}
      ${fy !== null
        ? html`<a class="clear" href="${clearQuarter(ctx)}">Clear the quarter filter</a>`
        : ''}
    </div>
    ${bars}
    <div class="section">
      <div class="section-head">
        <h2>
          ${fy === null
            ? 'Every projection'
            : `The contracts behind ${quarters.find((q) => q.projected_fy === fy && q.projected_quarter === quarter)?.quarter_label ?? 'that quarter'}`}
        </h2>
        <div class="hint">
          ${count(items.total)} projection(s). Each one opens its own evidence, including the
          evidence against it
        </div>
      </div>
      ${itemTable}
      ${pager({
        page: pageNumber(ctx.url),
        pageSize: PAGE_SIZE,
        total: items.total,
        baseQuery: baseQuery(ctx.url),
      })}
    </div>
    ${cards([accuracyCard, cadenceCard])}
  `;

  return screen(ctx, {
    title: 'Forecast',
    intro:
      (scope === 'patch'
        ? 'What is coming in your patch, by fiscal quarter. '
        : 'What is coming across the whole market, by fiscal quarter. ') +
      'A projection is a contract end date or a vehicle expiry minus a lead time. It is not a ' +
      'dollar forecast and not a win probability, and nothing here is a requirement until it ' +
      'appears in the feed.',
    body,
    actions: html`<a class="button quiet" href="/feed">Back to the feed</a>`,
    suppressEmptyNotice: true,
  });
}

function clearQuarter(ctx: Ctx): string {
  const url = new URL(ctx.url);
  url.searchParams.delete('fy');
  url.searchParams.delete('q');
  url.searchParams.delete('page');
  return `${url.pathname}${url.search}`;
}

/**
 * One projection, and the reasoning behind it.
 *
 * The same argument the pursuit screen makes about a score: a number nobody can open is a number
 * to be argued with rather than used. Contrary evidence comes first and is never hidden.
 */
export async function forecastDetail(ctx: Ctx, forecastId: string): Promise<string | null> {
  const record = await forecastItem(forecastId);
  if (record === null) return null;

  const evidence = await forecastEvidence(forecastId);
  const against = evidence.filter((e) => !e.supports);
  const supporting = evidence.filter((e) => e.supports);

  const summary = tiles([
    { label: 'Confidence', value: record.confidence, foot: `Lead time: ${leadSourceLabel(record.lead_source)}` },
    {
      label: 'Expected to solicit',
      value: record.quarter_label,
      foot: day(record.projected_solicitation_date),
    },
    {
      label: 'Current period ends',
      value: day(record.period_end_date),
      foot: `Less ${count(record.lead_days)} days of lead time`,
    },
    {
      label: 'Value',
      value: usd(record.estimated_value),
      foot:
        record.value_basis === null
          ? 'Nothing recorded. Blank is not zero'
          : record.value_basis === 'base_and_all_options'
            ? 'Base and all options'
            : record.value_basis === 'order_ceiling'
              ? 'Largest order ceiling under the vehicle'
              : 'Obligated to date',
    },
    {
      label: 'Recompete rhythm',
      value:
        record.cadence_median_days === null
          ? ABSENT
          : `${Math.round(record.cadence_median_days / 30.44)} mo`,
      foot:
        record.cadence_chains === null || record.cadence_chains === 0
          ? 'No chain observed in this office'
          : `From ${count(record.cadence_chains)} observed chain(s)`,
    },
    {
      label: 'Has it appeared',
      value: record.pursuit_id === null ? 'Not yet' : 'Yes',
      foot: record.pursuit_id === null ? 'Nothing detected for this contract' : 'Open the requirement',
      href: record.pursuit_id === null ? undefined : `/requirements/${record.pursuit_id}`,
    },
  ]);

  const evidenceTable = (rows: typeof evidence, empty: string) =>
    table({
      columns: [
        { header: 'Rule', cell: (r) => html`<code>${r.rule_id}</code>` },
        { header: 'What it says', cell: (r) => r.detail },
      ],
      rows,
      empty: html`<strong>${empty}</strong>`,
    });

  const body = html`
    ${summary}
    <div class="section">
      <div class="section-head">
        <h2>Evidence against this projection</h2>
        <div class="hint">Shown first and never hidden. Spec 14.2 makes the same argument about a score</div>
      </div>
      ${evidenceTable(against, 'Nothing argues against this projection.')}
    </div>
    <div class="section">
      <div class="section-head">
        <h2>Evidence for it</h2>
        <div class="hint">The arithmetic, and where each part of it came from</div>
      </div>
      ${evidenceTable(supporting, 'No supporting evidence recorded.')}
    </div>
    <div class="section">
      <div class="section-head">
        <h2>The contract</h2>
      </div>
      ${table({
        columns: [
          { header: 'Field', cell: (r) => r.label },
          { header: 'Value', cell: (r) => r.value },
        ],
        rows: [
          { label: 'Contract', value: record.related_piid ?? ABSENT },
          { label: 'Vehicle', value: record.idv_piid ?? ABSENT },
          { label: 'Agency', value: record.agency_label ?? record.agency_code ?? ABSENT },
          { label: 'Office', value: record.office_code ?? ABSENT },
          { label: 'NAICS', value: record.naics_code ?? ABSENT },
          { label: 'PSC', value: record.psc_code ?? ABSENT },
          { label: 'Incumbent', value: record.incumbent_name ?? ABSENT },
          { label: 'Our position', value: record.astrion_position ?? ABSENT },
          { label: 'Forecast key', value: record.forecast_key },
        ],
        empty: html``,
      })}
    </div>
  `;

  return screen(ctx, {
    title: truncate(record.title, 90),
    intro:
      `Projected to solicit in ${record.quarter_label}, from a period ending ` +
      `${day(record.period_end_date)} less ${record.lead_days} days of lead time ` +
      `(${leadSourceLabel(record.lead_source)}). A projection, not a requirement.`,
    body,
    actions: html`<a class="button quiet" href="/forecast">Back to the forecast</a>`,
    suppressEmptyNotice: true,
  });
}

/** The forecast as JSON, for a scheduled digest or a status check. */
export async function forecastJson(): Promise<unknown> {
  const [quarters, state, runs] = await Promise.all([
    forecastQuarters('', 'everything', ''),
    forecastState(),
    backtests(1),
  ]);
  return {
    generated_at: state.generated_at,
    items: state.items,
    lead_sources: state.by_lead_source,
    accuracy: runs[0] ?? null,
    quarters,
  };
}
