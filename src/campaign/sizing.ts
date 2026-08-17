/**
 * Campaign sizing. Spec section 11, acceptance tests 9 and 10.
 *
 * Three figures and a rate, all derived, none aspirational:
 *
 *     TAM  obligations under the campaign's codes, any office, over the window
 *     SAM  the same, restricted to the offices the campaign says it competes in
 *     SOM  SAM times the capture rate Astrion has actually achieved in that slice
 *
 * The rate is measured rather than assumed, and it never travels without its sample size. Spec 11.2
 * asks for that and the reason is worth stating plainly: a 12 percent capture rate over four awards
 * and a 12 percent rate over four hundred are different claims, and a screen showing only the
 * percentage lets a reader treat them as the same one.
 *
 * **TAM is a floor and is labelled one.** This corpus is Astrion's history plus the watchlist
 * competitors, not every dollar every agency spent. A true addressable market is not derivable from
 * it. Computing one anyway and calling it TAM would be the single most quotable wrong number this
 * system could produce, so the caveat is written as evidence on every campaign, shown first on the
 * screen, and cannot be turned off.
 *
 * **A campaign with no offices has no SAM, and that is not an error.** SAM is the served market, and
 * a campaign that has not said where it competes has not said what it serves. The figure comes back
 * null with a caveat naming what is missing, rather than silently falling back to TAM.
 *
 * Everything here writes an audit row, because BD Ops owns campaign definitions (spec section 13)
 * and a figure that appeared without a recorded actor is a figure nobody can ask about.
 */
import type { PoolClient } from 'pg';

/**
 * How many complete fiscal years to size over by default.
 *
 * Five. Long enough to smooth a lumpy year and short enough that the mix still describes the market
 * as it is rather than as it was. The current fiscal year is excluded: it is incomplete, and a
 * partial year in the denominator makes the capture rate move for reasons that are about the
 * calendar rather than about the business.
 */
export const DEFAULT_WINDOW_YEARS = 5;

export interface SizingWindow {
  readonly fyFrom: number;
  readonly fyTo: number;
}

export interface SizingResult {
  readonly campaignId: string;
  readonly campaignName: string;
  readonly window: SizingWindow;
  readonly tamUsd: string | null;
  readonly tamAwards: number;
  readonly samUsd: string | null;
  readonly samAwards: number;
  readonly captureRate: number | null;
  readonly captureRateSampleSize: number | null;
  readonly somUsd: string | null;
  readonly codes: number;
  readonly offices: number;
  readonly caveats: readonly string[];
}

interface Fact {
  readonly figure: 'tam' | 'sam' | 'som' | 'capture_rate' | 'scope';
  readonly rule_id: string;
  readonly detail: string;
  readonly supports: boolean;
}

/** The default window: the last complete fiscal years, current one excluded. */
export async function defaultWindow(client: PoolClient): Promise<SizingWindow> {
  const { rows } = await client.query<{ fy: number }>(
    'select cie_fiscal_year(current_date) as fy',
  );
  const currentFy = rows[0]!.fy;
  return { fyFrom: currentFy - DEFAULT_WINDOW_YEARS, fyTo: currentFy - 1 };
}

/* ------------------------------------------------------------------- create */

export interface CreateCampaignOptions {
  readonly name: string;
  /** Taxonomy node keys, e.g. CAP-01. Keyed on the key so a re-version does not orphan them. */
  readonly nodeKeys: readonly string[];
  /** 'agency/office' pairs. */
  readonly offices: readonly string[];
  readonly owner?: string | null;
  readonly businessUnit?: string | null;
  readonly actor: string;
}

export interface CreateResult {
  readonly campaignId: string;
  readonly nodesAttached: number;
  readonly officesAttached: number;
  readonly unknownNodes: readonly string[];
}

/**
 * Define a campaign.
 *
 * A node key that does not resolve is reported rather than skipped silently: a campaign quietly
 * missing half its capability areas produces a small TAM and no indication that the number is small
 * for the wrong reason.
 */
export async function createCampaign(
  client: PoolClient,
  options: CreateCampaignOptions,
): Promise<CreateResult> {
  const name = options.name.trim();
  if (name === '') throw new Error('A campaign needs a name.');

  const { rows: existing } = await client.query<{ campaign_id: string }>(
    'select campaign_id::text from campaign where cie_normalize_name(campaign_name) = cie_normalize_name($1)',
    [name],
  );
  if (existing[0] !== undefined) {
    throw new Error(
      `A campaign called "${name}" already exists (id ${existing[0].campaign_id}). ` +
        'Size it with npm run size, or pick another name.',
    );
  }

  const { rows } = await client.query<{ campaign_id: string }>(
    `insert into campaign (campaign_name, owner, business_unit, state)
     values ($1, $2, $3, 'active') returning campaign_id::text`,
    [name, options.owner ?? null, options.businessUnit ?? null],
  );
  const campaignId = rows[0]!.campaign_id;

  const unknownNodes: string[] = [];
  let nodesAttached = 0;
  for (const key of options.nodeKeys) {
    const { rowCount } = await client.query(
      `insert into campaign_node (campaign_id, node_id)
       select $1::bigint, node_id from taxonomy_node
        where node_key = $2 and active
        order by version desc limit 1
       on conflict do nothing`,
      [campaignId, key.trim()],
    );
    if (rowCount === 0) unknownNodes.push(key.trim());
    else nodesAttached += 1;
  }

  let officesAttached = 0;
  for (const pair of options.offices) {
    const match = /^([^/\s]+)\s*\/\s*([^/\s]+)$/.exec(pair.trim());
    if (match === null) {
      throw new Error(`"${pair}" is not an office. Write one as agency/office, e.g. 9700/FA8601.`);
    }
    await client.query(
      `insert into campaign_office (campaign_id, agency_code, office_code)
       values ($1::bigint, $2, $3) on conflict do nothing`,
      [campaignId, match[1]!.toUpperCase(), match[2]!.toUpperCase()],
    );
    officesAttached += 1;
  }

  await client.query(
    `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
     values ($1, 'insert', 'campaign', $2, $3::jsonb, $4)`,
    [
      options.actor,
      campaignId,
      JSON.stringify({ campaign_name: name, nodes: options.nodeKeys, offices: options.offices }),
      `Campaign created: ${name}`,
    ],
  );

  return { campaignId, nodesAttached, officesAttached, unknownNodes };
}

/* --------------------------------------------------------------------- size */

/**
 * Compute and store the sizing for one campaign.
 *
 * The figures are written to `campaign` and the reasoning to `campaign_sizing_evidence`, which is
 * rewritten rather than appended to: a caveat that was true under last quarter's corpus reads as
 * current, and a stale caveat is worse than none.
 */
export async function sizeCampaign(
  client: PoolClient,
  campaignId: string,
  window: SizingWindow,
  actor: string,
): Promise<SizingResult> {
  const { rows: head } = await client.query<{ campaign_name: string }>(
    'select campaign_name from campaign where campaign_id = $1::bigint',
    [campaignId],
  );
  if (head[0] === undefined) throw new Error(`No campaign has the id ${campaignId}.`);
  const campaignName = head[0].campaign_name;

  const { rows } = await client.query<{
    tam_usd: string | null;
    tam_awards: string;
    sam_usd: string | null;
    sam_awards: string;
    sam_astrion_usd: string | null;
    sam_astrion_awards: string;
    offices_named: string;
    codes_named: string;
  }>(
    `select tam_usd::text, tam_awards::text, sam_usd::text, sam_awards::text,
            sam_astrion_usd::text, sam_astrion_awards::text,
            offices_named::text, codes_named::text
       from cie_campaign_market($1::bigint, $2, $3)`,
    [campaignId, window.fyFrom, window.fyTo],
  );

  const slice = rows[0]!;
  const codes = Number(slice.codes_named);
  const offices = Number(slice.offices_named);
  const tamAwards = Number(slice.tam_awards);
  const samAwards = Number(slice.sam_awards);
  const facts: Fact[] = [];

  facts.push({
    figure: 'scope',
    rule_id: 'scope',
    detail:
      `${codes} code(s) from the campaign's capability nodes, ${offices} office(s) named, ` +
      `sized over FY${window.fyFrom} to FY${window.fyTo}.`,
    supports: codes > 0,
  });

  // TAM. Always caveated, because the corpus is not the market.
  const tamUsd = codes === 0 ? null : slice.tam_usd;
  if (codes === 0) {
    facts.push({
      figure: 'tam',
      rule_id: 'no_codes',
      detail:
        'No capability node on this campaign crosswalks to a NAICS or PSC code, so there is nothing ' +
        'to size against. Attach a node that carries crosswalks, or add them to the node.',
      supports: false,
    });
  } else {
    facts.push({
      figure: 'tam',
      rule_id: 'tam_basis',
      detail:
        `${tamAwards} award(s) in this corpus fall under the campaign's codes in the window, ` +
        `obligating ${tamUsd === null ? 'nothing recorded' : tamUsd}.`,
      supports: true,
    });
    facts.push({
      figure: 'tam',
      rule_id: 'corpus_is_not_the_market',
      detail:
        "This is a floor, not a total addressable market. The corpus holds Astrion's own history " +
        'and the watchlist competitors, not every dollar every agency spent under these codes, and ' +
        'the difference is not derivable from what is here. Read it as "the market this corpus can ' +
        'see" and do not quote it as TAM.',
      supports: false,
    });
  }

  // SAM. Null rather than a fallback when the campaign has not said where it competes.
  const samUsd = offices === 0 || codes === 0 ? null : slice.sam_usd;
  if (offices === 0) {
    facts.push({
      figure: 'sam',
      rule_id: 'no_offices',
      detail:
        'This campaign names no offices, so it has not said where it competes and there is no served ' +
        'market to compute. Add offices with npm run campaign -- --add-offices. Falling back to TAM ' +
        'here would report an addressable figure under a served label.',
      supports: false,
    });
  } else if (samAwards === 0) {
    facts.push({
      figure: 'sam',
      rule_id: 'no_awards_in_scope',
      detail:
        `No award under the campaign's codes was made by any of its ${offices} office(s) in the ` +
        'window. Either the offices are wrong, or this corpus does not hold their buying.',
      supports: false,
    });
  } else {
    facts.push({
      figure: 'sam',
      rule_id: 'sam_basis',
      detail:
        `${samAwards} of those ${tamAwards} award(s) were made by the ${offices} office(s) this ` +
        'campaign names. That restriction is what makes an addressable dollar a served one.',
      supports: true,
    });
  }

  // The capture rate, measured. Null when there is nothing to measure it against.
  const samValue = samUsd === null ? null : Number(samUsd);
  const astrionValue = slice.sam_astrion_usd === null ? null : Number(slice.sam_astrion_usd);
  const captureRate =
    samValue === null || samValue === 0 || astrionValue === null ? null : astrionValue / samValue;
  const sampleSize = samUsd === null ? null : samAwards;

  if (captureRate === null) {
    facts.push({
      figure: 'capture_rate',
      rule_id: 'not_measurable',
      detail:
        samUsd === null
          ? 'No served market, so no rate to measure against it.'
          : 'The served market obligates nothing recorded, so a share of it is undefined. Blank is ' +
            'not zero: this is a rate nobody can compute, not a rate of nought.',
      supports: false,
    });
  } else {
    facts.push({
      figure: 'capture_rate',
      rule_id: 'observed',
      detail:
        `Astrion holds ${slice.sam_astrion_awards} of the ${samAwards} award(s) in the served ` +
        `market, worth ${(captureRate * 100).toFixed(1)} percent of its obligations. Measured, not ` +
        'assumed, and not a target.',
      supports: true,
    });
    if (samAwards < 10) {
      facts.push({
        figure: 'capture_rate',
        rule_id: 'sample_too_small',
        detail:
          `${samAwards} award(s) is not a sample. A rate from this many moves several points when ` +
          'one award lands, so treat it as an anecdote with a percent sign. Spec 11.2 is why the ' +
          'sample size is shown beside the rate everywhere it appears.',
        supports: false,
      });
    }
  }

  const somUsd = samValue === null || captureRate === null ? null : (samValue * captureRate).toFixed(2);
  if (somUsd !== null) {
    facts.push({
      figure: 'som',
      rule_id: 'som_basis',
      detail:
        'The served market times the rate Astrion has actually achieved in it. Not a plan and not ' +
        'a quota: it is what the same performance against the same buyers would be worth.',
      supports: true,
    });
  }

  const { rows: before } = await client.query(
    `select tam_usd::text, sam_usd::text, som_usd::text, capture_rate::text,
            capture_rate_sample_size, sizing_fy_from, sizing_fy_to
       from campaign where campaign_id = $1::bigint`,
    [campaignId],
  );

  await client.query(
    `update campaign set
       tam_usd = $2::numeric, sam_usd = $3::numeric, som_usd = $4::numeric,
       capture_rate = $5::numeric, capture_rate_sample_size = $6,
       sizing_fy_from = $7, sizing_fy_to = $8, sizing_computed_at = now()
     where campaign_id = $1::bigint`,
    [
      campaignId,
      tamUsd,
      samUsd,
      somUsd,
      captureRate === null ? null : captureRate.toFixed(5),
      sampleSize,
      window.fyFrom,
      window.fyTo,
    ],
  );

  await client.query('delete from campaign_sizing_evidence where campaign_id = $1::bigint', [campaignId]);
  for (const fact of facts) {
    await client.query(
      `insert into campaign_sizing_evidence (campaign_id, figure, rule_id, detail, supports)
       values ($1::bigint, $2, $3, $4, $5)`,
      [campaignId, fact.figure, fact.rule_id, fact.detail, fact.supports],
    );
  }

  await client.query(
    `insert into audit_log (actor, action, object_type, object_key, before_value, after_value, reason)
     values ($1, 'recompute', 'campaign', $2, $3::jsonb, $4::jsonb, $5)`,
    [
      actor,
      campaignId,
      JSON.stringify(before[0] ?? null),
      JSON.stringify({
        tam_usd: tamUsd,
        sam_usd: samUsd,
        som_usd: somUsd,
        capture_rate: captureRate,
        capture_rate_sample_size: sampleSize,
        window,
      }),
      `Campaign sized: ${campaignName}, FY${window.fyFrom} to FY${window.fyTo}`,
    ],
  );

  return {
    campaignId,
    campaignName,
    window,
    tamUsd,
    tamAwards,
    samUsd,
    samAwards,
    captureRate,
    captureRateSampleSize: sampleSize,
    somUsd,
    codes,
    offices,
    caveats: facts.filter((f) => !f.supports).map((f) => f.detail),
  };
}

export async function sizeAll(
  client: PoolClient,
  window: SizingWindow,
  actor: string,
): Promise<SizingResult[]> {
  const { rows } = await client.query<{ campaign_id: string }>(
    `select campaign_id::text from campaign where state = 'active' order by campaign_id`,
  );
  const results: SizingResult[] = [];
  for (const row of rows) results.push(await sizeCampaign(client, row.campaign_id, window, actor));
  return results;
}

/* ------------------------------------------------------------------- assign */

export interface AssignResult {
  readonly assigned: number;
  readonly campaignName: string;
}

/**
 * Put every unclaimed requirement whose codes match a campaign into it.
 *
 * This is what closes the gap report, and it is deliberately a deliberate act rather than something
 * detection does on its own. A requirement assigned to a campaign by a code match is a claim that
 * the campaign owns that work, and a detector making that claim silently would put requirements in
 * campaigns nobody chose.
 *
 * It never reassigns. A requirement already in a campaign stays there, because somebody put it
 * there and a code match is weaker evidence than a person.
 */
export async function assignMatching(
  client: PoolClient,
  campaignId: string,
  actor: string,
): Promise<AssignResult> {
  const { rows: head } = await client.query<{ campaign_name: string }>(
    'select campaign_name from campaign where campaign_id = $1::bigint',
    [campaignId],
  );
  if (head[0] === undefined) throw new Error(`No campaign has the id ${campaignId}.`);

  const { rows } = await client.query<{ pursuit_id: string }>(
    `update pursuit p set campaign_id = $1::bigint
      where p.campaign_id is null
        and p.signal_class <> 'market_movement'
        and exists (
          select 1 from campaign_code cc
           where cc.campaign_id = $1::bigint
             and ((cc.code_type = 'naics' and p.naics_code is not null
                   and p.naics_code like cc.code_value || '%')
               or (cc.code_type = 'psc' and p.psc_code is not null
                   and p.psc_code like cc.code_value || '%'))
        )
      returning pursuit_id::text`,
    [campaignId],
  );

  for (const row of rows) {
    await client.query(
      `insert into audit_log (actor, action, object_type, object_key, after_value, reason)
       values ($1, 'update', 'pursuit', $2, $3::jsonb, $4)`,
      [
        actor,
        row.pursuit_id,
        JSON.stringify({ campaign_id: campaignId }),
        `Assigned to campaign ${head[0].campaign_name} on a code match`,
      ],
    );
  }

  return { assigned: rows.length, campaignName: head[0].campaign_name };
}
