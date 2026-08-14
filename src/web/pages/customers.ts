/**
 * Customer organisations, from the DACIS customer export.
 *
 * These are the offices a campaign is eventually aimed at, so the acronym matters as
 * much as the full name: the acronym is what people search for.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { emptyBecauseNoData, pager, searchForm, table } from '../components.js';
import { orAbsent, truncate } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { customers as customerRows } from '../queries.js';

export async function customers(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const result = await customerRows(search, PAGE_SIZE, offset(ctx.url));

  const body = html`
    ${searchForm('/customers', [{ name: 'q', placeholder: 'Name, acronym or code', value: search }])}
    ${table({
      columns: [
        {
          header: 'Customer',
          cell: (r) =>
            html`${r.customer_name}
              ${r.description ? html`<span class="sub">${truncate(r.description, 110)}</span>` : ''}`,
        },
        { header: 'Acronym', cell: (r) => orAbsent(r.acronym) },
        { header: 'Code', cell: (r) => html`<code>${orAbsent(r.customer_code)}</code>` },
        {
          header: 'Location',
          cell: (r) => [r.city, r.state, r.country].filter(Boolean).join(', ') || '—',
        },
        {
          header: 'Source',
          cell: (r) => (r.dacis_url ? html`<a href="${r.dacis_url}" rel="noreferrer">DACIS</a>` : '—'),
        },
      ],
      rows: result.rows,
      empty: search
        ? html`<strong>No customer matches “${search}”.</strong>`
        : emptyBecauseNoData('customer organisations', 'npm run load -- --dir &lt;directory&gt;'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'Customers',
    intro: 'Customer organisations as the DACIS customer export describes them.',
    body,
  });
}
