/**
 * The dashboard. What business development should do today.
 *
 * This replaced an overview of the data foundation, and the difference is the point. The
 * old screen answered "what is loaded", which is a question the person who built the system
 * asks once a week. This one answers "what needs me", which is the question the person
 * using it asks every morning.
 *
 * So the first row of tiles is work, not row counts: what is overdue, what is due, what is
 * unclaimed, what is mine. The corpus figures still exist and are still true; they moved to
 * Data quality, where somebody looking for them will look.
 *
 * Nothing here is a new number. Every card reads `pipeline_item`, which is the same view the
 * pipeline screen reads, so the dashboard and the list cannot disagree about what is due.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, feed, tiles, type FeedItem } from '../components.js';
import { count, day, since, truncate, usd, usdCompact } from '../format.js';
import {
  freshness,
  pipeline,
  pipelineByAgency,
  pipelineByState,
  pipelineCounts,
  recentActivity,
} from '../queries.js';

const STATE_ORDER = ['open', 'qualifying', 'pursuing', 'submitted'];

function bandChip(band: string | null) {
  if (band === 'pursue') return chip('pass', 'Pursue');
  if (band === 'review') return chip('blocked', 'Review');
  if (band === 'pass') return chip('neutral', 'Pass');
  if (band === 'blocked') return chip('fail', 'Blocked');
  if (band === 'insufficient_evidence') return chip('sky', 'No rank');
  return chip('neutral', 'Unscored');
}

/** A due date, said the way a person would say it. */
function dueIn(date: Date | null): string {
  if (date === null) return 'no date';
  const days = Math.round((new Date(date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days <= 60) return `due in ${days} days`;
  return `due ${day(date)}`;
}

function toFeed(rows: readonly Awaited<ReturnType<typeof pipeline>>['rows'][number][]): FeedItem[] {
  return rows.map((row) => ({
    href: `/pursuits/${row.pursuit_id}`,
    lead: bandChip(row.band),
    headline: truncate(row.title, 64),
    figure: row.strategic_fit === null ? undefined : Number(row.strategic_fit).toFixed(0),
    meta: [
      dueIn(row.due_date),
      row.agency_label ?? row.agency_code ?? 'agency unknown',
      row.estimated_value === null ? 'value unknown' : usd(row.estimated_value),
      row.owner ? `owned by ${row.owner}` : 'unclaimed',
    ],
  }));
}

export async function dashboard(ctx: Ctx): Promise<string> {
  const principal = ctx.user?.principalName ?? '';

  const [counts, byState, byAgency, activity, sources, due, unclaimed, mine, best] =
    await Promise.all([
      pipelineCounts(principal),
      pipelineByState(),
      pipelineByAgency(),
      recentActivity(12),
      freshness(),
      pipeline('', '', '', 'due', principal, 'due', 8, 0),
      pipeline('', '', '', 'unclaimed', principal, 'fit', 8, 0),
      pipeline('', '', '', 'mine', principal, 'due', 8, 0),
      pipeline('', '', 'pursue', 'open', principal, 'fit', 8, 0),
    ]);

  const stateTotal = byState.reduce((sum, row) => sum + Number(row.n), 0);
  const agencyTotal = byAgency.reduce((sum, row) => sum + Number(row.n), 0);

  const headline = tiles([
    {
      label: 'Overdue',
      value: count(counts.overdue),
      foot: counts.overdue === 0 ? 'Nothing has slipped' : 'Past its response date',
      href: '/pipeline?view=due',
    },
    { label: 'Due in 45 days', value: count(counts.due_45), foot: 'Needs a decision soon', href: '/pipeline?view=due' },
    {
      label: 'Unclaimed',
      value: count(counts.unclaimed),
      foot: 'Nobody has picked these up',
      href: '/pipeline?view=unclaimed',
    },
    {
      label: ctx.user ? 'Mine' : 'Assigned',
      value: count(counts.mine),
      foot: ctx.user ? 'Open and owned by you' : 'Sign in to see your own',
      href: '/my-work',
    },
    { label: 'Pursuing', value: count(counts.pursuing), foot: 'Actively worked', href: '/pipeline' },
    {
      label: 'Open pipeline',
      value: usdCompact(counts.pipeline_value),
      foot: `${count(counts.open)} open · blank values excluded`,
    },
  ]);

  const funnel = card({
    title: 'Where the pipeline sits',
    hint: `${count(stateTotal)} open`,
    body: feed(
      STATE_ORDER.filter((state) => byState.some((row) => row.state === state)).map((state) => {
        const row = byState.find((r) => r.state === state)!;
        return {
          href: `/pipeline?state=${state}`,
          headline: state.replace(/^./, (c) => c.toUpperCase()),
          figure: count(row.n),
          meta: [row.value === null ? 'value unknown' : usdCompact(row.value)],
          share: stateTotal === 0 ? 0 : Number(row.n) / stateTotal,
        };
      }),
      html`<strong>Nothing in the pipeline.</strong><br>
        Run <code>npm run signals</code> and <code>npm run load:sam</code>.`,
    ),
  });

  const dueCard = card({
    title: 'Needs a decision',
    more: { href: '/pipeline?view=due', label: 'See all' },
    body: feed(
      toFeed(due.rows),
      html`<strong>Nothing is due in the next 45 days.</strong>`,
    ),
  });

  const unclaimedCard = card({
    title: 'Unclaimed, best fit first',
    more: { href: '/pipeline?view=unclaimed', label: 'See all' },
    body: feed(
      toFeed(unclaimed.rows),
      html`<strong>Everything open has an owner.</strong>`,
    ),
  });

  const mineCard = card({
    title: ctx.user ? 'Your work' : 'Owned work',
    more: { href: '/my-work', label: 'Open' },
    body: feed(
      toFeed(mine.rows),
      ctx.user
        ? html`<strong>Nothing is assigned to you.</strong><br>
            Claim something from the unclaimed queue.`
        : html`<strong>Not signed in.</strong><br>
            Sign in to claim work and see your own queue.`,
    ),
  });

  const bestCard = card({
    title: 'Best fit, unworked',
    hint: 'Band: pursue',
    body: feed(
      toFeed(best.rows),
      html`<strong>Nothing is banded as pursue.</strong><br>
        Run <code>npm run score</code>, or the bar in
        <code>signal_class_threshold</code> may be higher than anything scores.`,
    ),
  });

  const agencyCard = card({
    title: 'Where the work is',
    hint: 'Open pursuits by agency',
    body: feed(
      byAgency.map((row) => ({
        href: `/pipeline?q=${encodeURIComponent(row.agency_code)}`,
        headline: truncate(row.label ?? row.agency_code, 44),
        figure: count(row.n),
        meta: [row.value === null ? 'value unknown' : usdCompact(row.value)],
        share: agencyTotal === 0 ? 0 : Number(row.n) / agencyTotal,
        shareTone: 'sky' as const,
      })),
      html`<strong>No open pursuit carries an agency.</strong>`,
    ),
  });

  const activityCard = card({
    title: 'Team activity',
    hint: 'Every change, with who made it',
    body: feed(
      activity.map((row) => ({
        href: row.object_type === 'pursuit' ? `/pursuits/${row.object_key}` : undefined,
        headline: truncate(row.reason ?? `${row.action} ${row.object_type}`, 56),
        meta: [row.actor, since(row.occurred_at), truncate(row.title, 40)],
      })),
      html`<strong>Nothing has been changed yet.</strong><br>
        Claiming a pursuit or adding a note writes an audit row, and it appears here.`,
    ),
  });

  const sourceCard = card({
    title: 'Sources',
    hint: 'When each last landed',
    body: feed(
      sources.map((row) => ({
        headline: row.source_system,
        lead: row.is_stale ? chip('blocked', 'Stale') : chip('pass', 'Fresh'),
        meta: [since(row.last_success_at)],
      })),
      html`<strong>No loader has run.</strong>`,
    ),
  });

  const body = html`
    ${counts.unscored > 0
      ? html`<div class="notice">
          <h3>${count(counts.unscored)} open pursuit(s) carry no score</h3>
          Scoring is a scheduled job rather than something a page load does. Run
          <code>npm run score</code>. Until then they sort to the bottom of every
          fit-ordered list rather than being hidden.
        </div>`
      : ''}
    ${headline}
    ${cards([dueCard, unclaimedCard, mineCard, bestCard, funnel, agencyCard, activityCard, sourceCard])}
  `;

  return screen(ctx, {
    title: 'Dashboard',
    intro:
      'What needs a decision, what nobody has picked up, and what the team has been doing. ' +
      'Every card reads the same view the pipeline does, so they cannot disagree.',
    body,
    actions: html`<a class="button quiet" href="/pipeline">Open the pipeline</a>`,
    suppressEmptyNotice: false,
  });
}

/** The same numbers as JSON, for a scheduled digest or a status check. */
export async function dashboardJson(): Promise<unknown> {
  const counts = await pipelineCounts('');
  const [byState, byAgency] = await Promise.all([pipelineByState(), pipelineByAgency()]);
  return { counts, byState, byAgency };
}
