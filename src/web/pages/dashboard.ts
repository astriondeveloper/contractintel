/**
 * The dashboard. What is new in your patch, what is coming, and whether any of this is being used.
 *
 * Reworked from a pipeline dashboard, and the two things it stopped showing are the point. There is
 * no funnel, because funnel states live in TechnoMile. There is no unclaimed queue, because nothing
 * here is assigned to anybody. What replaced both is the same feed the feed screen reads and the
 * same forecast the forecast screen reads, so no card on this page can disagree with the screen it
 * links to.
 *
 * The hand-off tile is deliberately near the top rather than filed under a metrics heading. With
 * 20-odd occasional users the real risk to this tool is not that it surfaces the wrong things, it
 * is that nobody opens it; and the count of requirements somebody carried into TechnoMile is the
 * only figure on any screen that would notice.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { card, cards, chip, feed as feedList, liveStatus, tiles, type FeedItem } from '../components.js';
import { ABSENT, count, day, moment, since, truncate, usd, usdCompact } from '../format.js';
import {
  backtests,
  feed as feedQuery,
  feedCounts,
  followsFor,
  forecastQuarters,
  forecastState,
  feedFreshness,
  freshness,
  handoffMetric,
  recentActivity,
  requirementSummary,
  watermarkFor,
  type FeedRow,
} from '../queries.js';
import { bandChip, dueIn, positionChip, stageChip } from './feed.js';

function toFeed(rows: readonly FeedRow[]): FeedItem[] {
  return rows.map((row) => ({
    href: `/requirements/${row.pursuit_id}`,
    lead: row.is_new ? chip('sky', 'New') : stageChip(row.signal_class),
    headline: truncate(row.title, 62),
    figure: row.strategic_fit === null ? undefined : Number(row.strategic_fit).toFixed(0),
    meta: [
      row.agency_label ?? row.agency_code ?? 'agency unrecorded',
      dueIn(row.response_date ?? row.period_end_date, row.response_date === null ? 'end' : 'response'),
      row.estimated_value === null ? 'value unrecorded' : usd(row.estimated_value),
    ],
  }));
}

export async function dashboard(ctx: Ctx): Promise<string> {
  const principal = ctx.user?.principalName ?? '';
  const mark = await watermarkFor(principal);

  const [counts, follows, newest, tracked, quarters, state, runs, metric, activity, sources, summary, live] =
    await Promise.all([
      feedCounts(principal, mark.seen_through),
      principal === '' ? Promise.resolve([]) : followsFor(principal, mark.seen_through),
      feedQuery(principal, mark.seen_through, principal === '' ? 'everything' : 'new', '', '', '', 'newest', 8, 0),
      feedQuery(principal, mark.seen_through, 'tracked', '', '', '', 'due', 8, 0),
      forecastQuarters(principal, principal === '' ? 'everything' : 'patch', ''),
      forecastState(),
      backtests(1),
      handoffMetric(),
      recentActivity(12),
      freshness(),
      requirementSummary(),
      feedFreshness(),
    ]);

  const nextQuarters = quarters.slice(0, 6);
  const busiest = Math.max(1, ...nextQuarters.map((q) => q.items));
  const latestRun = runs[0];

  const headline = tiles([
    {
      label: 'New in your patch',
      value: count(counts.new_since),
      foot: mark.is_set ? `Since ${moment(mark.seen_through)}` : 'Last 14 days, no mark set yet',
      href: '/feed',
    },
    {
      label: 'In your patch',
      value: count(counts.in_patch),
      foot: `${count(counts.follows)} follow(s)`,
      href: '/follows',
    },
    { label: 'Tracked', value: count(counts.tracked), foot: 'You are watching these', href: '/feed?view=tracked' },
    {
      label: 'Sent to TechnoMile',
      value: count(metric.sent_all_time),
      foot:
        metric.median_days_before_due === null
          ? 'Across the team, all time'
          : `Median ${count(metric.median_days_before_due)} days ahead of the deadline`,
      href: '/handoffs',
    },
    {
      label: 'Projected next 6 quarters',
      value: count(nextQuarters.reduce((sum, q) => sum + q.items, 0)),
      foot: `${count(state.items)} projections in all`,
      href: '/forecast',
    },
    {
      label: 'Requirements loaded',
      value: count(summary.total),
      foot: `${count(summary.active_solicitation)} out now · ${count(summary.recompete_window)} recompete`,
      href: '/feed?view=everything',
    },
  ]);

  const newCard = card({
    title: principal === '' ? 'Newest requirements' : 'New in your patch',
    more: { href: '/feed', label: 'Open the feed' },
    body: feedList(
      toFeed(newest.rows),
      counts.follows === 0
        ? html`<strong>You are not following anything yet.</strong><br>
            <a href="/follows">Pick a capability area, an agency or a company</a> and this becomes
            your patch.`
        : html`<strong>Nothing new since ${moment(mark.seen_through)}.</strong><br>
            That is the normal state most days.`,
    ),
  });

  const trackedCard = card({
    title: 'What you are tracking',
    more: { href: '/feed?view=tracked', label: 'See all' },
    body: feedList(
      toFeed(tracked.rows),
      html`<strong>You are not tracking anything.</strong><br>
        Track something from the feed and it collects here.`,
    ),
  });

  const forecastCard = card({
    title: principal === '' ? 'What is coming, whole market' : 'What is coming in your patch',
    more: { href: '/forecast', label: 'Open the forecast' },
    body: feedList(
      nextQuarters.map((q) => ({
        href: `/forecast?fy=${q.projected_fy}&q=${q.projected_quarter}`,
        headline: q.quarter_label,
        figure: count(q.items),
        meta: [
          q.value_floor_usd === null ? 'no value recorded' : `${usdCompact(q.value_floor_usd)} floor`,
          `${count(q.high_confidence)} high confidence`,
          q.items_without_value > 0 ? `${count(q.items_without_value)} unpriced` : '',
        ].filter((m) => m !== ''),
        share: q.items / busiest,
        shareTone: 'sky' as const,
      })),
      html`<strong>Nothing is projected.</strong><br>
        Run <code>npm run forecast</code>. It needs the FPDS corpus, because every projection starts
        from a contract end date.`,
    ),
  });

  const followsCard = card({
    title: 'Your follows',
    more: { href: '/follows', label: 'Manage' },
    body: feedList(
      follows.map((f) => ({
        href: `/feed?view=patch&q=${encodeURIComponent(f.target)}`,
        lead: chip('neutral', f.follow_type),
        headline: truncate(f.label ?? f.target, 44),
        figure: count(f.matches),
        meta: [
          f.new_matches > 0 ? `${count(f.new_matches)} new` : 'nothing new',
          f.forecast_matches > 0 ? `${count(f.forecast_matches)} projected` : '',
        ].filter((m) => m !== ''),
      })),
      ctx.user === null
        ? html`<strong>Not signed in.</strong><br>Sign in to build a patch.`
        : html`<strong>No follows yet.</strong><br>
            <a href="/follows">Start with the capability areas closest to your work.</a>`,
    ),
  });

  const accuracyCard = card({
    title: 'How much to believe the forecast',
    hint: latestRun === undefined ? 'Never scored' : `Scored as of ${day(latestRun.as_of_date)}`,
    plain: true,
    body:
      latestRun === undefined
        ? html`<p>
            The forecast has never been scored against history, so its accuracy is unknown. That is
            the honest state of it. <code>npm run forecast:backtest -- --sweep 2021,2022,2023</code>
            recomputes it as it would have stood on each of those dates and checks it against what
            happened next.
          </p>`
        : html`<p>
              <strong>${count(latestRun.hits)} of ${count(latestRun.projected)}</strong> projections
              had a follow-on award land where they said it would, scoring as of
              ${day(latestRun.as_of_date)} with a ${count(latestRun.tolerance_days)}-day tolerance.
            </p>
            <p class="sub">
              High-confidence rows:
              ${latestRun.hit_rate_high === null
                ? ABSENT
                : `${(Number(latestRun.hit_rate_high) * 100).toFixed(0)}%`}.
              Low-confidence rows:
              ${latestRun.hit_rate_low === null
                ? ABSENT
                : `${(Number(latestRun.hit_rate_low) * 100).toFixed(0)}%`}.
              If those two are level, the confidence chip is decoration.
            </p>`,
  });

  const activityCard = card({
    title: 'What the team has been doing',
    hint: 'Every change, with who made it',
    body: feedList(
      activity.map((row) => ({
        href:
          row.object_type === 'pursuit' || row.object_type === 'pursuit_action'
            ? `/requirements/${row.object_key}`
            : undefined,
        headline: truncate(row.reason ?? `${row.action} ${row.object_type}`, 58),
        meta: [row.actor, since(row.occurred_at)],
      })),
      html`<strong>Nothing has been done yet.</strong><br>
        Following something, tracking a requirement or handing one off writes an audit row, and it
        appears here.`,
    ),
  });

  const sourceCard = card({
    title: 'Sources',
    hint: 'When each last landed',
    body: feedList(
      sources.map((row) => ({
        headline: row.source_system,
        lead: row.is_stale ? chip('blocked', 'Stale') : chip('pass', 'Fresh'),
        meta: [since(row.last_success_at)],
      })),
      html`<strong>No loader has run.</strong>`,
    ),
  });

  const body = html`
    ${liveStatus(live, since)}
    ${ctx.user !== null && counts.follows === 0
      ? html`<div class="notice info">
          <h3>Two minutes of setup and this becomes yours</h3>
          A feed is the union of what you follow. Until you follow something, every screen here shows
          the whole federal picture rather than your patch.
          <a href="/follows">Pick a few capability areas, agencies and offices.</a>
        </div>`
      : ''}
    ${metric.sent_all_time === 0
      ? html`<div class="notice">
          <h3>Nothing has been handed off to TechnoMile yet</h3>
          That count is the one measure of whether this tool is doing anything, and it is at zero.
          Everything else on this page can look healthy while it stays there.
          <a href="/handoffs">What the number means.</a>
        </div>`
      : ''}
    ${headline}
    ${cards([newCard, forecastCard, trackedCard, followsCard, accuracyCard, activityCard, sourceCard])}
  `;

  return screen(ctx, {
    title: 'Dashboard',
    intro:
      'What is new in your patch, what is coming, and whether any of it reached TechnoMile. Every ' +
      'card reads the same view the screen it links to reads, so they cannot disagree.',
    body,
    actions: html`<a class="button" href="/feed">Open the feed</a>
      <a class="button quiet" href="/follows">Manage follows</a>`,
    suppressEmptyNotice: false,
  });
}

/** The same numbers as JSON, for a scheduled digest or a status check. */
export async function dashboardJson(): Promise<unknown> {
  const mark = await watermarkFor('');
  const [counts, metric, state, summary] = await Promise.all([
    feedCounts('', mark.seen_through),
    handoffMetric(),
    forecastState(),
    requirementSummary(),
  ]);
  return { requirements: summary, feed: counts, handoffs: metric, forecast: state };
}
