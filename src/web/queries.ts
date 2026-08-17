/**
 * Every statement the interface runs, in one file.
 *
 * Three rules hold throughout:
 *
 *   Read only.      Nothing here writes. The interface is a window on the corpus; BD Ops
 *                   confirmation and merge decisions are a later phase with an audit trail
 *                   behind them (spec section 20), not a link on a list screen.
 *   Parameterised.  Every value the caller supplies is a bind parameter. Vendor names in
 *                   this corpus contain quotes and ampersands and arrive from a file.
 *   Bounded.        Every list takes a limit. A screen that streams 22,000 rows into a
 *                   browser is not a screen.
 */
import { query } from '../db/index.js';

/** A page of rows plus the unfiltered-by-page total, for the pager. */
export interface Page<Row> {
  readonly rows: Row[];
  readonly total: number;
}

/**
 * Run a list query and its count in one round trip each.
 *
 * `countSql` counts the same filtered set, so by default the two take the same parameters
 * and the pager cannot disagree with the table.
 *
 * `countParams` exists for the one case where they legitimately differ: a list query that
 * takes a parameter the filter does not use, such as a sort key. Postgres rejects a bind
 * with more parameters than the statement declares, so the count needs the shorter list.
 * It is a separate argument rather than an inlined value because a sort key reaching SQL
 * as a string is how a whitelist becomes an injection two refactors later.
 */
async function paged<Row>(
  listSql: string,
  countSql: string,
  params: unknown[],
  limit: number,
  offset: number,
  countParams: unknown[] = params,
): Promise<Page<Row>> {
  const [rows, totals] = await Promise.all([
    query<Row extends Record<string, unknown> ? Row : never>(listSql, [...params, limit, offset]),
    query<{ n: string }>(countSql, countParams),
  ]);
  return { rows: rows as Row[], total: Number(totals[0]?.n ?? 0) };
}

/* ==================================================================== state */

export interface DatabaseState {
  readonly migrationsApplied: number;
  readonly lastMigration: string | null;
  readonly hasCorpus: boolean;
  readonly hasSeeds: boolean;
}

/**
 * What state the database is in, asked before anything else so a screen can explain
 * itself rather than render an empty table. A database with no schema at all is a
 * normal first-run condition, not an error, so a missing table answers "not migrated"
 * instead of throwing.
 */
export async function databaseState(): Promise<DatabaseState> {
  const migrated = await query<{ n: string; last: string | null }>(
    `select count(*)::text as n, max(filename) as last
       from schema_migration`,
  ).catch(() => []);

  if (migrated.length === 0) {
    return { migrationsApplied: 0, lastMigration: null, hasCorpus: false, hasSeeds: false };
  }

  const actions = (await query<{ n: string }>('select count(*)::text as n from contract_action'))[0]!.n;
  const aliases = (await query<{ n: string }>('select count(*)::text as n from entity_alias'))[0]!.n;

  return {
    migrationsApplied: Number(migrated[0]!.n),
    lastMigration: migrated[0]!.last,
    hasCorpus: Number(actions) > 0,
    hasSeeds: Number(aliases) > 0,
  };
}

/* ================================================================= overview */

export interface Totals {
  readonly contract_actions: string;
  readonly obligations_usd: string | null;
  readonly entities: string;
  readonly aliases: string;
  readonly identifiers: string;
  readonly subcontract_edges: string;
  readonly subcontract_value_usd: string | null;
  readonly customers: string;
  readonly programs: string;
  readonly dacis_contracts: string;
  readonly taxonomy_nodes: string;
  readonly watchlist_rows: string;
  readonly review_open: string;
  readonly merge_open: string;
  readonly unresolved_actions: string;
  readonly first_signed: Date | null;
  readonly last_signed: Date | null;
}

export async function totals(): Promise<Totals> {
  const [row] = await query<Totals>(
    `select
       (select count(*)::text from contract_action)                       as contract_actions,
       (select sum(action_obligation)::text from contract_action)         as obligations_usd,
       (select count(*)::text from entity)                                as entities,
       (select count(*)::text from entity_alias)                          as aliases,
       (select count(*)::text from entity_identifier)                     as identifiers,
       (select count(*)::text from subcontract_edge)                      as subcontract_edges,
       (select sum(value_usd)::text from subcontract_edge)                as subcontract_value_usd,
       (select count(*)::text from customer_org)                          as customers,
       (select count(*)::text from program)                               as programs,
       (select count(*)::text from dacis_contract)                        as dacis_contracts,
       (select count(*)::text from taxonomy_node where active)            as taxonomy_nodes,
       (select count(*)::text from watchlist_seed_direction)              as watchlist_rows,
       (select count(*)::text from vendor_review_queue where state = 'open')      as review_open,
       (select count(*)::text from entity_merge_candidate where state = 'open')   as merge_open,
       (select count(*)::text from contract_action where entity_id is null)       as unresolved_actions,
       (select min(signed_date) from contract_action)                     as first_signed,
       (select max(signed_date) from contract_action)                     as last_signed`,
  );
  return row!;
}

export interface Freshness {
  readonly source_system: string;
  readonly last_success_at: Date | null;
  readonly age: string | null;
  readonly is_stale: boolean | null;
}

export function freshness(): Promise<Freshness[]> {
  return query<Freshness>('select * from source_freshness order by source_system');
}

export interface Run {
  readonly run_id: string;
  readonly source_system: string;
  readonly source_label: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly record_count: number | null;
  readonly inserted_count: number | null;
  readonly updated_count: number | null;
  readonly unchanged_count: number | null;
  readonly status: string;
  readonly error_text: string | null;
}

export function recentRuns(limit = 12): Promise<Run[]> {
  return query<Run>(
    `select run_id::text, source_system, source_label, started_at, finished_at,
            record_count, inserted_count, updated_count, unchanged_count, status, error_text
       from source_run
      order by run_id desc
      limit $1`,
    [limit],
  );
}

export interface MatchMethod {
  readonly entity_match_method: string | null;
  readonly entity_match_confidence: string | null;
  readonly n: string;
}

/** How the corpus resolved. Spec section 8: every step of the ladder is recorded. */
export function matchMethods(): Promise<MatchMethod[]> {
  return query<MatchMethod>(
    `select entity_match_method, entity_match_confidence, count(*)::text as n
       from contract_action
      group by entity_match_method, entity_match_confidence
      order by count(*) desc`,
  );
}

/* ================================================================= entities */

export interface EntityRow {
  readonly entity_id: string;
  readonly canonical_name: string;
  readonly entity_type: string | null;
  readonly parent_name: string | null;
  readonly alias_count: string;
  readonly identifier_count: string;
  readonly action_count: string;
  readonly obligations_usd: string | null;
}

const ENTITY_FILTER = `
  ($1 = '' or e.canonical_name ilike '%' || $1 || '%'
           or exists (select 1 from entity_alias a
                       where a.entity_id = e.entity_id
                         and a.alias_name ilike '%' || $1 || '%')
           or exists (select 1 from entity_identifier i
                       where i.entity_id = e.entity_id
                         and i.identifier_value ilike '%' || $1 || '%'))
  and ($2 = '' or e.entity_type = $2)`;

export function entities(search: string, type: string, limit: number, offset: number): Promise<Page<EntityRow>> {
  return paged<EntityRow>(
    `select e.entity_id::text,
            e.canonical_name,
            e.entity_type,
            p.canonical_name as parent_name,
            (select count(*)::text from entity_alias a where a.entity_id = e.entity_id)      as alias_count,
            (select count(*)::text from entity_identifier i where i.entity_id = e.entity_id) as identifier_count,
            (select count(*)::text from contract_action c where c.entity_id = e.entity_id)   as action_count,
            (select sum(c.action_obligation)::text from contract_action c
              where c.entity_id = e.entity_id)                                               as obligations_usd
       from entity e
       left join entity p on p.entity_id = e.ultimate_parent_id
      where ${ENTITY_FILTER}
      order by (select count(*) from contract_action c where c.entity_id = e.entity_id) desc,
               e.canonical_name
      limit $3 offset $4`,
    `select count(*)::text as n
       from entity e
      where ${ENTITY_FILTER}`,
    [search, type],
    limit,
    offset,
  );
}

export function entityTypes(): Promise<{ entity_type: string | null; n: string }[]> {
  return query<{ entity_type: string | null; n: string }>(
    `select entity_type, count(*)::text as n from entity group by entity_type order by entity_type`,
  );
}

export interface EntityDetail {
  readonly entity_id: string;
  readonly canonical_name: string;
  readonly entity_type: string | null;
  readonly notes: string | null;
  readonly parent_id: string | null;
  readonly parent_name: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export async function entity(entityId: string): Promise<EntityDetail | null> {
  const rows = await query<EntityDetail>(
    `select e.entity_id::text, e.canonical_name, e.entity_type, e.notes,
            e.ultimate_parent_id::text as parent_id, p.canonical_name as parent_name,
            e.created_at, e.updated_at
       from entity e
       left join entity p on p.entity_id = e.ultimate_parent_id
      where e.entity_id = $1::bigint`,
    [entityId],
  );
  return rows[0] ?? null;
}

export interface AliasRow {
  readonly alias_name: string;
  readonly alias_name_normalized: string | null;
  readonly source_system: string | null;
  readonly transaction_count: number | null;
  readonly obligations_usd: string | null;
  readonly first_seen_fy: number | null;
  readonly last_seen_fy: number | null;
  readonly confirmed_at: Date | null;
}

export function aliasesFor(entityId: string): Promise<AliasRow[]> {
  return query<AliasRow>(
    `select alias_name, alias_name_normalized, source_system, transaction_count,
            obligations_usd::text, first_seen_fy, last_seen_fy, confirmed_at
       from entity_alias
      where entity_id = $1::bigint
      order by coalesce(transaction_count, 0) desc, alias_name`,
    [entityId],
  );
}

export interface IdentifierRow {
  readonly identifier_type: string;
  readonly identifier_value: string;
  readonly source_system: string | null;
  readonly effective_from: Date | null;
  readonly effective_to: Date | null;
}

export function identifiersFor(entityId: string): Promise<IdentifierRow[]> {
  return query<IdentifierRow>(
    `select identifier_type, identifier_value, source_system, effective_from, effective_to
       from entity_identifier
      where entity_id = $1::bigint
      order by identifier_type, identifier_value`,
    [entityId],
  );
}

export interface ChildRow {
  readonly entity_id: string;
  readonly canonical_name: string;
  readonly entity_type: string | null;
  readonly action_count: string;
}

export function childrenOf(entityId: string): Promise<ChildRow[]> {
  return query<ChildRow>(
    `select e.entity_id::text, e.canonical_name, e.entity_type,
            (select count(*)::text from contract_action c where c.entity_id = e.entity_id) as action_count
       from entity e
      where e.ultimate_parent_id = $1::bigint and e.entity_id <> $1::bigint
      order by e.canonical_name`,
    [entityId],
  );
}

/* ======================================================== contract actions */

export interface ActionRow {
  readonly contract_action_id: string;
  readonly piid: string | null;
  readonly modification_number: string | null;
  readonly transaction_number: string | null;
  readonly idv_piid: string | null;
  readonly award_type: string | null;
  readonly signed_date: Date | null;
  readonly ultimate_completion_date: Date | null;
  readonly action_obligation: string | null;
  readonly base_and_all_options: string | null;
  readonly vendor_name_raw: string | null;
  readonly entity_id: string | null;
  readonly canonical_name: string | null;
  readonly entity_match_method: string | null;
  readonly awarding_agency_code: string | null;
  readonly agency_label: string | null;
  readonly place_of_performance_state: string | null;
  readonly extent_competed: string | null;
  readonly set_aside_type: string | null;
}

const ACTION_FILTER = `
  ($1 = '' or ca.vendor_name_raw ilike '%' || $1 || '%'
           or ca.piid ilike '%' || $1 || '%'
           or ca.idv_piid ilike '%' || $1 || '%'
           or e.canonical_name ilike '%' || $1 || '%')
  and ($2 = '' or ca.awarding_agency_code = $2)
  and ($3 = '' or ca.entity_id = $3::bigint)`;

export function contractActions(
  search: string,
  agency: string,
  entityId: string,
  limit: number,
  offset: number,
): Promise<Page<ActionRow>> {
  return paged<ActionRow>(
    `select ca.contract_action_id::text, ca.piid, ca.modification_number, ca.transaction_number,
            ca.idv_piid, ca.award_type, ca.signed_date, ca.ultimate_completion_date,
            ca.action_obligation::text, ca.base_and_all_options::text,
            ca.vendor_name_raw, ca.entity_id::text, e.canonical_name, ca.entity_match_method,
            ca.awarding_agency_code, al.label as agency_label,
            ca.place_of_performance_state, ca.extent_competed, ca.set_aside_type
       from contract_action ca
       left join entity e on e.entity_id = ca.entity_id
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = ca.awarding_agency_code
      where ${ACTION_FILTER}
      order by ca.signed_date desc nulls last, ca.contract_action_id desc
      limit $4 offset $5`,
    `select count(*)::text as n
       from contract_action ca
       left join entity e on e.entity_id = ca.entity_id
      where ${ACTION_FILTER}`,
    [search, agency, entityId],
    limit,
    offset,
  );
}

export interface AgencyOption {
  readonly awarding_agency_code: string;
  readonly label: string | null;
  readonly n: string;
}

export function agencies(limit = 40): Promise<AgencyOption[]> {
  return query<AgencyOption>(
    `select ca.awarding_agency_code, max(al.label) as label, count(*)::text as n
       from contract_action ca
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = ca.awarding_agency_code
      where ca.awarding_agency_code is not null
      group by ca.awarding_agency_code
      order by count(*) desc
      limit $1`,
    [limit],
  );
}

/* ============================================================= subcontracts */

export interface EdgeRow {
  readonly edge_id: string;
  readonly prime_name_raw: string | null;
  readonly prime_entity_id: string | null;
  readonly prime_canonical: string | null;
  readonly sub_name_raw: string | null;
  readonly sub_entity_id: string | null;
  readonly sub_canonical: string | null;
  readonly value_usd: string | null;
  readonly award_date: Date | null;
  readonly award_number: string | null;
  readonly prime_piid: string | null;
  readonly agency_name: string | null;
  readonly customer_name: string | null;
  readonly description: string | null;
}

const EDGE_FILTER = `
  ($1 = '' or se.prime_name_raw ilike '%' || $1 || '%'
           or se.sub_name_raw ilike '%' || $1 || '%'
           or se.award_number ilike '%' || $1 || '%'
           or se.prime_piid ilike '%' || $1 || '%')`;

export function subcontracts(search: string, limit: number, offset: number): Promise<Page<EdgeRow>> {
  return paged<EdgeRow>(
    `select se.edge_id::text, se.prime_name_raw, se.prime_entity_id::text,
            pe.canonical_name as prime_canonical,
            se.sub_name_raw, se.sub_entity_id::text, sube.canonical_name as sub_canonical,
            se.value_usd::text, se.award_date, se.award_number, se.prime_piid,
            se.agency_name, se.customer_name, se.description
       from subcontract_edge se
       left join entity pe   on pe.entity_id = se.prime_entity_id
       left join entity sube on sube.entity_id = se.sub_entity_id
      where ${EDGE_FILTER}
      order by se.value_usd desc nulls last, se.edge_id
      limit $2 offset $3`,
    `select count(*)::text as n from subcontract_edge se where ${EDGE_FILTER}`,
    [search],
    limit,
    offset,
  );
}

/* ================================================================ customers */

export interface CustomerRow {
  readonly customer_org_id: string;
  readonly customer_code: string | null;
  readonly customer_name: string;
  readonly acronym: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly country: string | null;
  readonly description: string | null;
  readonly dacis_url: string | null;
}

const CUSTOMER_FILTER = `
  ($1 = '' or c.customer_name ilike '%' || $1 || '%'
           or c.acronym ilike '%' || $1 || '%'
           or c.customer_code ilike '%' || $1 || '%')`;

export function customers(search: string, limit: number, offset: number): Promise<Page<CustomerRow>> {
  return paged<CustomerRow>(
    `select c.customer_org_id::text, c.customer_code, c.customer_name, c.acronym,
            c.city, c.state, c.country, c.description, c.dacis_url
       from customer_org c
      where ${CUSTOMER_FILTER}
      order by c.customer_name
      limit $2 offset $3`,
    `select count(*)::text as n from customer_org c where ${CUSTOMER_FILTER}`,
    [search],
    limit,
    offset,
  );
}

/* ================================================================= programs */

export interface ProgramRow {
  readonly program_id: string;
  readonly program_name: string;
  readonly lifecycle_status: string | null;
  readonly participants_supplied: number | null;
  readonly participant_list_truncated: boolean | null;
  readonly description: string | null;
  readonly customer_count: string;
  readonly dacis_url: string | null;
}

const PROGRAM_FILTER = `($1 = '' or p.program_name ilike '%' || $1 || '%')`;

export function programs(search: string, limit: number, offset: number): Promise<Page<ProgramRow>> {
  return paged<ProgramRow>(
    `select p.program_id::text, p.program_name, p.lifecycle_status, p.participants_supplied,
            p.participant_list_truncated, p.description, p.dacis_url,
            (select count(*)::text from program_customer pc where pc.program_id = p.program_id) as customer_count
       from program p
      where ${PROGRAM_FILTER}
      order by p.program_name
      limit $2 offset $3`,
    `select count(*)::text as n from program p where ${PROGRAM_FILTER}`,
    [search],
    limit,
    offset,
  );
}

/* ========================================================== DACIS contracts */

export interface DacisRow {
  readonly dacis_contract_id: string;
  readonly contract_number: string | null;
  readonly solicitation_number: string | null;
  readonly title: string | null;
  readonly value_usd: string | null;
  readonly value_is_shared: boolean | null;
  readonly award_date: Date | null;
  readonly end_date: Date | null;
  readonly doge_canceled: boolean | null;
  readonly customer_using_activity: string | null;
  readonly contract_type_raw: string | null;
  readonly role_count: string;
  readonly dacis_url: string | null;
}

const DACIS_FILTER = `
  ($1 = '' or d.title ilike '%' || $1 || '%'
           or d.contract_number ilike '%' || $1 || '%'
           or d.solicitation_number ilike '%' || $1 || '%'
           or d.customer_using_activity ilike '%' || $1 || '%')`;

export function dacisContracts(search: string, limit: number, offset: number): Promise<Page<DacisRow>> {
  return paged<DacisRow>(
    `select d.dacis_contract_id::text, d.contract_number, d.solicitation_number, d.title,
            d.value_usd::text, d.value_is_shared, d.award_date, d.end_date, d.doge_canceled,
            d.customer_using_activity, d.contract_type_raw, d.dacis_url,
            (select count(*)::text from dacis_contract_role r
              where r.dacis_contract_id = d.dacis_contract_id) as role_count
       from dacis_contract d
      where ${DACIS_FILTER}
      order by d.value_usd desc nulls last, d.dacis_contract_id
      limit $2 offset $3`,
    `select count(*)::text as n from dacis_contract d where ${DACIS_FILTER}`,
    [search],
    limit,
    offset,
  );
}

/* ================================================================= taxonomy */

export interface TaxonomyRow {
  readonly node_id: string;
  readonly node_key: string;
  readonly node_name: string;
  readonly node_type: string | null;
  readonly parent_name: string | null;
  readonly version: number;
  readonly active: boolean;
  readonly fy19plus_obligations_musd: string | null;
  readonly growth_priority: string | null;
  readonly confirmed_at: Date | null;
  readonly crosswalk_count: string;
}

export function taxonomy(): Promise<TaxonomyRow[]> {
  return query<TaxonomyRow>(
    `select t.node_id::text, t.node_key, t.node_name, t.node_type,
            p.node_name as parent_name, t.version, t.active,
            t.fy19plus_obligations_musd::text, t.growth_priority, t.confirmed_at,
            (select count(*)::text from node_crosswalk nc where nc.node_id = t.node_id) as crosswalk_count
       from taxonomy_node t
       left join taxonomy_node p on p.node_id = t.parent_node_id
      where t.active
      order by t.node_key`,
  );
}

/* ================================================================ watchlist */

export interface WatchlistRow {
  readonly entity_id: string | null;
  readonly canonical_name: string | null;
  readonly spelling_count: string | null;
  readonly spellings: string[] | null;
  readonly stated_directions: string[] | null;
  readonly times_astrion_subbed_to_them: string | null;
  readonly times_they_subbed_to_astrion: string | null;
  readonly observed_relationship: string | null;
  readonly direction_changed_by_rollup: boolean | null;
}

export function watchlist(): Promise<WatchlistRow[]> {
  return query<WatchlistRow>(
    `select entity_id::text, canonical_name, spelling_count::text, spellings, stated_directions,
            times_astrion_subbed_to_them::text, times_they_subbed_to_astrion::text,
            observed_relationship, direction_changed_by_rollup
       from watchlist_company
      order by (coalesce(times_astrion_subbed_to_them, 0) + coalesce(times_they_subbed_to_astrion, 0)) desc,
               canonical_name`,
  );
}

/* ================================================================= signals */

export interface UpcomingRow {
  readonly pursuit_id: string;
  readonly title: string;
  readonly signal_class: string;
  readonly related_piid: string | null;
  readonly period_end_date: Date | null;
  readonly expected_solicitation_fy: number | null;
  readonly estimated_value: string | null;
  readonly astrion_position: string | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_name: string | null;
  readonly incumbent_confidence: string | null;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly state: string;
  readonly owner: string | null;
  readonly notice_type: string | null;
  readonly response_date: Date | null;
  readonly posted_date: Date | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly set_aside_code: string | null;
  readonly notice_url: string | null;
  readonly solicitation_number: string | null;
  readonly band: string | null;
  readonly strategic_fit: string | null;
  readonly coverage: string | null;
  readonly assessment_id: string | null;
}

const UPCOMING_FILTER = `
  p.signal_class <> 'market_movement'
  and ($3 = '' or p.signal_class = $3)
  and ($1 = '' or p.title ilike '%' || $1 || '%'
               or p.solicitation_number ilike '%' || $1 || '%'
               or p.naics_code ilike '%' || $1 || '%'
               or p.psc_code ilike '%' || $1 || '%'
               or p.related_piid ilike '%' || $1 || '%'
               or p.agency_code ilike '%' || $1 || '%'
               or e.canonical_name ilike '%' || $1 || '%')
  and ($2 = '' or p.astrion_position = $2)`;

export function upcomingSignals(
  search: string,
  position: string,
  signalClass: string,
  sort: string,
  limit: number,
  offset: number,
): Promise<Page<UpcomingRow>> {
  return paged<UpcomingRow>(
    `select p.pursuit_id::text, p.title, p.signal_class, p.related_piid, p.period_end_date,
            p.expected_solicitation_fy, p.estimated_value::text, p.astrion_position,
            p.incumbent_entity_id::text, e.canonical_name as incumbent_name,
            p.incumbent_confidence, p.agency_code, al.label as agency_label,
            p.state, p.owner, p.notice_type, p.response_date, p.posted_date,
            p.naics_code, p.psc_code, p.set_aside_code, p.notice_url, p.solicitation_number,
            a.band, a.strategic_fit::text, a.coverage::text, a.assessment_id::text
       from pursuit p
       left join entity e on e.entity_id = p.incumbent_entity_id
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = p.agency_code
       -- The assessment under the current score model. An assessment computed under an
       -- older model is kept but not shown here: comparing scores across model versions is
       -- exactly what pinning the version exists to prevent.
       left join assessment a
              on a.pursuit_id = p.pursuit_id
             and a.score_model_version =
                 (select score_model_version from score_model where is_current limit 1)
      where ${UPCOMING_FILTER}
      -- Whichever date this signal is actually timed against. A solicitation is timed by
      -- its response deadline and a recompete by the end of the period of performance, and
      -- ordering on one of them alone buries the other class at the bottom of the list.
      order by
        case when $4 = 'fit' then a.rank_value end desc nulls last,
        case when $4 = 'fit' then p.pursuit_id end,
        coalesce(p.response_date, p.period_end_date) asc nulls last,
        p.estimated_value desc nulls last, p.pursuit_id
      limit $5 offset $6`,
    `select count(*)::text as n
       from pursuit p
       left join entity e on e.entity_id = p.incumbent_entity_id
       left join assessment a
              on a.pursuit_id = p.pursuit_id
             and a.score_model_version =
                 (select score_model_version from score_model where is_current limit 1)
      where ${UPCOMING_FILTER}`,
    [search, position, signalClass, sort],
    limit,
    offset,
    // The filter uses three of these; `sort` only reaches the order by.
    [search, position, signalClass],
  );
}

export interface UpcomingSummary {
  readonly total: number;
  readonly prime_incumbent: number;
  readonly subcontractor: number;
  readonly none: number;
  readonly without_value: number;
  readonly estimated_value: string | null;
  readonly detected_at: Date | null;
  readonly recompete_window: number;
  readonly active_solicitation: number;
  readonly shaping_target: number;
}

export async function upcomingSummary(): Promise<UpcomingSummary> {
  const [row] = await query<{
    total: string;
    prime_incumbent: string;
    subcontractor: string;
    none: string;
    without_value: string;
    estimated_value: string | null;
    detected_at: Date | null;
    recompete_window: string;
    active_solicitation: string;
    shaping_target: string;
  }>(
    `select count(*)::text                                                          as total,
            count(*) filter (where astrion_position = 'prime_incumbent')::text      as prime_incumbent,
            count(*) filter (where astrion_position = 'subcontractor')::text        as subcontractor,
            count(*) filter (where astrion_position = 'none')::text                 as none,
            count(*) filter (where estimated_value is null)::text                   as without_value,
            sum(estimated_value)::text                                              as estimated_value,
            count(*) filter (where signal_class = 'recompete_window')::text          as recompete_window,
            count(*) filter (where signal_class = 'active_solicitation')::text       as active_solicitation,
            count(*) filter (where signal_class = 'shaping_target')::text            as shaping_target,
            max(generated_at)                                                       as detected_at
       from pursuit
      where signal_class <> 'market_movement'`,
  );
  return {
    total: Number(row!.total),
    prime_incumbent: Number(row!.prime_incumbent),
    subcontractor: Number(row!.subcontractor),
    none: Number(row!.none),
    without_value: Number(row!.without_value),
    estimated_value: row!.estimated_value,
    detected_at: row!.detected_at,
    recompete_window: Number(row!.recompete_window),
    active_solicitation: Number(row!.active_solicitation),
    shaping_target: Number(row!.shaping_target),
  };
}

export interface ThresholdRow {
  readonly signal_class: string;
  readonly min_strategic_fit: number;
  readonly rhythm: string;
  readonly horizon_months_from: number | null;
  readonly horizon_months_to: number | null;
}

/** BD Ops owns these rows. Spec section 13. The interface reads them, never writes them. */
export function signalThresholds(): Promise<ThresholdRow[]> {
  return query<ThresholdRow>(
    `select signal_class, min_strategic_fit, rhythm, horizon_months_from, horizon_months_to
       from signal_class_threshold order by signal_class`,
  );
}

export interface AssessmentRow {
  readonly assessment_id: string;
  readonly pursuit_id: string;
  readonly score_model_version: number;
  readonly taxonomy_version: number;
  readonly computed_at: Date;
  readonly eligibility: string;
  readonly status: string;
  readonly band: string | null;
  readonly strategic_fit: string | null;
  readonly evidence_confidence: string | null;
  readonly timing_urgency: string | null;
  readonly applicable_weight: string | null;
  readonly known_weight: string | null;
  readonly coverage: string | null;
  readonly rank_value: string | null;
}

export async function currentAssessment(pursuitId: string): Promise<AssessmentRow | null> {
  const rows = await query<AssessmentRow>(
    `select assessment_id::text, pursuit_id::text, score_model_version, taxonomy_version,
            computed_at, eligibility, status, band, strategic_fit::text,
            evidence_confidence::text, timing_urgency::text, applicable_weight::text,
            known_weight::text, coverage::text, rank_value::text
       from assessment
      where pursuit_id = $1::bigint
      order by score_model_version desc, computed_at desc
      limit 1`,
    [pursuitId],
  );
  return rows[0] ?? null;
}

export interface FactorResultRow {
  readonly factor_code: string;
  readonly factor_name: string | null;
  readonly state: string;
  readonly score: string | null;
  readonly weight_applied: string | null;
  readonly contribution: string | null;
  readonly rule_id: string;
  readonly summary: string | null;
  readonly display_order: number | null;
}

export function factorResults(assessmentId: string): Promise<FactorResultRow[]> {
  return query<FactorResultRow>(
    `select fr.factor_code, smf.factor_name, fr.state, fr.score::text,
            fr.weight_applied::text, fr.contribution::text, fr.rule_id, fr.summary,
            smf.display_order
       from factor_result fr
       join assessment a on a.assessment_id = fr.assessment_id
       left join score_model_factor smf
              on smf.score_model_version = a.score_model_version
             and smf.factor_code = fr.factor_code
      where fr.assessment_id = $1::bigint
      order by smf.display_order nulls last, fr.factor_code`,
    [assessmentId],
  );
}

export interface GateResultRow {
  readonly gate_code: string;
  readonly gate_name: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly rule_id: string;
}

export function gateResults(assessmentId: string): Promise<GateResultRow[]> {
  return query<GateResultRow>(
    `select gr.gate_code, smg.gate_name, gr.state, gr.reason, gr.rule_id
       from gate_result gr
       join assessment a on a.assessment_id = gr.assessment_id
       left join score_model_gate smg
              on smg.score_model_version = a.score_model_version
             and smg.gate_code = gr.gate_code
      where gr.assessment_id = $1::bigint
      order by smg.display_order nulls last, gr.gate_code`,
    [assessmentId],
  );
}

export interface EvidenceRow {
  readonly evidence_id: string;
  readonly factor_code: string | null;
  readonly gate_code: string | null;
  readonly source_system: string;
  readonly source_record_id: string | null;
  readonly source_uri: string | null;
  readonly displayed_value: string | null;
  readonly is_contrary: boolean;
}

export function evidenceFor(assessmentId: string): Promise<EvidenceRow[]> {
  return query<EvidenceRow>(
    `select evidence_id::text, factor_code, gate_code, source_system, source_record_id,
            source_uri, displayed_value, is_contrary
       from evidence_ref
      where assessment_id = $1::bigint
      order by is_contrary desc, evidence_id`,
    [assessmentId],
  );
}

export interface PursuitDetailRow extends UpcomingRow {
  readonly office_code: string | null;
  readonly posted_date: Date | null;
  readonly generated_by: string | null;
  readonly generated_at: Date | null;
  readonly signal_key: string | null;
  readonly snoozed_until: Date | null;
  readonly state_changed_at: Date | null;
}

export async function pursuitDetail(pursuitId: string): Promise<PursuitDetailRow | null> {
  const rows = await query<PursuitDetailRow>(
    `select p.pursuit_id::text, p.title, p.signal_class, p.related_piid, p.period_end_date,
            p.expected_solicitation_fy, p.estimated_value::text, p.astrion_position,
            p.incumbent_entity_id::text, e.canonical_name as incumbent_name,
            p.incumbent_confidence, p.agency_code, al.label as agency_label,
            p.state, p.owner, p.notice_type, p.response_date, p.posted_date,
            p.naics_code, p.psc_code, p.set_aside_code, p.notice_url, p.solicitation_number,
            p.office_code, p.generated_by, p.generated_at, p.signal_key,
            p.snoozed_until, p.state_changed_at,
            a.band, a.strategic_fit::text, a.coverage::text, a.assessment_id::text
       from pursuit p
       left join entity e on e.entity_id = p.incumbent_entity_id
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = p.agency_code
       left join assessment a
              on a.pursuit_id = p.pursuit_id
             and a.score_model_version =
                 (select score_model_version from score_model where is_current limit 1)
      where p.pursuit_id = $1::bigint`,
    [pursuitId],
  );
  return rows[0] ?? null;
}

/** Which profile rows caused this notice to be fetched. The answer to "why is this here". */
export function profileMatches(pursuitId: string): Promise<
  { code_type: string; code_value: string; label: string | null; matched_on: string; origin: string }[]
> {
  return query(
    `select op.code_type, op.code_value, op.label, m.matched_on, op.origin
       from pursuit_profile_match m
       join opportunity_profile op on op.profile_id = m.profile_id
      where m.pursuit_id = $1::bigint
      order by m.matched_on, op.code_value`,
    [pursuitId],
  );
}

/* ================================================================ pipeline */

export interface PipelineRow {
  readonly pursuit_id: string;
  readonly signal_class: string;
  readonly title: string;
  readonly state: string;
  readonly owner: string | null;
  readonly snoozed_until: Date | null;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly solicitation_number: string | null;
  readonly related_piid: string | null;
  readonly estimated_value: string | null;
  readonly due_date: Date | null;
  readonly response_date: Date | null;
  readonly period_end_date: Date | null;
  readonly astrion_position: string | null;
  readonly band: string | null;
  readonly strategic_fit: string | null;
  readonly coverage: string | null;
  readonly note_count: string;
  readonly is_snoozed: boolean;
  readonly is_unclaimed: boolean;
  readonly is_closed: boolean;
}

const PIPELINE_SELECT = `
  select i.pursuit_id::text, i.signal_class, i.title, i.state, i.owner, i.snoozed_until,
         i.agency_code, al.label as agency_label, i.solicitation_number, i.related_piid,
         i.estimated_value::text, i.due_date, i.response_date, i.period_end_date,
         i.astrion_position, i.band, i.strategic_fit::text, i.coverage::text,
         i.note_count::text, i.is_snoozed, i.is_unclaimed, i.is_closed
    from pipeline_item i
    left join code_label_current al
           on al.code_type = 'agency' and al.code_value = i.agency_code`;

/**
 * The pipeline, filtered the way business development thinks about it.
 *
 * `view` is the saved question rather than a column filter: "mine", "unclaimed", "due"
 * and "closed" are the four things anybody actually asks of a queue, and spelling them
 * out here keeps the same definition behind the dashboard card and the full list.
 */
const PIPELINE_FILTER = `
  ($1 = '' or i.title ilike '%' || $1 || '%'
           or i.solicitation_number ilike '%' || $1 || '%'
           or i.related_piid ilike '%' || $1 || '%'
           or i.agency_code ilike '%' || $1 || '%')
  and ($2 = '' or i.signal_class = $2)
  and ($3 = '' or i.band = $3)
  and (case $4
         when 'mine'      then i.owner = $5 and not i.is_closed
         when 'unclaimed' then i.is_unclaimed and not i.is_snoozed
         when 'due'       then i.due_date is not null
                               and i.due_date <= current_date + interval '45 days'
                               and not i.is_closed and not i.is_snoozed
         when 'snoozed'   then i.is_snoozed
         when 'closed'    then i.is_closed
         else not i.is_closed and not i.is_snoozed
       end)`;

export function pipeline(
  search: string,
  signalClass: string,
  band: string,
  view: string,
  principal: string,
  sort: string,
  limit: number,
  offset: number,
): Promise<Page<PipelineRow>> {
  return paged<PipelineRow>(
    `${PIPELINE_SELECT}
      where ${PIPELINE_FILTER}
      order by
        case when $6 = 'fit' then i.strategic_fit end desc nulls last,
        case when $6 = 'value' then i.estimated_value end desc nulls last,
        i.due_date asc nulls last, i.pursuit_id
      limit $7 offset $8`,
    `select count(*)::text as n from pipeline_item i where ${PIPELINE_FILTER}`,
    [search, signalClass, band, view, principal, sort],
    limit,
    offset,
    [search, signalClass, band, view, principal],
  );
}

export interface PipelineCounts {
  readonly open: number;
  readonly mine: number;
  readonly unclaimed: number;
  readonly due_45: number;
  readonly overdue: number;
  readonly snoozed: number;
  readonly won: number;
  readonly lost: number;
  readonly pursuing: number;
  readonly pipeline_value: string | null;
  readonly unscored: number;
}

export async function pipelineCounts(principal: string): Promise<PipelineCounts> {
  const [row] = await query<Record<keyof PipelineCounts, string | null>>(
    `select
       count(*) filter (where not is_closed and not is_snoozed)::text                     as open,
       count(*) filter (where owner = $1 and not is_closed)::text                         as mine,
       count(*) filter (where is_unclaimed and not is_snoozed)::text                      as unclaimed,
       count(*) filter (where due_date is not null and due_date between current_date
                              and current_date + interval '45 days' and not is_closed
                              and not is_snoozed)::text                                   as due_45,
       count(*) filter (where due_date is not null and due_date < current_date
                              and not is_closed)::text                                    as overdue,
       count(*) filter (where is_snoozed)::text                                           as snoozed,
       count(*) filter (where state = 'won')::text                                        as won,
       count(*) filter (where state = 'lost')::text                                       as lost,
       count(*) filter (where state = 'pursuing')::text                                   as pursuing,
       sum(estimated_value) filter (where not is_closed and not is_snoozed)::text         as pipeline_value,
       count(*) filter (where band is null and not is_closed)::text                       as unscored
     from pipeline_item`,
    [principal],
  );
  const n = (key: keyof PipelineCounts) => Number(row![key] ?? 0);
  return {
    open: n('open'),
    mine: n('mine'),
    unclaimed: n('unclaimed'),
    due_45: n('due_45'),
    overdue: n('overdue'),
    snoozed: n('snoozed'),
    won: n('won'),
    lost: n('lost'),
    pursuing: n('pursuing'),
    pipeline_value: row!.pipeline_value,
    unscored: n('unscored'),
  };
}

/** The pipeline broken down by working state, for the funnel card. */
export function pipelineByState(): Promise<{ state: string; n: string; value: string | null }[]> {
  return query(
    `select state, count(*)::text as n, sum(estimated_value)::text as value
       from pipeline_item where not is_closed group by state`,
  );
}

/** Where the work is concentrated. The answer to "who should we be talking to". */
export function pipelineByAgency(limit = 8): Promise<
  { agency_code: string; label: string | null; n: string; value: string | null }[]
> {
  return query(
    `select i.agency_code, max(al.label) as label, count(*)::text as n,
            sum(i.estimated_value)::text as value
       from pipeline_item i
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = i.agency_code
      where not i.is_closed and i.agency_code is not null
      group by i.agency_code
      order by count(*) desc
      limit $1`,
    [limit],
  );
}

export interface NoteRow {
  readonly note_id: string;
  readonly author: string;
  readonly body: string;
  readonly created_at: Date;
}

export function notesFor(pursuitId: string): Promise<NoteRow[]> {
  return query<NoteRow>(
    `select note_id::text, author, body, created_at
       from pursuit_note where pursuit_id = $1::bigint order by created_at desc`,
    [pursuitId],
  );
}

export interface AuditRow {
  readonly actor: string;
  readonly action: string;
  readonly object_type: string;
  readonly object_key: string;
  readonly reason: string | null;
  readonly occurred_at: Date;
  readonly title: string | null;
}

/** What people have been doing. The team-activity card, and the record's own history. */
export function recentActivity(limit = 25, pursuitId?: string): Promise<AuditRow[]> {
  return query<AuditRow>(
    `select a.actor, a.action, a.object_type, a.object_key, a.reason, a.occurred_at,
            p.title
       from audit_log a
       left join pursuit p
              on a.object_type = 'pursuit' and p.pursuit_id = a.object_key::bigint
      where ($2::text is null or (a.object_type = 'pursuit' and a.object_key = $2))
      order by a.occurred_at desc
      limit $1`,
    [limit, pursuitId ?? null],
  );
}

/** People who have signed in, so work can be assigned to somebody who is not here now. */
export function assignableUsers(): Promise<{ principal_name: string; display_name: string | null }[]> {
  return query(
    `select principal_name, display_name from app_user where active
      order by coalesce(display_name, principal_name)`,
  );
}

/* ============================================================ review queue */

export interface ReviewRow {
  readonly queue_id: string;
  readonly vendor_name_raw: string;
  readonly vendor_name_normalized: string | null;
  readonly uei_observed: string | null;
  readonly cage_observed: string | null;
  readonly source_system: string | null;
  readonly furthest_step: string | null;
  readonly occurrence_count: number | null;
  readonly first_seen_at: Date | null;
  readonly last_seen_at: Date | null;
  readonly state: string;
}

export function reviewQueue(state: string, limit: number, offset: number): Promise<Page<ReviewRow>> {
  const filter = `($1 = '' or v.state = $1)`;
  return paged<ReviewRow>(
    `select v.queue_id::text, v.vendor_name_raw, v.vendor_name_normalized, v.uei_observed,
            v.cage_observed, v.source_system, v.furthest_step, v.occurrence_count,
            v.first_seen_at, v.last_seen_at, v.state
       from vendor_review_queue v
      where ${filter}
      order by coalesce(v.occurrence_count, 0) desc, v.vendor_name_raw
      limit $2 offset $3`,
    `select count(*)::text as n from vendor_review_queue v where ${filter}`,
    [state],
    limit,
    offset,
  );
}

export interface MergeCandidateRow {
  readonly candidate_id: string;
  readonly name_a: string;
  readonly name_b: string;
  readonly entity_id_a: string;
  readonly entity_id_b: string;
  readonly match_basis: string | null;
  readonly match_detail: string | null;
  readonly state: string;
  readonly created_at: Date;
}

export function mergeCandidates(limit = 100): Promise<MergeCandidateRow[]> {
  return query<MergeCandidateRow>(
    `select m.candidate_id::text, a.canonical_name as name_a, b.canonical_name as name_b,
            m.entity_id_a::text, m.entity_id_b::text, m.match_basis, m.match_detail,
            m.state, m.created_at
       from entity_merge_candidate m
       join entity a on a.entity_id = m.entity_id_a
       join entity b on b.entity_id = m.entity_id_b
      where m.state = 'open'
      order by m.candidate_id
      limit $1`,
    [limit],
  );
}

/* ============================================================= data quality */

export interface CollapseSummary {
  readonly distinct_payloads: string | null;
  readonly contract_actions: string | null;
  readonly keys_affected: string | null;
  readonly payloads_overwritten: string | null;
  readonly obligation_all_payloads: string | null;
  readonly obligation_not_in_contract_action: string | null;
}

export async function collapseSummary(): Promise<CollapseSummary | null> {
  const rows = await query<CollapseSummary>(
    `select distinct_payloads::text, contract_actions::text, keys_affected::text,
            payloads_overwritten::text, obligation_all_payloads::text,
            obligation_not_in_contract_action::text
       from fpds_collapse_summary`,
  );
  return rows[0] ?? null;
}

export interface CollisionRow {
  readonly identifier_type: string;
  readonly identifier_value: string;
  readonly entity_count: string;
  readonly entity_names: string | null;
  readonly distinct_parent_count: string | null;
}

export function identifierCollisions(limit = 50): Promise<CollisionRow[]> {
  return query<CollisionRow>(
    `select identifier_type, identifier_value, entity_count::text,
            entity_names, distinct_parent_count::text
       from identifier_collision
      order by entity_count desc, identifier_value
      limit $1`,
    [limit],
  );
}

export interface AliasConflictRow {
  readonly alias_name_normalized: string;
  readonly entity_count: string;
  readonly spellings: string | null;
}

export function aliasConflicts(limit = 50): Promise<AliasConflictRow[]> {
  return query<AliasConflictRow>(
    `select alias_name_normalized, entity_count::text, spellings
       from alias_normalization_conflict
      order by entity_count desc, alias_name_normalized
      limit $1`,
    [limit],
  );
}

export interface UnplacedEdgeRow {
  readonly edge_id: string;
  readonly prime_name_raw: string | null;
  readonly sub_name_raw: string | null;
  readonly value_usd: string | null;
  readonly award_date: Date | null;
  readonly agency_name: string | null;
}

export function unplacedEdges(limit = 50): Promise<UnplacedEdgeRow[]> {
  return query<UnplacedEdgeRow>(
    `select edge_id::text, prime_name_raw, sub_name_raw, value_usd::text, award_date, agency_name
       from subcontract_edge_unplaced
      order by value_usd desc nulls last, edge_id
      limit $1`,
    [limit],
  );
}

export interface DisputedLabelRow {
  readonly code_type: string;
  readonly code_value: string;
  readonly label_count: string;
  readonly labels: string | null;
  readonly current_label: string | null;
}

export function disputedLabels(limit = 50): Promise<DisputedLabelRow[]> {
  return query<DisputedLabelRow>(
    `select code_type, code_value, label_count::text, labels::text, current_label
       from code_label_disputed
      order by label_count desc, code_type, code_value
      limit $1`,
    [limit],
  );
}

export interface RoleConflictRow {
  readonly dacis_contract_id: string;
  readonly contract_number: string | null;
  readonly title: string | null;
  readonly roles_asserted: string | null;
  readonly source_files: string | null;
}

export function roleConflicts(limit = 50): Promise<RoleConflictRow[]> {
  return query<RoleConflictRow>(
    `select dacis_contract_id::text, contract_number, title,
            roles_asserted::text, source_files::text
       from dacis_contract_role_conflict
      order by dacis_contract_id
      limit $1`,
    [limit],
  );
}

/** Counts for the data-quality tiles, so a clean database says so in one line. */
export interface QualityCounts {
  readonly collisions: string;
  readonly alias_conflicts: string;
  readonly unplaced_edges: string;
  readonly disputed_labels: string;
  readonly role_conflicts: string;
  readonly unresolved_actions: string;
}

export async function qualityCounts(): Promise<QualityCounts> {
  const [row] = await query<QualityCounts>(
    `select (select count(*)::text from identifier_collision)              as collisions,
            (select count(*)::text from alias_normalization_conflict)      as alias_conflicts,
            (select count(*)::text from subcontract_edge_unplaced)         as unplaced_edges,
            (select count(*)::text from code_label_disputed)               as disputed_labels,
            (select count(*)::text from dacis_contract_role_conflict)      as role_conflicts,
            (select count(*)::text from contract_action where entity_id is null) as unresolved_actions`,
  );
  return row!;
}
