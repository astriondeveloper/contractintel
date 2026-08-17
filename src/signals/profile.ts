/**
 * Building the opportunity profile: the codes worth searching SAM.gov for.
 *
 * Two sources, and the difference between them matters.
 *
 * **The taxonomy** is what BD says the company does. `capability_taxonomy_seed.csv` carries
 * a PSC, NAICS and agency crosswalk on every capability node, and those land in
 * `node_crosswalk`. It is intent: it includes work the company wants and may not yet hold.
 *
 * **The corpus** is what the company has actually been paid for. NAICS and PSC codes on
 * Astrion's own contract actions, and the agencies that awarded them. It is evidence: it
 * catches work the taxonomy has not caught up with, and it cannot flatter itself.
 *
 * Both are kept, tagged by origin, because a code that appears in both is a stronger
 * statement than a code in either. Neither is trusted until BD Ops confirms the row, in
 * the same way a seeded taxonomy node is not trusted. Spec section 20.
 *
 * A minimum action count applies to the observed side and nothing else. One contract under
 * a NAICS code is as likely to be a mis-coded transaction as a line of business, and a
 * profile built from every code the corpus has ever touched is the firehose this exists to
 * avoid.
 */
import type { PoolClient } from 'pg';

/**
 * How many of Astrion's own contract actions a code needs before the corpus is taken to be
 * saying something. Below this it is noise, a mis-code, or a one-off.
 */
export const MIN_OBSERVED_ACTIONS = 5;

export interface BuildProfileOptions {
  readonly minObservedActions?: number;
  /** Work it out, write nothing. */
  readonly dryRun?: boolean;
  /** Skip the corpus side. Useful before any corpus is loaded. */
  readonly taxonomyOnly?: boolean;
}

export interface ProfileCount {
  readonly code_type: string;
  readonly origin: string;
  readonly n: number;
}

export interface BuildProfileResult {
  readonly counts: ProfileCount[];
  readonly total: number;
  readonly effective: number;
}

/**
 * Codes from the capability taxonomy.
 *
 * `node_crosswalk.crosswalk_type` uses the same vocabulary as `opportunity_profile`
 * except for `office_freetext`, which is prose rather than a code and cannot be searched
 * on, so it is excluded rather than stored as an unusable row.
 */
const FROM_TAXONOMY = `
  insert into opportunity_profile (code_type, code_value, label, origin, node_id)
  select distinct nc.crosswalk_type, nc.crosswalk_value, t.node_name, 'taxonomy', nc.node_id
    from node_crosswalk nc
    join taxonomy_node t on t.node_id = nc.node_id
   where nc.crosswalk_type in ('naics', 'psc', 'agency')
     and t.active
     and coalesce(nc.crosswalk_value, '') <> ''
  on conflict (code_type, code_value, origin, node_id) do update set
     label   = excluded.label,
     node_id = excluded.node_id`;

/**
 * Codes the corpus shows Astrion working under.
 *
 * Scoped to the Astrion family through the entity rollup, which is the whole point of the
 * entity map: filtering on the legal name would find 0.7 percent of the history, which is
 * the failure acceptance test 1 exists to catch.
 */
const FROM_CORPUS_CLASSIFICATION = `
  insert into opportunity_profile
    (code_type, code_value, origin, observed_actions, observed_obligations, observed_last_fy)
  select cac.code_type,
         cac.code_value,
         'observed',
         count(*)::int,
         sum(ca.action_obligation),
         max(cie_fiscal_year(ca.signed_date))
    from contract_action_classification cac
    join contract_action ca on ca.contract_action_id = cac.contract_action_id
    join entity e on e.entity_id = ca.entity_id
   where coalesce(e.ultimate_parent_id, e.entity_id) =
         (select entity_id from entity where canonical_name = 'Astrion')
     and coalesce(cac.code_value, '') <> ''
   group by cac.code_type, cac.code_value
  having count(*) >= $1
  on conflict (code_type, code_value, origin, node_id) do update set
     observed_actions     = excluded.observed_actions,
     observed_obligations = excluded.observed_obligations,
     observed_last_fy     = excluded.observed_last_fy`;

const FROM_CORPUS_AGENCY = `
  insert into opportunity_profile
    (code_type, code_value, label, origin, observed_actions, observed_obligations, observed_last_fy)
  select 'agency',
         ca.awarding_agency_code,
         max(al.label),
         'observed',
         count(*)::int,
         sum(ca.action_obligation),
         max(cie_fiscal_year(ca.signed_date))
    from contract_action ca
    join entity e on e.entity_id = ca.entity_id
    left join code_label_current al
           on al.code_type = 'agency' and al.code_value = ca.awarding_agency_code
   where coalesce(e.ultimate_parent_id, e.entity_id) =
         (select entity_id from entity where canonical_name = 'Astrion')
     and coalesce(ca.awarding_agency_code, '') <> ''
   group by ca.awarding_agency_code
  having count(*) >= $1
  on conflict (code_type, code_value, origin, node_id) do update set
     label                = excluded.label,
     observed_actions     = excluded.observed_actions,
     observed_obligations = excluded.observed_obligations,
     observed_last_fy     = excluded.observed_last_fy`;

/**
 * Set-asides Astrion has actually been awarded under.
 *
 * This one is not a search filter, it is gate input. A notice reserved for a category the
 * company does not hold is ineligible rather than low scoring, and the score model's
 * set_aside gate needs to know which categories those are. Recording what the corpus shows
 * is a starting point BD Ops corrects, not an assertion about the company's status.
 */
const FROM_CORPUS_SET_ASIDE = `
  insert into opportunity_profile
    (code_type, code_value, origin, observed_actions, observed_obligations, observed_last_fy)
  select 'set_aside', ca.set_aside_type, 'observed',
         count(*)::int, sum(ca.action_obligation), max(cie_fiscal_year(ca.signed_date))
    from contract_action ca
    join entity e on e.entity_id = ca.entity_id
   where coalesce(e.ultimate_parent_id, e.entity_id) =
         (select entity_id from entity where canonical_name = 'Astrion')
     and coalesce(ca.set_aside_type, '') <> ''
   group by ca.set_aside_type
  having count(*) >= $1
  on conflict (code_type, code_value, origin, node_id) do update set
     observed_actions     = excluded.observed_actions,
     observed_obligations = excluded.observed_obligations,
     observed_last_fy     = excluded.observed_last_fy`;

export async function buildProfile(
  client: PoolClient,
  options: BuildProfileOptions = {},
): Promise<BuildProfileResult> {
  const minimum = options.minObservedActions ?? MIN_OBSERVED_ACTIONS;

  if (options.dryRun !== true) {
    await client.query(FROM_TAXONOMY);
    if (options.taxonomyOnly !== true) {
      await client.query(FROM_CORPUS_CLASSIFICATION, [minimum]);
      await client.query(FROM_CORPUS_AGENCY, [minimum]);
      await client.query(FROM_CORPUS_SET_ASIDE, [minimum]);
    }
  }

  const { rows: counts } = await client.query<{ code_type: string; origin: string; n: string }>(
    `select code_type, origin, count(*)::text as n
       from opportunity_profile where active
      group by code_type, origin order by code_type, origin`,
  );
  const { rows: effective } = await client.query<{ n: string }>(
    'select count(*)::text as n from opportunity_profile_effective',
  );

  return {
    counts: counts.map((c) => ({ code_type: c.code_type, origin: c.origin, n: Number(c.n) })),
    total: counts.reduce((sum, c) => sum + Number(c.n), 0),
    effective: Number(effective[0]?.n ?? 0),
  };
}

export interface ProfileCode {
  readonly code_type: string;
  readonly code_value: string;
  readonly label: string | null;
  readonly origins: string[];
  readonly profile_ids: string[];
}

/** The active codes of one type, with the profile rows behind each so a match is traceable. */
export async function profileCodes(client: PoolClient, codeType: string): Promise<ProfileCode[]> {
  const { rows } = await client.query<ProfileCode>(
    `select p.code_type, p.code_value, max(p.label) as label,
            array_agg(distinct p.origin order by p.origin) as origins,
            array_agg(p.profile_id::text)                  as profile_ids
       from opportunity_profile p
      where p.active and p.code_type = $1
      group by p.code_type, p.code_value
      order by p.code_value`,
    [codeType],
  );
  return rows;
}
