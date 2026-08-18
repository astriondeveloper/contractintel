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

export interface RequirementRow {
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

export interface RequirementSummary {
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

export async function requirementSummary(): Promise<RequirementSummary> {
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

export interface PursuitDetailRow extends RequirementRow {
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

/**
 * What people have been doing.
 *
 * `object_key` is the pursuit id for anything about a requirement, whether the row was written by a
 * per-person action, a note, or something else, so one join reaches the title in all three cases.
 *
 * The cast is wrapped in a `case` and that is load bearing rather than tidy. `audit_log.object_key`
 * is text because the trail covers several kinds of object, and a follow row keys on a follow id
 * while a read mark keys on a principal name. A predicate written as
 * `object_type = 'pursuit' and pursuit_id = object_key::bigint` reads as though the type check
 * happens first, and Postgres is under no obligation to evaluate it that way: it is free to
 * evaluate the cast against every row and fail on the first email address it meets. A `case` fixes
 * the order, and the guard makes a non-numeric key join to nothing instead of throwing.
 */
export function recentActivity(limit = 25, pursuitId?: string): Promise<AuditRow[]> {
  return query<AuditRow>(
    `select a.actor, a.action, a.object_type, a.object_key, a.reason, a.occurred_at,
            p.title
       from audit_log a
       left join pursuit p
              on p.pursuit_id = (case
                                   when a.object_type in ('pursuit', 'pursuit_action', 'pursuit_note')
                                    and a.object_key ~ '^\\d{1,19}$'
                                   then a.object_key::bigint
                                 end)
      where ($2::text is null
             or (a.object_type in ('pursuit', 'pursuit_action', 'pursuit_note')
                 and a.object_key = $2))
      order by a.occurred_at desc
      limit $1`,
    [limit, pursuitId ?? null],
  );
}

/* ===================================================================== feed */

/**
 * The feed, and why it is a different query from the pipeline it replaces.
 *
 * A pipeline query starts from every pursuit and filters. A feed query starts from one person's
 * follows and finds what they match, which is a different question with a different shape: the
 * driving table is `follow_pursuit`, not `pursuit`.
 *
 * Two consequences worth stating.
 *
 * A requirement matched by four of somebody's follows must appear once, not four times, and the
 * four reasons have to survive the collapse: "why is this in my feed" is the first thing anybody
 * asks of a list they did not curate, and `matched_by` is the answer. So the matches are
 * aggregated per requirement before the join rather than de-duplicated after it.
 *
 * The per-person action state is a left join and not a filter. A dismissed requirement is
 * excluded by the view, not by its absence from the data: a person who dismisses something has
 * to be able to find it again, and a row that vanishes leaves nothing to look for.
 */
export interface FeedRow {
  readonly pursuit_id: string;
  readonly signal_class: string;
  readonly title: string;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly office_code: string | null;
  readonly solicitation_number: string | null;
  readonly related_piid: string | null;
  readonly notice_type: string | null;
  readonly notice_url: string | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly set_aside_code: string | null;
  readonly estimated_value: string | null;
  readonly response_date: Date | null;
  readonly posted_date: Date | null;
  readonly period_end_date: Date | null;
  readonly key_date: Date | null;
  readonly astrion_position: string | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_name: string | null;
  readonly first_seen_at: Date;
  readonly band: string | null;
  readonly strategic_fit: string | null;
  readonly follow_count: number;
  readonly matched_by: string;
  readonly is_new: boolean;
  readonly tracked: boolean;
  readonly dismissed: boolean;
  readonly sent: boolean;
  readonly sent_by_anyone: number;
}

/**
 * How far back "new" reaches for somebody who has never marked the feed read.
 *
 * Fourteen days. Long enough that a person who checks fortnightly sees a full picture on their
 * first visit, short enough that the first visit is not the entire corpus declared new. Once
 * they mark it read, their own mark takes over and this stops mattering.
 */
export const DEFAULT_NEW_WINDOW_DAYS = 14;

export type FeedView = 'new' | 'patch' | 'tracked' | 'dismissed' | 'sent' | 'everything';

/**
 * The follow matches for one person, collapsed to one row per requirement.
 *
 * `everything` widens the scope past the person's follows deliberately. Somebody with no follows
 * yet has an empty patch and no way to discover what is worth following, and an empty first
 * screen is how a tool nobody has to use stops being used. The screen labels it as the whole
 * market rather than their patch, so the two are never confused.
 */
const FEED_SOURCE = `
  with matches as (
    select fp.pursuit_id,
           count(distinct fp.follow_id)::int                              as follow_count,
           -- The follow's own name, not the code that matched, because the person chose the name.
           -- The code is appended only when it adds something: following a capability and matching
           -- on one of its NAICS codes is worth spelling out, whereas following office 5700/ZOFF02
           -- and matching on office 5700/ZOFF02 says the same thing twice.
           string_agg(distinct
             fp.follow_type || ' ' || coalesce(f.label, f.target)
             || case
                  when fp.matched_field = fp.follow_type
                    or fp.matched_value = coalesce(f.label, f.target)
                    or fp.matched_value is null
                  then ''
                  else ' via ' || fp.matched_field || ' ' || fp.matched_value
                end,
             ', ')                                                        as matched_by
      from follow_pursuit fp
      join follow f on f.follow_id = fp.follow_id
     where fp.principal_name = $1
     group by fp.pursuit_id
  ),
  mine as (
    select pa.pursuit_id,
           bool_or(pa.action = 'track')   as tracked,
           bool_or(pa.action = 'dismiss') as dismissed,
           bool_or(pa.action = 'sent')    as sent
      from pursuit_action pa
     where pa.principal_name = $1
     group by pa.pursuit_id
  )
  select i.pursuit_id::text, i.signal_class, i.title, i.agency_code, al.label as agency_label,
         i.office_code, i.solicitation_number, i.related_piid, i.notice_type, i.notice_url,
         i.naics_code, i.psc_code, i.set_aside_code, i.estimated_value::text,
         i.response_date, i.posted_date, i.period_end_date, i.key_date,
         i.astrion_position, i.incumbent_entity_id::text, e.canonical_name as incumbent_name,
         i.first_seen_at, i.band, i.strategic_fit::text,
         coalesce(m.follow_count, 0)                as follow_count,
         coalesce(m.matched_by, 'not in your patch') as matched_by,
         -- New *to you*, which requires it to be in your patch at all.
         --
         -- The follow test is not decoration. "New" is a patch-scoped idea everywhere else on this
         -- screen: the New tab, its count, and the "new since you looked" figure all require a follow
         -- match, because somebody with no follows has no patch for anything to be new in. Without the
         -- test here, the Everything tab badged every row New while the tab beside it read New (0) —
         -- the same word meaning two things eight pixels apart.
         --
         -- The fix is this direction rather than relaxing the tabs, because the empty-patch case is a
         -- deliberate design decision with its own test: the everything view is the fallback that
         -- keeps a day-one screen useful, and the patch view staying empty is what makes a follow
         -- matching nothing visible as a dead follow rather than hidden behind a full screen.
         (i.first_seen_at > $2::timestamptz and m.pursuit_id is not null) as is_new,
         coalesce(mine.tracked, false)               as tracked,
         coalesce(mine.dismissed, false)             as dismissed,
         coalesce(mine.sent, false)                  as sent,
         (select count(*)::int from pursuit_action pa2
           where pa2.pursuit_id = i.pursuit_id and pa2.action = 'sent') as sent_by_anyone
    from feed_item i
    left join matches m on m.pursuit_id = i.pursuit_id
    left join mine on mine.pursuit_id = i.pursuit_id
    left join entity e on e.entity_id = i.incumbent_entity_id
    left join code_label_current al
           on al.code_type = 'agency' and al.code_value = i.agency_code`;

/**
 * The saved questions, spelled out rather than assembled from column filters.
 *
 * `new` and `patch` both exclude what the person has dismissed, because dismissing something is
 * how they say "not mine, stop showing me this" and a feed that keeps showing it has ignored the
 * only instruction it was given. `dismissed` is the view that gets it back.
 */
const FEED_FILTER = `
  ($4 = '' or i.title ilike '%' || $4 || '%'
           or i.solicitation_number ilike '%' || $4 || '%'
           or i.related_piid ilike '%' || $4 || '%'
           or i.naics_code ilike '%' || $4 || '%'
           or i.psc_code ilike '%' || $4 || '%'
           or i.agency_code ilike '%' || $4 || '%'
           or e.canonical_name ilike '%' || $4 || '%')
  and ($5 = '' or i.signal_class = $5)
  and ($6 = '' or i.astrion_position = $6)
  and (case $3
         when 'new'        then m.pursuit_id is not null
                                and i.first_seen_at > $2::timestamptz
                                and not coalesce(mine.dismissed, false)
         when 'patch'      then m.pursuit_id is not null
                                and not coalesce(mine.dismissed, false)
         when 'tracked'    then coalesce(mine.tracked, false)
         when 'dismissed'  then coalesce(mine.dismissed, false)
         when 'sent'       then coalesce(mine.sent, false)
         when 'everything' then true
         else m.pursuit_id is not null
       end)`;

/**
 * The two CTEs the count query needs, which are the two the list query needs.
 *
 * Repeated rather than derived from the list SQL by string surgery. A regex over a query is a
 * regex that stops matching the day somebody reformats the query, and the failure is a pager
 * that disagrees with its own table.
 */
const FEED_CTES = `
  with matches as (
    select fp.pursuit_id, count(distinct fp.follow_id)::int as follow_count
      from follow_pursuit fp
     where fp.principal_name = $1
     group by fp.pursuit_id
  ),
  mine as (
    select pa.pursuit_id,
           bool_or(pa.action = 'track')   as tracked,
           bool_or(pa.action = 'dismiss') as dismissed,
           bool_or(pa.action = 'sent')    as sent
      from pursuit_action pa
     where pa.principal_name = $1
     group by pa.pursuit_id
  )`;

export function feed(
  principal: string,
  seenThrough: Date,
  view: FeedView,
  search: string,
  signalClass: string,
  position: string,
  sort: string,
  limit: number,
  offset: number,
): Promise<Page<FeedRow>> {
  const params = [principal, seenThrough, view, search, signalClass, position];
  return paged<FeedRow>(
    `${FEED_SOURCE}
      where ${FEED_FILTER}
      order by
        case when $7 = 'newest' then i.first_seen_at end desc nulls last,
        case when $7 = 'fit'    then i.strategic_fit end desc nulls last,
        case when $7 = 'value'  then i.estimated_value end desc nulls last,
        i.key_date asc nulls last, i.pursuit_id
      limit $8 offset $9`,
    `${FEED_CTES}
     select count(*)::text as n
       from feed_item i
       left join matches m on m.pursuit_id = i.pursuit_id
       left join mine on mine.pursuit_id = i.pursuit_id
       left join entity e on e.entity_id = i.incumbent_entity_id
      where ${FEED_FILTER}`,
    [...params, sort],
    limit,
    offset,
    params,
  );
}

export interface FeedCounts {
  readonly follows: number;
  readonly in_patch: number;
  readonly new_since: number;
  readonly tracked: number;
  readonly dismissed: number;
  readonly sent: number;
  readonly everything: number;
  readonly sent_all_time: number;
  readonly sent_team_all_time: number;
}

export async function feedCounts(principal: string, seenThrough: Date): Promise<FeedCounts> {
  const [row] = await query<Record<keyof FeedCounts, string | null>>(
    `with matches as (
       select distinct fp.pursuit_id from follow_pursuit fp where fp.principal_name = $1
     ),
     mine as (
       select pa.pursuit_id,
              bool_or(pa.action = 'track')   as tracked,
              bool_or(pa.action = 'dismiss') as dismissed,
              bool_or(pa.action = 'sent')    as sent
         from pursuit_action pa
        where pa.principal_name = $1
        group by pa.pursuit_id
     )
     select
       (select count(*)::text from follow where principal_name = $1)                as follows,
       count(*) filter (where m.pursuit_id is not null
                          and not coalesce(mine.dismissed, false))::text            as in_patch,
       count(*) filter (where m.pursuit_id is not null
                          and i.first_seen_at > $2::timestamptz
                          and not coalesce(mine.dismissed, false))::text            as new_since,
       count(*) filter (where coalesce(mine.tracked, false))::text                  as tracked,
       count(*) filter (where coalesce(mine.dismissed, false))::text                as dismissed,
       count(*) filter (where coalesce(mine.sent, false))::text                     as sent,
       count(*)::text                                                              as everything,
       (select count(*)::text from pursuit_action
         where action = 'sent' and principal_name = $1)                            as sent_all_time,
       (select count(*)::text from pursuit_action where action = 'sent')            as sent_team_all_time
     from feed_item i
     left join matches m on m.pursuit_id = i.pursuit_id
     left join mine on mine.pursuit_id = i.pursuit_id`,
    [principal, seenThrough],
  );
  const n = (key: keyof FeedCounts) => Number(row![key] ?? 0);
  return {
    follows: n('follows'),
    in_patch: n('in_patch'),
    new_since: n('new_since'),
    tracked: n('tracked'),
    dismissed: n('dismissed'),
    sent: n('sent'),
    everything: n('everything'),
    sent_all_time: n('sent_all_time'),
    sent_team_all_time: n('sent_team_all_time'),
  };
}

export interface Watermark {
  readonly seen_through: Date;
  readonly previous_seen_through: Date | null;
  /** False when the person has never marked the feed read and the default window is in use. */
  readonly is_set: boolean;
}

/**
 * Where this person has read up to.
 *
 * The default when there is no row is a fixed window rather than the beginning of time, because
 * a first visit that declares the whole corpus new is a first visit that tells you nothing.
 */
export async function watermarkFor(principal: string): Promise<Watermark> {
  if (principal === '') {
    return {
      seen_through: new Date(Date.now() - DEFAULT_NEW_WINDOW_DAYS * 86_400_000),
      previous_seen_through: null,
      is_set: false,
    };
  }
  const rows = await query<{ seen_through: Date; previous_seen_through: Date | null }>(
    'select seen_through, previous_seen_through from feed_watermark where principal_name = $1',
    [principal],
  );
  if (rows[0] === undefined) {
    return {
      seen_through: new Date(Date.now() - DEFAULT_NEW_WINDOW_DAYS * 86_400_000),
      previous_seen_through: null,
      is_set: false,
    };
  }
  return { ...rows[0], is_set: true };
}

/* ================================================================== follows */

export interface FollowRow {
  readonly follow_id: string;
  readonly follow_type: string;
  readonly target: string;
  readonly label: string | null;
  readonly created_at: Date;
  readonly matches: number;
  readonly new_matches: number;
  readonly forecast_matches: number;
}

/**
 * One person's follows, each with what it is currently bringing in.
 *
 * The match count is the point. A follow that matches nothing is either a code nobody buys under
 * or a typo, and the two are indistinguishable from an empty feed. Showing the count next to the
 * follow makes a dead follow visible as a dead follow.
 */
export function followsFor(principal: string, seenThrough: Date): Promise<FollowRow[]> {
  return query<FollowRow>(
    `select f.follow_id::text, f.follow_type, f.target, f.label, f.created_at,
            (select count(distinct fp.pursuit_id)::int from follow_pursuit fp
              where fp.follow_id = f.follow_id)                       as matches,
            (select count(distinct fp.pursuit_id)::int from follow_pursuit fp
               join pursuit p on p.pursuit_id = fp.pursuit_id
              where fp.follow_id = f.follow_id
                and p.created_at > $2::timestamptz)                   as new_matches,
            (select count(distinct ff.forecast_id)::int from follow_forecast ff
              where ff.follow_id = f.follow_id)                       as forecast_matches
       from follow f
      where f.principal_name = $1
      order by f.follow_type, coalesce(f.label, f.target)`,
    [principal, seenThrough],
  );
}

/** Which of this person's follows put a requirement in front of them. */
export function whyInFeed(
  pursuitId: string,
  principal: string,
): Promise<{ follow_id: string; follow_type: string; label: string | null; matched_field: string; matched_value: string | null }[]> {
  return query(
    `select distinct f.follow_id::text, fp.follow_type, f.label,
            fp.matched_field, fp.matched_value
       from follow_pursuit fp
       join follow f on f.follow_id = fp.follow_id
      where fp.pursuit_id = $1::bigint and fp.principal_name = $2
      order by fp.follow_type, fp.matched_field`,
    [pursuitId, principal],
  );
}

/**
 * What there is to follow, for the pickers on the follows screen.
 *
 * Each list is what the corpus actually contains rather than a fixed vocabulary, so a person
 * cannot follow an agency that has never appeared. `count` orders them by how much is there,
 * which is the only ordering that puts the useful choices first.
 */
export function followableCapabilities(): Promise<
  { node_key: string; node_name: string; crosswalks: number; confirmed: boolean }[]
> {
  return query(
    `select t.node_key, t.node_name,
            (select count(*)::int from node_crosswalk nc
              where nc.node_id = t.node_id
                and nc.crosswalk_type in ('naics', 'psc', 'keyword'))       as crosswalks,
            (t.confirmed_at is not null)                                    as confirmed
       from taxonomy_node t
      where t.active and t.node_type in ('capability', 'growth_priority')
      order by t.node_key`,
  );
}

export function followableAgencies(limit = 60): Promise<
  { agency_code: string; label: string | null; requirements: number }[]
> {
  return query(
    `select p.agency_code, max(al.label) as label, count(*)::int as requirements
       from feed_item p
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = p.agency_code
      where p.agency_code is not null
      group by p.agency_code
      order by count(*) desc, p.agency_code
      limit $1`,
    [limit],
  );
}

export function followableOffices(limit = 60): Promise<
  { agency_code: string; office_code: string; label: string | null; requirements: number }[]
> {
  return query(
    `select p.agency_code, p.office_code, max(al.label) as label, count(*)::int as requirements
       from feed_item p
       left join code_label_current al
              on al.code_type = 'office' and al.code_value = p.office_code
      where p.agency_code is not null and p.office_code is not null
      group by p.agency_code, p.office_code
      order by count(*) desc, p.office_code
      limit $1`,
    [limit],
  );
}

/**
 * Companies worth following: the watchlist, the corporate families, and whoever holds a
 * requirement in the corpus. The competitor watchlist is the authored answer and the incumbents
 * are the observed one, in the same spirit as the opportunity profile's two origins.
 */
export function followableCompanies(limit = 80): Promise<
  { entity_id: string; canonical_name: string; entity_type: string | null; requirements: number }[]
> {
  return query(
    `select e.entity_id::text, e.canonical_name, e.entity_type,
            (select count(*)::int from feed_item i
              where i.incumbent_entity_id = e.entity_id)                     as requirements
       from entity e
      where e.ultimate_parent_id is null
        and (e.entity_type in ('astrion_family', 'competitor')
             or exists (select 1 from feed_item i where i.incumbent_entity_id = e.entity_id))
      order by e.entity_type, e.canonical_name
      limit $1`,
    [limit],
  );
}

/* ================================================================= forecast */

export interface ForecastQuarterRow {
  readonly projected_fy: number;
  readonly projected_quarter: number;
  readonly quarter_label: string;
  readonly items: number;
  readonly high_confidence: number;
  readonly medium_confidence: number;
  readonly low_confidence: number;
  readonly vehicles: number;
  readonly already_detected: number;
  readonly prime_incumbent: number;
  readonly subcontractor: number;
  readonly value_floor_usd: string | null;
  readonly items_without_value: number;
  readonly earliest: Date;
  readonly latest: Date;
}

/**
 * The bars.
 *
 * `principal` scopes the whole thing to one person's follows, which is what makes the forecast
 * answer "what is coming in my patch" rather than "what is coming in the federal market". An
 * empty principal, or the `everything` scope, widens it and the screen says which it is showing.
 */
export function forecastQuarters(
  principal: string,
  scope: 'patch' | 'everything',
  confidence: string,
): Promise<ForecastQuarterRow[]> {
  return query<ForecastQuarterRow>(
    `select f.projected_fy, f.projected_quarter,
            cie_fiscal_quarter_label(f.projected_fy, f.projected_quarter)      as quarter_label,
            count(*)::int                                                      as items,
            count(*) filter (where f.confidence = 'high')::int                 as high_confidence,
            count(*) filter (where f.confidence = 'medium')::int               as medium_confidence,
            count(*) filter (where f.confidence = 'low')::int                  as low_confidence,
            count(*) filter (where f.basis = 'vehicle_expiry')::int            as vehicles,
            count(*) filter (where f.pursuit_id is not null)::int              as already_detected,
            count(*) filter (where f.astrion_position = 'prime_incumbent')::int as prime_incumbent,
            count(*) filter (where f.astrion_position = 'subcontractor')::int   as subcontractor,
            sum(f.estimated_value)                                             as value_floor_usd,
            count(*) filter (where f.estimated_value is null)::int             as items_without_value,
            min(f.projected_solicitation_date)                                 as earliest,
            max(f.projected_solicitation_date)                                 as latest
       from forecast_item f
      where ($2 = 'everything'
             or exists (select 1 from follow_forecast ff
                         where ff.forecast_id = f.forecast_id and ff.principal_name = $1))
        and ($3 = '' or f.confidence = $3)
      group by f.projected_fy, f.projected_quarter
      order by f.projected_fy, f.projected_quarter`,
    [principal, scope, confidence],
  );
}

export interface ForecastItemRow {
  readonly forecast_id: string;
  readonly forecast_key: string;
  readonly basis: string;
  readonly title: string;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly office_code: string | null;
  readonly related_piid: string | null;
  readonly idv_piid: string | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly incumbent_entity_id: string | null;
  readonly incumbent_name: string | null;
  readonly astrion_position: string | null;
  readonly period_end_date: Date;
  readonly lead_days: number;
  readonly projected_solicitation_date: Date;
  readonly projected_fy: number;
  readonly projected_quarter: number;
  readonly quarter_label: string;
  readonly estimated_value: string | null;
  readonly value_basis: string | null;
  readonly confidence: string;
  readonly lead_source: string;
  readonly cadence_chains: number | null;
  readonly cadence_median_days: number | null;
  readonly pursuit_id: string | null;
  readonly matched_by: string | null;
}

/** The specific contracts behind a bar. A bar nobody can open is a picture, not intelligence. */
export function forecastItems(
  principal: string,
  scope: 'patch' | 'everything',
  fy: number | null,
  quarter: number | null,
  confidence: string,
  limit: number,
  offset: number,
): Promise<Page<ForecastItemRow>> {
  const filter = `
    ($2 = 'everything'
     or exists (select 1 from follow_forecast ff
                 where ff.forecast_id = f.forecast_id and ff.principal_name = $1))
    and ($3::int is null or f.projected_fy = $3::int)
    and ($4::int is null or f.projected_quarter = $4::int)
    and ($5 = '' or f.confidence = $5)`;

  return paged<ForecastItemRow>(
    `select f.forecast_id::text, f.forecast_key, f.basis, f.title, f.agency_code,
            al.label as agency_label, f.office_code, f.related_piid, f.idv_piid,
            f.naics_code, f.psc_code, f.incumbent_entity_id::text,
            e.canonical_name as incumbent_name, f.astrion_position,
            f.period_end_date, f.lead_days, f.projected_solicitation_date,
            f.projected_fy, f.projected_quarter,
            cie_fiscal_quarter_label(f.projected_fy, f.projected_quarter) as quarter_label,
            f.estimated_value::text, f.value_basis, f.confidence, f.lead_source,
            f.cadence_chains, f.cadence_median_days, f.pursuit_id::text,
            (select string_agg(distinct ff.follow_type || ' ' || coalesce(ff.matched_value, ff.matched_field), ', ')
               from follow_forecast ff
              where ff.forecast_id = f.forecast_id and ff.principal_name = $1) as matched_by
       from forecast_item f
       left join entity e on e.entity_id = f.incumbent_entity_id
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = f.agency_code
      where ${filter}
      order by f.projected_solicitation_date, f.estimated_value desc nulls last, f.forecast_id
      limit $6 offset $7`,
    `select count(*)::text as n from forecast_item f where ${filter}`,
    [principal, scope, fy, quarter, confidence],
    limit,
    offset,
  );
}

export async function forecastItem(forecastId: string): Promise<ForecastItemRow | null> {
  const rows = await query<ForecastItemRow>(
    `select f.forecast_id::text, f.forecast_key, f.basis, f.title, f.agency_code,
            al.label as agency_label, f.office_code, f.related_piid, f.idv_piid,
            f.naics_code, f.psc_code, f.incumbent_entity_id::text,
            e.canonical_name as incumbent_name, f.astrion_position,
            f.period_end_date, f.lead_days, f.projected_solicitation_date,
            f.projected_fy, f.projected_quarter,
            cie_fiscal_quarter_label(f.projected_fy, f.projected_quarter) as quarter_label,
            f.estimated_value::text, f.value_basis, f.confidence, f.lead_source,
            f.cadence_chains, f.cadence_median_days, f.pursuit_id::text,
            null::text as matched_by
       from forecast_item f
       left join entity e on e.entity_id = f.incumbent_entity_id
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = f.agency_code
      where f.forecast_id = $1::bigint`,
    [forecastId],
  );
  return rows[0] ?? null;
}

export interface ForecastEvidenceRow {
  readonly rule_id: string;
  readonly detail: string;
  readonly supports: boolean;
  readonly source_system: string | null;
  readonly source_uri: string | null;
}

/** Contrary evidence first, on the same argument spec 14.2 makes about a score. */
export function forecastEvidence(forecastId: string): Promise<ForecastEvidenceRow[]> {
  return query<ForecastEvidenceRow>(
    `select rule_id, detail, supports, source_system, source_uri
       from forecast_evidence
      where forecast_id = $1::bigint
      order by supports, rule_id`,
    [forecastId],
  );
}

export interface ForecastState {
  readonly items: number;
  readonly generated_at: Date | null;
  readonly by_lead_source: { lead_source: string; n: number }[];
  readonly offices_with_cadence: number;
  readonly offices_with_lag: number;
}

/**
 * How much of the forecast rests on a measurement.
 *
 * The one figure that says whether the forecast should be read as intelligence or as arithmetic
 * on an assumption. It goes on the screen rather than in a log.
 */
export async function forecastState(): Promise<ForecastState> {
  const [head] = await query<{ items: string; generated_at: Date | null }>(
    'select count(*)::text as items, max(generated_at) as generated_at from forecast_item',
  );
  const bySource = await query<{ lead_source: string; n: string }>(
    'select lead_source, count(*)::text as n from forecast_item group by lead_source order by lead_source',
  );
  const [coverage] = await query<{ cadence: string; lag: string }>(
    `select (select count(*)::text from office_recompete_cadence where chains_observed >= 3) as cadence,
            (select count(*)::text from office_notice_lag where awards_matched >= 3)         as lag`,
  );
  return {
    items: Number(head!.items),
    generated_at: head!.generated_at,
    by_lead_source: bySource.map((r) => ({ lead_source: r.lead_source, n: Number(r.n) })),
    offices_with_cadence: Number(coverage!.cadence),
    offices_with_lag: Number(coverage!.lag),
  };
}

export interface BacktestRow {
  readonly backtest_id: string;
  readonly as_of_date: Date;
  readonly horizon_months: number;
  readonly tolerance_days: number;
  readonly projected: number;
  readonly hits: number;
  readonly misses: number;
  readonly unforecast: number | null;
  readonly hit_rate: string | null;
  readonly hit_rate_high: string | null;
  readonly hit_rate_medium: string | null;
  readonly hit_rate_low: string | null;
  readonly method: string;
  readonly notes: string | null;
  readonly created_at: Date;
}

/** Every scoring run, newest first. The accuracy of the forecast, such as it is known. */
export function backtests(limit = 12): Promise<BacktestRow[]> {
  return query<BacktestRow>(
    `select backtest_id::text, as_of_date, horizon_months, tolerance_days, projected, hits,
            misses, unforecast, hit_rate::text, hit_rate_high::text, hit_rate_medium::text,
            hit_rate_low::text, method, notes, created_at
       from forecast_backtest_summary
      order by created_at desc
      limit $1`,
    [limit],
  );
}

/** The offices whose rhythm the forecast has actually learned, strongest evidence first. */
export function cadenceEvidence(limit = 40): Promise<
  {
    agency_code: string;
    office_code: string;
    office_label: string | null;
    psc_code: string;
    psc_label: string | null;
    chains_observed: number;
    chains_across_vehicles: number;
    chains_incumbent_retained: number;
    median_interval_days: number | null;
    median_gap_days: number | null;
  }[]
> {
  return query(
    `select c.awarding_agency_code as agency_code, c.contracting_office_code as office_code,
            ol.label as office_label, c.psc_code, pl.label as psc_label,
            c.chains_observed, c.chains_across_vehicles, c.chains_incumbent_retained,
            c.median_interval_days, c.median_gap_days
       from office_recompete_cadence c
       left join code_label_current ol on ol.code_type = 'office' and ol.code_value = c.contracting_office_code
       left join code_label_current pl on pl.code_type = 'psc'    and pl.code_value = c.psc_code
      order by c.chains_observed desc, c.median_interval_days
      limit $1`,
    [limit],
  );
}

/* ================================================================= hand-off */

export interface HandoffRow {
  readonly pursuit_id: string;
  readonly title: string;
  readonly signal_class: string;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly office_code: string | null;
  readonly office_label: string | null;
  readonly solicitation_number: string | null;
  readonly notice_id: string | null;
  readonly related_piid: string | null;
  readonly naics_code: string | null;
  readonly naics_label: string | null;
  readonly psc_code: string | null;
  readonly psc_label: string | null;
  readonly set_aside_code: string | null;
  readonly place_of_performance_state: string | null;
  readonly estimated_value: string | null;
  readonly response_date: Date | null;
  readonly posted_date: Date | null;
  readonly period_end_date: Date | null;
  readonly notice_url: string | null;
  readonly notice_type: string | null;
  readonly incumbent_name: string | null;
  readonly incumbent_confidence: string | null;
  readonly astrion_position: string | null;
  readonly band: string | null;
  readonly strategic_fit: string | null;
  readonly capabilities: string | null;
}

/**
 * Everything the hand-off panel needs, with labels resolved.
 *
 * The labels are the reason this is its own query rather than a reuse of the feed row. A field
 * block that somebody is about to paste into TechnoMile has to carry `EXAMPLE AVIATION
 * ADMINISTRATION` and not `6920`, because the person pasting it will not look the code up and
 * the record will carry the number for ever.
 */
export function handoffRows(pursuitIds: readonly string[]): Promise<HandoffRow[]> {
  return query<HandoffRow>(
    `select p.pursuit_id::text, p.title, p.signal_class, p.agency_code, al.label as agency_label,
            p.office_code, ol.label as office_label, p.solicitation_number, p.notice_id,
            p.related_piid, p.naics_code, nl.label as naics_label, p.psc_code, pl.label as psc_label,
            p.set_aside_code, p.place_of_performance_state, p.estimated_value::text,
            p.response_date, p.posted_date, p.period_end_date, p.notice_url, p.notice_type,
            e.canonical_name as incumbent_name, p.incumbent_confidence, p.astrion_position,
            a.band, a.strategic_fit::text,
            (select string_agg(distinct t.node_name, '; ' order by t.node_name)
               from pursuit_profile_match m
               join opportunity_profile op on op.profile_id = m.profile_id
               join taxonomy_node t on t.node_id = op.node_id
              where m.pursuit_id = p.pursuit_id)                             as capabilities
       from pursuit p
       left join entity e on e.entity_id = p.incumbent_entity_id
       left join code_label_current al on al.code_type = 'agency' and al.code_value = p.agency_code
       left join code_label_current ol on ol.code_type = 'office' and ol.code_value = p.office_code
       left join code_label_current nl on nl.code_type = 'naics'  and nl.code_value = p.naics_code
       left join code_label_current pl on pl.code_type = 'psc'    and pl.code_value = p.psc_code
       left join assessment a
              on a.pursuit_id = p.pursuit_id
             and a.score_model_version =
                 (select score_model_version from score_model where is_current limit 1)
      where p.pursuit_id = any($1::bigint[])
      order by p.response_date nulls last, p.pursuit_id`,
    [pursuitIds],
  );
}

/** What one person has done about one requirement. */
export async function actionState(
  pursuitId: string,
  principal: string,
): Promise<{ tracked: boolean; dismissed: boolean; sent: boolean; sentAt: Date | null }> {
  if (principal === '') return { tracked: false, dismissed: false, sent: false, sentAt: null };
  const rows = await query<{ action: string; acted_at: Date }>(
    'select action, acted_at from pursuit_action where pursuit_id = $1::bigint and principal_name = $2',
    [pursuitId, principal],
  );
  const held = new Map(rows.map((r) => [r.action, r.acted_at]));
  return {
    tracked: held.has('track'),
    dismissed: held.has('dismiss'),
    sent: held.has('sent'),
    sentAt: held.get('sent') ?? null,
  };
}

/** Who else has done something about a requirement. Not ownership: awareness. */
export function othersOn(
  pursuitId: string,
  principal: string,
): Promise<{ principal_name: string; display_name: string | null; action: string; acted_at: Date }[]> {
  return query(
    `select pa.principal_name, u.display_name, pa.action, pa.acted_at
       from pursuit_action pa
       left join app_user u on u.principal_name = pa.principal_name
      where pa.pursuit_id = $1::bigint and pa.principal_name <> $2
      order by pa.acted_at desc`,
    [pursuitId, principal],
  );
}

export interface HandoffMetric {
  readonly sent_all_time: number;
  readonly sent_this_fy: number;
  readonly sent_last_30_days: number;
  readonly people_who_have_sent: number;
  readonly value_sent_usd: string | null;
  readonly sent_without_value: number;
  readonly median_days_before_due: number | null;
}

/**
 * Whether this tool is doing anything.
 *
 * One number matters and it is the count of requirements a person carried from here into
 * TechnoMile. Everything else on every screen could look healthy while this stayed at zero, and
 * if it does stay at zero the honest conclusion is that the tool is not earning its place.
 *
 * `median_days_before_due` is the second number: how far ahead of the response deadline the
 * hand-off happened. Being early is the entire proposition, so a median of four days would mean
 * the tool is technically working and practically useless.
 */
export async function handoffMetric(): Promise<HandoffMetric> {
  const [row] = await query<Record<string, string | null>>(
    `select count(*)::text                                                     as sent_all_time,
            count(*) filter (where fiscal_year = cie_fiscal_year(current_date))::text as sent_this_fy,
            count(*) filter (where acted_at > now() - interval '30 days')::text as sent_last_30_days,
            count(distinct principal_name)::text                               as people_who_have_sent,
            sum(estimated_value)::text                                         as value_sent_usd,
            count(*) filter (where estimated_value is null)::text              as sent_without_value,
            percentile_cont(0.5) within group (order by days_before_response_due)::text
                                                                              as median_days_before_due
       from technomile_handoff`,
  );
  return {
    sent_all_time: Number(row!.sent_all_time ?? 0),
    sent_this_fy: Number(row!.sent_this_fy ?? 0),
    sent_last_30_days: Number(row!.sent_last_30_days ?? 0),
    people_who_have_sent: Number(row!.people_who_have_sent ?? 0),
    value_sent_usd: row!.value_sent_usd ?? null,
    sent_without_value: Number(row!.sent_without_value ?? 0),
    median_days_before_due:
      row!.median_days_before_due == null ? null : Number(row!.median_days_before_due),
  };
}

/** The hand-off log: what went across, when, and by whom. */
export function handoffLog(limit = 40): Promise<
  {
    pursuit_id: string;
    title: string;
    principal_name: string;
    display_name: string | null;
    acted_at: Date;
    note: string | null;
    estimated_value: string | null;
    days_before_response_due: number | null;
    surfaced_by: string | null;
  }[]
> {
  return query(
    `select h.pursuit_id::text, h.title, h.principal_name, u.display_name, h.acted_at, h.note,
            h.estimated_value::text, h.days_before_response_due, h.surfaced_by
       from technomile_handoff h
       left join app_user u on u.principal_name = h.principal_name
      order by h.acted_at desc
      limit $1`,
    [limit],
  );
}

/** Hand-offs by week, for the shape of the line rather than a single total. */
export function handoffByWeek(weeks = 12): Promise<{ week_starting: Date; n: number }[]> {
  return query(
    `select week_starting, count(*)::int as n
       from technomile_handoff
      where week_starting > (current_date - ($1::int * 7))
      group by week_starting
      order by week_starting`,
    [weeks],
  );
}

/* ================================================================ campaigns */

export interface CampaignRow {
  readonly campaign_id: string;
  readonly campaign_name: string;
  readonly owner: string | null;
  readonly business_unit: string | null;
  readonly state: string;
  readonly tam_usd: string | null;
  readonly sam_usd: string | null;
  readonly som_usd: string | null;
  readonly capture_rate: string | null;
  readonly capture_rate_sample_size: number | null;
  readonly capture_rate_standing: string;
  readonly sizing_fy_from: number | null;
  readonly sizing_fy_to: number | null;
  readonly sizing_computed_at: Date | null;
  readonly nodes: string;
  readonly offices: string;
  readonly codes: string;
  readonly requirements: string;
  readonly caveats: string;
}

/**
 * Every campaign with its sizing.
 *
 * Read from `campaign_summary` rather than from `campaign`, because the view is what guarantees the
 * capture rate and its sample size arrive together. Acceptance test 9 is a display requirement and
 * the view is where it is enforced: nothing reading this can get one figure without the other.
 */
export function campaigns(): Promise<CampaignRow[]> {
  return query<CampaignRow>('select * from campaign_summary order by som_usd desc nulls last, campaign_id');
}

export async function campaign(campaignId: string): Promise<CampaignRow | null> {
  const rows = await query<CampaignRow>(
    'select * from campaign_summary where campaign_id = $1::bigint',
    [campaignId],
  );
  return rows[0] ?? null;
}

export interface CampaignEvidenceRow {
  readonly figure: string;
  readonly rule_id: string;
  readonly detail: string;
  readonly supports: boolean;
}

/** Caveats first. The corpus-is-not-the-market one is always among them. */
export function campaignEvidence(campaignId: string): Promise<CampaignEvidenceRow[]> {
  return query<CampaignEvidenceRow>(
    `select figure, rule_id, detail, supports
       from campaign_sizing_evidence
      where campaign_id = $1::bigint
      order by supports, figure, rule_id`,
    [campaignId],
  );
}

/** What a campaign competes under, and where. The scope behind every figure on the screen. */
export function campaignScope(campaignId: string): Promise<{
  nodes: { node_key: string; node_name: string }[];
  offices: { agency_code: string; office_code: string; agency_label: string | null; office_label: string | null }[];
  codes: { code_type: string; code_value: string; label: string | null }[];
}> {
  return Promise.all([
    query<{ node_key: string; node_name: string }>(
      `select t.node_key, t.node_name
         from campaign_node cn join taxonomy_node t on t.node_id = cn.node_id
        where cn.campaign_id = $1::bigint order by t.node_key`,
      [campaignId],
    ),
    query<{ agency_code: string; office_code: string; agency_label: string | null; office_label: string | null }>(
      `select co.agency_code, co.office_code, al.label as agency_label, ol.label as office_label
         from campaign_office co
         left join code_label_current al on al.code_type = 'agency' and al.code_value = co.agency_code
         left join code_label_current ol on ol.code_type = 'office' and ol.code_value = co.office_code
        where co.campaign_id = $1::bigint order by co.agency_code, co.office_code`,
      [campaignId],
    ),
    query<{ code_type: string; code_value: string; label: string | null }>(
      `select cc.code_type, cc.code_value, l.label
         from campaign_code cc
         left join code_label_current l
                on l.code_type = cc.code_type and l.code_value = cc.code_value
        where cc.campaign_id = $1::bigint order by cc.code_type, cc.code_value`,
      [campaignId],
    ),
  ]).then(([nodes, offices, codes]) => ({ nodes, offices, codes }));
}

export interface GapRow {
  readonly pursuit_id: string;
  readonly title: string;
  readonly signal_class: string;
  readonly agency_code: string | null;
  readonly agency_label: string | null;
  readonly naics_code: string | null;
  readonly psc_code: string | null;
  readonly estimated_value: string | null;
  readonly response_date: Date | null;
  readonly period_end_date: Date | null;
  readonly first_seen_at: Date;
  readonly would_match: string | null;
  readonly uncodeable: boolean;
}

/**
 * The gap report. Acceptance test 10.
 *
 * Ordered by value so the largest unclaimed work is first, which is the only ordering that makes a
 * gap report worth opening twice.
 */
export function campaignGap(limit: number, offset: number): Promise<Page<GapRow>> {
  return paged<GapRow>(
    `select g.pursuit_id::text, g.title, g.signal_class, g.agency_code, al.label as agency_label,
            g.naics_code, g.psc_code, g.estimated_value::text, g.response_date, g.period_end_date,
            g.first_seen_at, g.would_match, g.uncodeable
       from campaign_gap g
       left join code_label_current al
              on al.code_type = 'agency' and al.code_value = g.agency_code
      order by g.estimated_value desc nulls last, g.pursuit_id
      limit $1 offset $2`,
    'select count(*)::text as n from campaign_gap',
    [],
    limit,
    offset,
  );
}

export interface GapSummary {
  readonly total: number;
  readonly matchable: number;
  readonly uncodeable: number;
  readonly value_usd: string | null;
  readonly without_value: number;
}

export async function gapSummary(): Promise<GapSummary> {
  const [row] = await query<Record<string, string | null>>(
    `select count(*)::text                                              as total,
            count(*) filter (where would_match is not null)::text        as matchable,
            count(*) filter (where uncodeable)::text                     as uncodeable,
            sum(estimated_value)::text                                   as value_usd,
            count(*) filter (where estimated_value is null)::text        as without_value
       from campaign_gap`,
  );
  return {
    total: Number(row!.total ?? 0),
    matchable: Number(row!.matchable ?? 0),
    uncodeable: Number(row!.uncodeable ?? 0),
    value_usd: row!.value_usd ?? null,
    without_value: Number(row!.without_value ?? 0),
  };
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

/* ========================================================== how live the feed is */

/**
 * How live the opportunities on screen are.
 *
 * This exists because the interface could not previously tell three situations apart, and they look
 * identical from a chair: nothing matched your follows, no sync has ever run, and the API key is
 * missing so no sync can run. All three render as an empty or unchanging feed. For a tool whose entire
 * premise is seeing a requirement before anybody else, "how old is this" is not a diagnostic detail —
 * it is the first thing a person should be able to read, and the thing that decides whether they trust
 * the screen at all.
 *
 * Notice sources only. Contract and seed loaders are corpus depth rather than the live feed, and mixing
 * them in would let a fresh FPDS load make a dead notice sync look healthy.
 */
export const NOTICE_SOURCES = ['govcon_opportunity', 'sam_opportunity'] as const;

export interface NoticeSourceRow {
  readonly source_system: string;
  readonly last_success_at: Date | null;
  readonly age_seconds: number | null;
  readonly runs: number;
  readonly notices: number;
}

export interface FeedFreshness {
  readonly sources: readonly NoticeSourceRow[];
  /** The most recent successful notice run across every source, which is what "live" means. */
  readonly last_success_at: Date | null;
  readonly age_seconds: number | null;
  /** True when no notice loader has ever completed. Different from stale, and fixed differently. */
  readonly never_run: boolean;
  /** Requirements that arrived in the last day, whichever source brought them. */
  readonly landed_today: number;
  /** Where the incremental cursor got to, and whether its last run left a gap. */
  readonly cursor_at: Date | null;
  readonly cursor_clamped: boolean;
}

export async function feedFreshness(): Promise<FeedFreshness> {
  const sources = await query<NoticeSourceRow & { age_seconds: string | null; runs: string; notices: string }>(
    `select r.source_system,
            max(r.finished_at) filter (where r.status = 'succeeded')          as last_success_at,
            extract(epoch from now() - max(r.finished_at)
              filter (where r.status = 'succeeded'))::text                    as age_seconds,
            count(*) filter (where r.status = 'succeeded')::text               as runs,
            (select count(*)::text from pursuit p
              where p.generated_by = r.source_system)                         as notices
       from source_run r
      where r.source_system = any($1::text[])
      group by r.source_system
      order by r.source_system`,
    [[...NOTICE_SOURCES]],
  );

  const [extra] = await query<{
    landed_today: string;
    cursor_at: Date | null;
    cursor_clamped: boolean | null;
  }>(
    `select
       (select count(*)::text from pursuit
         where generated_by = any($1::text[]) and created_at > now() - interval '1 day') as landed_today,
       (select cursor_at from sync_cursor
         where source_system = 'govcon_opportunity' order by cursor_at desc limit 1)     as cursor_at,
       (select last_clamped from sync_cursor
         where source_system = 'govcon_opportunity' order by cursor_at desc limit 1)     as cursor_clamped`,
    [[...NOTICE_SOURCES]],
  );

  const typed: NoticeSourceRow[] = sources.map((row) => ({
    source_system: row.source_system,
    last_success_at: row.last_success_at,
    age_seconds: row.age_seconds === null ? null : Number(row.age_seconds),
    runs: Number(row.runs),
    notices: Number(row.notices),
  }));

  const withSuccess = typed.filter((row) => row.last_success_at !== null);
  // The freshest source wins. One dead source alongside one live one is not a stale feed — it is a
  // live feed with a dead fallback, which is a different message and a different fix.
  const newest = withSuccess.reduce<NoticeSourceRow | null>(
    (best, row) => (best === null || (row.age_seconds ?? Infinity) < (best.age_seconds ?? Infinity) ? row : best),
    null,
  );

  return {
    sources: typed,
    last_success_at: newest?.last_success_at ?? null,
    age_seconds: newest?.age_seconds ?? null,
    never_run: withSuccess.length === 0,
    landed_today: Number(extra?.landed_today ?? '0'),
    cursor_at: extra?.cursor_at ?? null,
    cursor_clamped: extra?.cursor_clamped === true,
  };
}
