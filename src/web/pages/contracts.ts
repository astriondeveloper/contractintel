/**
 * Contract actions. The FPDS corpus, one row per action.
 *
 * Two columns carry a caveat worth knowing before reading the table. The transaction
 * number is blank on every row of the export (`docs/DECISIONS.md` D3), so some rows
 * carry a content-derived surrogate instead; and a blank obligation is blank, not zero.
 * Both are visible here rather than smoothed over.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, pager, searchForm, table } from '../components.js';
import { count, day, orAbsent, truncate, usd, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import { agencies, contractActions, entity } from '../queries.js';

export async function contracts(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const agency = text(ctx.url, 'agency');
  const entityId = /^\d{1,19}$/.test(text(ctx.url, 'entity')) ? text(ctx.url, 'entity') : '';

  const [result, agencyOptions, focus] = await Promise.all([
    contractActions(search, agency, entityId, PAGE_SIZE, offset(ctx.url)),
    agencies(),
    entityId ? entity(entityId) : Promise.resolve(null),
  ]);

  const agencySelect = html`<select name="agency" aria-label="Awarding agency">
    <option value=""${agency === '' ? html` selected` : ''}>Every agency</option>
    ${agencyOptions.map(
      (a) =>
        html`<option value="${a.awarding_agency_code}"${agency === a.awarding_agency_code ? html` selected` : ''}>
          ${a.label ?? a.awarding_agency_code} (${count(a.n)})
        </option>`,
    )}
  </select>`;

  const keepEntity = entityId ? html`<input type="hidden" name="entity" value="${entityId}">` : html``;

  const body = html`
    ${focus
      ? html`<div class="notice info">
          <h3>Filtered to ${focus.canonical_name}</h3>
          Every action that resolved to this entity, under any spelling.
          <a href="/contracts">Remove the filter</a>.
        </div>`
      : ''}
    ${searchForm(
      '/contracts',
      [{ name: 'q', placeholder: 'PIID, IDV PIID, vendor name or entity', value: search }],
      html`${agencySelect}${keepEntity}`,
    )}
    ${table({
      columns: [
        {
          header: 'PIID',
          cell: (r) =>
            html`<code>${orAbsent(r.piid)}</code>
              ${r.idv_piid ? html`<span class="sub">IDV ${r.idv_piid}</span>` : ''}`,
        },
        { header: 'Mod', cell: (r) => orAbsent(r.modification_number) },
        {
          header: 'Transaction',
          cell: (r) => (r.transaction_number ? html`<code>${r.transaction_number}</code>` : ABSENT),
        },
        { header: 'Signed', cell: (r) => day(r.signed_date) },
        { header: 'Ends', cell: (r) => day(r.ultimate_completion_date) },
        {
          header: 'Vendor as filed',
          cell: (r) =>
            html`${truncate(r.vendor_name_raw, 40)}
              ${r.entity_id
                ? html`<span class="sub"
                    >→ <a href="/entities/${r.entity_id}">${r.canonical_name}</a></span
                  >`
                : html`<span class="sub">unresolved</span>`}`,
        },
        { header: 'Agency', cell: (r) => truncate(r.agency_label ?? r.awarding_agency_code, 28) },
        { header: 'Obligation', align: 'num', cell: (r) => usd(r.action_obligation) },
        { header: 'Base + options', align: 'num', cell: (r) => usd(r.base_and_all_options) },
        {
          // The export packs the code and its label into one cell ("A: FULL AND OPEN
          // COMPETITION"). The label is the readable half, so the code prefix is dropped
          // here rather than truncating the sentence away from the far end.
          header: 'Competed',
          cell: (r) =>
            r.extent_competed
              ? chip('neutral', truncate(r.extent_competed.replace(/^[A-Z0-9]{1,4}\s*:\s*/, ''), 26))
              : ABSENT,
        },
      ],
      rows: result.rows,
      empty:
        search || agency || entityId
          ? html`<strong>No action matches this filter.</strong><br>
              The search covers PIID, IDV PIID, the vendor name as filed, and the resolved entity name.`
          : emptyBecauseNoData('contract actions', 'npm run load:fpds -- --dir &lt;directory&gt;'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'Contract actions',
    intro:
      'The FPDS corpus. Vendor name is the string as filed; the arrow under it is the entity the ' +
      'resolver landed on. A blank obligation is blank, never zero.',
    body,
  });
}
