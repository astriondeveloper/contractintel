/**
 * The twelve acceptance tests from specification section 18, run live.
 *
 * This is the same code `npm run accept` runs, against whatever database the interface
 * is pointed at. Two things follow from that and both are deliberate:
 *
 *   A blocked test is not a passing test. It gets its own colour and its own count,
 *   and the summary line never folds it into the pass number.
 *
 *   Each blocked test says what it is waiting for. That sentence is the roadmap, and
 *   it is generated from the state of the database rather than written down and left
 *   to go stale.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, section, tiles } from '../components.js';
import { count } from '../format.js';
import { runAcceptanceChecks, tally, type Result } from '../../acceptance/checks.js';

function statusChip(status: Result['status']) {
  if (status === 'PASS') return chip('pass', 'Pass');
  if (status === 'FAIL') return chip('fail', 'Fail');
  return chip('blocked', 'Blocked');
}

export async function acceptance(ctx: Ctx): Promise<string> {
  const results = await runAcceptanceChecks();
  const counted = tally(results);

  const body = html`
    ${tiles([
      { label: 'Pass', value: count(counted.passed), foot: `of ${counted.total}` },
      {
        label: 'Fail',
        value: count(counted.failed),
        foot: counted.failed === 0 ? 'Nothing is broken' : 'CI treats a fail as a broken build',
      },
      {
        label: 'Blocked',
        value: count(counted.blocked),
        foot: 'Each names what it waits for',
      },
    ])}
    ${counted.failed > 0
      ? html`<div class="notice alert">
          <h3>${count(counted.failed)} test(s) fail</h3>
          A FAIL is a real problem rather than an unbuilt feature. <code>npm run accept</code> exits
          non-zero on one, so CI fails the build too.
        </div>`
      : ''}
    ${section(
      'The twelve',
      html`${results.map(
        (result) => html`<div class="accept">
          <div>
            ${statusChip(result.status)}
            <div class="n">Test ${result.number}</div>
          </div>
          <div>
            <div class="title">${result.title}</div>
            <div class="detail">${result.detail}</div>
          </div>
        </div>`,
      )}`,
      'Specification section 18. Run live against this database',
    )}
  `;

  return screen(ctx, {
    title: 'Acceptance tests',
    intro:
      'Blocked is not passed. A blocked test names the prerequisite it is waiting for, so this screen ' +
      'doubles as the state of the build.',
    body,
    suppressEmptyNotice: true,
  });
}

/** The same twelve as JSON. */
export async function acceptanceJson(): Promise<unknown> {
  const results = await runAcceptanceChecks();
  return { ...tally(results), results };
}
