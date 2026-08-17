/**
 * The scoring engine. Spec section 10.
 *
 * The first test in this file is the one that matters most. `docs/BACKLOG.md` item 2 names
 * dividing by known weight instead of applicable weight as the single easiest thing to get
 * wrong here, and it was defect 2 in the Codex baseline. It is easy to get wrong because
 * both denominators produce a plausible number: the wrong one just quietly flatters every
 * pursuit that could not be fully evaluated. So it is asserted directly, and asserted to be
 * different from the wrong answer.
 *
 * Everything is built through the real engine against a real database. The pursuits are
 * invented and cleaned up afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import { scorePursuits } from '../src/scoring/engine.js';
import { MIN_COVERAGE } from '../src/scoring/model.js';
import { buildProfile } from '../src/signals/profile.js';

let client: PoolClient;

const TITLE_PREFIX = 'ZTSCORE';

beforeAll(async () => {
  client = await pool.connect();
  await buildProfile(client, { taxonomyOnly: true });
  await seedPastPerformance();
});

/**
 * A little Astrion history under a profile NAICS code.
 *
 * Without it `past_performance` is correctly `unknown` -- the corpus holds nothing to look
 * up -- and every pursuit here comes out as insufficient evidence, which is the engine
 * being right and the fixture being wrong. The test database carries the seeds but no FPDS
 * corpus, so the history has to be built.
 */
async function seedPastPerformance(): Promise<void> {
  const naics = await profileNaics();
  const { rows } = await client.query<{ entity_id: string }>(
    `select e.entity_id from entity e
      where coalesce(e.ultimate_parent_id, e.entity_id) =
            (select entity_id from entity where canonical_name = 'Astrion')
        and e.canonical_name <> 'Astrion'
      order by e.entity_id limit 1`,
  );
  const entityId = rows[0]!.entity_id;

  for (let i = 0; i < 25; i += 1) {
    const inserted = await client.query<{ contract_action_id: string }>(
      `insert into contract_action
         (awarding_agency_code, piid, modification_number, transaction_number,
          signed_date, action_obligation, entity_id, vendor_name_raw,
          entity_match_method, entity_match_confidence)
       values ('9700', $1, '0', '', current_date - interval '90 days', 250000, $2::bigint,
               'ZTSCORE VENDOR', 'confirmed_alias', 'confirmed')
       on conflict do nothing
       returning contract_action_id`,
      [`ZTSPP${String(i).padStart(4, '0')}`, entityId],
    );
    const id = inserted.rows[0]?.contract_action_id;
    if (id !== undefined) {
      await client.query(
        `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
         values ($1::bigint, 'naics', $2, true)`,
        [id, naics],
      );
    }
  }
}

afterAll(async () => {
  await cleanup();
  await client.query(`delete from contract_action where piid like 'ZTSPP%'`);
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from pursuit where title like '${TITLE_PREFIX}%'`);
  await client.query(`delete from score_model where score_model_version > 1`);
  // The version test clears is_current on version 1 to make room for version 2. Dropping
  // version 2 without putting that back leaves the database with no current model, and
  // every test after it fails for a reason that has nothing to do with what it asserts.
  await client.query(`update score_model set is_current = true where score_model_version = 1`);
}

beforeEach(cleanup);

interface PursuitFixture {
  title?: string;
  signalClass?: string;
  naics?: string | null;
  psc?: string | null;
  agency?: string | null;
  setAside?: string | null;
  vehicle?: string | null;
  value?: number | null;
  /** Days from today. Negative is the past. */
  responseInDays?: number | null;
  endsInMonths?: number | null;
  position?: string | null;
  state?: string;
}

/** A NAICS code that is on the seeded capability profile, so capability can score. */
async function profileNaics(): Promise<string> {
  const { rows } = await client.query<{ code_value: string }>(
    `select code_value from opportunity_profile_effective where code_type = 'naics' order by code_value limit 1`,
  );
  return rows[0]!.code_value;
}

async function makePursuit(fixture: PursuitFixture = {}): Promise<string> {
  const { rows } = await client.query<{ pursuit_id: string }>(
    `insert into pursuit (
       signal_class, title, naics_code, psc_code, agency_code, set_aside_code,
       required_vehicle, estimated_value, response_date, period_end_date,
       astrion_position, state, signal_key, generated_by
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::numeric,
       case when $9::int is null then null else (current_date + ($9 || ' days')::interval)::date end,
       case when $10::int is null then null else (current_date + ($10 || ' months')::interval)::date end,
       $11, $12, $13, 'test'
     ) returning pursuit_id`,
    [
      fixture.signalClass ?? 'recompete_window',
      fixture.title ?? `${TITLE_PREFIX} pursuit`,
      fixture.naics === undefined ? await profileNaics() : fixture.naics,
      fixture.psc ?? null,
      fixture.agency === undefined ? '9700' : fixture.agency,
      fixture.setAside ?? null,
      fixture.vehicle ?? null,
      fixture.value === undefined ? 5_000_000 : fixture.value,
      fixture.responseInDays ?? null,
      fixture.endsInMonths === undefined ? 24 : fixture.endsInMonths,
      fixture.position === undefined ? 'prime_incumbent' : fixture.position,
      fixture.state ?? 'open',
      `${TITLE_PREFIX}:${Math.random().toString(36).slice(2)}`,
    ],
  );
  return rows[0]!.pursuit_id;
}

async function assessmentFor(pursuitId: string) {
  const { rows } = await client.query<{
    assessment_id: string;
    status: string;
    eligibility: string;
    band: string;
    strategic_fit: string | null;
    evidence_confidence: string | null;
    timing_urgency: string | null;
    rank_value: string | null;
    applicable_weight: string | null;
    known_weight: string | null;
    coverage: string | null;
  }>(`select * from assessment where pursuit_id = $1::bigint`, [pursuitId]);
  return rows[0];
}

async function factors(assessmentId: string) {
  const { rows } = await client.query<{
    factor_code: string;
    state: string;
    score: string | null;
    weight_applied: string | null;
    contribution: string | null;
  }>(`select factor_code, state, score, weight_applied, contribution
        from factor_result where assessment_id = $1::bigint`, [assessmentId]);
  return rows;
}

describe('the denominator, spec 10.3', () => {
  it('divides by applicable weight, not known weight', async () => {
    // The whole point. On a pursuit where some factors are unknown, the two denominators
    // give different answers, and the wrong one flatters the pursuit.
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });

    const assessment = await assessmentFor(pursuitId);
    expect(assessment).toBeDefined();
    expect(assessment!.status).toBe('scored');

    const rows = await factors(assessment!.assessment_id);
    const applicable = rows
      .filter((r) => r.state !== 'not_applicable')
      .reduce((sum, r) => sum + Number(r.weight_applied ?? 0), 0);
    const known = rows
      .filter((r) => r.state === 'scored')
      .reduce((sum, r) => sum + Number(r.weight_applied ?? 0), 0);
    const contribution = rows.reduce((sum, r) => sum + Number(r.contribution ?? 0), 0);

    // The fixture has to actually exercise the difference, or this test proves nothing.
    expect(known).toBeLessThan(applicable);

    expect(Number(assessment!.applicable_weight)).toBeCloseTo(applicable, 3);
    expect(Number(assessment!.known_weight)).toBeCloseTo(known, 3);
    expect(Number(assessment!.strategic_fit)).toBeCloseTo(contribution / applicable, 1);
    // And explicitly not the wrong one.
    expect(Number(assessment!.strategic_fit)).not.toBeCloseTo(contribution / known, 1);
  });

  it('a not_applicable factor leaves the denominator entirely', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);
    const rows = await factors(assessment!.assessment_id);

    const notApplicable = rows.filter((r) => r.state === 'not_applicable');
    expect(notApplicable.length).toBeGreaterThan(0);
    for (const row of notApplicable) {
      expect(Number(row.weight_applied)).toBe(0);
      expect(row.score).toBeNull();
    }

    const modelTotal = await client.query<{ total: string }>(
      `select sum(weight)::text as total from score_model_factor where score_model_version = 1`,
    );
    // Applicable is strictly less than the model total, which is what "leaves the
    // denominator" means.
    expect(Number(assessment!.applicable_weight)).toBeLessThan(Number(modelTotal.rows[0]!.total));
  });

  it('an unknown factor stays in the denominator and costs coverage', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);
    const rows = await factors(assessment!.assessment_id);

    const unknown = rows.filter((r) => r.state === 'unknown');
    expect(unknown.length).toBeGreaterThan(0);
    for (const row of unknown) {
      // Its weight is still applied, so it is still in the denominator.
      expect(Number(row.weight_applied)).toBeGreaterThan(0);
      expect(row.score).toBeNull();
      expect(row.contribution).toBeNull();
    }
    expect(Number(assessment!.coverage)).toBeLessThan(1);
  });
});

describe('the three factor states, spec 10.5', () => {
  it('a searched-and-not-found factor scores zero, not unknown', async () => {
    // Codes are present and none is on the profile: the question was asked and the answer
    // is none. That is a zero and it is different from not knowing.
    const pursuitId = await makePursuit({ naics: '999999', psc: 'ZZZZ' });
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);
    const rows = await factors(assessment!.assessment_id);

    const capability = rows.find((r) => r.factor_code === 'capability')!;
    expect(capability.state).toBe('scored');
    expect(Number(capability.score)).toBe(0);
  });

  it('a factor with nothing to search on is unknown, not zero', async () => {
    const pursuitId = await makePursuit({ naics: null, psc: null });
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);
    const rows = await factors(assessment!.assessment_id);

    const capability = rows.find((r) => r.factor_code === 'capability')!;
    expect(capability.state).toBe('unknown');
    expect(capability.score).toBeNull();
  });

  it('the database refuses a score outside the scored state', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    await expect(
      client.query(
        `update factor_result set score = 50
          where assessment_id = $1::bigint and state = 'unknown'`,
        [assessment!.assessment_id],
      ),
    ).rejects.toThrow();
  });
});

describe('hard gates, acceptance test 5', () => {
  it('a failed gate shows no score at all, not a low one', async () => {
    // The response date has passed. A closed solicitation is a fact, not a judgement.
    const pursuitId = await makePursuit({
      signalClass: 'active_solicitation',
      responseInDays: -5,
      endsInMonths: null,
    });
    await scorePursuits(client, { pursuitId });

    const assessment = await assessmentFor(pursuitId);
    expect(assessment!.eligibility).toBe('fail');
    expect(assessment!.band).toBe('blocked');
    expect(assessment!.strategic_fit).toBeNull();
    expect(assessment!.rank_value).toBeNull();

    // And no per-factor scores either: showing those would be showing a score.
    const rows = await factors(assessment!.assessment_id);
    expect(rows).toHaveLength(0);

    const gates = await client.query<{ gate_code: string; state: string }>(
      `select gate_code, state from gate_result where assessment_id = $1::bigint`,
      [assessment!.assessment_id],
    );
    expect(gates.rows.find((g) => g.gate_code === 'response_window')!.state).toBe('fail');
  });

  it('a gate nobody could evaluate is not_evaluated, never pass', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    const gates = await client.query<{ gate_code: string; state: string }>(
      `select gate_code, state from gate_result where assessment_id = $1::bigint`,
      [assessment!.assessment_id],
    );
    const clearance = gates.rows.find((g) => g.gate_code === 'clearance')!;
    expect(clearance.state).toBe('not_evaluated');
    expect(clearance.state).not.toBe('pass');
  });

  it('a tight response window is review, which does not block the score', async () => {
    const pursuitId = await makePursuit({
      signalClass: 'active_solicitation',
      responseInDays: 3,
      endsInMonths: null,
    });
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    expect(assessment!.eligibility).toBe('review');
    expect(assessment!.strategic_fit).not.toBeNull();
  });
});

describe('insufficient evidence, acceptance test 4', () => {
  it('a missing mandatory factor gives no rank', async () => {
    // capability and past_performance are the two is_mandatory rows in the model. With no
    // codes, neither can be answered.
    const pursuitId = await makePursuit({ naics: null, psc: null });
    await scorePursuits(client, { pursuitId });

    const assessment = await assessmentFor(pursuitId);
    expect(assessment!.status).toBe('insufficient_evidence');
    expect(assessment!.band).toBe('insufficient_evidence');
    expect(assessment!.rank_value).toBeNull();
    expect(assessment!.strategic_fit).toBeNull();
  });

  it('coverage below the floor gives no rank even with the mandatory factors scored', async () => {
    const pursuitId = await makePursuit({
      agency: null,      // target_customer unknown
      value: null,       // value_timing needs a date instead
      endsInMonths: null,
      position: null,    // competitive_position unknown
    });
    await scorePursuits(client, { pursuitId });

    const assessment = await assessmentFor(pursuitId);
    expect(Number(assessment!.coverage)).toBeLessThan(MIN_COVERAGE);
    expect(assessment!.rank_value).toBeNull();
    expect(assessment!.status).toBe('insufficient_evidence');
  });
});

describe('the rule trace, acceptance test 7', () => {
  it('every scored assessment carries evidence with a source link', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from evidence_ref
        where assessment_id = $1::bigint and source_uri is not null`,
      [assessment!.assessment_id],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('records evidence that argues against the score rather than hiding it', async () => {
    const pursuitId = await makePursuit({ naics: '999999', psc: 'ZZZZ' });
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from evidence_ref
        where assessment_id = $1::bigint and is_contrary`,
      [assessment!.assessment_id],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('opens a trace naming the rule behind each factor', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    const assessment = await assessmentFor(pursuitId);

    const { rows } = await client.query<{ rule_id: string; factor_code: string }>(
      `select rule_id, factor_code from assessment_trace where assessment_id = $1::bigint`,
      [assessment!.assessment_id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.rule_id).toMatch(/^RULE-/);
  });
});

describe('weights are rows, acceptance test 6', () => {
  it('a weight change makes a new version and does not move a past score', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });

    const before = await assessmentFor(pursuitId);
    const originalFit = Number(before!.strategic_fit);

    // A new model version with capability weighted far more heavily. Spec 13 and D2: this
    // is an insert, not an edit, and it is data rather than a deploy.
    await client.query(`update score_model set is_current = false where score_model_version = 1`);
    await client.query(
      `insert into score_model (score_model_version, created_by, notes, is_current)
       values (2, 'test', 'capability weighted up', true)`,
    );
    await client.query(
      `insert into score_model_factor
         (score_model_version, factor_code, factor_name, weight, is_mandatory, display_order)
       select 2, factor_code, factor_name,
              case when factor_code = 'capability' then 60 else weight end,
              is_mandatory, display_order
         from score_model_factor where score_model_version = 1`,
    );
    await client.query(
      `insert into score_model_gate (score_model_version, gate_code, gate_name, description, display_order)
       select 2, gate_code, gate_name, description, display_order
         from score_model_gate where score_model_version = 1`,
    );

    await scorePursuits(client, { pursuitId });

    const { rows } = await client.query<{ score_model_version: number; strategic_fit: string | null }>(
      `select score_model_version, strategic_fit from assessment
        where pursuit_id = $1::bigint order by score_model_version`,
      [pursuitId],
    );

    // Two assessments now: the original under version 1, untouched, and a new one under 2.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.score_model_version).toBe(1);
    expect(Number(rows[0]!.strategic_fit)).toBeCloseTo(originalFit, 2);
    expect(rows[1]!.score_model_version).toBe(2);
  });

  it('re-running under the same version replaces rather than duplicates', async () => {
    const pursuitId = await makePursuit();
    await scorePursuits(client, { pursuitId });
    await scorePursuits(client, { pursuitId });

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from assessment where pursuit_id = $1::bigint`,
      [pursuitId],
    );
    expect(rows[0]!.n).toBe('1');
  });
});

describe('what is not scored', () => {
  it('leaves a decided pursuit alone', async () => {
    // Scoring a won or lost pursuit is arguing with a decision already made.
    for (const state of ['won', 'lost', 'dropped']) {
      const pursuitId = await makePursuit({ state });
      await scorePursuits(client, { pursuitId });
      expect(await assessmentFor(pursuitId)).toBeUndefined();
    }
  });

  it('bands against the threshold for the signal class, not one number for all', async () => {
    // The same fit is a pursue on a shaping target and a review on a solicitation,
    // because BD Ops sets a different bar per class. Spec section 13.
    const { rows } = await client.query<{ signal_class: string; min_strategic_fit: string }>(
      `select signal_class, min_strategic_fit::text from signal_class_threshold
        where signal_class in ('active_solicitation', 'shaping_target')`,
    );
    const solicitation = Number(rows.find((r) => r.signal_class === 'active_solicitation')!.min_strategic_fit);
    const shaping = Number(rows.find((r) => r.signal_class === 'shaping_target')!.min_strategic_fit);
    expect(solicitation).toBeGreaterThan(shaping);

    const shapingId = await makePursuit({ signalClass: 'shaping_target' });
    const solicitationId = await makePursuit({ signalClass: 'active_solicitation' });
    await scorePursuits(client, {});

    const a = await assessmentFor(shapingId);
    const b = await assessmentFor(solicitationId);
    // Same inputs, same fit, different bar.
    expect(Number(a!.strategic_fit)).toBeCloseTo(Number(b!.strategic_fit), 1);
    expect(a!.band).toBe('pursue');
    expect(b!.band).not.toBe('pursue');
  });
});
