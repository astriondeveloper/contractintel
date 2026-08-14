/**
 * Overview. What is in the database, how it got there, and how fresh it is.
 *
 * The first question anyone asks of this system is whether it is looking at the whole
 * corpus or a slice of it, so the counts come first and the resolution ladder comes
 * immediately after. Spec section 8: every action records how it was matched, and a
 * corpus with unresolved actions is a corpus with a gap in every downstream number.
 */
import { html } from '../html.js';
import { screen, type Ctx } from '../shell.js';
import { table, tiles, section, chip } from '../components.js';
import { count, day, moment, since, usd, usdCompact, orAbsent, percent, ABSENT } from '../format.js';
import { freshness, matchMethods, recentRuns, totals } from '../queries.js';
import { runAcceptanceChecks, tally } from '../../acceptance/checks.js';

export async function overview(ctx: Ctx): Promise<string> {
  const [total, fresh, runs, methods, acceptance] = await Promise.all([
    totals(),
    freshness(),
    recentRuns(10),
    matchMethods(),
    runAcceptanceChecks().catch(() => []),
  ]);

  const counted = tally(acceptance);
  const actions = Number(total.contract_actions);
  const unresolved = Number(total.unresolved_actions);

  const headline = tiles([
    {
      label: 'Contract actions',
      value: count(total.contract_actions),
      foot:
        actions > 0
          ? `${day(total.first_signed)} to ${day(total.last_signed)}`
          : 'FPDS exports not loaded',
    },
    {
      label: 'Obligated',
      value: usdCompact(total.obligations_usd),
      foot: 'Sum of action obligation. Blank is not zero.',
    },
    {
      label: 'Subcontract edges',
      value: count(total.subcontract_edges),
      foot:
        Number(total.subcontract_edges) === 0
          ? 'Subcontract exports not loaded'
          : `${usdCompact(total.subcontract_value_usd)} of subcontract value`,
    },
    {
      label: 'Entities',
      value: count(total.entities),
      foot: `${count(total.aliases)} aliases · ${count(total.identifiers)} identifiers`,
    },
    {
      label: 'Resolved',
      value: actions === 0 ? ABSENT : percent(actions - unresolved, actions),
      foot:
        actions === 0
          ? 'No corpus to resolve'
          : unresolved === 0
            ? 'Every action carries an entity'
            : `${count(unresolved)} action(s) unresolved`,
    },
    {
      label: 'Waiting on a human',
      value: count(Number(total.review_open) + Number(total.merge_open)),
      foot: `${count(total.review_open)} vendor review · ${count(total.merge_open)} merge candidates`,
      href: '/review',
    },
  ]);

  const reference = tiles([
    { label: 'Customers', value: count(total.customers), href: '/customers' },
    { label: 'Programs', value: count(total.programs), href: '/programs' },
    { label: 'DACIS contracts', value: count(total.dacis_contracts), href: '/dacis-contracts' },
    { label: 'Taxonomy nodes', value: count(total.taxonomy_nodes), href: '/taxonomy' },
    { label: 'Watchlist rows', value: count(total.watchlist_rows), href: '/watchlist' },
    {
      label: 'Acceptance',
      value: `${counted.passed}/${counted.total}`,
      foot: `${counted.failed} fail · ${counted.blocked} blocked`,
      href: '/acceptance',
    },
  ]);

  const resolution = table({
    columns: [
      {
        header: 'Match method',
        cell: (r) => (r.entity_match_method ? html`<code>${r.entity_match_method}</code>` : ABSENT),
      },
      { header: 'Confidence', cell: (r) => orAbsent(r.entity_match_confidence) },
      { header: 'Actions', align: 'num', cell: (r) => count(r.n) },
      { header: 'Share', align: 'num', cell: (r) => percent(Number(r.n), actions) },
    ],
    rows: methods,
    empty: html`<strong>Nothing resolved yet.</strong><br>
      The resolution ladder records how each action matched. It fills as the FPDS corpus loads.`,
  });

  const sources = table({
    columns: [
      { header: 'Source system', cell: (r) => html`<code>${r.source_system}</code>` },
      { header: 'Last success', cell: (r) => moment(r.last_success_at) },
      { header: 'Age', cell: (r) => since(r.last_success_at) },
      {
        header: 'State',
        cell: (r) => (r.is_stale ? chip('blocked', 'Stale') : chip('pass', 'Fresh')),
      },
    ],
    rows: fresh,
    empty: html`<strong>No source has reported a successful run.</strong><br>
      <code>source_freshness</code> fills the first time a loader finishes.`,
  });

  const history = table({
    columns: [
      { header: 'Run', align: 'num', cell: (r) => r.run_id },
      {
        header: 'Source',
        cell: (r) =>
          html`<code>${r.source_system}</code>${r.source_label
            ? html`<span class="sub">${r.source_label}</span>`
            : ''}`,
      },
      { header: 'Started', cell: (r) => moment(r.started_at) },
      { header: 'Records', align: 'num', cell: (r) => count(r.record_count) },
      { header: 'New', align: 'num', cell: (r) => count(r.inserted_count) },
      { header: 'Changed', align: 'num', cell: (r) => count(r.updated_count) },
      { header: 'Unchanged', align: 'num', cell: (r) => count(r.unchanged_count) },
      {
        header: 'Status',
        cell: (r) =>
          r.status === 'succeeded'
            ? chip('pass', r.status)
            : r.status === 'failed'
              ? chip('fail', r.status)
              : chip('neutral', r.status),
      },
    ],
    rows: runs,
    empty: html`<strong>No loader has run against this database.</strong><br>
      Start with <code>npm run seed</code>, then
      <code>npm run load -- --dry-run --dir &lt;directory&gt;</code>.`,
  });

  const body = html`
    ${headline}
    ${section(
      'Reference data',
      reference,
      'Loaded from the DACIS exports and the three authored seed files',
    )}
    ${section(
      'How the corpus resolved',
      resolution,
      'Spec section 8. Every action records the rung of the ladder it matched on',
    )}
    ${section('Source freshness', sources, 'A source is stale when its last success is old')}
    ${section('Recent loads', history, 'Every loader is idempotent: a second run reports unchanged')}
  `;

  return screen(ctx, {
    title: 'Overview',
    intro:
      'The state of the data foundation: what is loaded, how it resolved, and when each source last ' +
      'landed. Everything on this screen is read live from the database the interface is pointed at.',
    body,
  });
}

/** The same numbers as JSON, for a health dashboard or a scheduled check. */
export async function overviewJson(): Promise<unknown> {
  const [total, fresh, acceptance] = await Promise.all([
    totals(),
    freshness(),
    runAcceptanceChecks().catch(() => []),
  ]);
  return {
    totals: {
      contract_actions: Number(total.contract_actions),
      obligations_usd: total.obligations_usd === null ? null : Number(total.obligations_usd),
      subcontract_edges: Number(total.subcontract_edges),
      entities: Number(total.entities),
      aliases: Number(total.aliases),
      customers: Number(total.customers),
      programs: Number(total.programs),
      dacis_contracts: Number(total.dacis_contracts),
      unresolved_actions: Number(total.unresolved_actions),
      review_open: Number(total.review_open),
      merge_open: Number(total.merge_open),
    },
    obligations_display: usd(total.obligations_usd),
    source_freshness: fresh,
    acceptance: { ...tally(acceptance), results: acceptance },
  };
}
