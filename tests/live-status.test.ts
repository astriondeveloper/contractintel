/**
 * How live the feed says it is, and the relative-time helper it leans on.
 *
 * The interface could not previously distinguish three situations that look identical from a chair:
 * nothing matched your follows, no sync has ever run, and the API key is missing so no sync can run.
 * All three render as a feed that never changes, and for a tool whose premise is seeing a requirement
 * before anybody else that ambiguity is the difference between "quiet week" and "this has been broken
 * since Tuesday".
 *
 * So each state has to say which one it is *and* name the command that fixes it. These assert that,
 * because a status line that says "stale" without saying what to do is a status line that gets
 * ignored, and one that shows a stale feed as live is worse than having none.
 *
 * Pure functions, no database and no network.
 */
import { describe, it, expect } from 'vitest';
import { liveStatus, type LiveStatus } from '../src/web/components.js';
import { toString as htmlToString } from '../src/web/html.js';
import { since } from '../src/web/format.js';

/** The rendered line as plain text, so assertions read like the sentence a person sees. */
function render(status: Partial<LiveStatus>): string {
  const full: LiveStatus = {
    last_success_at: null,
    age_seconds: null,
    never_run: false,
    landed_today: 0,
    cursor_clamped: false,
    sources: [],
    ...status,
  };
  return htmlToString(liveStatus(full, since))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 3_600_000);

describe('when no sync has ever run', () => {
  const line = () => render({ never_run: true });

  it('says so rather than showing an age', () => {
    expect(line()).toContain('No opportunity sync has run yet');
  });

  it('names the probe first, because the key is the likeliest cause on a new deployment', () => {
    expect(line()).toContain('--probe');
  });

  it('says what the requirements on screen actually are, so the screen is not simply dismissed', () => {
    // There may well be rows: recompete detection finds them in the loaded corpus without any API.
    // Saying "nothing is live" without saying that would make a working screen look broken.
    expect(line()).toContain('npm run signals');
  });

  it('does not claim to be live', () => {
    expect(line()).not.toMatch(/\bLive\b/);
  });
});

describe('when the sync has stopped running', () => {
  const line = () => render({ last_success_at: hoursAgo(40), age_seconds: 40 * 3600 });

  it('reads as stale past a day and a bit', () => {
    expect(line()).toContain('last arrived');
    expect(line()).not.toMatch(/^Live/);
  });

  it('says it is the schedule and not the key, because those are different people', () => {
    expect(line()).toContain('rather than the key');
  });

  it('stays live at an age the hourly job would normally produce', () => {
    expect(render({ last_success_at: hoursAgo(2), age_seconds: 2 * 3600 })).toMatch(/^Live/);
  });

  it('is stale rather than live right after the threshold', () => {
    expect(render({ last_success_at: hoursAgo(27), age_seconds: 27 * 3600 })).not.toMatch(/^Live/);
  });
});

describe('when the last sync had a gap', () => {
  const line = () =>
    render({ last_success_at: hoursAgo(1), age_seconds: 3600, cursor_clamped: true });

  it('does not present a clamped run as simply live', () => {
    // The run succeeded and the records are correct, which is exactly why this needs saying: an
    // interval was fetched by nobody and nothing about the run looks wrong.
    expect(line()).toContain('had a gap');
  });

  it('names the backfill command with the argument it needs', () => {
    expect(line()).toContain('--backfill');
    expect(line()).toContain('--from');
  });

  it('still reports when it last ran, because the gap is not a total failure', () => {
    expect(line()).toContain('Live as of');
  });
});

describe('when it is live', () => {
  it('gives an age rather than the word live on its own', () => {
    // "Live" with no number is a claim. With a number it is a fact somebody can disagree with.
    const line = render({ last_success_at: hoursAgo(1), age_seconds: 3600, landed_today: 4 });
    expect(line).toMatch(/^Live/);
    expect(line).toContain('ago');
  });

  it('counts what arrived', () => {
    expect(render({ last_success_at: hoursAgo(1), age_seconds: 3600, landed_today: 4 })).toContain(
      '4 arrived in the last day',
    );
  });

  it('calls a quiet day ordinary rather than leaving a bare zero to look like a fault', () => {
    const line = render({ last_success_at: hoursAgo(1), age_seconds: 3600, landed_today: 0 });
    expect(line).toContain('ordinary day');
  });
});

describe('the relative time helper', () => {
  it('uses the singular for one', () => {
    // Surfaced by the status line, which read "last arrived 1 days ago" before this.
    //
    // 40 hours rather than 24, because the bands overlap on purpose: hours run to 36 before days take
    // over, so a day-old timestamp reads "28 hours ago" and the singular day is reachable between 36
    // and 47 hours. The overlap is the design — a unit changes once the smaller one stops being
    // readable — so the test has to ask at an hour the band actually covers.
    expect(since(hoursAgo(40))).toBe('1 day ago');
    expect(since(new Date(Date.now() - 90 * 60_000))).toBe('1 hour ago');
  });

  it('uses the plural for everything else', () => {
    expect(since(hoursAgo(60))).toBe('2 days ago');
    expect(since(new Date(Date.now() - 5 * 60_000))).toBe('5 minutes ago');
  });

  it('keeps the overlapping bands, so an hour-old timestamp is not rounded to a day', () => {
    expect(since(hoursAgo(24))).toBe('24 hours ago');
  });

  it('says just now inside a minute and a half', () => {
    expect(since(new Date(Date.now() - 30_000))).toBe('just now');
  });

  it('reports an absent date as absent rather than as the epoch', () => {
    expect(since(null)).not.toContain('ago');
  });
});
