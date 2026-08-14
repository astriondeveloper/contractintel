/**
 * The review queue: everything the resolver would not decide on its own.
 *
 * Spec section 8 ends the resolution ladder with a queue rather than a guess. A name
 * that reaches the last rung without a confident match lands here instead of being
 * attached to whichever entity scored highest, because a wrong merge is expensive and
 * silent while an unresolved row is cheap and visible.
 *
 * This screen is read only. Working the queue writes to the corpus and needs the audit
 * trail spec section 20 describes, so it is a later phase rather than a button here.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, pager, searchForm, section, table, tiles } from '../components.js';
import { count, moment, orAbsent, truncate, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { mergeCandidates, reviewQueue } from '../queries.js';

export async function review(ctx: Ctx): Promise<string> {
  const state = text(ctx.url, 'state') || 'open';
  const filter = state === 'all' ? '' : state;

  const [queue, merges] = await Promise.all([
    reviewQueue(filter, PAGE_SIZE, offset(ctx.url)),
    mergeCandidates(),
  ]);

  const stateSelect = html`<select name="state" aria-label="Queue state">
    ${['open', 'resolved', 'dismissed', 'all'].map(
      (option) =>
        html`<option value="${option}"${state === option ? html` selected` : ''}>${option}</option>`,
    )}
  </select>`;

  const body = html`
    ${tiles([
      { label: 'Vendor names queued', value: count(queue.total), foot: `state: ${state}` },
      { label: 'Open merge candidates', value: count(merges.length) },
    ])}
    ${queue.total === 0 && merges.length === 0
      ? html`<div class="notice info">
          <h3>Nothing is waiting on a person</h3>
          The queue is empty and no merge candidate is open. Every name in the loaded corpus resolved
          without a judgement call.
        </div>`
      : ''}
    ${section(
      'Vendor names awaiting a decision',
      html`${searchForm('/review', [], stateSelect)}
        ${table({
          columns: [
            {
              header: 'Vendor name as filed',
              cell: (r) =>
                html`${truncate(r.vendor_name_raw, 52)}
                  ${r.vendor_name_normalized
                    ? html`<span class="sub"><code>${r.vendor_name_normalized}</code></span>`
                    : ''}`,
            },
            { header: 'UEI', cell: (r) => (r.uei_observed ? html`<code>${r.uei_observed}</code>` : ABSENT) },
            { header: 'CAGE', cell: (r) => (r.cage_observed ? html`<code>${r.cage_observed}</code>` : ABSENT) },
            { header: 'Source', cell: (r) => orAbsent(r.source_system) },
            {
              header: 'Reached',
              cell: (r) => (r.furthest_step ? chip('neutral', r.furthest_step) : ABSENT),
            },
            { header: 'Seen', align: 'num', cell: (r) => count(r.occurrence_count) },
            { header: 'Last seen', cell: (r) => moment(r.last_seen_at) },
            {
              header: 'State',
              cell: (r) =>
                r.state === 'open'
                  ? chip('blocked', r.state)
                  : r.state === 'resolved'
                    ? chip('pass', r.state)
                    : chip('neutral', r.state),
            },
          ],
          rows: queue.rows,
          empty: html`<strong>No row in state “${state}”.</strong><br>
            A name lands here when it reaches the end of the resolution ladder without a confident
            match. Spec section 8.`,
        })}
        ${pager({
          page: pageNumber(ctx.url),
          pageSize: PAGE_SIZE,
          total: queue.total,
          baseQuery: baseQuery(ctx.url),
        })}`,
      'The furthest rung of the ladder each name reached',
    )}
    ${section(
      'Merge candidates',
      table({
        columns: [
          { header: 'Entity A', cell: (r) => html`<a href="/entities/${r.entity_id_a}">${r.name_a}</a>` },
          { header: 'Entity B', cell: (r) => html`<a href="/entities/${r.entity_id_b}">${r.name_b}</a>` },
          { header: 'Basis', cell: (r) => (r.match_basis ? chip('neutral', r.match_basis) : ABSENT) },
          { header: 'Detail', cell: (r) => truncate(r.match_detail, 70) },
          { header: 'Raised', cell: (r) => moment(r.created_at) },
        ],
        rows: merges,
        empty: html`<strong>No merge candidate is open.</strong><br>
          A candidate is raised when two entities share an identifier or normalise to the same name.`,
      }),
      'Two entities the resolver suspects are one company',
    )}
  `;

  return screen(ctx, {
    title: 'Review queue',
    intro:
      'What the resolver refused to decide alone. Read only: working the queue writes to the corpus ' +
      'and needs the audit trail that spec section 20 describes, which is a later phase.',
    body,
    suppressEmptyNotice: true,
  });
}
