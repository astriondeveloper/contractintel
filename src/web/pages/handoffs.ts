/**
 * Hand-offs. Whether this tool is doing anything.
 *
 * One number on this screen matters and every other figure in the system could look healthy while
 * it stayed at zero: the count of requirements a person read here and carried into TechnoMile by
 * hand. Not sign-ins, not rows loaded, not notices matched. Those measure whether the machinery
 * runs. This measures whether it was any use.
 *
 * The second number is how far ahead of the deadline each hand-off happened. Being early is the
 * entire proposition, so a healthy count with a median of four days would mean the tool is
 * technically working and practically pointless, and it should be possible to see that from here
 * rather than from a conversation six months later.
 *
 * Kept deliberately plain. This is the screen somebody puts in front of leadership, and a screen
 * built to persuade is a screen nobody believes twice.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, table, tiles } from '../components.js';
import { ABSENT, count, day, moment, since, truncate, usd, usdCompact } from '../format.js';
import { handoffByWeek, handoffLog, handoffMetric } from '../queries.js';

export async function handoffs(ctx: Ctx): Promise<string> {
  const [metric, log, byWeek] = await Promise.all([
    handoffMetric(),
    handoffLog(60),
    handoffByWeek(12),
  ]);

  const busiestWeek = Math.max(1, ...byWeek.map((w) => w.n));

  const headline = tiles([
    {
      label: 'Sent to TechnoMile',
      value: count(metric.sent_all_time),
      foot: 'All time. The only measure of whether this earns its place',
    },
    {
      label: 'This fiscal year',
      value: count(metric.sent_this_fy),
      foot: `${count(metric.sent_last_30_days)} in the last 30 days`,
    },
    {
      label: 'People who have used it',
      value: count(metric.people_who_have_sent),
      foot: 'Distinct principals who have handed something off',
    },
    {
      label: 'Median lead over the deadline',
      value:
        metric.median_days_before_due === null
          ? ABSENT
          : `${count(metric.median_days_before_due)} days`,
      foot:
        metric.median_days_before_due === null
          ? 'No hand-off carried a response date'
          : 'Being early is the whole proposition',
    },
    {
      label: 'Value handed off',
      value: metric.value_sent_usd === null ? ABSENT : usdCompact(metric.value_sent_usd),
      foot:
        metric.sent_without_value === 0
          ? 'Every hand-off carried a figure'
          : `A floor: ${count(metric.sent_without_value)} carried no recorded value`,
    },
  ]);

  const weekCard = card({
    title: 'By week',
    hint: 'Last twelve weeks',
    body:
      byWeek.length === 0
        ? html`<div class="empty">Nothing has been handed off yet.</div>`
        : html`${byWeek.map(
            (week) => html`<div class="feed">
              <div class="top">
                <span class="headline">Week of ${day(week.week_starting)}</span>
                <span class="num">${count(week.n)}</span>
              </div>
              <div class="meter sky">
                <span style="width:${Math.round((week.n / busiestWeek) * 100)}%"></span>
              </div>
            </div>`,
          )}`,
  });

  const meaningCard = card({
    title: 'What this number is, and is not',
    plain: true,
    body: html`<p>
        A row is created when somebody presses <strong>Mark as sent to TechnoMile</strong> on a
        requirement. It is a claim by a person that they carried this across by hand, and it is the
        only outcome this system produces that anybody outside it can feel.
      </p>
      <p>
        It is not a pipeline, not a forecast of wins, and not a count of opportunities. Ownership,
        funnel state and win probability live in TechnoMile and stay there. If this number is low,
        the honest readings are that the feed is not surfacing the right things, that people are not
        logging in, or that the hand-off is still too much work. All three are fixable and none of
        them is fixed by changing what is counted here.
      </p>
      <p class="sub">
        Marking something sent is never undone by tracking or dismissing it. Undoing it is a
        separate action with its own audit row, so the count cannot quietly drift downwards.
      </p>`,
  });

  const logTable = table({
    columns: [
      { header: 'When', cell: (r) => html`${since(r.acted_at)}<span class="sub">${moment(r.acted_at)}</span>` },
      { header: 'Who', cell: (r) => truncate(r.display_name ?? r.principal_name, 28) },
      {
        header: 'What',
        cell: (r) =>
          html`<a href="/requirements/${r.pursuit_id}">${truncate(r.title, 64)}</a>
            ${r.note ? html`<span class="sub">${truncate(r.note, 90)}</span>` : ''}`,
      },
      { header: 'Value', align: 'num', cell: (r) => usd(r.estimated_value) },
      {
        header: 'Lead over the deadline',
        align: 'num',
        cell: (r) =>
          r.days_before_response_due === null
            ? ABSENT
            : html`${count(r.days_before_response_due)} days`,
      },
      {
        header: 'Surfaced by',
        cell: (r) =>
          r.surfaced_by === null
            ? html`<span class="sub">entered by hand</span>`
            : chip('neutral', r.surfaced_by),
      },
    ],
    rows: log,
    empty: html`<strong>Nothing has been handed off yet.</strong><br>
      Open a requirement from the <a href="/feed">feed</a>, use the hand-off panel, and mark it
      sent. Until somebody does that, this system has produced nothing.`,
  });

  const body = html`
    ${headline}
    ${cards([weekCard, meaningCard])}
    <div class="section">
      <div class="section-head">
        <h2>Every hand-off</h2>
        <div class="hint">Newest first, with who did it and how far ahead of the deadline</div>
      </div>
      ${logTable}
    </div>
  `;

  return screen(ctx, {
    title: 'Hand-offs',
    intro:
      'Requirements this tool fed into TechnoMile, counted. The one number that says whether any ' +
      'of the rest of this is worth keeping.',
    body,
    actions: html`<a class="button quiet" href="/feed">Back to the feed</a>`,
    suppressEmptyNotice: true,
  });
}

/** The same numbers as JSON, for a status check or a weekly note to leadership. */
export async function handoffsJson(): Promise<unknown> {
  const [metric, byWeek] = await Promise.all([handoffMetric(), handoffByWeek(26)]);
  return { metric, byWeek };
}
