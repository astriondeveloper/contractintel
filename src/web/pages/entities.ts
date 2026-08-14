/**
 * Entities: the resolved companies, and one screen per company.
 *
 * This is the screen acceptance test 1 is about. Searching a legal name returns the
 * fraction of the history that carried that exact spelling; searching the entity
 * returns the whole history. The alias table on the detail screen is where that
 * difference is visible, so it leads.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, emptyBecauseNoData, fields, pager, searchForm, section, table } from '../components.js';
import { count, day, moment, orAbsent, truncate, usd, ABSENT } from '../format.js';
import { PAGE_SIZE, baseQuery, offset, pageNumber, text } from '../params.js';
import {
  aliasesFor,
  childrenOf,
  entities,
  entity,
  entityTypes,
  identifiersFor,
  contractActions,
} from '../queries.js';

export async function entityList(ctx: Ctx): Promise<string> {
  const search = text(ctx.url, 'q');
  const type = text(ctx.url, 'type');

  const [result, types] = await Promise.all([
    entities(search, type, PAGE_SIZE, offset(ctx.url)),
    entityTypes(),
  ]);

  const typeSelect = html`<select name="type" aria-label="Entity type">
    <option value=""${type === '' ? html` selected` : ''}>Every type</option>
    ${types.map(
      (t) =>
        html`<option value="${t.entity_type ?? ''}"${type === (t.entity_type ?? '') ? html` selected` : ''}>
          ${t.entity_type ?? 'untyped'} (${count(t.n)})
        </option>`,
    )}
  </select>`;

  const body = html`
    ${searchForm('/entities', [{ name: 'q', placeholder: 'Name, alias, UEI or CAGE', value: search }], typeSelect)}
    ${table({
      columns: [
        {
          header: 'Entity',
          cell: (r) =>
            html`<a href="/entities/${r.entity_id}">${r.canonical_name}</a>
              ${r.parent_name && r.parent_name !== r.canonical_name
                ? html`<span class="sub">under ${r.parent_name}</span>`
                : ''}`,
        },
        { header: 'Type', cell: (r) => (r.entity_type ? chip('neutral', r.entity_type) : ABSENT) },
        { header: 'Aliases', align: 'num', cell: (r) => count(r.alias_count) },
        { header: 'Identifiers', align: 'num', cell: (r) => count(r.identifier_count) },
        { header: 'Actions', align: 'num', cell: (r) => count(r.action_count) },
        { header: 'Obligated', align: 'num', cell: (r) => usd(r.obligations_usd) },
      ],
      rows: result.rows,
      empty: search
        ? html`<strong>Nothing matches “${search}”.</strong><br>
            The search covers canonical names, every alias spelling, and UEI and CAGE values.`
        : emptyBecauseNoData('entities', 'npm run seed'),
    })}
    ${pager({ page: pageNumber(ctx.url), pageSize: PAGE_SIZE, total: result.total, baseQuery: baseQuery(ctx.url) })}
  `;

  return screen(ctx, {
    title: 'Entities',
    intro:
      'One row per resolved company. The alias count is the number of spellings the corpus uses for ' +
      'it, which is the whole reason a legal-name search misses most of a company’s history.',
    body,
  });
}

export async function entityDetail(ctx: Ctx, entityId: string): Promise<string | null> {
  const record = await entity(entityId);
  if (record === null) return null;

  const [aliases, identifiers, children, actions] = await Promise.all([
    aliasesFor(entityId),
    identifiersFor(entityId),
    childrenOf(entityId),
    contractActions('', '', entityId, 15, 0),
  ]);

  const summary = fields([
    { label: 'Entity id', value: html`<code>${record.entity_id}</code>` },
    { label: 'Type', value: record.entity_type ? chip('neutral', record.entity_type) : ABSENT },
    {
      label: 'Ultimate parent',
      value: record.parent_id
        ? html`<a href="/entities/${record.parent_id}">${record.parent_name}</a>`
        : 'None recorded',
    },
    { label: 'Alias spellings', value: count(aliases.length) },
    { label: 'Contract actions', value: count(actions.total) },
    { label: 'First seen', value: moment(record.created_at) },
    { label: 'Notes', value: orAbsent(record.notes) },
  ]);

  const aliasTable = table({
    columns: [
      { header: 'Spelling as it appears', cell: (r) => r.alias_name },
      { header: 'Normalised', cell: (r) => html`<code>${orAbsent(r.alias_name_normalized)}</code>` },
      { header: 'Source', cell: (r) => orAbsent(r.source_system) },
      { header: 'Transactions', align: 'num', cell: (r) => count(r.transaction_count) },
      { header: 'Obligated', align: 'num', cell: (r) => usd(r.obligations_usd) },
      {
        header: 'FY',
        cell: (r) =>
          r.first_seen_fy === null && r.last_seen_fy === null
            ? ABSENT
            : `${r.first_seen_fy ?? '?'}–${r.last_seen_fy ?? '?'}`,
      },
      {
        header: 'BD Ops',
        cell: (r) => (r.confirmed_at ? chip('pass', 'Confirmed') : chip('blocked', 'Unconfirmed')),
      },
    ],
    rows: aliases,
    empty: html`<strong>No alias is recorded for this entity.</strong><br>
      It was created by the resolver from a name in the corpus rather than by the authored map.`,
  });

  const identifierTable = table({
    columns: [
      { header: 'Type', cell: (r) => chip('neutral', r.identifier_type) },
      { header: 'Value', cell: (r) => html`<code>${r.identifier_value}</code>` },
      { header: 'Source', cell: (r) => orAbsent(r.source_system) },
      { header: 'From', cell: (r) => day(r.effective_from) },
      { header: 'To', cell: (r) => day(r.effective_to) },
    ],
    rows: identifiers,
    empty: html`<strong>No UEI or CAGE is recorded for this entity.</strong>`,
  });

  const actionTable = table({
    columns: [
      { header: 'PIID', cell: (r) => html`<code>${orAbsent(r.piid)}</code>` },
      { header: 'Mod', cell: (r) => orAbsent(r.modification_number) },
      { header: 'Signed', cell: (r) => day(r.signed_date) },
      { header: 'Agency', cell: (r) => orAbsent(r.agency_label ?? r.awarding_agency_code) },
      { header: 'Vendor as filed', cell: (r) => truncate(r.vendor_name_raw, 46) },
      { header: 'Obligation', align: 'num', cell: (r) => usd(r.action_obligation) },
    ],
    rows: actions.rows,
    empty: html`<strong>No contract action resolves to this entity.</strong>`,
  });

  const childTable =
    children.length === 0
      ? null
      : table({
          columns: [
            { header: 'Entity', cell: (r) => html`<a href="/entities/${r.entity_id}">${r.canonical_name}</a>` },
            { header: 'Type', cell: (r) => (r.entity_type ? chip('neutral', r.entity_type) : ABSENT) },
            { header: 'Actions', align: 'num', cell: (r) => count(r.action_count) },
          ],
          rows: children,
          empty: html``,
        });

  const body = html`
    ${summary}
    ${section('Alias spellings', aliasTable, 'Every spelling the corpus uses for this entity. Spec 8.3')}
    ${section('Identifiers', identifierTable, 'UEI and CAGE, with the window each was observed in')}
    ${childTable ? section('Entities rolling up to this one', childTable) : ''}
    ${section(
      'Contract actions',
      html`${actionTable}
        ${actions.total > 15
          ? html`<div class="pager">
              <div>Showing 15 of ${count(actions.total)}</div>
              <div class="links"><a href="/contracts?entity=${record.entity_id}">See all</a></div>
            </div>`
          : ''}`,
      'Most recent first',
    )}
  `;

  return screen(ctx, { title: record.canonical_name, intro: 'Resolved entity.', body });
}
