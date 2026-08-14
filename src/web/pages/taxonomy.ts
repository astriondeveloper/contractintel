/**
 * The capability taxonomy.
 *
 * Every row ships unconfirmed. The seed files carry `confirmed_by_bd_ops = NO` on
 * every line and the loaders land them with `confirmed_at` null, because spec section
 * 20 makes BD Ops confirmation a deliberate act rather than a side effect of loading.
 * The confirmation column is therefore expected to read Unconfirmed on a fresh load,
 * and that is not a defect.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, section, table, tiles } from '../components.js';
import { count, moment, orAbsent, ABSENT } from '../format.js';
import { taxonomy as taxonomyRows } from '../queries.js';

export async function taxonomy(ctx: Ctx): Promise<string> {
  const rows = await taxonomyRows();
  const confirmed = rows.filter((r) => r.confirmed_at !== null).length;
  const crosswalked = rows.filter((r) => Number(r.crosswalk_count) > 0).length;

  const body = html`
    ${tiles([
      { label: 'Active nodes', value: count(rows.length) },
      {
        label: 'Confirmed by BD Ops',
        value: `${count(confirmed)} of ${count(rows.length)}`,
        foot: confirmed === 0 ? 'Expected on a fresh load. Spec section 20' : undefined,
      },
      { label: 'With a crosswalk', value: `${count(crosswalked)} of ${count(rows.length)}` },
    ])}
    ${section(
      'Nodes',
      table({
        columns: [
          { header: 'Key', cell: (r) => html`<code>${r.node_key}</code>` },
          {
            header: 'Node',
            cell: (r) =>
              html`${r.node_name}${r.parent_name ? html`<span class="sub">under ${r.parent_name}</span>` : ''}`,
          },
          { header: 'Type', cell: (r) => (r.node_type ? chip('neutral', r.node_type) : ABSENT) },
          { header: 'Version', align: 'num', cell: (r) => String(r.version) },
          { header: 'Crosswalks', align: 'num', cell: (r) => count(r.crosswalk_count) },
          {
            header: 'FY19+ obligations',
            align: 'num',
            cell: (r) => (r.fy19plus_obligations_musd === null ? ABSENT : `$${r.fy19plus_obligations_musd}m`),
          },
          { header: 'Growth priority', cell: (r) => orAbsent(r.growth_priority) },
          {
            header: 'BD Ops',
            cell: (r) =>
              r.confirmed_at ? chip('pass', moment(r.confirmed_at)) : chip('blocked', 'Unconfirmed'),
          },
        ],
        rows,
        empty: emptyBecauseNoData('taxonomy nodes', 'npm run seed'),
      }),
      'Active nodes of the current version, in key order',
    )}
  `;

  return screen(ctx, {
    title: 'Capability taxonomy',
    intro:
      'The capability tree and its crosswalks to PSC, agency and NAICS codes. Rows land unconfirmed ' +
      'by design: the system does not trust a seeded row until BD Ops confirms it.',
    body,
  });
}
