/**
 * The forecast: cadence learning, the projection, the confidence bands, and the backtest.
 * Migration 0023 and src/forecast/.
 *
 * The fixtures reproduce properties rather than looking plausible. Two of them matter more
 * than the rest.
 *
 * **The as-of leak.** A contract whose end date was extended by a modification signed later
 * must show the earlier date when the projection is recomputed as of a date before that
 * modification. Without that property a backtest projects from facts it could not have had,
 * scores well, and means nothing. It is the first thing asserted here.
 *
 * **Blank is not zero.** A contract with no recorded ceiling has to reach the volume of its
 * quarter without reaching the value, and the quarter has to say how many of its rows did
 * that. A forecast that quietly sums unknown as zero produces a dollar figure that is wrong
 * in the direction nobody checks.
 *
 * Everything these tests insert carries a ZFC prefix and is removed afterwards, because this
 * file shares its database with the loader, resolver and recompete tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  DEFAULT_LEAD_DAYS,
  MIN_CADENCE_CHAINS,
  cadenceKey,
  leadTimeFor,
  loadCadence,
  loadNoticeLag,
} from '../src/forecast/cadence.js';
import {
  SOURCE_SYSTEM,
  buildForecast,
  fiscalPeriod,
  projectAsOf,
} from '../src/forecast/forecast.js';
import { runBacktest } from '../src/forecast/backtest.js';

let client: PoolClient;

const PREFIX = 'ZFC';

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query('delete from forecast_backtest_item');
  await client.query('delete from forecast_backtest');
  await client.query(`delete from forecast_item where generated_by = '${SOURCE_SYSTEM}'`);
  await client.query(
    `delete from contract_action_classification
      where contract_action_id in (select contract_action_id from contract_action
                                    where piid like '${PREFIX}%')`,
  );
  await client.query(`delete from contract_action where piid like '${PREFIX}%'`);
  await client.query(`delete from pursuit where signal_key like '%${PREFIX}%' or title like '%${PREFIX}%'`);
  await client.query(`delete from source_version where source_system = '${SOURCE_SYSTEM}'`);
  await client.query(`delete from source_run where source_system = '${SOURCE_SYSTEM}'`);
}

beforeEach(cleanup);

interface AwardFixture {
  piid: string;
  idv?: string | null;
  mod?: string;
  txn?: string;
  agency?: string;
  office?: string | null;
  psc?: string | null;
  naics?: string | null;
  signed: string;
  /** ultimate_completion_date. */
  ends?: string | null;
  current_ends?: string | null;
  obligation?: number | null;
  ceiling?: number | null;
  entityId?: number | null;
}

async function award(fixture: AwardFixture): Promise<number> {
  const { rows } = await client.query<{ contract_action_id: string }>(
    `insert into contract_action (
       awarding_agency_code, piid, modification_number, transaction_number, idv_piid,
       signed_date, ultimate_completion_date, current_completion_date,
       action_obligation, base_and_all_options, entity_id,
       contracting_agency_code, contracting_office_code, vendor_name_raw,
       entity_match_method, entity_match_confidence
     ) values (
       $1, $2, $3, $4, $5, $6::date, $7::date, $8::date, $9, $10, $11::bigint,
       $1, $12, $13, 'confirmed_alias', 'probable'
     ) returning contract_action_id`,
    [
      fixture.agency ?? '9700',
      fixture.piid,
      fixture.mod ?? '0',
      fixture.txn ?? '',
      fixture.idv ?? null,
      fixture.signed,
      fixture.ends ?? null,
      fixture.current_ends ?? fixture.ends ?? null,
      fixture.obligation === undefined ? 250_000 : fixture.obligation,
      fixture.ceiling === undefined ? 1_000_000 : fixture.ceiling,
      fixture.entityId ?? null,
      fixture.office === undefined ? `${PREFIX}OFF` : fixture.office,
      `VENDOR ${fixture.piid}`,
    ],
  );

  const actionId = rows[0]!.contract_action_id;
  const psc = fixture.psc === undefined ? `${PREFIX[0]}T1` : fixture.psc;
  if (psc !== null) {
    await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1::bigint, 'psc', $2, true)`,
      [actionId, psc],
    );
  }
  if (fixture.naics != null) {
    await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1::bigint, 'naics', $2, true)`,
      [actionId, fixture.naics],
    );
  }
  return Number(actionId);
}

/** Days from today, as an ISO day. Fixtures are relative so they do not expire. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function forecastRows(): Promise<
  {
    forecast_key: string;
    basis: string;
    confidence: string;
    lead_source: string;
    lead_days: number;
    projected_solicitation_date: Date;
    projected_fy: number;
    projected_quarter: number;
    estimated_value: string | null;
    cadence_chains: number | null;
    related_piid: string | null;
    idv_piid: string | null;
  }[]
> {
  const { rows } = await client.query(
    `select forecast_key, basis, confidence, lead_source, lead_days,
            projected_solicitation_date, projected_fy, projected_quarter,
            estimated_value::text, cadence_chains, related_piid, idv_piid
       from forecast_item order by forecast_key`,
  );
  return rows as never;
}

async function evidenceFor(forecastKey: string): Promise<{ rule_id: string; supports: boolean }[]> {
  const { rows } = await client.query(
    `select e.rule_id, e.supports
       from forecast_evidence e
       join forecast_item f on f.forecast_id = e.forecast_id
      where f.forecast_key = $1
      order by e.supports, e.rule_id`,
    [forecastKey],
  );
  return rows as never;
}

/* ====================================================================== as-of */

describe('as of a date, migration 0023', () => {
  it('hides an end date that a later modification supplied', async () => {
    // The base award said 2023. A modification signed in 2024 pushed it to 2028. A
    // projection recomputed as of 2023 must see 2023: it is the only thing that was true then,
    // and a backtest that sees 2028 is scoring itself against its own answer sheet.
    await award({ piid: `${PREFIX}L001`, signed: '2020-01-01', ends: '2023-01-01', mod: '0' });
    await award({
      piid: `${PREFIX}L001`, signed: '2024-06-01', ends: '2028-01-01', mod: 'P00001', txn: 'H:m1',
    });

    const before = await client.query<{ ends_on: Date }>(
      `select ends_on from cie_award_shape_asof(date '2023-06-01') where piid = $1`,
      [`${PREFIX}L001`],
    );
    const now = await client.query<{ ends_on: Date }>(
      `select ends_on from cie_award_shape_asof(date '9999-12-31') where piid = $1`,
      [`${PREFIX}L001`],
    );

    expect(before.rows[0]!.ends_on.toISOString().slice(0, 10)).toBe('2023-01-01');
    expect(now.rows[0]!.ends_on.toISOString().slice(0, 10)).toBe('2028-01-01');
  });

  it('hides an award that had not been signed yet', async () => {
    await award({ piid: `${PREFIX}L002`, signed: '2025-01-01', ends: '2029-01-01' });

    const before = await client.query(
      `select 1 from cie_award_shape_asof(date '2024-01-01') where piid = $1`,
      [`${PREFIX}L002`],
    );
    expect(before.rows).toHaveLength(0);
  });

  it('keeps obligations right when an action carries several classification codes', async () => {
    // Classification is many rows per action. Joining it into the award aggregate would
    // multiply every obligation by the number of codes, which is a wrong number that reads as
    // entirely plausible.
    const actionId = await award({
      piid: `${PREFIX}L003`, signed: '2024-01-01', ends: '2027-01-01',
      obligation: 1_000, naics: '541330',
    });
    await client.query(
      `insert into contract_action_classification (contract_action_id, code_type, code_value, is_principal)
       values ($1::bigint, 'psc', 'ZT9', false), ($1::bigint, 'naics', '541712', false)`,
      [actionId],
    );

    const { rows } = await client.query<{ obligated_usd: string }>(
      `select obligated_usd::text from cie_award_shape_asof(date '9999-12-31') where piid = $1`,
      [`${PREFIX}L003`],
    );
    expect(Number(rows[0]!.obligated_usd)).toBe(1_000);
  });
});

/* =================================================================== cadence */

describe('cadence learning', () => {
  /**
   * Four sequential awards of the same work in one office, each starting when the last ends.
   * That is three follow-on chains, which is the bar, and a five-year rhythm.
   */
  async function fiveYearOffice(office: string, psc: string): Promise<void> {
    const years: readonly [string, string][] = [
      ['2009-01-01', '2014-01-01'],
      ['2014-01-01', '2019-01-01'],
      ['2019-01-01', '2024-01-01'],
      ['2024-01-01', '2029-01-01'],
    ];
    for (const [signed, ends] of years) {
      await award({ piid: `${PREFIX}C${signed.slice(0, 4)}`, signed, ends, office, psc, idv: null });
    }
  }

  it('finds a chain when the same office buys the same PSC again as the last award ends', async () => {
    await fiveYearOffice(`${PREFIX}O1`, 'ZT1');

    const { rows } = await client.query<{ interval_days: number; gap_days: number }>(
      `select interval_days, gap_days from contract_followon_chain
        where contracting_office_code = $1 order by prior_starts_on`,
      [`${PREFIX}O1`],
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.interval_days).toBeGreaterThan(1_800);
      expect(row.interval_days).toBeLessThan(1_850);
      expect(row.gap_days).toBe(0);
    }
  });

  it('does not chain across a different kind of work in the same office', async () => {
    await award({ piid: `${PREFIX}C801`, signed: '2019-01-01', ends: '2024-01-01', office: `${PREFIX}O2`, psc: 'ZT1' });
    await award({ piid: `${PREFIX}C802`, signed: '2024-01-01', ends: '2029-01-01', office: `${PREFIX}O2`, psc: 'ZT2' });

    const { rows } = await client.query(
      `select 1 from contract_followon_chain where contracting_office_code = $1`,
      [`${PREFIX}O2`],
    );
    expect(rows).toHaveLength(0);
  });

  it('excludes an award with no PSC, and counts it as excluded', async () => {
    await award({ piid: `${PREFIX}C803`, signed: '2019-01-01', ends: '2024-01-01', office: `${PREFIX}O3`, psc: null });
    await award({ piid: `${PREFIX}C804`, signed: '2024-01-01', ends: '2029-01-01', office: `${PREFIX}O3`, psc: null });

    const chains = await client.query(
      `select 1 from contract_followon_chain where contracting_office_code = $1`,
      [`${PREFIX}O3`],
    );
    expect(chains.rows).toHaveLength(0);

    const { rows } = await client.query<{ no_psc: string }>('select no_psc::text from award_shape_excluded');
    expect(Number(rows[0]!.no_psc)).toBeGreaterThanOrEqual(2);
  });

  it('takes only the earliest successor, so a busy office is not counted many times over', async () => {
    // One award ending, three candidates starting inside the window. Without the earliest-only
    // rule this office would report three chains from one requirement and the median interval
    // would measure how busy the office is rather than how often it re-lets anything.
    await award({ piid: `${PREFIX}C810`, signed: '2019-01-01', ends: '2024-01-01', office: `${PREFIX}O4`, psc: 'ZT1' });
    await award({ piid: `${PREFIX}C811`, signed: '2024-02-01', ends: '2029-01-01', office: `${PREFIX}O4`, psc: 'ZT1' });
    await award({ piid: `${PREFIX}C812`, signed: '2024-03-01', ends: '2029-06-01', office: `${PREFIX}O4`, psc: 'ZT1' });
    await award({ piid: `${PREFIX}C813`, signed: '2024-04-01', ends: '2029-09-01', office: `${PREFIX}O4`, psc: 'ZT1' });

    const { rows } = await client.query<{ prior_piid: string; next_piid: string }>(
      `select prior_piid, next_piid from contract_followon_chain
        where contracting_office_code = $1 and prior_piid = $2`,
      [`${PREFIX}O4`, `${PREFIX}C810`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.next_piid).toBe(`${PREFIX}C811`);
  });

  it('reports the sample size beside the interval', async () => {
    await fiveYearOffice(`${PREFIX}O5`, 'ZT1');

    const cadences = await loadCadence(client);
    const cadence = cadences.get(cadenceKey('9700', `${PREFIX}O5`, 'ZT1'));

    expect(cadence).toBeDefined();
    expect(cadence!.chains_observed).toBe(3);
    expect(cadence!.median_interval_days).toBeGreaterThan(1_800);
  });

  it('will not learn a rhythm from an award that had not happened yet', async () => {
    await fiveYearOffice(`${PREFIX}O6`, 'ZT1');

    // As of 2015 only the first follow-on had been awarded, so there is one chain and it is
    // below the bar. The whole point of the as-of parameter.
    const early = await loadCadence(client, new Date('2015-01-01T00:00:00Z'));
    const now = await loadCadence(client);

    expect(early.get(cadenceKey('9700', `${PREFIX}O6`, 'ZT1'))!.chains_observed).toBe(1);
    expect(now.get(cadenceKey('9700', `${PREFIX}O6`, 'ZT1'))!.chains_observed).toBe(3);
  });
});

/* ================================================================ lead times */

describe('the lead time and where it came from', () => {
  it('falls back to the default, and says it is an assumption', async () => {
    const lead = leadTimeFor('9700', 'NOBODY', 'ZT1', new Map(), new Map());
    expect(lead.days).toBe(DEFAULT_LEAD_DAYS);
    expect(lead.source).toBe('default');
    expect(lead.reason).toContain('Assumed');
  });

  it('uses an office cadence once enough chains have been observed', async () => {
    const cadences = new Map([
      [
        cadenceKey('9700', 'BUSY', 'ZT1'),
        {
          agency_code: '9700', office_code: 'BUSY', psc_code: 'ZT1',
          chains_observed: MIN_CADENCE_CHAINS, chains_across_vehicles: 3,
          chains_incumbent_retained: 1, median_interval_days: 1_826,
          min_interval_days: 1_700, max_interval_days: 1_900,
          median_duration_days: 1_800, median_gap_days: -90,
        },
      ],
    ]);

    const lead = leadTimeFor('9700', 'BUSY', 'ZT1', cadences, new Map());
    expect(lead.source).toBe('office_cadence');
    // The office awards a median 90 days before the previous contract ends, so the
    // solicitation is that much further out than the default.
    expect(lead.days).toBe(DEFAULT_LEAD_DAYS + 90);
    expect(lead.reason).toContain('Inferred');
  });

  it('ignores a cadence built from too few chains', async () => {
    const cadences = new Map([
      [
        cadenceKey('9700', 'THIN', 'ZT1'),
        {
          agency_code: '9700', office_code: 'THIN', psc_code: 'ZT1',
          chains_observed: MIN_CADENCE_CHAINS - 1, chains_across_vehicles: 1,
          chains_incumbent_retained: 0, median_interval_days: 1_826,
          min_interval_days: 1_826, max_interval_days: 1_826,
          median_duration_days: 1_800, median_gap_days: 0,
        },
      ],
    ]);

    const lead = leadTimeFor('9700', 'THIN', 'ZT1', cadences, new Map());
    expect(lead.source).toBe('default');
    expect(lead.reason).toContain('below the');
  });

  it('ignores a cadence that is not a plausible contract rhythm', async () => {
    // Four months apart is a bridge or a task order tempo, not a recompete. The evidence is
    // still reported, but the lead time does not come from it.
    const cadences = new Map([
      [
        cadenceKey('9700', 'FAST', 'ZT1'),
        {
          agency_code: '9700', office_code: 'FAST', psc_code: 'ZT1',
          chains_observed: 9, chains_across_vehicles: 9, chains_incumbent_retained: 4,
          median_interval_days: 120, min_interval_days: 90, max_interval_days: 160,
          median_duration_days: 100, median_gap_days: 0,
        },
      ],
    ]);

    const lead = leadTimeFor('9700', 'FAST', 'ZT1', cadences, new Map());
    expect(lead.source).toBe('default');
    expect(lead.cadence!.chains_observed).toBe(9);
  });

  it('prefers a measured notice lag over an inferred cadence', async () => {
    const cadences = new Map([
      [
        cadenceKey('9700', 'BOTH', 'ZT1'),
        {
          agency_code: '9700', office_code: 'BOTH', psc_code: 'ZT1',
          chains_observed: 5, chains_across_vehicles: 5, chains_incumbent_retained: 2,
          median_interval_days: 1_826, min_interval_days: 1_700, max_interval_days: 2_000,
          median_duration_days: 1_800, median_gap_days: 0,
        },
      ],
    ]);
    const lags = new Map([
      ['9700|BOTH', { agency_code: '9700', office_code: 'BOTH', awards_matched: 4, median_lag_days: 210 }],
    ]);

    const lead = leadTimeFor('9700', 'BOTH', 'ZT1', cadences, lags);
    expect(lead.source).toBe('observed_notice_lag');
    expect(lead.days).toBe(210);
    expect(lead.reason).toContain('Measured');
  });

  it('borrows the agency lag when the office has none of its own', async () => {
    const lags = new Map([
      ['9700|', { agency_code: '9700', office_code: null, awards_matched: 8, median_lag_days: 180 }],
    ]);
    const lead = leadTimeFor('9700', 'QUIET', 'ZT1', new Map(), lags);
    expect(lead.source).toBe('observed_notice_lag');
    expect(lead.reason).toContain('agency 9700');
  });

  it('measures a notice lag from a solicitation number that appears in both sources', async () => {
    await client.query(
      `insert into pursuit (signal_class, title, solicitation_number, posted_date,
                            agency_code, office_code, signal_key, generated_by)
       values ('active_solicitation', '${PREFIX} notice', $1, date '2024-01-01',
               '9700', '${PREFIX}LAG', 'sam:${PREFIX}lag', 'sam_opportunity')`,
      [`${PREFIX}SOL1`],
    );
    await award({ piid: `${PREFIX}SOL1`, signed: '2024-07-01', ends: '2028-01-01', office: `${PREFIX}LAG` });

    const lags = await loadNoticeLag(client);
    const lag = lags.get(`9700|${PREFIX}LAG`);
    expect(lag).toBeDefined();
    expect(lag!.median_lag_days).toBe(182);
  });
});

/* ================================================================ projection */

describe('the projection', () => {
  it('is the end date minus the lead time, in the right fiscal quarter', async () => {
    // Ends in 24 months, no cadence, so the lead is the 365-day default and the projection
    // lands 12 months out.
    await award({ piid: `${PREFIX}P001`, signed: inDays(-400), ends: inDays(730), office: `${PREFIX}Q1` });

    const set = await projectAsOf(client);
    const projection = set.kept.find((p) => p.related_piid === `${PREFIX}P001`);

    expect(projection).toBeDefined();
    expect(projection!.lead.days).toBe(DEFAULT_LEAD_DAYS);

    const expected = new Date(projection!.period_end_date.getTime() - DEFAULT_LEAD_DAYS * 86_400_000);
    expect(projection!.projected.toISOString().slice(0, 10)).toBe(expected.toISOString().slice(0, 10));

    const { fy, quarter } = fiscalPeriod(projection!.projected);
    expect(projection!.projected_fy).toBe(fy);
    expect(projection!.projected_quarter).toBe(quarter);
  });

  it('agrees with the database about which fiscal quarter a date is in', async () => {
    // The projection buckets in TypeScript and the forecast_quarter view groups in SQL. If the
    // two ever disagree the bars stop matching the rows underneath them.
    const days = ['2026-10-01', '2026-12-31', '2027-01-01', '2027-03-31', '2027-07-01', '2027-09-30'];
    const { rows } = await client.query<{ d: string; fy: number; q: number }>(
      `select d::text, cie_fiscal_year(d::date) as fy, cie_fiscal_quarter(d::date) as q
         from unnest($1::text[]) as d`,
      [days],
    );
    for (const row of rows) {
      const mine = fiscalPeriod(new Date(`${row.d}T00:00:00Z`));
      expect([row.d, mine.fy, mine.quarter]).toEqual([row.d, row.fy, row.q]);
    }
  });

  it('bands a cadence-backed projection with a known value as high confidence', async () => {
    const history: readonly [string, string][] = [
      ['2009-01-01', '2014-01-01'],
      ['2014-01-01', '2019-01-01'],
      ['2019-01-01', '2024-01-01'],
    ];
    for (const [signed, ends] of history) {
      await award({ piid: `${PREFIX}H${signed.slice(0, 4)}`, signed, ends, office: `${PREFIX}Q2`, psc: 'ZT1' });
    }
    // The one being projected: same office, same work, ending inside the horizon.
    await award({ piid: `${PREFIX}H2024`, signed: '2024-01-01', ends: inDays(700), office: `${PREFIX}Q2`, psc: 'ZT1' });

    await buildForecast(client);
    const rows = await forecastRows();
    const row = rows.find((r) => r.related_piid === `${PREFIX}H2024`);

    expect(row).toBeDefined();
    expect(row!.lead_source).toBe('office_cadence');
    expect(row!.cadence_chains).toBeGreaterThanOrEqual(MIN_CADENCE_CHAINS);
    expect(row!.confidence).toBe('high');
  });

  it('bands a projection with no cadence evidence at all as low, and says why', async () => {
    await award({ piid: `${PREFIX}P002`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}Q3` });

    await buildForecast(client);
    const row = (await forecastRows()).find((r) => r.related_piid === `${PREFIX}P002`);

    expect(row!.confidence).toBe('low');
    expect(row!.lead_source).toBe('default');

    const evidence = await evidenceFor(row!.forecast_key);
    const against = evidence.filter((e) => !e.supports).map((e) => e.rule_id);
    expect(against).toContain('no_office_cadence');
  });

  it('caps confidence when the contract identity is not certain', async () => {
    // No vehicle, two awardees, two offices: this may be two unrelated awards sharing a short
    // PIID, in which case the end date belongs to the other one. Migration 0019's diagnostic
    // reaches the confidence band rather than sitting in a view nobody opens.
    const { rows: entities } = await client.query<{ entity_id: string }>(
      'select entity_id::text from entity order by entity_id limit 2',
    );
    await award({
      piid: `${PREFIX}P003`, signed: '2019-01-01', ends: inDays(700), idv: null,
      office: `${PREFIX}A1`, entityId: Number(entities[0]!.entity_id),
    });
    await award({
      piid: `${PREFIX}P003`, signed: '2020-01-01', ends: inDays(700), idv: null, mod: 'P00001',
      office: `${PREFIX}A2`, entityId: Number(entities[1]!.entity_id),
    });

    await buildForecast(client);
    const row = (await forecastRows()).find((r) => r.related_piid === `${PREFIX}P003`);

    expect(row!.confidence).not.toBe('high');
    const against = (await evidenceFor(row!.forecast_key)).filter((e) => !e.supports);
    expect(against.map((e) => e.rule_id)).toContain('ambiguous_contract_identity');
  });

  it('keeps a contract with no recorded value, in the volume but not the value', async () => {
    await award({
      piid: `${PREFIX}P004`, signed: inDays(-400), ends: inDays(700),
      obligation: null, ceiling: null, office: `${PREFIX}Q4`,
    });
    await award({
      piid: `${PREFIX}P005`, signed: inDays(-400), ends: inDays(700),
      obligation: 500_000, ceiling: 2_000_000, office: `${PREFIX}Q4`, psc: 'ZT2',
    });

    await buildForecast(client);
    const rows = await forecastRows();
    const blank = rows.find((r) => r.related_piid === `${PREFIX}P004`)!;
    const known = rows.find((r) => r.related_piid === `${PREFIX}P005`)!;

    expect(blank.estimated_value).toBeNull();
    expect(Number(known.estimated_value)).toBe(2_000_000);

    const { rows: quarters } = await client.query<{
      items: number; value_floor_usd: string | null; items_without_value: number;
    }>(
      `select items, value_floor_usd::text, items_without_value from forecast_quarter
        where projected_fy = $1 and projected_quarter = $2`,
      [blank.projected_fy, blank.projected_quarter],
    );
    expect(quarters[0]!.items_without_value).toBeGreaterThanOrEqual(1);
    // The floor counts the known contract and does not invent a zero for the blank one.
    expect(Number(quarters[0]!.value_floor_usd)).toBeGreaterThanOrEqual(2_000_000);
  });

  it('drops a known small contract on a floor and never an unknown one', async () => {
    await award({
      piid: `${PREFIX}P006`, signed: inDays(-400), ends: inDays(700),
      obligation: 1_000, ceiling: 5_000, office: `${PREFIX}Q5`,
    });
    await award({
      piid: `${PREFIX}P007`, signed: inDays(-400), ends: inDays(700),
      obligation: null, ceiling: null, office: `${PREFIX}Q5`, psc: 'ZT2',
    });

    await buildForecast(client, { minValueUsd: 1_000_000 });
    const piids = (await forecastRows()).map((r) => r.related_piid);

    expect(piids).not.toContain(`${PREFIX}P006`);
    expect(piids).toContain(`${PREFIX}P007`);
  });

  it('projects an expiring vehicle as its own item, and never as high confidence', async () => {
    // Two orders under a vehicle. The vehicle itself is the on-ramp opportunity, and the
    // projection is honest that its own lead time makes the date a late estimate.
    await award({
      piid: `${PREFIX}V001`, idv: `${PREFIX}IDV1`, signed: inDays(-800), ends: inDays(700),
      office: `${PREFIX}Q6`,
    });
    await award({
      piid: `${PREFIX}V002`, idv: `${PREFIX}IDV1`, signed: inDays(-700), ends: inDays(650),
      office: `${PREFIX}Q6`, txn: 'H:v2',
    });

    await buildForecast(client);
    const rows = await forecastRows();
    const vehicle = rows.find((r) => r.basis === 'vehicle_expiry' && r.idv_piid === `${PREFIX}IDV1`);

    expect(vehicle).toBeDefined();
    expect(vehicle!.confidence).not.toBe('high');

    const against = (await evidenceFor(vehicle!.forecast_key)).filter((e) => !e.supports);
    expect(against.map((e) => e.rule_id)).toContain('vehicle_lead_is_a_floor');
  });

  it('leaves the vehicles out when asked for contracts only', async () => {
    await award({
      piid: `${PREFIX}V003`, idv: `${PREFIX}IDV2`, signed: inDays(-800), ends: inDays(700),
      office: `${PREFIX}Q7`,
    });

    await buildForecast(client, { contractsOnly: true });
    expect((await forecastRows()).filter((r) => r.basis === 'vehicle_expiry')).toHaveLength(0);
  });

  it('links to a requirement that has already been detected rather than counting it twice', async () => {
    await award({ piid: `${PREFIX}P008`, idv: `${PREFIX}IDV3`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}Q8` });
    await client.query(
      `insert into pursuit (signal_class, title, signal_key, generated_by, related_piid)
       values ('recompete_window', 'Recompete: ${PREFIX}P008',
               'recompete:fpds:9700:${PREFIX}IDV3:${PREFIX}P008', 'signal_recompete', '${PREFIX}P008')`,
    );

    await buildForecast(client);
    const { rows } = await client.query<{ pursuit_id: string | null }>(
      `select pursuit_id::text from forecast_item where related_piid = $1 and basis = 'contract_end'`,
      [`${PREFIX}P008`],
    );
    expect(rows[0]!.pursuit_id).not.toBeNull();

    const supporting = (await client.query<{ rule_id: string }>(
      `select e.rule_id from forecast_evidence e
         join forecast_item f on f.forecast_id = e.forecast_id
        where f.related_piid = $1 and e.supports`,
      [`${PREFIX}P008`],
    )).rows.map((r) => r.rule_id);
    expect(supporting).toContain('already_detected');
  });

  it('never writes a pursuit', async () => {
    await award({ piid: `${PREFIX}P009`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}Q9` });

    const before = await client.query<{ n: string }>('select count(*)::text as n from pursuit');
    await buildForecast(client);
    const after = await client.query<{ n: string }>('select count(*)::text as n from pursuit');

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

/* =============================================================== idempotence */

describe('running it again', () => {
  it('changes nothing and duplicates nothing', async () => {
    await award({ piid: `${PREFIX}I001`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}R1` });

    const first = await buildForecast(client);
    expect(first.run!.inserted).toBeGreaterThan(0);
    const afterFirst = await forecastRows();

    const second = await buildForecast(client);
    expect(second.run!.inserted).toBe(0);
    expect(second.run!.updated).toBe(0);
    expect(second.run!.unchanged).toBe(second.run!.records);
    expect(await forecastRows()).toHaveLength(afterFirst.length);
  });

  it('prunes a projection it would no longer make', async () => {
    await award({ piid: `${PREFIX}I002`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}R2` });
    await buildForecast(client);
    expect((await forecastRows()).some((r) => r.related_piid === `${PREFIX}I002`)).toBe(true);

    // A modification pushes the end date well past the horizon. The projection is no longer one
    // this run would make, so it has to go: a derived table that keeps rows nobody would derive
    // again is a table that quietly stops being true.
    await award({
      piid: `${PREFIX}I002`, signed: inDays(-10), ends: inDays(4_000),
      mod: 'P00002', txn: 'H:x', office: `${PREFIX}R2`,
    });

    const result = await buildForecast(client);
    expect(result.pruned).toBeGreaterThan(0);
    expect((await forecastRows()).some((r) => r.related_piid === `${PREFIX}I002`)).toBe(false);
  });

  it('rewrites the evidence rather than accumulating it', async () => {
    await award({ piid: `${PREFIX}I003`, signed: inDays(-400), ends: inDays(700), office: `${PREFIX}R3` });

    await buildForecast(client);
    const first = await evidenceFor(`forecast:end:9700::${PREFIX}I003`);
    await buildForecast(client);
    const second = await evidenceFor(`forecast:end:9700::${PREFIX}I003`);

    expect(second).toHaveLength(first.length);
  });
});

/* ================================================================== backtest */

describe('the backtest', () => {
  it('scores a projection that came true as a hit and one that did not as a miss', async () => {
    // Re-let: the office bought the same work again as the contract ended.
    await award({
      piid: `${PREFIX}B001`, signed: '2018-01-01', ends: '2022-01-01',
      office: `${PREFIX}S1`, psc: 'ZT1', idv: null,
    });
    await award({
      piid: `${PREFIX}B002`, signed: '2022-01-01', ends: '2026-01-01',
      office: `${PREFIX}S1`, psc: 'ZT1', idv: null,
    });
    // Never re-let: the contract ended and nothing followed it.
    await award({
      piid: `${PREFIX}B003`, signed: '2018-01-01', ends: '2022-06-01',
      office: `${PREFIX}S2`, psc: 'ZT2', idv: null,
    });

    const result = await runBacktest(client, {
      asOf: new Date('2019-01-01T00:00:00Z'),
      horizonMonths: 48,
      dryRun: true,
    });

    const byPiid = new Map(result.scored.map((s) => [s.projection.related_piid, s]));
    expect(byPiid.get(`${PREFIX}B001`)!.outcome).toBe('hit');
    expect(byPiid.get(`${PREFIX}B001`)!.matchedPiid).toBe(`${PREFIX}B002`);
    expect(byPiid.get(`${PREFIX}B001`)!.daysOff).toBe(0);
    expect(byPiid.get(`${PREFIX}B003`)!.outcome).toBe('miss');
  });

  it('will not count an award that had already happened when the projection was made', async () => {
    // The follow-on was awarded in 2019, before the as-of date. Counting it would be scoring
    // a projection against something already on the books when it was made.
    await award({
      piid: `${PREFIX}B010`, signed: '2015-01-01', ends: '2019-01-01',
      office: `${PREFIX}S3`, psc: 'ZT1', idv: null,
    });
    await award({
      piid: `${PREFIX}B011`, signed: '2019-01-01', ends: inDays(700),
      office: `${PREFIX}S3`, psc: 'ZT1', idv: null,
    });

    const result = await runBacktest(client, {
      asOf: new Date('2021-01-01T00:00:00Z'),
      horizonMonths: 48,
      dryRun: true,
    });

    expect(result.scored.some((s) => s.projection.related_piid === `${PREFIX}B010`)).toBe(false);
  });

  it('excludes a projection whose window has not closed yet', async () => {
    await award({
      piid: `${PREFIX}B020`, signed: inDays(-400), ends: inDays(700),
      office: `${PREFIX}S4`, psc: 'ZT1', idv: null,
    });

    const result = await runBacktest(client, {
      asOf: new Date(Date.now() - 30 * 86_400_000),
      horizonMonths: 48,
      dryRun: true,
    });

    expect(result.unresolved).toBeGreaterThan(0);
    expect(result.scored.some((s) => s.projection.related_piid === `${PREFIX}B020`)).toBe(false);
  });

  it('counts a recompete it had no candidate for', async () => {
    // The contract behind this follow-on ended long before the as-of date, so the forecast
    // never had a candidate for it. That is a coverage gap and it is counted rather than
    // dividing hits only by the forecast's own projections.
    await award({
      piid: `${PREFIX}B030`, signed: '2010-01-01', ends: '2014-01-01',
      office: `${PREFIX}S5`, psc: 'ZT1', idv: null,
    });
    await award({
      piid: `${PREFIX}B031`, signed: '2014-01-01', ends: '2018-01-01',
      office: `${PREFIX}S5`, psc: 'ZT1', idv: null,
    });

    const result = await runBacktest(client, {
      asOf: new Date('2013-06-01T00:00:00Z'),
      horizonMonths: 12,
      dryRun: true,
    });

    expect(result.unforecast).toBeGreaterThan(0);
  });

  it('refuses an as-of date in the future', async () => {
    await expect(
      runBacktest(client, { asOf: new Date(Date.now() + 86_400_000), dryRun: true }),
    ).rejects.toThrow(/future/);
  });

  it('records the run, the per-item outcomes, and the rule it scored by', async () => {
    await award({
      piid: `${PREFIX}B040`, signed: '2018-01-01', ends: '2022-01-01',
      office: `${PREFIX}S6`, psc: 'ZT1', idv: null,
    });
    await award({
      piid: `${PREFIX}B041`, signed: '2022-01-01', ends: '2026-01-01',
      office: `${PREFIX}S6`, psc: 'ZT1', idv: null,
    });

    const result = await runBacktest(client, {
      asOf: new Date('2019-01-01T00:00:00Z'),
      horizonMonths: 48,
    });

    expect(result.backtestId).not.toBeNull();

    const { rows: summary } = await client.query<{
      hit_rate: string | null; tolerance_days: number; method: string; projected: number;
    }>(
      `select hit_rate::text, tolerance_days, method, projected
         from forecast_backtest_summary where backtest_id = $1`,
      [result.backtestId],
    );
    expect(summary[0]!.projected).toBe(result.projected);
    expect(Number(summary[0]!.hit_rate)).toBeGreaterThan(0);
    // The scoring rule is stored on the run, because a hit rate without it is not a number.
    expect(summary[0]!.method).toContain('tolerance');

    const { rows: items } = await client.query<{ outcome: string; matched_piid: string | null }>(
      `select outcome, matched_piid from forecast_backtest_item where backtest_id = $1`,
      [result.backtestId],
    );
    expect(items.some((i) => i.outcome === 'hit' && i.matched_piid === `${PREFIX}B041`)).toBe(true);
  });

  it('does not write its historical projections over the live forecast', async () => {
    await award({
      piid: `${PREFIX}B050`, signed: '2018-01-01', ends: '2022-01-01',
      office: `${PREFIX}S7`, psc: 'ZT1', idv: null,
    });

    const before = await client.query<{ n: string }>('select count(*)::text as n from forecast_item');
    await runBacktest(client, { asOf: new Date('2019-01-01T00:00:00Z'), horizonMonths: 48 });
    const after = await client.query<{ n: string }>('select count(*)::text as n from forecast_item');

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
