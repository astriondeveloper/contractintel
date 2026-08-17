/**
 * The eight factors. Spec section 10.2 for the weights, 10.5 for the states.
 *
 * One rule governs every function here and it is the one most worth getting right:
 *
 *   **unknown, not_applicable, and a score of zero are three different things.**
 *
 * A missing description does not mean a capability score of zero. It means unknown, and
 * unknown keeps its weight in the denominator so the coverage figure notices it. Zero means
 * the question was asked and the answer was none: the codes are known and none of them is
 * ours. `not_applicable` means the question does not arise for this pursuit at all, and it
 * leaves the denominator entirely — which is the trap `docs/BACKLOG.md` item 2 names as the
 * single easiest thing to get wrong.
 *
 * Every factor returns evidence, and every piece of evidence carries a link to the rows it
 * came from. Acceptance test 7 requires it, and the rail is the reason anyone believes a
 * number they did not compute themselves.
 */
import type { PoolClient } from 'pg';
import { capability as profileCode, type FactorOutcome, type PursuitRow, type ScoringContext } from './model.js';

/** A recompete signal is about work Astrion knows; a notice is about work it may not. */
function codeSearchLink(pursuit: PursuitRow): string {
  const term = pursuit.naics_code ?? pursuit.psc_code ?? pursuit.related_piid ?? pursuit.title;
  return `/contracts?q=${encodeURIComponent(term)}`;
}

/* ------------------------------------------------------------- capability */

/**
 * Does the work match something the company says it does?
 *
 * Matched against `opportunity_profile`, which carries the capability taxonomy's own PSC
 * and NAICS crosswalks. Both codes matching is a stronger statement than one, and a code
 * that is on the profile from the taxonomy *and* from the corpus is stronger still: BD says
 * we do this and the record shows we have been paid for it.
 */
export function capabilityFactor(pursuit: PursuitRow, context: ScoringContext): FactorOutcome {
  const naics = profileCode(context, 'naics', pursuit.naics_code);
  const psc = profileCode(context, 'psc', pursuit.psc_code);
  const hasCodes = Boolean(pursuit.naics_code || pursuit.psc_code);

  if (!hasCodes) {
    return {
      state: 'unknown',
      ruleId: 'RULE-CAP-01',
      summary:
        'No NAICS or PSC on this signal, so there is nothing to match against the capability ' +
        'taxonomy. Unknown, not zero.',
      evidence: [],
    };
  }

  const matches = [naics, psc].filter(Boolean) as NonNullable<typeof naics>[];
  if (matches.length === 0) {
    return {
      state: 'scored',
      score: 0,
      confidence: 90,
      ruleId: 'RULE-CAP-01',
      summary:
        `Neither ${[pursuit.naics_code, pursuit.psc_code].filter(Boolean).join(' nor ')} is on ` +
        'the capability profile. The question was asked and the answer is none, which is a ' +
        'zero rather than an unknown.',
      evidence: [
        {
          sourceSystem: 'opportunity_profile',
          sourceRecordId: pursuit.naics_code ?? pursuit.psc_code,
          sourceUri: '/taxonomy',
          displayedValue: 'No matching capability node',
          isContrary: true,
        },
      ],
    };
  }

  const bothCodes = Boolean(naics && psc);
  const corroborated = matches.some((m) => m.origins.includes('taxonomy') && m.origins.includes('observed'));

  const score = bothCodes ? (corroborated ? 100 : 85) : corroborated ? 75 : 60;

  return {
    state: 'scored',
    score,
    confidence: corroborated ? 95 : 75,
    ruleId: 'RULE-CAP-01',
    summary:
      `${bothCodes ? 'Both codes match' : 'One code matches'} the capability profile` +
      (corroborated ? ', and is corroborated by the corpus as well as the taxonomy.' : '.'),
    evidence: matches.map((match) => ({
      sourceSystem: 'opportunity_profile',
      sourceRecordId: match.nodeIds[0] ?? null,
      sourceUri: '/taxonomy',
      displayedValue: `${match.label ?? 'Capability node'} (${match.origins.join(' + ')})`,
    })),
  };
}

/* ------------------------------------------------- relevant past performance */

/**
 * Has the company been paid for this kind of work?
 *
 * Counted from Astrion's own contract actions under the same NAICS or PSC, scoped through
 * the entity rollup rather than the legal name -- the difference acceptance test 1 exists
 * about.
 *
 * Zero matching actions is a real zero and scores as one: the corpus was searched and the
 * work is not there. It is unknown only when there is nothing to search with, or nothing to
 * search in.
 */
export async function pastPerformanceFactor(
  client: PoolClient,
  pursuit: PursuitRow,
  context: ScoringContext,
): Promise<FactorOutcome> {
  if (!context.corpusLoaded) {
    return {
      state: 'unknown',
      ruleId: 'RULE-PP-01',
      summary:
        'No Astrion contract actions are loaded, so past performance cannot be looked up. ' +
        'Unknown, not zero. Load a corpus: npm run load -- --dir <directory>.',
      evidence: [],
    };
  }
  if (!pursuit.naics_code && !pursuit.psc_code) {
    return {
      state: 'unknown',
      ruleId: 'RULE-PP-01',
      summary: 'No NAICS or PSC on this signal, so there is no code to search past performance on.',
      evidence: [],
    };
  }

  const { rows } = await client.query<{ actions: string; obligations: string | null; last_fy: number | null }>(
    `select count(*)::text                          as actions,
            sum(ca.action_obligation)::text         as obligations,
            max(cie_fiscal_year(ca.signed_date))    as last_fy
       from contract_action ca
       join contract_action_classification cac on cac.contract_action_id = ca.contract_action_id
       join entity e on e.entity_id = ca.entity_id
      where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')
        and ((cac.code_type = 'naics' and cac.code_value = $1)
          or (cac.code_type = 'psc'   and cac.code_value = $2))`,
    [pursuit.naics_code, pursuit.psc_code],
  );

  const actions = Number(rows[0]!.actions);
  const lastFy = rows[0]!.last_fy;
  const obligations = rows[0]!.obligations;

  if (actions === 0) {
    return {
      state: 'scored',
      score: 0,
      confidence: 85,
      ruleId: 'RULE-PP-01',
      summary: 'No Astrion contract action under these codes. Searched and not found, so zero.',
      evidence: [
        {
          sourceSystem: 'fpds',
          sourceUri: codeSearchLink(pursuit),
          displayedValue: 'No matching contract actions',
          isContrary: true,
        },
      ],
    };
  }

  // Depth and recency, both bounded. Twenty actions is as convincing as two hundred, and
  // work that stopped five years ago is weaker evidence than work still running.
  const depth = Math.min(actions / 20, 1) * 70;
  const currentFy = new Date().getUTCFullYear() + (new Date().getUTCMonth() >= 9 ? 1 : 0);
  const staleness = lastFy === null ? 5 : Math.max(0, currentFy - lastFy);
  const recency = Math.max(0, 30 - staleness * 8);

  return {
    state: 'scored',
    score: Math.round(Math.min(100, depth + recency)),
    confidence: 90,
    ruleId: 'RULE-PP-01',
    summary:
      `${actions} Astrion contract action(s) under these codes, most recently FY${lastFy ?? '?'}.`,
    evidence: [
      {
        sourceSystem: 'fpds',
        sourceUri: codeSearchLink(pursuit),
        displayedValue:
          `${actions} action(s)` + (obligations === null ? '' : `, $${Math.round(Number(obligations)).toLocaleString()} obligated`),
      },
    ],
  };
}

/* --------------------------------------------------------- target customer */

export function targetCustomerFactor(pursuit: PursuitRow, context: ScoringContext): FactorOutcome {
  if (!pursuit.agency_code) {
    return {
      state: 'unknown',
      ruleId: 'RULE-CUST-01',
      summary: 'No awarding agency on this signal.',
      evidence: [],
    };
  }

  const match = context.agencyCodes.get(pursuit.agency_code);
  if (!match) {
    return {
      state: 'scored',
      score: 0,
      confidence: 85,
      ruleId: 'RULE-CUST-01',
      summary: `Agency ${pursuit.agency_code} is not a customer the profile names.`,
      evidence: [
        {
          sourceSystem: 'opportunity_profile',
          sourceRecordId: pursuit.agency_code,
          sourceUri: '/customers',
          displayedValue: `${pursuit.agency_code} not on the customer profile`,
          isContrary: true,
        },
      ],
    };
  }

  const observed = match.origins.includes('observed');
  const authored = match.origins.includes('taxonomy');
  const score = observed && authored ? 100 : observed ? 85 : 65;

  return {
    state: 'scored',
    score,
    confidence: observed ? 95 : 70,
    ruleId: 'RULE-CUST-01',
    summary:
      `${match.label ?? pursuit.agency_code} is ` +
      (observed && authored
        ? 'both a named target and an agency Astrion already sells to.'
        : observed
          ? 'an agency Astrion already sells to.'
          : 'a named target in the capability taxonomy, with no awards observed yet.'),
    evidence: [
      {
        sourceSystem: 'opportunity_profile',
        sourceRecordId: pursuit.agency_code,
        sourceUri: `/contracts?agency=${encodeURIComponent(pursuit.agency_code)}`,
        displayedValue: `${match.label ?? pursuit.agency_code} (${match.origins.join(' + ')})`,
      },
    ],
  };
}

/* ----------------------------------------------------------------- vehicle */

/**
 * Vehicle position or access.
 *
 * `not_applicable` when the work is not ordered under a vehicle at all, which removes its
 * weight from the denominator rather than counting as a gap. That distinction is the whole
 * point of the three states: a standalone award has no vehicle to hold a position on, and
 * penalising a pursuit for that would be scoring it against a question that does not arise.
 */
export async function vehicleFactor(
  client: PoolClient,
  pursuit: PursuitRow,
): Promise<FactorOutcome> {
  const vehicle = pursuit.required_vehicle?.trim();

  if (!vehicle && pursuit.related_piid) {
    const { rows } = await client.query<{ idv_piid: string | null }>(
      `select max(idv_piid) as idv_piid from contract_action where piid = $1 and idv_piid is not null`,
      [pursuit.related_piid],
    );
    const derived = rows[0]?.idv_piid ?? null;
    if (derived === null) {
      return {
        state: 'not_applicable',
        ruleId: 'RULE-VEH-01',
        summary:
          'A standalone award with no ordering vehicle, so vehicle position does not arise. ' +
          'Its weight leaves the denominator rather than counting against the pursuit.',
        evidence: [],
      };
    }
    return vehiclePosition(client, derived);
  }

  if (!vehicle) {
    return {
      state: 'unknown',
      ruleId: 'RULE-VEH-01',
      summary:
        'The notice does not say which vehicle the work would be ordered under, and there is ' +
        'no prior contract to read one from.',
      evidence: [],
    };
  }

  return vehiclePosition(client, vehicle);
}

async function vehiclePosition(client: PoolClient, vehicle: string): Promise<FactorOutcome> {
  const { rows } = await client.query<{ n: string; obligations: string | null }>(
    `select count(*)::text as n, sum(ca.action_obligation)::text as obligations
       from contract_action ca
       join entity e on e.entity_id = ca.entity_id
      where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')
        and ca.idv_piid = $1`,
    [vehicle],
  );
  const actions = Number(rows[0]!.n);

  return {
    state: 'scored',
    score: actions === 0 ? 0 : Math.round(Math.min(100, 55 + Math.min(actions / 10, 1) * 45)),
    confidence: 90,
    ruleId: 'RULE-VEH-01',
    summary:
      actions === 0
        ? `No Astrion action under ${vehicle}. On the vehicle in name only, or not at all.`
        : `${actions} Astrion action(s) ordered under ${vehicle}.`,
    evidence: [
      {
        sourceSystem: 'fpds',
        sourceRecordId: vehicle,
        sourceUri: `/contracts?q=${encodeURIComponent(vehicle)}`,
        displayedValue: `${actions} action(s) under ${vehicle}`,
        isContrary: actions === 0,
      },
    ],
  };
}

/* -------------------------------------------------------------- technology */

/**
 * Technology alignment.
 *
 * The seeded taxonomy is capabilities, not technologies: no node is typed as one. Until a
 * technology taxonomy exists there is nothing to align against, so this is
 * `not_applicable` and its weight leaves the denominator. Scoring every pursuit zero on a
 * dimension the model cannot express would drag every score down by the same amount and
 * tell nobody anything.
 */
export function technologyFactor(context: ScoringContext): FactorOutcome {
  if (!context.hasTechnologyNodes) {
    return {
      state: 'not_applicable',
      ruleId: 'RULE-TECH-01',
      summary:
        'The taxonomy carries no technology nodes, so there is nothing to align against. ' +
        'Not applicable rather than zero: its weight leaves the denominator.',
      evidence: [],
    };
  }
  return {
    state: 'unknown',
    ruleId: 'RULE-TECH-01',
    summary:
      'The taxonomy has technology nodes but this signal carries nothing to match against ' +
      'them. A notice description parser would answer this and does not exist yet.',
    evidence: [],
  };
}

/* --------------------------------------------------- competitive position */

/**
 * Incumbent and competitive position.
 *
 * Holding the work is the strongest position and also the one with the most to lose;
 * subbing on it is a foothold; neither is a cold start. This reads `astrion_position`,
 * which the recompete detector sets and a SAM.gov notice does not have.
 */
export function competitiveFactor(pursuit: PursuitRow): FactorOutcome {
  const position = pursuit.astrion_position;

  if (position === null) {
    return {
      state: 'unknown',
      ruleId: 'RULE-COMP-01',
      summary:
        'No incumbent is known for this signal. A solicitation does not name who holds the ' +
        'work today, and nothing here has reconciled it to a prior contract.',
      evidence: [],
    };
  }

  const score = position === 'prime_incumbent' ? 90 : position === 'subcontractor' ? 70 : 25;
  const summary =
    position === 'prime_incumbent'
      ? 'Astrion holds this work as prime. The strongest position, and the one with the most to lose.'
      : position === 'subcontractor'
        ? 'Astrion holds a subcontract on this work, which is a foothold and a route to the customer.'
        : 'No Astrion position on this contract today. A competitor holds it.';

  return {
    state: 'scored',
    score,
    confidence: pursuit.incumbent_confidence === 'confirmed' ? 95 : 75,
    ruleId: 'RULE-COMP-01',
    summary,
    evidence: [
      {
        sourceSystem: 'contract_group',
        sourceRecordId: pursuit.related_piid,
        sourceUri: pursuit.incumbent_entity_id
          ? `/entities/${pursuit.incumbent_entity_id}`
          : codeSearchLink(pursuit),
        displayedValue: summary,
        isContrary: position === 'none',
      },
    ],
  };
}

/* ------------------------------------------------------- growth priority */

/**
 * Growth priority alignment.
 *
 * `growth_priority` ships blank on every seeded taxonomy row -- the column is
 * `growth_priority_TBD` in the seed file, which is BD saying they have not decided yet.
 * Unknown is the honest answer and it costs coverage, which is the point: the number goes
 * up when BD fills the column in.
 */
export function growthFactor(pursuit: PursuitRow, context: ScoringContext): FactorOutcome {
  const naics = profileCode(context, 'naics', pursuit.naics_code);
  const psc = profileCode(context, 'psc', pursuit.psc_code);
  const nodeIds = [...(naics?.nodeIds ?? []), ...(psc?.nodeIds ?? [])];

  const priorities = nodeIds
    .map((id) => context.growthPriority.get(id))
    .filter((value): value is string => value !== undefined);

  if (priorities.length === 0) {
    return {
      state: 'unknown',
      ruleId: 'RULE-GROWTH-01',
      summary:
        nodeIds.length === 0
          ? 'No capability node matched, so there is no growth priority to read.'
          : 'The matched capability nodes carry no growth priority. The seed ships that column ' +
            'blank on every row and BD Ops fills it in.',
      evidence: [],
    };
  }

  const highest = priorities.some((p) => /high|1|primary/i.test(p))
    ? 100
    : priorities.some((p) => /med|2/i.test(p))
      ? 65
      : 35;

  return {
    state: 'scored',
    score: highest,
    confidence: 80,
    ruleId: 'RULE-GROWTH-01',
    summary: `Matched capability node(s) carry growth priority: ${priorities.join(', ')}.`,
    evidence: [
      {
        sourceSystem: 'taxonomy_node',
        sourceRecordId: nodeIds[0] ?? null,
        sourceUri: '/taxonomy',
        displayedValue: priorities.join(', '),
      },
    ],
  };
}

/* ---------------------------------------------------------- value and timing */

/**
 * Value and timing fit.
 *
 * Scores on whichever of the two inputs is present and says which it used. A blank value is
 * blank rather than zero, so a contract with no recorded value is not a small contract; it
 * is one whose size nobody has written down, and the summary says so instead of quietly
 * treating it as tiny.
 */
export function valueTimingFactor(pursuit: PursuitRow): FactorOutcome {
  const value = pursuit.estimated_value === null ? null : Number(pursuit.estimated_value);
  const date = pursuit.response_date ?? pursuit.period_end_date;

  if (value === null && date === null) {
    return {
      state: 'unknown',
      ruleId: 'RULE-VAL-01',
      summary: 'Neither a value nor a date on this signal, so neither half can be judged.',
      evidence: [],
    };
  }

  const parts: string[] = [];
  let total = 0;
  let weight = 0;

  if (value !== null && Number.isFinite(value)) {
    // Bigger is better up to a point; past that it is a different kind of pursuit and this
    // factor is not the place to say so.
    const valueScore = value <= 0 ? 20 : Math.min(100, 30 + (Math.log10(Math.max(value, 1)) / 9) * 70);
    total += valueScore;
    weight += 1;
    parts.push(`$${Math.round(value).toLocaleString()} estimated`);
  }

  if (date !== null) {
    const months = (new Date(date).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44);
    // Work that lands in the next two years is worth planning around; further out is real
    // but harder to act on, and anything already past scores low.
    const timingScore = months < 0 ? 10 : months <= 24 ? 100 - months * 1.5 : Math.max(20, 64 - (months - 24));
    total += Math.max(0, Math.min(100, timingScore));
    weight += 1;
    parts.push(`${Math.round(months)} month(s) out`);
  }

  return {
    state: 'scored',
    score: Math.round(total / weight),
    // One input is a weaker basis than two, and the confidence figure is where that shows.
    confidence: weight === 2 ? 85 : 55,
    ruleId: 'RULE-VAL-01',
    summary:
      parts.join(', ') +
      (value === null ? '. No value recorded, which is unknown rather than small.' : '.'),
    evidence: [
      {
        sourceSystem: 'pursuit',
        sourceRecordId: pursuit.pursuit_id,
        sourceUri: pursuit.notice_url ?? codeSearchLink(pursuit),
        displayedValue: parts.join(', '),
      },
    ],
  };
}

/** Every factor in the model, evaluated for one pursuit. */
export async function evaluateFactors(
  client: PoolClient,
  pursuit: PursuitRow,
  context: ScoringContext,
): Promise<Map<string, FactorOutcome>> {
  const results = new Map<string, FactorOutcome>();

  for (const factor of context.factors) {
    switch (factor.factor_code) {
      case 'capability':
        results.set(factor.factor_code, capabilityFactor(pursuit, context));
        break;
      case 'past_performance':
        results.set(factor.factor_code, await pastPerformanceFactor(client, pursuit, context));
        break;
      case 'target_customer':
        results.set(factor.factor_code, targetCustomerFactor(pursuit, context));
        break;
      case 'vehicle':
        results.set(factor.factor_code, await vehicleFactor(client, pursuit));
        break;
      case 'technology':
        results.set(factor.factor_code, technologyFactor(context));
        break;
      case 'competitive_position':
        results.set(factor.factor_code, competitiveFactor(pursuit));
        break;
      case 'growth_priority':
        results.set(factor.factor_code, growthFactor(pursuit, context));
        break;
      case 'value_timing':
        results.set(factor.factor_code, valueTimingFactor(pursuit));
        break;
      default:
        // A factor added to the model with no rule behind it is unknown, never zero. It
        // keeps its weight in the denominator, so coverage falls and somebody notices.
        results.set(factor.factor_code, {
          state: 'unknown',
          ruleId: 'RULE-NONE',
          summary:
            `No rule implements factor "${factor.factor_code}", which is on the score model. ` +
            'Unknown rather than zero, so coverage reports the gap.',
          evidence: [],
        });
        break;
    }
  }

  return results;
}
