/**
 * The feed. What is new on your follows since you last looked.
 *
 * This replaced a pipeline, and the difference is the whole point of the change. A pipeline has
 * a bottom, an owner per row and a state per row, which is the shape of a system of record.
 * TechnoMile is the system of record. What this is for is narrower: telling somebody a federal
 * requirement appeared in their patch before anyone else noticed it.
 *
 * Four things follow from that and each one is a decision rather than a layout.
 *
 * **Nothing is assigned.** There is no owner column and no unclaimed queue. With 20-odd people
 * checking occasionally, an owner column produces a list of things nobody has picked up, which
 * reads as a backlog and gets avoided.
 *
 * **New is measured against your own mark, and the mark only moves when you move it.** A feed
 * whose unread markers reset on refresh loses the item you were reading. The mark is a button.
 *
 * **Every row says why it is here.** A list nobody curated is only trusted if it can name the
 * follow that produced each item. `matched_by` is on every row for that reason.
 *
 * **Dismissing is not deleting.** A dismissed requirement leaves the feed and stays reachable
 * in one click, because a person who dismisses the wrong thing needs somewhere to look for it.
 */
import { html, type Html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, liveStatus, pager, searchForm, tiles } from '../components.js';
import { count, day, moment, since, truncate, usd, usdCompact } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import {
  feed as feedRows,
  feedCounts,
  feedFreshness,
  watermarkFor,
  type FeedRow,
  type FeedView,
} from '../queries.js';

const VIEWS: readonly FeedView[] = ['new', 'patch', 'tracked', 'sent', 'dismissed', 'everything'];
const SORTS = ['newest', 'due', 'fit', 'value'] as const;

export function stageChip(signalClass: string): Html {
  if (signalClass === 'active_solicitation') return chip('fail', 'Out now');
  if (signalClass === 'recompete_window') return chip('blocked', 'Recompete');
  if (signalClass === 'shaping_target') return chip('sky', 'Shaping');
  return chip('neutral', signalClass.replace(/_/g, ' '));
}

export function bandChip(band: string | null): Html {
  if (band === 'pursue') return chip('pass', 'Pursue');
  if (band === 'review') return chip('blocked', 'Review');
  if (band === 'pass') return chip('neutral', 'Pass');
  if (band === 'blocked') return chip('fail', 'Blocked');
  if (band === 'insufficient_evidence') return chip('sky', 'No rank');
  return html``;
}

export function positionChip(position: string | null): Html {
  if (position === 'prime_incumbent') return chip('pass', 'We hold it');
  if (position === 'subcontractor') return chip('sky', 'We sub on it');
  return html``;
}

/** A date said the way somebody would say it out loud. */
export function dueIn(date: Date | null, kind: 'response' | 'end'): string {
  if (date === null) return 'no date';
  const days = Math.round((new Date(date).getTime() - Date.now()) / 86_400_000);
  const noun = kind === 'response' ? 'responses due' : 'contract ends';
  if (days < 0) return `${noun} ${Math.abs(days)} days ago`;
  if (days === 0) return `${noun} today`;
  if (days === 1) return `${noun} tomorrow`;
  if (days <= 90) return `${noun} in ${days} days`;
  return `${noun} ${day(date)}`;
}

/**
 * One requirement, with the three actions on it.
 *
 * The buttons are form POSTs and not links. A link that changes something is a change a browser
 * will make on its own while prefetching, and every one of these writes an audit row.
 */
function row(item: FeedRow, ctx: Ctx, returnTo: string): Html {
  const post = (action: string) => `/requirements/${item.pursuit_id}/${action}`;
  const signedIn = ctx.user !== null;

  const actions = signedIn
    ? html`<div class="row-actions">
        <input type="checkbox" name="id" value="${item.pursuit_id}" aria-label="Select for export">
        ${item.tracked
          ? html`<form method="post" action="${post('clear')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit" title="Stop tracking">Tracking ✓</button>
            </form>`
          : html`<form method="post" action="${post('track')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Track</button>
            </form>`}
        ${item.dismissed
          ? html`<form method="post" action="${post('clear')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit" title="Put it back">Dismissed ✓</button>
            </form>`
          : html`<form method="post" action="${post('dismiss')}">
              <input type="hidden" name="back" value="${returnTo}">
              <button class="quiet" type="submit">Dismiss</button>
            </form>`}
        ${item.sent
          ? html`<span class="chip pass" title="Already carried into TechnoMile">Sent</span>`
          : html`<a class="button" href="/requirements/${item.pursuit_id}#handoff">Hand off</a>`}
      </div>`
    : html`<div class="row-actions">
        <span class="sub">sign in to track</span>
      </div>`;

  // The row's own state, on the element.
  //
  // The server does not read these: it filters in SQL, which is where filtering belongs when there is
  // a database and more rows than fit on a page. They exist for the static snapshot
  // (`scripts/build-demo.ts`), which has every row it renders already in the document and no server to
  // ask. Without them the snapshot's view tabs and filter chips are links to a query string that
  // nothing parses, so they all resolve to the same anchor and clicking one appears to do nothing.
  //
  // Kept in the real markup rather than injected by the demo builder, because a second copy of the
  // row's shape maintained in the build script would drift from this one silently.
  const flags = [
    item.is_new ? 'new' : '',
    item.follow_count > 0 ? 'patch' : '',
    item.tracked ? 'tracked' : '',
    item.dismissed ? 'dismissed' : '',
    item.sent ? 'sent' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const sortKey = (value: string | number | Date | null): string => {
    if (value === null) return '';
    if (value instanceof Date) return String(value.getTime());
    return String(value);
  };

  return html`<article class="item${item.is_new ? ' fresh' : ''}"
    data-views="${flags}"
    data-class="${item.signal_class}"
    data-position="${item.astrion_position ?? 'none'}"
    data-newest="${sortKey(item.first_seen_at)}"
    data-due="${sortKey(item.key_date)}"
    data-fit="${sortKey(item.strategic_fit)}"
    data-value="${sortKey(item.estimated_value)}">
    <div class="item-main">
      <div class="top">
        ${item.is_new ? chip('sky', 'New') : ''}
        ${stageChip(item.signal_class)}
        ${bandChip(item.band)}
        ${positionChip(item.astrion_position)}
        ${item.sent_by_anyone > 0 && !item.sent
          ? chip('pass', `sent by ${item.sent_by_anyone}`)
          : ''}
        <a class="headline" href="/requirements/${item.pursuit_id}">${truncate(item.title, 96)}</a>
      </div>
      <div class="meta">
        <span>${item.agency_label ?? item.agency_code ?? 'agency unrecorded'}</span>
        <span>${dueIn(item.response_date ?? item.period_end_date, item.response_date === null ? 'end' : 'response')}</span>
        <span>${item.estimated_value === null ? 'value unrecorded' : usd(item.estimated_value)}</span>
        ${item.solicitation_number
          ? html`<span><code>${item.solicitation_number}</code></span>`
          : item.related_piid
            ? html`<span><code>${item.related_piid}</code></span>`
            : ''}
        <span>landed ${since(item.first_seen_at)}</span>
      </div>
      <div class="why">Followed because: ${item.matched_by}</div>
    </div>
    ${actions}
  </article>`;
}

export async function feedScreen(ctx: Ctx): Promise<string> {
  const principal = ctx.user?.principalName ?? '';
  const search = text(ctx.url, 'q');
  const signalClass = text(ctx.url, 'class');
  const position = text(ctx.url, 'position');
  const rawSort = text(ctx.url, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort) ? rawSort : 'newest';
  const rawView = text(ctx.url, 'view');

  const mark = await watermarkFor(principal);
  const counts = await feedCounts(principal, mark.seen_through);
  // Above the tiles, because "is this live" comes before any number computed from it. A stale feed
  // with confident-looking counts is the failure mode this line exists to prevent.
  const live = await feedFreshness();

  // Somebody with no follows has an empty patch, so landing them on an empty "new" screen would
  // be the first and last thing they saw. They get the whole market instead, labelled as such,
  // with the follows screen one click away.
  const defaultView: FeedView = counts.follows === 0 ? 'everything' : 'new';
  const view = ((VIEWS as readonly string[]).includes(rawView) ? rawView : defaultView) as FeedView;

  const result = await feedRows(
    principal,
    mark.seen_through,
    view,
    search,
    signalClass,
    position,
    sort,
    PAGE_SIZE,
    offset(ctx.url),
  );

  const returnTo = `${ctx.url.pathname}${ctx.url.search}`;

  const link = (param: string, value: string, label: string, current: string) => {
    const url = new URL(ctx.url);
    url.searchParams.delete('page');
    // The clearing link keeps the parameter with an empty value rather than dropping it.
    //
    // Identical to the server, which reads an absent parameter and an empty one the same way. It
    // matters to the static snapshot: with the parameter dropped, the "Any" chip is a link to bare
    // /feed, indistinguishable from the rail's own Feed link, so the snapshot had no way to tell
    // "clear this filter" from "go to the feed" and the chip did nothing. `class=` says which filter
    // is being cleared.
    url.searchParams.set(param, value);
    return html`<a class="button quiet${current === value ? ' on' : ''}"
      href="${url.pathname}${url.search}"
      >${label}</a
    >`;
  };

  const headline = tiles([
    {
      label: 'New since you looked',
      value: count(counts.new_since),
      foot: mark.is_set
        ? `Your mark: ${moment(mark.seen_through)}`
        : `No mark yet, so this is the last 14 days`,
    },
    {
      label: 'In your patch',
      value: count(counts.in_patch),
      foot: `${count(counts.follows)} follow(s)`,
      href: '/follows',
    },
    { label: 'Tracked', value: count(counts.tracked), foot: 'Things you are watching' },
    {
      label: 'You sent to TechnoMile',
      value: count(counts.sent_all_time),
      foot: `${count(counts.sent_team_all_time)} across the team`,
      href: '/handoffs',
    },
  ]);

  const viewLinks = html`<div class="search">
    ${link('view', 'new', `New (${count(counts.new_since)})`, view)}
    ${link('view', 'patch', `My patch (${count(counts.in_patch)})`, view)}
    ${link('view', 'tracked', `Tracked (${count(counts.tracked)})`, view)}
    ${link('view', 'sent', `Sent (${count(counts.sent)})`, view)}
    ${link('view', 'dismissed', `Dismissed (${count(counts.dismissed)})`, view)}
    ${link('view', 'everything', `Everything (${count(counts.everything)})`, view)}
    ${ctx.user !== null && counts.new_since > 0
      ? html`<form method="post" action="/feed/mark-read" style="margin-left:auto">
          <input type="hidden" name="back" value="${returnTo}">
          <button class="quiet" type="submit">Mark all as read</button>
        </form>`
      : ''}
  </div>`;

  const refine = html`<div class="search">
    <span class="clear">Stage</span>
    ${link('class', '', 'Any', signalClass)}
    ${link('class', 'active_solicitation', 'Out now', signalClass)}
    ${link('class', 'recompete_window', 'Recompete', signalClass)}
    ${link('class', 'shaping_target', 'Shaping', signalClass)}
    <span class="clear">Position</span>
    ${link('position', '', 'Any', position)}
    ${link('position', 'prime_incumbent', 'We hold it', position)}
    ${link('position', 'subcontractor', 'We sub on it', position)}
    ${link('position', 'none', 'No position', position)}
    <span class="clear">Sort</span>
    ${link('sort', 'newest', 'Newest', sort)}
    ${link('sort', 'due', 'Soonest', sort)}
    ${link('sort', 'fit', 'Fit', sort)}
    ${link('sort', 'value', 'Value', sort)}
  </div>`;

  const emptyState = (): Html => {
    if (search !== '' || signalClass !== '' || position !== '') {
      return html`<div class="empty"><strong>Nothing matches this filter.</strong></div>`;
    }
    // Whether anything is loaded comes before whose patch it is in. Telling somebody who cannot
    // sign in to go and pick some follows is advice they cannot take, and on a fresh clone the
    // real answer is that the corpus is empty.
    if (counts.everything === 0) {
      return html`<div class="empty">
        <strong>No requirements are loaded, which is the expected state of a fresh clone.</strong><br>
        Three things fill this screen. <code>npm run profile</code> builds the codes to search for,
        then <code>npm run load:govcon</code> pulls open notices from GovCon API, and
        <code>npm run signals</code> finds contracts in the loaded corpus that end inside the
        recompete window. Check the key first with
        <code>npm run load:govcon -- --probe</code>; it spends one request and says whether the
        problem is the key, the plan or the network.
        <code>CONTRIBUTING.md</code> has the sequence.
      </div>`;
    }
    if (ctx.user === null) {
      return html`<div class="empty">
        <strong>This deployment cannot say who you are, so it has no patch to show you.</strong><br>
        Everything is readable through the <a href="${withView(ctx, 'everything')}">whole market</a>
        view. <code>docs/DEPLOY.md</code> covers turning on Microsoft Entra sign-in.
      </div>`;
    }
    if (counts.follows === 0) {
      return html`<div class="empty">
        <strong>You are not following anything yet, so you have no patch.</strong><br>
        A feed is the union of what you follow: capability areas, agencies and offices, companies,
        or a raw NAICS, PSC or keyword. <a href="/follows">Pick a few</a> and this becomes yours.
      </div>`;
    }
    if (view === 'new') {
      return html`<div class="empty">
        <strong>Nothing new in your patch since ${moment(mark.seen_through)}.</strong><br>
        That is the normal state most days. <a href="${withView(ctx, 'patch')}">See everything in
        your patch</a>, or widen it on the <a href="/follows">follows</a> screen.
      </div>`;
    }
    if (view === 'tracked') {
      return html`<div class="empty">
        <strong>You are not tracking anything.</strong><br>
        Track something from the feed and it collects here.
      </div>`;
    }
    if (view === 'sent') {
      return html`<div class="empty">
        <strong>You have not sent anything to TechnoMile from here yet.</strong><br>
        The hand-off panel on a requirement gives you the fields to paste, a written summary, the
        SAM.gov link and a spreadsheet export.
      </div>`;
    }
    if (view === 'dismissed') {
      return html`<div class="empty"><strong>You have not dismissed anything.</strong></div>`;
    }
    return html`<div class="empty">
      <strong>No requirements are loaded.</strong><br>
      They arrive from <code>npm run load:sam</code> and <code>npm run signals</code>.
    </div>`;
  };

  const body = html`
    ${liveStatus(live, since)}
    ${headline}
    ${counts.follows === 0 && ctx.user !== null
      ? html`<div class="notice info">
          <h3>This is the whole federal picture, not your patch</h3>
          You have no follows yet, so there is nothing to narrow it to.
          <a href="/follows">Follow a capability area, an agency, an office or a company</a> and the
          feed starts answering "what is new in my patch" instead of "what is new".
        </div>`
      : ''}
    ${viewLinks}
    ${searchForm('/feed', [
      { name: 'q', placeholder: 'Title, solicitation, PIID, code or company', value: search },
    ])}
    ${refine}
    ${view === 'everything' && counts.follows > 0
      ? html`<div class="notice">
          <h3>Showing everything, not just your patch</h3>
          Rows outside your follows say so where the reason would be. Useful for finding something
          worth following; the other views are scoped to you.
        </div>`
      : ''}
    ${result.rows.length === 0
      ? emptyState()
      : html`<form method="get" action="/export.csv">
          <div class="feed-list">${result.rows.map((item) => row(item, ctx, returnTo))}</div>
          <div class="bulk">
            <button type="submit">Export selected to a spreadsheet</button>
            <span class="sub"
              >Tick the rows you want. The file opens in Excel and carries the fields TechnoMile
              asks for.</span
            >
          </div>
        </form>`}
    ${pager({
      page: pageNumber(ctx.url),
      pageSize: PAGE_SIZE,
      total: result.total,
      baseQuery: baseQuery(ctx.url),
    })}
  `;

  return screen(ctx, {
    title: 'Feed',
    intro:
      view === 'everything' && counts.follows === 0
        ? 'Every federal requirement this system has found. Follow something and this narrows to your patch.'
        : 'What is new on your follows since you last looked. Nothing here is assigned to anybody: ' +
          'track what you want to keep an eye on, dismiss what is not yours, and hand off what you ' +
          'are taking into TechnoMile.',
    body,
    actions: html`<a class="button quiet" href="/follows">Manage follows</a>
      <a class="button quiet" href="/forecast">Forecast</a>`,
    suppressEmptyNotice: true,
    flash: flashFrom(ctx),
  });
}

function withView(ctx: Ctx, view: string): string {
  const url = new URL(ctx.url);
  url.searchParams.set('view', view);
  url.searchParams.delete('page');
  return `${url.pathname}${url.search}`;
}

/** The message a refused action redirected back with. */
export function flashFrom(ctx: Ctx): Html | undefined {
  const problem = text(ctx.url, 'problem');
  if (problem === '') return undefined;
  return html`<div class="notice alert"><h3>That did not work</h3>${problem}</div>`;
}

/** The same feed as JSON, for a scheduled digest. */
export async function feedJson(): Promise<unknown> {
  const mark = await watermarkFor('');
  const counts = await feedCounts('', mark.seen_through);
  const recent = await feedRows('', mark.seen_through, 'everything', '', '', '', 'newest', 25, 0);
  return {
    // Scoped to nobody, so this is the whole picture rather than one person's patch. A per-person
    // digest needs a per-person request, and the delivery mechanism for one does not exist yet:
    // in-app only, for now.
    scope: 'everything',
    counts: { total: counts.everything, sent_all_time: counts.sent_team_all_time },
    newest: recent.rows.map((r) => ({
      pursuit_id: r.pursuit_id,
      title: r.title,
      signal_class: r.signal_class,
      agency: r.agency_label ?? r.agency_code,
      response_date: r.response_date,
      estimated_value: r.estimated_value,
      first_seen_at: r.first_seen_at,
      notice_url: r.notice_url,
    })),
  };
}

/** Compact value for a tile, exported so the dashboard and the feed agree on the format. */
export const compactValue = usdCompact;
