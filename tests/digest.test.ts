/**
 * The digest. src/digest/, and backlog item 9.
 *
 * Four properties, each one a way a digest fails in practice rather than in principle:
 *
 *   It is per person, so two people with different follows get different mail. A digest assembled
 *   once and sent to everybody is the failure that makes people stop reading it.
 *
 *   Nothing goes out when there is nothing. Most weeks in most patches are quiet, and a cheerful
 *   empty digest every Monday is how one gets filtered into a folder nobody opens.
 *
 *   The subject line carries the content. It is the only part most people read.
 *
 *   It never moves the read mark. A digest is a copy of the feed, not a visit, and emptying the
 *   screen somebody came to read is worse than not sending anything.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import { asHtml, asText, render, renderAll, subjectFor } from '../src/digest/digest.js';
import { performFollowAction, performPursuitAction, touchUser } from '../src/web/actions.js';
import { watermarkFor } from '../src/web/queries.js';
import type { User } from '../src/web/auth.js';

let client: PoolClient;

const PREFIX = 'ZDG';
const ALICE: User = { principalName: 'zdg-alice@example.test', displayName: 'Alice Adams', email: null };
const BOB: User = { principalName: 'zdg-bob@example.test', displayName: 'Bob Barnes', email: null };

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from audit_log where actor like 'zdg-%'`);
  await client.query(`delete from pursuit_action where principal_name like 'zdg-%'`);
  await client.query(`delete from follow where principal_name like 'zdg-%'`);
  await client.query(`delete from feed_watermark where principal_name like 'zdg-%'`);
  await client.query(`delete from pursuit where signal_key like '${PREFIX}%'`);
  await client.query(`delete from app_user where principal_name like 'zdg-%'`);
}

beforeEach(async () => {
  await cleanup();
  await touchUser(ALICE);
  await touchUser(BOB);
});

/**
 * Agency codes private to this file.
 *
 * Not '9700'. Several test files write requirements under the real-looking codes, and this file is
 * the only one that asserts a *count* of what a follow brings in rather than whether a particular
 * title is present. A shared code makes that count depend on which files ran first, which is how a
 * suite acquires a test that fails one run in eight for a reason nobody can find.
 */
const AGENCY_A = 'ZDGA';
const AGENCY_B = 'ZDGB';

interface Fixture {
  key: string;
  title?: string;
  agency?: string;
  office?: string;
  signalClass?: string;
  responseInDays?: number | null;
  value?: number | null;
  /**
   * How long ago this requirement landed. Set it on anything meant to predate a read mark.
   *
   * The insert and the `mark-read` run on two different pooled connections, each stamping its own
   * `now()`, so "inserted first" does not reliably mean "earlier" at microsecond resolution. Every
   * fixture meant to sit behind a mark says so in the data instead. Racing the clock is not what
   * these tests are about, and a test that passes seven runs in eight is worse than no test: it
   * teaches whoever hits the eighth to re-run rather than to look.
   */
  landedDaysAgo?: number;
}

async function requirement(fixture: Fixture): Promise<string> {
  const { rows } = await client.query<{ pursuit_id: string }>(
    `insert into pursuit (
       signal_class, title, agency_code, office_code, naics_code, response_date,
       estimated_value, signal_key, generated_by, generated_at, created_at
     ) values (
       $1, $2, $3, $4, '541330',
       case when $5::int is null then null else (current_date + $5::int) end,
       $6::numeric, $7, 'test', now(),
       now() - ($8 || ' days')::interval
     ) returning pursuit_id::text`,
    [
      fixture.signalClass ?? 'active_solicitation',
      fixture.title ?? `${PREFIX} requirement ${fixture.key}`,
      fixture.agency ?? AGENCY_A,
      fixture.office ?? `${PREFIX}OFF`,
      fixture.responseInDays === undefined ? 30 : fixture.responseInDays,
      fixture.value === undefined ? 1_000_000 : fixture.value,
      `${PREFIX}${fixture.key}`,
      String(fixture.landedDaysAgo ?? 0),
    ],
  );
  return rows[0]!.pursuit_id;
}

const form = (values: Record<string, string> = {}) => new URLSearchParams(values);

async function followAgency(user: User, agency: string): Promise<void> {
  await performFollowAction('follow', form({ follow_type: 'agency', target: agency }), user);
}

/* ================================================================== subject */

describe('the subject line', () => {
  const item = (signalClass: string, office: string | null) => ({
    pursuitId: '1',
    title: 'x',
    signalClass,
    agency: 'AGENCY',
    office,
    estimatedValue: null,
    responseDate: null,
    periodEndDate: null,
    matchedBy: 'agency AGENCY',
    noticeUrl: null,
    firstSeenAt: new Date(),
  });

  it('names the count, the kind of work, and where it is', () => {
    const subject = subjectFor(
      [
        item('recompete_window', 'EXAMPLE RANGE OPERATIONS'),
        item('recompete_window', 'EXAMPLE RANGE OPERATIONS'),
        item('shaping_target', 'EXAMPLE RANGE OPERATIONS'),
      ],
      3,
    );
    expect(subject).toBe('3 new in your patch: 2 recompetes and 1 sources sought at EXAMPLE RANGE OPERATIONS');
  });

  it('counts the offices when the work is spread out rather than naming one', () => {
    const subject = subjectFor(
      [
        item('recompete_window', 'OFFICE A'),
        item('recompete_window', 'OFFICE B'),
        item('recompete_window', 'OFFICE C'),
        item('recompete_window', 'OFFICE D'),
      ],
      4,
    );
    expect(subject).toContain('across 4 offices');
  });

  it('says nothing when there is nothing', () => {
    expect(subjectFor([], 0)).toBe('');
  });

  it('reports the true total even when only some are named', () => {
    // The digest names five and counts the rest, so the subject has to carry the total rather than
    // the length of the list it was handed.
    const subject = subjectFor([item('recompete_window', 'OFFICE A')], 23);
    expect(subject).toMatch(/^23 new/);
  });

  it('uses a singular where there is one', () => {
    expect(subjectFor([item('recompete_window', 'OFFICE A')], 1)).toBe(
      '1 new in your patch: 1 recompete at OFFICE A',
    );
  });
});

/* ================================================================ rendering */

describe('what gets sent', () => {
  it('sends nothing to somebody who follows nothing', async () => {
    await requirement({ key: 'N1' });
    // Nothing personal to send, and the right nudge for them is a colleague rather than mail from a
    // system they have not set up.
    expect(await render(client, ALICE.principalName)).toBeNull();
  });

  it('sends nothing when the patch has been quiet', async () => {
    await followAgency(ALICE, AGENCY_A);
    // Every requirement predates the read mark.
    await requirement({ key: 'N2', landedDaysAgo: 1 });
    await performFollowAction('mark-read', form(), ALICE);

    expect(await render(client, ALICE.principalName)).toBeNull();
  });

  it('sends nothing to somebody who does not exist', async () => {
    expect(await render(client, 'nobody@example.test')).toBeNull();
  });

  it('carries what is new since the read mark, and nothing older', async () => {
    await followAgency(ALICE, AGENCY_A);
    // A day old, so it is unambiguously on the far side of the mark rather than a microsecond away
    // from it.
    await requirement({ key: 'N3', title: `${PREFIX} old news`, landedDaysAgo: 1 });
    await performFollowAction('mark-read', form(), ALICE);
    await requirement({ key: 'N4', title: `${PREFIX} fresh` });

    const digest = await render(client, ALICE.principalName);
    expect(digest).not.toBeNull();
    expect(digest!.newCount).toBe(1);
    expect(digest!.items[0]!.title).toContain('fresh');
  });

  it('gives two people with different follows different mail', async () => {
    await followAgency(ALICE, AGENCY_A);
    await followAgency(BOB, AGENCY_B);
    await requirement({ key: 'N5', agency: AGENCY_A, title: `${PREFIX} for alice` });
    await requirement({ key: 'N6', agency: AGENCY_B, title: `${PREFIX} for bob` });

    const forAlice = await render(client, ALICE.principalName);
    const forBob = await render(client, BOB.principalName);

    expect(forAlice!.items.map((i) => i.title).join()).toContain('for alice');
    expect(forAlice!.items.map((i) => i.title).join()).not.toContain('for bob');
    expect(forBob!.items.map((i) => i.title).join()).toContain('for bob');
    expect(forBob!.items.map((i) => i.title).join()).not.toContain('for alice');
  });

  it('leaves out what the person dismissed', async () => {
    await followAgency(ALICE, AGENCY_A);
    const id = await requirement({ key: 'N7', title: `${PREFIX} not mine` });
    await performPursuitAction('dismiss', id, form(), ALICE);

    // Dismissing is the one instruction the person gave, and mailing it back to them ignores it.
    expect(await render(client, ALICE.principalName)).toBeNull();
  });

  it('names a few and counts the rest', async () => {
    await followAgency(ALICE, AGENCY_A);
    for (let i = 0; i < 9; i += 1) await requirement({ key: `M${i}` });

    const digest = await render(client, ALICE.principalName, { namedItems: 4 });
    expect(digest!.newCount).toBe(9);
    expect(digest!.items).toHaveLength(4);
    expect(digest!.remainder).toBe(5);
    expect(digest!.text).toContain('and 5 more in your patch');
  });

  it('says why each requirement is in the digest', async () => {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'W1' });

    const digest = await render(client, ALICE.principalName);
    expect(digest!.items[0]!.matchedBy).toContain('agency');
    expect(digest!.text).toContain('followed because:');
  });

  it('raises something the person is tracking whose deadline is close', async () => {
    await followAgency(ALICE, AGENCY_A);
    const soon = await requirement({
      key: 'T1', title: `${PREFIX} closes soon`, responseInDays: 10, landedDaysAgo: 1,
    });
    await performPursuitAction('track', soon, form(), ALICE);
    await performFollowAction('mark-read', form(), ALICE);

    // Nothing new, but a deadline is close, so there is still something to say.
    const digest = await render(client, ALICE.principalName);
    expect(digest).not.toBeNull();
    expect(digest!.newCount).toBe(0);
    expect(digest!.closingSoon.map((i) => i.title).join()).toContain('closes soon');
    expect(digest!.subject).toMatch(/closes soon/);
  });

  it('stops raising something once it has been handed off', async () => {
    await followAgency(ALICE, AGENCY_A);
    const soon = await requirement({ key: 'T2', responseInDays: 10, landedDaysAgo: 1 });
    await performPursuitAction('track', soon, form(), ALICE);
    await performPursuitAction('sent', soon, form(), ALICE);
    await performFollowAction('mark-read', form(), ALICE);

    // It is in TechnoMile now. Chasing it there is not this tool's job.
    expect(await render(client, ALICE.principalName)).toBeNull();
  });

  it('does not treat the forecast on its own as news', async () => {
    // The forecast is the same two quarters it was last week. Sending it weekly is how a digest
    // becomes wallpaper.
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'F1', landedDaysAgo: 1 });
    await performFollowAction('mark-read', form(), ALICE);
    expect(await render(client, ALICE.principalName)).toBeNull();
  });
});

/* ================================================================ watermark */

describe('the read mark', () => {
  it('is not moved by rendering a digest', async () => {
    await followAgency(ALICE, AGENCY_A);
    await performFollowAction('mark-read', form(), ALICE);
    const before = await watermarkFor(ALICE.principalName);

    await requirement({ key: 'X1' });
    const digest = await render(client, ALICE.principalName);
    expect(digest).not.toBeNull();

    const after = await watermarkFor(ALICE.principalName);
    expect(new Date(after.seen_through).getTime()).toBe(new Date(before.seen_through).getTime());
    expect(digest!.text).toContain('nothing here is marked as read');
  });

  it('falls back to a window for somebody who has never marked it read', async () => {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'X2' });

    const digest = await render(client, ALICE.principalName, { windowDays: 3 });
    const daysBack = (Date.now() - digest!.since.getTime()) / 86_400_000;
    expect(daysBack).toBeGreaterThan(2.5);
    expect(daysBack).toBeLessThan(3.5);
  });
});

/* ================================================================ renderers */

describe('the rendered digest', () => {
  async function oneDigest() {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'R1', title: `${PREFIX} thing`, value: 2_500_000, responseInDays: 40 });
    return (await render(client, ALICE.principalName, { baseUrl: 'https://cie.example.test' }))!;
  }

  it('puts an absolute link on every requirement when a base URL is given', async () => {
    const digest = await oneDigest();
    expect(digest.text).toContain('https://cie.example.test/requirements/');
    expect(digest.html).toContain('https://cie.example.test/requirements/');
  });

  it('says so when it has no base URL, rather than shipping broken links', async () => {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'R2' });
    const digest = await render(client, ALICE.principalName);
    expect(digest!.text).toContain('no base URL was configured');
  });

  it('says value not recorded rather than showing a zero', async () => {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'R3', value: null });
    const digest = await render(client, ALICE.principalName);
    expect(digest!.text).toContain('value not recorded');
    expect(digest!.text).not.toMatch(/\$0\b/);
  });

  it('escapes a title that carries markup', async () => {
    // Vendor and notice titles arrive from a file and a public API. An unescaped one in an HTML
    // email is an injection into somebody's inbox.
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'R4', title: `${PREFIX} <script>alert(1)</script> & "quotes"` });
    const digest = await render(client, ALICE.principalName);

    expect(digest!.html).not.toContain('<script>alert(1)</script>');
    expect(digest!.html).toContain('&lt;script&gt;');
    expect(digest!.html).toContain('&amp;');
  });

  it('renders text that stands on its own without the HTML', async () => {
    const digest = await oneDigest();
    expect(digest.text).toContain(digest.subject);
    expect(digest.text).toContain(`${PREFIX} thing`);
    expect(digest.text).toContain('$2.5m');
    expect(digest.text).not.toContain('<');
  });

  it('renders HTML with inline styles, because a mail client strips a stylesheet', async () => {
    const digest = await oneDigest();
    expect(digest.html).toContain('style=');
    expect(digest.html).not.toContain('<link');
    expect(digest.html).not.toContain('class=');
  });

  it('renders on a light ground, because a dark email in a light inbox reads as phishing', async () => {
    const digest = await oneDigest();
    expect(digest.html).toContain('background:#ffffff');
  });

  it('renders the same shape through the exported renderers', async () => {
    const digest = await oneDigest();
    expect(asText(digest, 'https://cie.example.test')).toBe(digest.text);
    expect(asHtml(digest, 'https://cie.example.test')).toBe(digest.html);
  });
});

/* ================================================================= everybody */

describe('rendering for everybody', () => {
  it('leaves out the people with nothing to say', async () => {
    await followAgency(ALICE, AGENCY_A);
    await followAgency(BOB, AGENCY_B);
    await requirement({ key: 'A1', agency: AGENCY_A });

    const digests = await renderAll(client);
    const mine = digests.filter((d) => d.principalName.startsWith('zdg-'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.principalName).toBe(ALICE.principalName);
  });

  it('returns nothing when nobody has anything, so the caller sends no mail', async () => {
    await followAgency(ALICE, AGENCY_A);
    await requirement({ key: 'A2', landedDaysAgo: 1 });
    await performFollowAction('mark-read', form(), ALICE);

    const digests = (await renderAll(client)).filter((d) => d.principalName.startsWith('zdg-'));
    expect(digests).toHaveLength(0);
  });
});
