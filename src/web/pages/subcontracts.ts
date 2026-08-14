/**
 * Subcontract edges. Who sits under whom, and in which direction.
 *
 * The direction is the point. An edge where Astrion is the sub and an edge where
 * Astrion is the prime describe two different plays on the same counterparty, and the
 * watchlist screen reads this table to say which one the corpus actually shows.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { emptyBecauseNoData, pager, searchForm, table } from '../components.js';
import { day, orAbsent, truncate, usd } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { subcontracts as subcontractEdges } from '../queries.js';

export async function subcontracts(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const result = await subcontractEdges(search, PAGE_SIZE, offset(ctx.url));

  const party = (raw: string | null, entityId: string | null, canonical: string | null) =>
    html`${truncate(raw, 42)}
      ${entityId
        ? html`<span class="sub">→ <a href="/entities/${entityId}">${canonical}</a></span>`
        : html`<span class="sub">unplaced</span>`}`;

  const body = html`
    ${searchForm('/subcontracts', [
      { name: 'q', placeholder: 'Prime or sub name, award number, prime PIID', value: search },
    ])}
    ${table({
      columns: [
        { header: 'Prime', cell: (r) => party(r.prime_name_raw, r.prime_entity_id, r.prime_canonical) },
        { header: 'Sub', cell: (r) => party(r.sub_name_raw, r.sub_entity_id, r.sub_canonical) },
        { header: 'Value', align: 'num', cell: (r) => usd(r.value_usd) },
        { header: 'Awarded', cell: (r) => day(r.award_date) },
        {
          header: 'Award number',
          cell: (r) =>
            html`<code>${orAbsent(r.award_number)}</code>
              ${r.prime_piid ? html`<span class="sub">prime ${r.prime_piid}</span>` : ''}`,
        },
        { header: 'Agency', cell: (r) => truncate(r.agency_name, 30) },
        { header: 'Customer', cell: (r) => truncate(r.customer_name, 30) },
      ],
      rows: result.rows,
      empty: search
        ? html`<strong>No edge matches “${search}”.</strong>`
        : emptyBecauseNoData('subcontract edges', 'npm run load:subs -- --dir &lt;directory&gt;'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'Subcontract edges',
    intro:
      'One row per prime-to-sub relationship the corpus records. An unplaced party is a name the ' +
      'resolver could not tie to an entity; those are collected on the Data quality screen.',
    body,
  });
}
