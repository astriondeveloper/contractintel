/**
 * The evaluator. Spec section 10.
 *
 * Turns a pursuit into an `assessment`, one `factor_result` per factor, one `gate_result`
 * per gate, and an `evidence_ref` per claim. Four rules run the whole thing and each one
 * exists because getting it wrong is easy and quiet.
 *
 * **A gate is not a score.** Gates run first. If one fails the factors are not evaluated at
 * all, so there is no score to show and none is shown. Acceptance test 5 asks for exactly
 * that: a failed gate shows no score, not a low one. Evaluating the factors anyway and
 * hiding the total would leave per-factor scores on screen, which is the same mistake
 * wearing a hat.
 *
 * **Divide by applicable weight, not known weight.** Spec 10.3. `not_applicable` leaves the
 * denominator; `unknown` stays in it. So a factor nobody could answer costs the pursuit
 * score, and `coverage` reports how much of the model was answerable. Dividing by known
 * weight instead would let a pursuit with one scored factor out of eight report a perfect
 * fit, which was defect 2 in the Codex baseline.
 *
 * **Both mandatory factors must be scored.** Capability and past performance are
 * `is_mandatory` rows in the model. If either is unknown the assessment is
 * `insufficient_evidence` and carries no rank at all. Acceptance test 4, and decision D3.
 *
 * **Every score opens a rule trace.** Each factor and gate writes its evidence with a link
 * to the rows behind it. Acceptance test 7 checks that a scored assessment has at least one
 * evidence row carrying a source link.
 */
import type { PoolClient } from 'pg';
import { evaluateFactors } from './factors.js';
import { evaluateGates } from './gates.js';
import { loadContext, MIN_COVERAGE, type Evidence, type PursuitRow, type ScoringContext } from './model.js';

export interface ScoreOptions {
  /** Score only this pursuit. */
  readonly pursuitId?: string;
  /** Score only this signal class. */
  readonly signalClass?: string;
  /** Evaluate and report, write nothing. */
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly onProgress?: (message: string) => void;
}

export interface ScoreResult {
  readonly scoreModelVersion: number;
  readonly taxonomyVersion: number;
  readonly assessed: number;
  readonly byBand: Record<string, number>;
  readonly blockedBy: Record<string, number>;
  readonly meanCoverage: number | null;
}

/** How soon this matters, on its own axis. Spec 10.1: never folded into the fit. */
function timingUrgency(pursuit: PursuitRow): number | null {
  const date = pursuit.response_date ?? pursuit.period_end_date;
  if (date === null) return null;
  const days = (new Date(date).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  if (days < 0) return 0;
  if (days <= 30) return 100;
  if (days >= 1095) return 5;
  return Math.round(Math.max(5, 100 - ((days - 30) / (1095 - 30)) * 95));
}

async function writeEvidence(
  client: PoolClient,
  assessmentId: string,
  evidence: readonly Evidence[],
  factorCode: string | null,
  gateCode: string | null,
): Promise<void> {
  for (const item of evidence) {
    await client.query(
      `insert into evidence_ref
         (assessment_id, factor_code, gate_code, source_system, source_record_id,
          source_uri, displayed_value, is_contrary, observed_at)
       values ($1::bigint, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        assessmentId,
        factorCode,
        gateCode,
        item.sourceSystem,
        item.sourceRecordId ?? null,
        item.sourceUri ?? null,
        item.displayedValue ?? null,
        item.isContrary ?? false,
      ],
    );
  }
}

async function assessOne(
  client: PoolClient,
  pursuit: PursuitRow,
  context: ScoringContext,
  dryRun: boolean,
): Promise<{ band: string; blockedBy: string | null; coverage: number | null }> {
  const gates = await evaluateGates(client, pursuit, context);
  const failing = [...gates.entries()].filter(([, outcome]) => outcome.state === 'fail');
  const reviewing = [...gates.values()].filter((outcome) => outcome.state === 'review');

  const eligibility = failing.length > 0 ? 'fail' : reviewing.length > 0 ? 'review' : 'pass';

  // A failed gate stops here. The factors are not evaluated, so there is no score to show.
  const factors = failing.length > 0 ? new Map() : await evaluateFactors(client, pursuit, context);

  let applicableWeight = 0;
  let knownWeight = 0;
  let weightedScore = 0;
  let weightedConfidence = 0;
  const missingMandatory: string[] = [];

  for (const factor of context.factors) {
    const outcome = factors.get(factor.factor_code);
    if (outcome === undefined) continue;

    if (outcome.state !== 'not_applicable') applicableWeight += factor.weight;
    if (outcome.state === 'scored') {
      knownWeight += factor.weight;
      weightedScore += (outcome.score ?? 0) * factor.weight;
      weightedConfidence += (outcome.confidence ?? 70) * factor.weight;
    }
    if (factor.is_mandatory && outcome.state !== 'scored') {
      missingMandatory.push(factor.factor_code);
    }
  }

  const coverage = applicableWeight > 0 ? knownWeight / applicableWeight : 0;
  const insufficient =
    failing.length === 0 && (missingMandatory.length > 0 || coverage < MIN_COVERAGE);

  let status: 'scored' | 'insufficient_evidence';
  let band: string;
  let strategicFit: number | null = null;
  let evidenceConfidence: number | null = null;
  let urgency: number | null = null;
  let rank: number | null = null;

  if (failing.length > 0) {
    status = 'scored';
    band = 'blocked';
  } else if (insufficient) {
    status = 'insufficient_evidence';
    band = 'insufficient_evidence';
  } else {
    status = 'scored';
    // The denominator is the applicable weight, not the known weight. Spec 10.3.
    strategicFit = Math.round((weightedScore / applicableWeight) * 100) / 100;
    evidenceConfidence = knownWeight > 0 ? Math.round((weightedConfidence / knownWeight) * 100) / 100 : null;
    urgency = timingUrgency(pursuit);
    // The rank is the strategic fit and nothing else. Timing and confidence sit beside it
    // and are never folded in, because spec 10.1 says these are four separate outputs and
    // merging them is how a number stops meaning anything.
    rank = strategicFit;

    const minimum = context.thresholds.get(pursuit.signal_class) ?? 55;
    band = strategicFit >= minimum ? 'pursue' : strategicFit >= minimum - 15 ? 'review' : 'pass';
  }

  if (dryRun) {
    return {
      band,
      blockedBy: failing[0]?.[0] ?? null,
      coverage: failing.length > 0 ? null : coverage,
    };
  }

  // One current assessment per pursuit per model version. A weight change makes a new
  // version, so the old assessment survives untouched, which is the property acceptance
  // test 6 is about.
  await client.query(
    `delete from assessment
      where pursuit_id = $1::bigint and score_model_version = $2 and taxonomy_version = $3`,
    [pursuit.pursuit_id, context.scoreModelVersion, context.taxonomyVersion],
  );

  const { rows } = await client.query<{ assessment_id: string }>(
    `insert into assessment (
       pursuit_id, score_model_version, taxonomy_version, eligibility, status,
       strategic_fit, evidence_confidence, timing_urgency,
       applicable_weight, known_weight, coverage, rank_value, band
     ) values (
       $1::bigint, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11, $12, $13
     ) returning assessment_id`,
    [
      pursuit.pursuit_id,
      context.scoreModelVersion,
      context.taxonomyVersion,
      eligibility,
      status,
      strategicFit,
      evidenceConfidence,
      urgency,
      failing.length > 0 ? null : applicableWeight,
      failing.length > 0 ? null : knownWeight,
      failing.length > 0 ? null : Math.round(coverage * 10000) / 10000,
      rank,
      band,
    ],
  );
  const assessmentId = rows[0]!.assessment_id;

  for (const [gateCode, outcome] of gates) {
    await client.query(
      `insert into gate_result (assessment_id, gate_code, state, reason, rule_id)
       values ($1::bigint, $2, $3, $4, $5)`,
      [assessmentId, gateCode, outcome.state, outcome.reason, outcome.ruleId],
    );
    await writeEvidence(client, assessmentId, outcome.evidence, null, gateCode);
  }

  for (const factor of context.factors) {
    const outcome = factors.get(factor.factor_code);
    if (outcome === undefined) continue;

    const weightApplied = outcome.state === 'not_applicable' ? 0 : factor.weight;
    const contribution =
      outcome.state === 'scored' ? Math.round((outcome.score ?? 0) * factor.weight * 100) / 100 : null;

    await client.query(
      `insert into factor_result
         (assessment_id, factor_code, state, score, weight_applied, contribution, rule_id, summary)
       values ($1::bigint, $2, $3, $4, $5, $6, $7, $8)`,
      [
        assessmentId,
        factor.factor_code,
        outcome.state,
        // The database enforces this too: a score exists only in the scored state.
        outcome.state === 'scored' ? (outcome.score ?? 0) : null,
        weightApplied,
        contribution,
        outcome.ruleId,
        outcome.summary,
      ],
    );
    await writeEvidence(client, assessmentId, outcome.evidence, factor.factor_code, null);
  }

  return {
    band,
    blockedBy: failing[0]?.[0] ?? null,
    coverage: failing.length > 0 ? null : coverage,
  };
}

export async function scorePursuits(
  client: PoolClient,
  options: ScoreOptions = {},
): Promise<ScoreResult> {
  const context = await loadContext(client);
  const progress = options.onProgress ?? (() => {});

  const { rows: pursuits } = await client.query<PursuitRow>(
    `select pursuit_id::text, signal_class, title, agency_code, office_code, naics_code,
            psc_code, set_aside_code, notice_type, notice_url, solicitation_number,
            related_piid, required_vehicle, estimated_value::text, response_date,
            period_end_date, posted_date, incumbent_entity_id::text, incumbent_confidence,
            astrion_position
       from pursuit
      where ($1::bigint is null or pursuit_id = $1::bigint)
        and ($2 = '' or signal_class = $2)
        and state not in ('won', 'lost', 'dropped')
      order by pursuit_id
      limit $3`,
    [options.pursuitId ?? null, options.signalClass ?? '', options.limit ?? 100000],
  );

  const byBand: Record<string, number> = {};
  const blockedBy: Record<string, number> = {};
  let coverageTotal = 0;
  let coverageCount = 0;

  for (const pursuit of pursuits) {
    const outcome = await assessOne(client, pursuit, context, options.dryRun === true);
    byBand[outcome.band] = (byBand[outcome.band] ?? 0) + 1;
    if (outcome.blockedBy !== null) {
      blockedBy[outcome.blockedBy] = (blockedBy[outcome.blockedBy] ?? 0) + 1;
    }
    if (outcome.coverage !== null) {
      coverageTotal += outcome.coverage;
      coverageCount += 1;
    }
    if (pursuits.length > 200 && (byBand.pursue ?? 0) % 100 === 0) {
      progress(`  ${Object.values(byBand).reduce((a, b) => a + b, 0)} of ${pursuits.length}`);
    }
  }

  return {
    scoreModelVersion: context.scoreModelVersion,
    taxonomyVersion: context.taxonomyVersion,
    assessed: pursuits.length,
    byBand,
    blockedBy,
    meanCoverage: coverageCount > 0 ? coverageTotal / coverageCount : null,
  };
}
