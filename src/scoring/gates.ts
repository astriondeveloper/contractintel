/**
 * The hard gates. Spec section 3 and section 10.
 *
 * A gate is a rule that stops a pursuit, and a score cannot override one. That is why
 * gates run first and, when one fails, the factors are not evaluated at all: acceptance
 * test 5 says a failed gate shows **no score**, not a low one, and the cleanest way to
 * honour that is to have no score to show.
 *
 * Three of the five gates cannot be evaluated from anything this system holds. There is no
 * clearance data in the corpus and no conflict-of-interest register, and the vehicle a
 * solicitation will be ordered under is rarely stated in a notice. Those return
 * `not_evaluated` with a reason naming what is missing.
 *
 * **`not_evaluated` is not `pass`.** A gate nobody checked is not a gate that was cleared,
 * and the interface shows the difference. This is the same rule as blocked-is-not-passed in
 * the acceptance suite, applied one level down.
 */
import type { PoolClient } from 'pg';
import type { GateOutcome, PursuitRow, ScoringContext } from './model.js';

/** Inside this many days of the deadline, responding is a decision rather than a plan. */
export const TIGHT_RESPONSE_DAYS = 10;

function daysUntil(date: Date | null): number | null {
  if (date === null) return null;
  return Math.round((new Date(date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

/**
 * The response window. The one gate that fails on ordinary data, because a closed
 * solicitation is a fact rather than a judgement.
 */
export function responseWindow(pursuit: PursuitRow): GateOutcome {
  const days = daysUntil(pursuit.response_date);

  if (days === null) {
    return {
      state: 'not_evaluated',
      ruleId: 'GATE-RSP-01',
      reason:
        'No response date. A recompete signal has no solicitation out yet, so there is no ' +
        'window to be inside or outside of.',
      evidence: [],
    };
  }

  const evidence = [
    {
      sourceSystem: 'pursuit',
      sourceRecordId: pursuit.pursuit_id,
      sourceUri: pursuit.notice_url ?? `/upcoming?q=${encodeURIComponent(pursuit.solicitation_number ?? pursuit.title)}`,
      displayedValue: `Responses due ${new Date(pursuit.response_date!).toISOString().slice(0, 10)}`,
      isContrary: days < 0,
    },
  ];

  if (days < 0) {
    return {
      state: 'fail',
      ruleId: 'GATE-RSP-01',
      reason: `The response date passed ${Math.abs(days)} day(s) ago.`,
      evidence,
    };
  }
  if (days <= TIGHT_RESPONSE_DAYS) {
    return {
      state: 'review',
      ruleId: 'GATE-RSP-01',
      reason: `${days} day(s) to respond, which is inside the ${TIGHT_RESPONSE_DAYS}-day mark. A person decides whether that is enough.`,
      evidence,
    };
  }
  return {
    state: 'pass',
    ruleId: 'GATE-RSP-01',
    reason: `${days} day(s) to respond.`,
    evidence,
  };
}

/**
 * Set-aside eligibility.
 *
 * This gate deliberately never fails, and that is a decision rather than an omission.
 *
 * The only evidence available is which set-asides Astrion has previously been awarded
 * under, collected on `opportunity_profile`. Having won under a category is good evidence
 * of holding it. Never having won under one is **not** evidence of not holding it: the
 * company may hold a status it has not used, or have gained one since the corpus was
 * exported. Failing a pursuit on that inference would silently drop real opportunities,
 * and it is the kind of error nobody notices because the thing that vanished leaves no
 * trace.
 *
 * So an unrecognised set-aside is `review`: a person checks the status. Recorded in
 * docs/DECISIONS.md D16.
 */
export function setAside(pursuit: PursuitRow, context: ScoringContext): GateOutcome {
  const code = pursuit.set_aside_code?.trim();

  if (!code) {
    return {
      state: 'pass',
      ruleId: 'GATE-SET-01',
      reason: 'No set-aside on the notice, so it is open.',
      evidence: [],
    };
  }

  if (context.setAsides.size === 0) {
    return {
      state: 'not_evaluated',
      ruleId: 'GATE-SET-01',
      reason:
        `Reserved for ${code}, and nothing records which set-asides Astrion holds. Run ` +
        'npm run profile against a loaded corpus, or have BD Ops add them to ' +
        'opportunity_profile.',
      evidence: [],
    };
  }

  if (context.setAsides.has(code)) {
    return {
      state: 'pass',
      ruleId: 'GATE-SET-01',
      reason: `Reserved for ${code}, which Astrion has been awarded under before.`,
      evidence: [
        {
          sourceSystem: 'opportunity_profile',
          sourceRecordId: code,
          sourceUri: `/contracts?q=${encodeURIComponent(code)}`,
          displayedValue: `Prior awards under ${code}`,
        },
      ],
    };
  }

  return {
    state: 'review',
    ruleId: 'GATE-SET-01',
    reason:
      `Reserved for ${code}, which the corpus does not show Astrion being awarded under. ` +
      'Not held is not the same as not observed, so this is a question for a person rather ' +
      'than a reason to drop it.',
    evidence: [
      {
        sourceSystem: 'opportunity_profile',
        sourceRecordId: code,
        sourceUri: '/upcoming',
        displayedValue: `No prior award under ${code}`,
        isContrary: true,
      },
    ],
  };
}

/**
 * Vehicle access.
 *
 * Fails only when the work must be ordered under a named vehicle and the corpus shows no
 * Astrion action under it. That is a real disqualification: no position and no order can
 * be placed. `required_vehicle` is rarely populated, so this is usually `not_evaluated`.
 */
export async function vehicleAccess(
  client: PoolClient,
  pursuit: PursuitRow,
): Promise<GateOutcome> {
  const vehicle = pursuit.required_vehicle?.trim();
  if (!vehicle) {
    return {
      state: 'not_evaluated',
      ruleId: 'GATE-VEH-01',
      reason: 'No required vehicle stated, so there is nothing to check access against.',
      evidence: [],
    };
  }

  const { rows } = await client.query<{ n: string }>(
    `select count(*)::text as n
       from contract_action ca
       join entity e on e.entity_id = ca.entity_id
      where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')
        and ca.idv_piid = $1`,
    [vehicle],
  );
  const actions = Number(rows[0]!.n);

  if (actions > 0) {
    return {
      state: 'pass',
      ruleId: 'GATE-VEH-01',
      reason: `Astrion holds a position on ${vehicle}: ${actions} action(s) ordered under it.`,
      evidence: [
        {
          sourceSystem: 'fpds',
          sourceRecordId: vehicle,
          sourceUri: `/contracts?q=${encodeURIComponent(vehicle)}`,
          displayedValue: `${actions} action(s) under ${vehicle}`,
        },
      ],
    };
  }

  return {
    state: 'fail',
    ruleId: 'GATE-VEH-01',
    reason:
      `The work must be ordered under ${vehicle} and the corpus shows no Astrion action ` +
      'under it. A teaming path onto the vehicle would change this, and nothing here knows ' +
      'about one.',
    evidence: [
      {
        sourceSystem: 'fpds',
        sourceRecordId: vehicle,
        sourceUri: `/contracts?q=${encodeURIComponent(vehicle)}`,
        displayedValue: `No Astrion action under ${vehicle}`,
        isContrary: true,
      },
    ],
  };
}

/**
 * Facility clearance and organisational conflict of interest.
 *
 * Neither is knowable from anything loaded. There is no clearance register and no conflict
 * register, and inventing an answer for either would be worse than saying so: a gate
 * reported as passed is a gate somebody stops checking.
 */
export function notKnowable(gateCode: string): GateOutcome {
  if (gateCode === 'clearance') {
    return {
      state: 'not_evaluated',
      ruleId: 'GATE-CLR-01',
      reason:
        'No facility clearance data is loaded, on the requirement or on Astrion. This gate ' +
        'needs a source that does not exist yet, and not evaluated is not passed.',
      evidence: [],
    };
  }
  return {
    state: 'not_evaluated',
    ruleId: 'GATE-OCI-01',
    reason:
      'Organisational conflict of interest needs the current contract portfolio judged ' +
      'against the requirement, which is a person and a register rather than a query. Not ' +
      'evaluated is not passed.',
    evidence: [],
  };
}

/** Every gate in the model, evaluated for one pursuit. */
export async function evaluateGates(
  client: PoolClient,
  pursuit: PursuitRow,
  context: ScoringContext,
): Promise<Map<string, GateOutcome>> {
  const results = new Map<string, GateOutcome>();

  for (const gate of context.gates) {
    switch (gate.gate_code) {
      case 'response_window':
        results.set(gate.gate_code, responseWindow(pursuit));
        break;
      case 'set_aside':
        results.set(gate.gate_code, setAside(pursuit, context));
        break;
      case 'vehicle_access':
        results.set(gate.gate_code, await vehicleAccess(client, pursuit));
        break;
      default:
        results.set(gate.gate_code, notKnowable(gate.gate_code));
        break;
    }
  }

  return results;
}
