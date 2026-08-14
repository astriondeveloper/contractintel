/**
 * Programs, from the DACIS program export.
 *
 * `participant_list_truncated` is the column to read first. Where it is true the
 * export gave a partial participant list, so an absence of a competitor on a program
 * is not evidence that the competitor is absent. Any later analysis that counts
 * participants has to exclude those rows or say it did not.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, pager, searchForm, table } from '../components.js';
import { count, orAbsent, truncate, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { programs as programRows } from '../queries.js';

export async function programs(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const result = await programRows(search, PAGE_SIZE, offset(ctx.url));

  const body = html`
    ${searchForm('/programs', [{ name: 'q', placeholder: 'Program name', value: search }])}
    ${table({
      columns: [
        {
          header: 'Program',
          cell: (r) =>
            html`${r.program_name}
              ${r.description ? html`<span class="sub">${truncate(r.description, 110)}</span>` : ''}`,
        },
        { header: 'Lifecycle', cell: (r) => (r.lifecycle_status ? chip('neutral', r.lifecycle_status) : ABSENT) },
        { header: 'Participants', align: 'num', cell: (r) => count(r.participants_supplied) },
        {
          header: 'List',
          cell: (r) =>
            r.participant_list_truncated ? chip('blocked', 'Truncated') : chip('pass', 'Complete'),
        },
        { header: 'Customers', align: 'num', cell: (r) => count(r.customer_count) },
        {
          header: 'Source',
          cell: (r) => (r.dacis_url ? html`<a href="${r.dacis_url}" rel="noreferrer">DACIS</a>` : ABSENT),
        },
      ],
      rows: result.rows,
      empty: search
        ? html`<strong>No program matches “${search}”.</strong>`
        : emptyBecauseNoData('programs', 'npm run load -- --dir &lt;directory&gt;'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'Programs',
    intro:
      'A truncated participant list means the export gave a partial roster. On those rows the absence ' +
      'of a company is not evidence that the company is absent.',
    body,
  });
}
