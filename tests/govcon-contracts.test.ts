/**
 * Contract actions from GovCon API.
 *
 * No network and no API key: the loader takes its HTTP call as a parameter. What these tests assert is
 * not mainly that a field lands in a column — it is the three things that would corrupt the corpus
 * quietly if they were wrong.
 *
 *   A rollup must never be written as a transaction. `/contracts/{piid}` returns the latest action
 *   plus a sum across every action on the PIID, and writing that sum as one row would make every
 *   downstream total wrong while nothing failed.
 *
 *   An API-sourced transaction and a CSV-sourced one must converge on the same row. They share the
 *   spec 7.2 natural key, so a transaction arriving from both must not double an obligation.
 *
 *   The end dates must not be swapped. The forecast projects from the ultimate date, so mapping the
 *   current end date onto it would move every projection by the length of the option years.
 *
 * Every record here is invented and ZC-prefixed so that another test file cannot make these flap.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import {
  pullContracts,
  normalize,
  isRollup,
  readCursor,
  COVERAGE_STARTS,
  SOURCE_SYSTEM,
  type GovconContract,
} from '../src/loaders/govcon/contracts.js';
import { writeContractAction, sourceRecordIdFor, LabelTally } from '../src/loaders/contract.js';
import { startRun, finishRun } from '../src/lib/provenance.js';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import { buildProfile } from '../src/signals/profile.js';
import type { Envelope, Fetched, FetchJson } from '../src/loaders/govcon/client.js';

let client: PoolClient;

const PIID = 'ZCPIID0001';
const AGENCY = '9700';

beforeAll(async () => {
  client = await pool.connect();
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from contract_action where piid like 'ZCPIID%'`);
  await client.query(`delete from sync_cursor where source_system = $1`, [SOURCE_SYSTEM]);
  await client.query(`delete from source_version where source_system in ($1, 'zc_test_csv')`, [SOURCE_SYSTEM]);
  await client.query(`delete from source_run where source_system in ($1, 'zc_test_csv')`, [SOURCE_SYSTEM]);
}

beforeEach(cleanup);

function contract(overrides: Partial<GovconContract> = {}): GovconContract {
  return {
    contract_award_unique_key: `CONT_AWD_${PIID}_${AGENCY}_-NONE-_-NONE-`,
    piid: PIID,
    modification_number: '',
    awarding_agency_code: AGENCY,
    awarding_department_code: '97',
    awarding_office_code: 'ZCOFF1',
    awarding_agency_name: 'Example Defense Department',
    awarding_office_name: 'Example Test Office',
    award_type: 'C',
    signed_date: '2025-03-14',
    period_of_performance_start_date: '2025-04-01',
    period_of_performance_current_end_date: '2027-03-31',
    period_of_performance_potential_end_date: '2029-03-31',
    federal_action_obligation: 4200000,
    base_and_all_options_value: 18500000,
    extent_competed: 'A',
    type_of_set_aside: 'SBA',
    number_of_offers_received: 3,
    recipient_name: 'Example Systems Incorporated',
    recipient_uei: 'ZCUEI0000001',
    recipient_cage_code: 'ZC001',
    naics_code: '541330',
    naics_description: 'Engineering Services',
    product_or_service_code: 'R425',
    ...overrides,
  };
}

function fake(pages: GovconContract[] | ((url: URL) => GovconContract[])): {
  fetchJson: FetchJson;
  urls: URL[];
} {
  const urls: URL[] = [];
  const fetchJson = (async <R>(url: URL): Promise<Fetched<R>> => {
    urls.push(new URL(url.toString()));
    const data = typeof pages === 'function' ? pages(url) : pages;
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const served = offset > 0 ? [] : data;
    return {
      envelope: {
        data: served,
        pagination: { limit: 100, offset, total: data.length, has_next: false },
      } as unknown as Envelope<R>,
      rateLimit: { limit: 1000, remaining: 900 },
    };
  }) as FetchJson;
  return { fetchJson, urls };
}

describe('the rollup guard', () => {
  it('refuses a record carrying a transaction rollup', () => {
    expect(isRollup(contract({ transaction_rollup: { total_obligated: 31_000_000 } }))).toBe(true);
  });

  it('refuses a record carrying a subaward rollup', () => {
    expect(isRollup(contract({ subaward_rollup: { count: 4 } }))).toBe(true);
  });

  it('refuses a rollup total with no per-action figure, which is the same hazard renamed', () => {
    expect(
      isRollup({
        piid: PIID,
        awarding_agency_code: AGENCY,
        total_dollars_obligated: 31_000_000,
      }),
    ).toBe(true);
  });

  it('accepts a rollup total when a per-action figure is also present', () => {
    // A search result may legitimately carry both. The per-action figure is what gets written.
    expect(
      isRollup(contract({ total_dollars_obligated: 31_000_000, federal_action_obligation: 4_200_000 })),
    ).toBe(false);
  });

  it('accepts an ordinary transaction', () => {
    expect(isRollup(contract())).toBe(false);
  });

  it('does not write a rollup, and counts it', async () => {
    await buildProfile(client, { taxonomyOnly: true });
    const { fetchJson } = fake([contract({ transaction_rollup: { total_obligated: 31_000_000 } })]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(result.skippedRollup).toBe(1);
    expect(result.written).toBe(0);

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from contract_action where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('counts one rollup once, however many code searches returned it', async () => {
    // A contract carrying two of the profile's codes comes back from both searches. Counting every
    // occurrence would report eleven rollups where there was one, which an operator would reasonably
    // read as a data problem rather than as arithmetic.
    await buildProfile(client, { taxonomyOnly: true });
    const { fetchJson, urls } = fake([contract({ transaction_rollup: { total_obligated: 31_000_000 } })]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(urls.length).toBeGreaterThan(1);
    expect(result.fetched).toBe(urls.length);
    expect(result.skippedRollup).toBe(1);
  });

  it('sums the transactions rather than trusting a rollup figure', async () => {
    // The whole point. Three actions totalling 7.7M, alongside a rollup claiming 31M. The award shape
    // must read 7.7M — if the rollup leaked in, this is the number that would be wrong.
    await buildProfile(client, { taxonomyOnly: true });
    const { fetchJson } = fake([
      contract({ modification_number: '', federal_action_obligation: 4_200_000 }),
      contract({ modification_number: 'P00001', federal_action_obligation: 1_100_000 }),
      contract({ modification_number: 'P00002', federal_action_obligation: 2_400_000 }),
      contract({
        piid: 'ZCPIID0002',
        transaction_rollup: { total_obligated: 31_000_000 },
        total_dollars_obligated: 31_000_000,
        federal_action_obligation: undefined,
      }),
    ]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    const { rows } = await client.query<{ obligated_usd: string; action_count: string }>(
      `select obligated_usd, action_count from cie_award_shape_asof(current_date) where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.action_count).toBe('3');
    expect(Number(rows[0]!.obligated_usd)).toBe(7_700_000);
  });
});

describe('the field mapping', () => {
  it('keeps the current end date and the ultimate end date apart', () => {
    // The forecast projects from the ultimate date. Swapping these moves every projection by the
    // length of the option years, and nothing would look broken.
    const mapped = normalize(contract())!;
    expect(mapped.currentCompletionDate).toBe('2027-03-31');
    expect(mapped.ultimateCompletionDate).toBe('2029-03-31');
  });

  it('reads the award key', () => {
    expect(normalize(contract())!.awardKey).toBe(`CONT_AWD_${PIID}_${AGENCY}_-NONE-_-NONE-`);
  });

  it('uses the empty string for a blank modification number, as the key requires', () => {
    const mapped = normalize(contract({ modification_number: undefined }))!;
    expect(mapped.modificationNumber).toBe('');
    expect(mapped.transactionNumber).toBe('');
  });

  it('refuses a record with no PIID', () => {
    expect(normalize(contract({ piid: undefined, award_id_piid: undefined }))).toBeNull();
  });

  it('refuses a record with no awarding agency', () => {
    expect(
      normalize(contract({ awarding_agency_code: undefined, awarding_sub_agency_code: undefined })),
    ).toBeNull();
  });

  it('parses a money string with punctuation', () => {
    expect(normalize(contract({ federal_action_obligation: '$4,200,000.00' }))!.actionObligation).toBe(4_200_000);
  });

  it('leaves a missing obligation blank rather than zero', () => {
    // Blank is not zero. A zero-dollar action is a real thing and must not be invented.
    const mapped = normalize(
      contract({ federal_action_obligation: undefined, action_obligation: undefined }),
    )!;
    expect(mapped.actionObligation).toBeNull();
  });

  it('falls back to the action date when there is no signed date', () => {
    const mapped = normalize(contract({ signed_date: undefined, action_date: '2025-05-06' }))!;
    expect(mapped.signedDate).toBe('2025-05-06');
  });

  it('reads the parent vehicle, which is what makes a task order PIID unambiguous', () => {
    const mapped = normalize(contract({ parent_award_id_piid: 'ZCVEHICLE1' }))!;
    expect(mapped.idvPiid).toBe('ZCVEHICLE1');
  });
});

describe('the pull', () => {
  beforeEach(async () => {
    await buildProfile(client, { taxonomyOnly: true });
  });

  it('writes a transaction with its classifications', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(result.written).toBe(1);
    const { rows } = await client.query<{ code_type: string; code_value: string }>(
      `select c.code_type, c.code_value
         from contract_action_classification c
         join contract_action a using (contract_action_id)
        where a.piid = $1 order by c.code_type`,
      [PIID],
    );
    expect(rows).toEqual([
      { code_type: 'naics', code_value: '541330' },
      { code_type: 'psc', code_value: 'R425' },
    ]);
  });

  it('observes code labels, so a code has something to display', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(result.labelsWritten).toBeGreaterThan(0);
    const { rows } = await client.query<{ label: string }>(
      `select label from code_label_current where code_type = 'naics' and code_value = '541330'`,
    );
    expect(rows.length).toBe(1);
  });

  it('resolves the vendor through the same resolver the bulk loader uses', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    // Whatever it resolved to, it must have gone through resolution and recorded a method rather
    // than leaving the columns null unconsidered.
    expect(Object.keys(result.resolvedByMethod).length).toBe(1);
    const { rows } = await client.query<{ entity_match_confidence: string }>(
      `select entity_match_confidence from contract_action where piid = $1`,
      [PIID],
    );
    expect(['confirmed', 'probable', 'unresolved']).toContain(rows[0]!.entity_match_confidence);
  });

  it('is idempotent', async () => {
    const { fetchJson } = fake([contract()]);
    await pullContracts(client, { apiKey: 'ZCKEY', fetchJson, signedFrom: new Date('2025-01-01T00:00:00Z') });
    const second = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from contract_action where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('writes nothing on a dry run', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
      dryRun: true,
    });

    expect(result.written).toBe(0);
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from contract_action where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('moves the cursor on a completed search', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(result.cursorAdvancedTo).not.toBeNull();
    expect((await readCursor(client))!.cursor_at.getTime()).toBe(result.cursorAdvancedTo!.getTime());
  });

  it('does not move the cursor on a dry run', async () => {
    const { fetchJson } = fake([contract()]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
      dryRun: true,
    });
    expect(await readCursor(client)).toBeNull();
  });

  it('does not move the cursor on a company pull', async () => {
    // A company pull covers that company's history, not a window ending now. Advancing would tell the
    // next scheduled run that a window had been covered when it had not.
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      ueis: ['ZCUEI0000001'],
    });

    expect(result.mode).toBe('company');
    expect(result.cursorAdvancedTo).toBeNull();
    expect(await readCursor(client)).toBeNull();
  });

  it('asks the ungated company endpoint in company mode', async () => {
    const { fetchJson, urls } = fake([contract()]);
    await pullContracts(client, { apiKey: 'ZCKEY', fetchJson, ueis: ['ZCUEI0000001'] });

    expect(urls[0]!.pathname).toContain('/companies/ZCUEI0000001/awards');
    expect(urls[0]!.searchParams.has('date_from')).toBe(false);
  });

  it('sends a signed-date range and a code filter in search mode', async () => {
    const { fetchJson, urls } = fake([]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
      signedTo: new Date('2025-06-30T00:00:00Z'),
      dryRun: true,
    });

    expect(urls[0]!.pathname).toContain('/contracts/search');
    expect(urls[0]!.searchParams.get('date_from')).toBe('2025-01-01');
    expect(urls[0]!.searchParams.get('date_to')).toBe('2025-06-30');
    expect(urls[0]!.searchParams.has('naics')).toBe(true);
  });

  it('flags a run that reached before the API covers comprehensively', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2019-01-01T00:00:00Z'),
      dryRun: true,
    });

    expect(result.reachedBeforeCoverage).toBe(true);
    expect(COVERAGE_STARTS).toBe('2024-10-01');
  });

  it('does not flag a run inside the covered window', async () => {
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-06-01T00:00:00Z'),
      dryRun: true,
    });

    expect(result.reachedBeforeCoverage).toBe(false);
  });

  it('refuses an empty date range', async () => {
    const { fetchJson } = fake([]);
    await expect(
      pullContracts(client, {
        apiKey: 'ZCKEY',
        fetchJson,
        signedFrom: new Date('2025-06-30T00:00:00Z'),
        signedTo: new Date('2025-01-01T00:00:00Z'),
      }),
    ).rejects.toThrow(/empty/);
  });

  it('writes one row for a transaction two code searches both return', async () => {
    // The same transaction comes back from the NAICS search for each of its codes. Written once.
    const { fetchJson } = fake([contract()]);
    const result = await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    expect(result.fetched).toBeGreaterThanOrEqual(result.written);
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from contract_action where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.n).toBe('1');
  });

  it('never lets the API key reach the archived payload', async () => {
    const { fetchJson } = fake([contract()]);
    await pullContracts(client, {
      apiKey: 'ZCSECRETKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    const { rows } = await client.query<{ payload: string }>(
      `select payload::text from source_version where source_system = $1`,
      [SOURCE_SYSTEM],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.payload).not.toContain('ZCSECRETKEY');
  });
});

describe('two sources, one contract action', () => {
  it('converges when the same transaction arrives from an extract and from the API', async () => {
    // The load-bearing test. A transaction written by a bulk extract and then seen by the API must
    // update one row rather than create a second, because a second row would double its obligation in
    // every sum downstream and nothing would error.
    await buildProfile(client, { taxonomyOnly: true });
    const resolver = await EntityResolver.load(client);

    // Stand in for the bulk extract: the shared write path, under a different source system.
    const csvRun = await startRun(client, 'zc_test_csv', 'zc.csv');
    const fromCsv = normalize(contract())!;
    await writeContractAction(
      client,
      csvRun,
      // A bulk extract carries no award key. The upsert must not later erase what the API supplies,
      // nor must this blank overwrite it.
      { ...fromCsv, awardKey: null },
      { source: 'csv', piid: PIID },
      resolver,
    );
    await finishRun(client, csvRun);

    const { fetchJson } = fake([contract()]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    const { rows } = await client.query<{ n: string; contract_award_key: string | null }>(
      `select count(*)::text as n, max(contract_award_key) as contract_award_key
         from contract_action where piid = $1`,
      [PIID],
    );
    expect(rows[0]!.n).toBe('1');
    // And the API's key survived rather than being blanked by the extract's null.
    expect(rows[0]!.contract_award_key).toBe(`CONT_AWD_${PIID}_${AGENCY}_-NONE-_-NONE-`);
  });

  it('does not blank an award key when an extract row arrives after the API row', async () => {
    await buildProfile(client, { taxonomyOnly: true });
    const resolver = await EntityResolver.load(client);

    const { fetchJson } = fake([contract()]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    // Now the extract, second, with a changed payload so the hash skip does not hide the question.
    const csvRun = await startRun(client, 'zc_test_csv', 'zc.csv');
    const fromCsv = normalize(contract({ number_of_offers_received: 9 }))!;
    await writeContractAction(client, csvRun, { ...fromCsv, awardKey: null }, { source: 'csv', n: 9 }, resolver);
    await finishRun(client, csvRun);

    const { rows } = await client.query<{ contract_award_key: string | null; number_of_offers_received: number }>(
      `select contract_award_key, number_of_offers_received from contract_action where piid = $1`,
      [PIID],
    );
    // The extract's value won for the field it carries, and the key it does not carry survived.
    expect(rows[0]!.number_of_offers_received).toBe(9);
    expect(rows[0]!.contract_award_key).toBe(`CONT_AWD_${PIID}_${AGENCY}_-NONE-_-NONE-`);
  });

  it('agrees with D13 grouping on the award key', async () => {
    // The award key identifies the award, not the transaction, so every modification on one PIID
    // carries one value and one D13 group holds one key. This is the measurement that would justify
    // changing D13 later, so it is asserted rather than assumed.
    await buildProfile(client, { taxonomyOnly: true });
    const { fetchJson } = fake([
      contract({ modification_number: '' }),
      contract({ modification_number: 'P00001' }),
      contract({ modification_number: 'P00002' }),
    ]);
    await pullContracts(client, {
      apiKey: 'ZCKEY',
      fetchJson,
      signedFrom: new Date('2025-01-01T00:00:00Z'),
    });

    const { rows } = await client.query<{
      keyed_actions: string;
      distinct_keys: string;
      keys_split_across_groups: string;
      groups_holding_many_keys: string;
    }>(`select * from contract_award_key_agreement`);

    expect(rows[0]!.keys_split_across_groups).toBe('0');
    expect(rows[0]!.groups_holding_many_keys).toBe('0');
  });
});

describe('the shared write path', () => {
  it('builds the natural key in spec 7.2 order', () => {
    expect(
      sourceRecordIdFor({
        awardingAgencyCode: AGENCY,
        piid: PIID,
        modificationNumber: 'P00001',
        transactionNumber: '',
      }),
    ).toBe(`${AGENCY}|${PIID}|P00001|`);
  });

  it('counts a label once per record rather than once per run', async () => {
    const tally = new LabelTally();
    tally.observe('naics', '541330', 'Engineering Services');
    tally.observe('naics', '541330', 'Engineering Services');
    tally.observe('psc', 'R425', 'Engineering support');
    expect(tally.size).toBe(2);
  });

  it('ignores a label with no code and a code with no label', () => {
    const tally = new LabelTally();
    tally.observe('naics', null, 'Engineering Services');
    tally.observe('naics', '541330', null);
    expect(tally.size).toBe(0);
  });
});
