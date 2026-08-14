/**
 * The blank transaction number, and the decision taken about it.
 *
 * The Astrion FPDS export supplies a 'Transaction #' column and leaves it empty on
 * every row. FPDS-NG uses that column to distinguish several transactions recorded
 * against one modification, and spec 7.2 makes it the fourth component of
 * contract_action's natural key. Keyed literally, distinct transactions overwrite
 * each other: on the supplied corpus, 2,023 modifications, 4,912 payloads, and
 * $1.87bn of Action Obligation.
 *
 * Gavin Taylor's decision of 14 August 2026 was to keep every transaction by
 * substituting a deterministic content hash, and to pursue a populated column
 * upstream in parallel. These tests pin all three parts of that: the default keeps
 * both transactions, the literal reading is still reachable for comparison, and a
 * real transaction number always beats the surrogate so the handover needs no code
 * change.
 *
 * The fixture is the real collision from the corpus, on Air Force PIID ZT100022F0001
 * modification P00120: one transaction obligating against USAF funds, one
 * deobligating against FMS funds, same agency, PIID and modification.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import { query, closePool, withTransaction } from '../src/db/index.js';
import { loadFpdsFile } from '../src/loaders/fpds.js';

let fixtureDir: string;

const HEADER = [
  'Agency',
  'PIID',
  'Mod #',
  'Transaction #',
  'Signed Date',
  'Action Obligation',
  'Funding: Office',
  'Contractor: Name',
  'Contractor: UEI',
  'Product Service Code',
].join(',');

interface Row {
  piid: string;
  mod: string;
  txn: string;
  obligation: string;
  fundingOffice: string;
}

/** Uses the packed 'CODE: LABEL' form the real export supplies. */
function toCsv(rows: Row[]): string {
  const lines = [HEADER];
  for (const r of rows) {
    lines.push(
      [
        '"9700: DEPARTMENT OF EXAMPLE"',
        r.piid,
        r.mod,
        r.txn,
        '2026-08-06',
        r.obligation,
        `"${r.fundingOffice}"`,
        '"QUANTALYTIC INC"',
        'ZZ2TESTUEI02',
        '"R425: SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL"',
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** The collision as it appears in the corpus: blank transaction numbers. */
const COLLIDING: Row[] = [
  { piid: 'ZT100022F0001', mod: 'P00120', txn: '', obligation: '16695.57', fundingOffice: 'ZO001A: ZO001A REGIONAL OFFICE ALPHA' },
  { piid: 'ZT100022F0001', mod: 'P00120', txn: '', obligation: '-373549.1', fundingOffice: 'ZO001B: ZO001B REGIONAL OFFICE BRAVO' },
];

/** The same two transactions once the export supplies the column. */
const NUMBERED: Row[] = [
  { piid: 'ZT100022F0001', mod: 'P00121', txn: '0', obligation: '16695.57', fundingOffice: 'ZO001A: ZO001A REGIONAL OFFICE ALPHA' },
  { piid: 'ZT100022F0001', mod: 'P00121', txn: '1', obligation: '-373549.1', fundingOffice: 'ZO001B: ZO001B REGIONAL OFFICE BRAVO' },
];

async function load(
  fileName: string,
  options: Parameters<typeof loadFpdsFile>[3] = {},
): Promise<NonNullable<Awaited<ReturnType<typeof loadFpdsFile>>>> {
  const result = await withTransaction(async (client) => {
    const resolver = await EntityResolver.load(client);
    return loadFpdsFile(client, path.join(fixtureDir, fileName), resolver, options);
  });
  if (result === null) throw new Error('loader returned null outside header-report mode');
  return result;
}

async function actionsFor(piid: string, mod: string): Promise<Array<{ txn: string; obligation: number }>> {
  const rows = await query<{ transaction_number: string; action_obligation: string | null }>(
    `select transaction_number, action_obligation
       from contract_action
      where piid = $1 and modification_number = $2
      order by transaction_number`,
    [piid, mod],
  );
  return rows.map((r) => ({ txn: r.transaction_number, obligation: Number(r.action_obligation ?? 0) }));
}

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'cie-txnkey-'));
  await writeFile(path.join(fixtureDir, 'colliding.csv'), toCsv(COLLIDING));
  await writeFile(path.join(fixtureDir, 'colliding_again.csv'), toCsv(COLLIDING));
  await writeFile(path.join(fixtureDir, 'numbered.csv'), toCsv(NUMBERED));
});

afterAll(async () => {
  await closePool();
});

describe('the blank transaction number', () => {
  it('reports every blank cell, so the condition is never silent', async () => {
    const result = await load('colliding.csv');
    expect(result.blankTransactionNumbers).toBe(2);
  });

  it('keeps both transactions by default, which is the decision taken', async () => {
    // colliding.csv was loaded by the test above. Both rows must be present.
    const actions = await actionsFor('ZT100022F0001', 'P00120');
    expect(actions).toHaveLength(2);

    // The money is what the decision was about. Both figures survive.
    const obligations = actions.map((a) => a.obligation).sort((a, b) => a - b);
    expect(obligations).toEqual([-373549.1, 16695.57]);

    // Both keys are marked as synthetic rather than passing as real FPDS numbers.
    for (const action of actions) expect(action.txn).toMatch(/^H:[0-9a-f]{12}$/);
  });

  it('stays idempotent: the same rows in a second file are all unchanged', async () => {
    const result = await load('colliding_again.csv');
    expect(result.run.records).toBe(2);
    expect(result.run.inserted).toBe(0);
    expect(result.run.unchanged).toBe(2);
    expect(await actionsFor('ZT100022F0001', 'P00120')).toHaveLength(2);
  });

  it('prefers a real transaction number over the surrogate', async () => {
    // The handover path. Once the export populates the column, nothing changes in
    // the code and the real numbers are used.
    const result = await load('numbered.csv');
    expect(result.blankTransactionNumbers).toBe(0);
    expect(result.surrogateKeysIssued).toBe(0);

    const actions = await actionsFor('ZT100022F0001', 'P00121');
    expect(actions.map((a) => a.txn)).toEqual(['0', '1']);
  });

  it('still collapses under the literal spec 7.2 reading, and counts what it drops', async () => {
    // Kept reachable so the cost of the literal reading can be measured rather than
    // argued about. This is not the default.
    const result = await load('colliding.csv', { syntheticTransactionNumber: false });

    expect(result.surrogateKeysIssued).toBe(0);
    expect(result.collapsedTransactions).toBe(1);

    // The row that lost is the one whose obligation is reported as dropped.
    expect(result.collapsedObligation).toBeCloseTo(-373549.1, 2);

    // One key, so one action, and the other transaction is not in the projection.
    const actions = await actionsFor('ZT100022F0001', 'P00120');
    const specKeyed = actions.filter((a) => a.txn === '');
    expect(specKeyed).toHaveLength(1);
  });

  it('archives both payloads under the collapsed key, which is why nothing is lost', async () => {
    // This is the load-bearing claim behind migration 0015: contract_action loses a
    // transaction, source_version does not. Under the literal spec key both rows share
    // one source_record_id, and source_version keys on payload_hash as well, so both
    // payloads are retained where only one action survived.
    const archived = await query<{ n: string }>(
      `select count(*)::text as n
         from source_version
        where source_system = 'fpds'
          and source_record_id = '9700|ZT100022F0001|P00120|'`,
    );
    expect(Number(archived[0]!.n)).toBe(2);

    const projected = await query<{ n: string }>(
      `select count(*)::text as n
         from contract_action
        where piid = 'ZT100022F0001' and modification_number = 'P00120'
          and transaction_number = ''`,
    );
    expect(Number(projected[0]!.n)).toBe(1);
  });

  it('reports the collapse through fpds_collapse_summary, not just in the loader log', async () => {
    // The view is what a developer or an acceptance check reads later, so it has to
    // agree with what the loader printed at the time.
    const rows = await query<{
      keys_affected: string;
      payloads_overwritten: string;
      obligation_not_in_contract_action: string;
    }>('select * from fpds_collapse_summary');

    const summary = rows[0]!;
    expect(Number(summary.keys_affected)).toBeGreaterThanOrEqual(1);
    expect(Number(summary.payloads_overwritten)).toBeGreaterThanOrEqual(1);

    // The dropped obligation is a real figure, not zero, and carries a sign.
    expect(Number(summary.obligation_not_in_contract_action)).not.toBe(0);
  });
});
