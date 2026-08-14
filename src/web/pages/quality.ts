/**
 * Data quality: the seven views that exist to make a known defect visible rather than
 * to hide it.
 *
 * The collapse summary at the top is the one to read first. The export supplies a
 * `Transaction #` column and leaves it blank on every row, so keying an action the way
 * spec 7.2 literally describes collapses distinct payloads onto one key and drops the
 * obligations they carried. `docs/DECISIONS.md` D3 records the surrogate key that
 * avoids it, and this view measures what the literal reading would have cost.
 * When the export starts populating the column, every figure here reads zero.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { chip, section, table, tiles } from '../components.js';
import { count, day, truncate, usd, usdCompact, orAbsent } from '../format.js';
import {
  aliasConflicts,
  collapseSummary,
  disputedLabels,
  identifierCollisions,
  qualityCounts,
  roleConflicts,
  unplacedEdges,
} from '../queries.js';

export async function quality(ctx: Ctx): Promise<string> {
  const [counts, collapse, collisions, aliases, unplaced, disputed, roles] = await Promise.all([
    qualityCounts(),
    collapseSummary(),
    identifierCollisions(),
    aliasConflicts(),
    unplacedEdges(),
    disputedLabels(),
    roleConflicts(),
  ]);

  const clean =
    Number(counts.collisions) === 0 &&
    Number(counts.alias_conflicts) === 0 &&
    Number(counts.unplaced_edges) === 0 &&
    Number(counts.disputed_labels) === 0 &&
    Number(counts.role_conflicts) === 0 &&
    Number(counts.unresolved_actions) === 0;

  const body = html`
    ${tiles([
      { label: 'Unresolved actions', value: count(counts.unresolved_actions) },
      { label: 'Identifier collisions', value: count(counts.collisions) },
      { label: 'Alias conflicts', value: count(counts.alias_conflicts) },
      { label: 'Unplaced subcontract parties', value: count(counts.unplaced_edges) },
      { label: 'Disputed code labels', value: count(counts.disputed_labels) },
      { label: 'DACIS role conflicts', value: count(counts.role_conflicts) },
    ])}
    ${clean
      ? html`<div class="notice info">
          <h3>Every quality view is empty</h3>
          Nothing on this screen has a row. On a loaded corpus that is a strong result; on an empty
          database it only means there is nothing to check yet.
        </div>`
      : ''}
    ${section(
      'FPDS transaction key collapse',
      collapse === null
        ? html`<div class="table-wrap"><div class="empty">The collapse view returned nothing.</div></div>`
        : html`${tiles([
            { label: 'Distinct payloads', value: count(collapse.distinct_payloads) },
            { label: 'Contract actions', value: count(collapse.contract_actions) },
            { label: 'Keys affected', value: count(collapse.keys_affected) },
            {
              label: 'Payloads overwritten',
              value: count(collapse.payloads_overwritten),
              foot: 'Under the literal spec 7.2 key',
            },
            { label: 'Obligation, all payloads', value: usdCompact(collapse.obligation_all_payloads) },
            {
              label: 'Obligation that would be lost',
              value: usdCompact(collapse.obligation_not_in_contract_action),
              foot: 'What the literal key would drop',
            },
          ])}`,
      'Zero here means the export has started populating Transaction #. Backlog item 1',
    )}
    ${section(
      'Identifier collisions',
      table({
        columns: [
          { header: 'Type', cell: (r) => chip('neutral', r.identifier_type) },
          { header: 'Value', cell: (r) => html`<code>${r.identifier_value}</code>` },
          { header: 'Entities', align: 'num', cell: (r) => count(r.entity_count) },
          { header: 'Distinct parents', align: 'num', cell: (r) => count(r.distinct_parent_count) },
          { header: 'Names', cell: (r) => truncate(r.entity_names, 80) },
        ],
        rows: collisions,
        empty: html`<strong>No UEI or CAGE is shared by two entities.</strong>`,
      }),
      'One identifier carried by more than one entity. A collision across distinct parents is the serious kind',
    )}
    ${section(
      'Alias normalisation conflicts',
      table({
        columns: [
          { header: 'Normalises to', cell: (r) => html`<code>${r.alias_name_normalized}</code>` },
          { header: 'Entities', align: 'num', cell: (r) => count(r.entity_count) },
          { header: 'Spellings', cell: (r) => truncate(r.spellings, 90) },
        ],
        rows: aliases,
        empty: html`<strong>No two entities share a normalised alias.</strong><br>
          This is the property acceptance test 3 asserts. Spec 8.3.`,
      }),
      'Spellings that reduce to the same normalised form but sit on different entities',
    )}
    ${section(
      'Unplaced subcontract parties',
      table({
        columns: [
          { header: 'Prime', cell: (r) => truncate(r.prime_name_raw, 40) },
          { header: 'Sub', cell: (r) => truncate(r.sub_name_raw, 40) },
          { header: 'Value', align: 'num', cell: (r) => usd(r.value_usd) },
          { header: 'Awarded', cell: (r) => day(r.award_date) },
          { header: 'Agency', cell: (r) => truncate(r.agency_name, 30) },
        ],
        rows: unplaced,
        empty: html`<strong>Every subcontract party resolved to an entity.</strong>`,
      }),
      'Edges where one side could not be tied to an entity',
    )}
    ${section(
      'Disputed code labels',
      table({
        columns: [
          { header: 'Code type', cell: (r) => chip('neutral', r.code_type) },
          { header: 'Value', cell: (r) => html`<code>${r.code_value}</code>` },
          { header: 'Labels seen', align: 'num', cell: (r) => count(r.label_count) },
          { header: 'Current', cell: (r) => orAbsent(r.current_label) },
          { header: 'All spellings', cell: (r) => truncate(r.labels, 70) },
        ],
        rows: disputed,
        empty: html`<strong>Every code carries one label.</strong>`,
      }),
      'One code the exports label more than one way. The current label is the most recently observed',
    )}
    ${section(
      'DACIS role conflicts',
      table({
        columns: [
          { header: 'Contract', cell: (r) => html`<code>${orAbsent(r.contract_number)}</code>` },
          { header: 'Title', cell: (r) => truncate(r.title, 60) },
          { header: 'Roles asserted', cell: (r) => orAbsent(r.roles_asserted) },
          { header: 'Source files', cell: (r) => truncate(r.source_files, 50) },
        ],
        rows: roles,
        empty: html`<strong>No contract asserts a conflicting role.</strong>`,
      }),
      'One contract where the exports disagree about whether a company won or lost it',
    )}
  `;

  return screen(ctx, {
    title: 'Data quality',
    intro:
      'These views exist to keep known source defects visible. An empty view is the goal; a populated ' +
      'one names a specific problem with a specific input rather than a general warning about the data.',
    body,
    suppressEmptyNotice: true,
  });
}

/** The quality counts as JSON, so a scheduled check can watch them without scraping. */
export async function qualityJson(): Promise<unknown> {
  const [counts, collapse] = await Promise.all([qualityCounts(), collapseSummary()]);
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
    fpds_collapse: collapse,
  };
}
