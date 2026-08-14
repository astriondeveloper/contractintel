/**
 * DACIS contracts.
 *
 * `value_is_shared` is the column that changes an answer. Where it is true the value
 * covers several awardees, so summing the column across a set of contracts overstates
 * what any one company holds. The flag is a chip here rather than a footnote for that
 * reason: anything derived from contract value has to exclude or apportion these rows.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, pager, searchForm, table } from '../components.js';
import { count, day, orAbsent, truncate, usd, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { dacisContracts } from '../queries.js';

export async function dacis(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const result = await dacisContracts(search, PAGE_SIZE, offset(ctx.url));

  const body = html`
    ${searchForm('/dacis-contracts', [
      { name: 'q', placeholder: 'Title, contract number, solicitation or using activity', value: search },
    ])}
    ${table({
      columns: [
        {
          header: 'Contract',
          cell: (r) =>
            html`${truncate(r.title, 70)}
              <span class="sub"
                ><code>${orAbsent(r.contract_number)}</code>
                ${r.solicitation_number ? html` · sol ${r.solicitation_number}` : ''}</span
              >`,
        },
        {
          header: 'Value',
          align: 'num',
          cell: (r) =>
            html`${usd(r.value_usd)}${r.value_is_shared ? html`<span class="sub">shared</span>` : ''}`,
        },
        { header: 'Awarded', cell: (r) => day(r.award_date) },
        { header: 'Ends', cell: (r) => day(r.end_date) },
        { header: 'Using activity', cell: (r) => truncate(r.customer_using_activity, 34) },
        { header: 'Type', cell: (r) => truncate(r.contract_type_raw, 22) },
        { header: 'Roles', align: 'num', cell: (r) => count(r.role_count) },
        {
          header: 'Flags',
          cell: (r) =>
            html`${r.value_is_shared ? chip('blocked', 'Shared value') : ''}
              ${r.doge_canceled ? chip('fail', 'Cancelled') : ''}
              ${!r.value_is_shared && !r.doge_canceled ? ABSENT : ''}`,
        },
        {
          header: 'Source',
          cell: (r) => (r.dacis_url ? html`<a href="${r.dacis_url}" rel="noreferrer">DACIS</a>` : ABSENT),
        },
      ],
      rows: result.rows,
      empty: search
        ? html`<strong>No contract matches “${search}”.</strong>`
        : emptyBecauseNoData('DACIS contracts', 'npm run load -- --dir &lt;directory&gt;'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'DACIS contracts',
    intro:
      'Highest value first. A contract flagged Shared value has a value covering several awardees, ' +
      'so it cannot be summed as though one company holds it.',
    body,
  });
}
