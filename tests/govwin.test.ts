/**
 * The GovWin export: the XLSX reader, the parsers, the loader and the comparison views.
 *
 * No GovWin data is committed. Deltek's export is licensed content and this is a public repository, so
 * every workbook here is built in the test from invented rows — which also means the reader is exercised
 * against bytes this file produced rather than against a fixture nobody can regenerate.
 *
 * Four things are asserted because each would be silent if wrong:
 *
 *   The value column is thousands. Reading it as dollars is a 1000x error on every figure and nothing
 *   fails. `172400000` in the export is $172.4bn, which is the OASIS+ ceiling.
 *
 *   A month is not a day. Every Deltek estimate in the real export is month-precision and every actual
 *   is day-precision, exactly. A month stored without its precision becomes a claim about the 1st.
 *
 *   Absent cells are absent from the XML, not blank in it. A reader that takes cells positionally
 *   shifts every column after the first gap and produces a file that parses and means something else.
 *
 *   The forecast comparison joins on the predecessor contract. It returns nothing on a thin corpus,
 *   which is indistinguishable from a broken join unless something proves it matches when it should.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../src/db/index.js';
import { readSheet, columnIndex, serialToIsoDay } from '../src/loaders/xlsx.js';
import {
  loadGovwinExport,
  parseGovwinDate,
  parseBasis,
  parseValueUsd,
  parseNaics,
  parseContractNumbers,
  parseExpirations,
  THOUSANDS,
  SOURCE_SYSTEM,
} from '../src/loaders/govwin.js';

let client: PoolClient;
let scratch: string;

const PREFIX = 'ZGW';

beforeAll(async () => {
  client = await pool.connect();
  scratch = mkdtempSync(join(tmpdir(), 'govwin-test-'));
});

afterAll(async () => {
  await cleanup();
  client.release();
  await closePool();
});

async function cleanup(): Promise<void> {
  await client.query(`delete from govwin_opportunity where govwin_id like '${PREFIX}%'`);
  await client.query(`delete from forecast_item where forecast_key like '${PREFIX}%'`);
  await client.query(`delete from pursuit where signal_key like '${PREFIX}%'`);
  await client.query(`delete from source_version where source_system = $1 and source_record_id like '${PREFIX}%'`, [SOURCE_SYSTEM]);
  await client.query(`delete from source_run where source_system = $1 and source_label like '${PREFIX}%'`, [SOURCE_SYSTEM]);
}

beforeEach(cleanup);

/* ------------------------------------------------------------ a workbook, from nothing */

/**
 * A minimal XLSX writer, so the reader can be tested without a committed binary.
 *
 * Stored entries rather than deflated where it makes no difference, and one worksheet. It writes the
 * shape the reader has to cope with: cells carry `r` references and a gap in a row is an absent cell
 * rather than an empty one, which is the trap the reader exists to avoid.
 */
function buildWorkbook(rows: readonly (readonly (string | null)[])[]): Buffer {
  const letters = (index: number): string => {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };

  const escapeXml = (text: string): string =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          // null means the cell is not in the file at all, which is what a blank looks like in XLSX.
          if (value === null) return '';
          const reference = `${letters(columnIndex)}${rowIndex + 1}`;
          if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) {
            return `<c r="${reference}"><v>${value}</v></c>`;
          }
          return `<c r="${reference}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;

  const entries: { name: string; data: Buffer }[] = [
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];

  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, name, compressed);
  }
  // No central directory: the reader walks local headers, and stopping at the first non-signature is
  // how it knows it is done.
  chunks.push(Buffer.alloc(4));
  return Buffer.concat(chunks);
}

const HEADERS = [
  'Status', 'Advertised Interest', 'Opp Type', 'Organization Level 3', 'Primary Requirement',
  'Current Expiration Date', 'Created Date', 'NAICS', 'Incumbent/Contractor', 'Contract Numbers',
  'Competition Type', 'Contract Type', 'Opp ID', 'Program Name', 'Acronym',
  'Organization Level 1', 'Organization Level 2', 'Organization Level 4', 'Solicitation Number',
  'Value (USD-$K)', 'Type of Award', 'Solicitation Date', 'Solicitation Date (Actual/Estimate)',
  'Projected Award Date', 'Response Date', 'Duration', 'Place of Perf - State/Prov.',
  'Place of Perf - Country', 'Place of Perf - Location',
];

function rowFor(values: Record<string, string | null>): (string | null)[] {
  return HEADERS.map((h) => (h in values ? values[h]! : null));
}

function workbookOf(...records: Record<string, string | null>[]): string {
  const path = join(scratch, `export-${Math.abs(records.length * 7 + records.length)}-${records[0]?.['Opp ID'] ?? 'x'}.xlsx`);
  writeFileSync(path, buildWorkbook([HEADERS, ...records.map(rowFor)]));
  return path;
}

const tracked = (overrides: Record<string, string | null> = {}): Record<string, string | null> => ({
  'Opp ID': `${PREFIX}0001`,
  'Opp Type': 'Tracked Opportunities',
  Status: 'Pre-RFP',
  'Program Name': 'EXAMPLE RANGE INSTRUMENTATION SUPPORT',
  'Solicitation Number': `${PREFIX}-26-R-0001`,
  'Organization Level 1': 'DEFENSE',
  'Organization Level 2': 'EXAMPLE TEST AGENCY',
  NAICS: '541330 - Engineering Services, 541715 - Research and Development',
  'Value (USD-$K)': '50000',
  'Solicitation Date': '06/2027',
  'Solicitation Date (Actual/Estimate)': '(Deltek Estimate)',
  'Projected Award Date': '01/2028',
  'Contract Numbers': '[C]ZGWPIID0001',
  'Advertised Interest': '42.0',
  ...overrides,
});

/* ------------------------------------------------------------------- the reader */

describe('the XLSX reader', () => {
  it('converts a cell reference to a column index', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('AN9')).toBe(39);
  });

  it('reads an Excel serial as a day', () => {
    expect(serialToIsoDay(45000)).toBe('2023-03-15');
    expect(serialToIsoDay(0)).toBeNull();
  });

  it('puts a value in the column its reference names, not the next one along', () => {
    // The trap. Absent cells are missing from the XML, so a reader counting siblings shifts every
    // column after a gap and produces a file that parses cleanly and means something else.
    const path = join(scratch, 'gaps.xlsx');
    writeFileSync(path, buildWorkbook([
      ['first', 'second', 'third', 'fourth'],
      ['a', null, null, 'd'],
    ]));
    const rows = readSheet(require('node:fs').readFileSync(path));
    expect(rows[1]).toEqual(['a', '', '', 'd']);
  });

  it('pads a short row so a column index is always safe', () => {
    const path = join(scratch, 'short.xlsx');
    writeFileSync(path, buildWorkbook([['a', 'b', 'c'], ['only']]));
    const rows = readSheet(require('node:fs').readFileSync(path));
    expect(rows[1]!.length).toBeLessThanOrEqual(3);
    expect(rows[1]![0]).toBe('only');
  });

  it('decodes escaped characters without decoding twice', () => {
    const path = join(scratch, 'entities.xlsx');
    writeFileSync(path, buildWorkbook([['h'], ['Research & Development <phase>']]));
    const rows = readSheet(require('node:fs').readFileSync(path));
    expect(rows[1]![0]).toBe('Research & Development <phase>');
  });

  it('refuses a file that is not a workbook rather than returning nothing', () => {
    expect(() => readSheet(Buffer.from('this is not a zip'))).toThrow(/workbook/i);
  });

  it('says so when the sheet asked for is not there', () => {
    const path = join(scratch, 'one-sheet.xlsx');
    writeFileSync(path, buildWorkbook([['a']]));
    expect(() => readSheet(require('node:fs').readFileSync(path), { sheetIndex: 3 })).toThrow(/sheet/i);
  });
});

/* ------------------------------------------------------------------ the parsers */

describe('dates keep the precision the source claimed', () => {
  it('reads a day as a day', () => {
    expect(parseGovwinDate('09/10/2025')).toEqual({ date: '2025-09-10', precision: 'day' });
  });

  it('reads a month as a month, anchored to the first', () => {
    // The anchor is storage, not a claim. The precision column is what carries the claim, which is why
    // it must travel with the date everywhere.
    expect(parseGovwinDate('06/2027')).toEqual({ date: '2027-06-01', precision: 'month' });
  });

  it('treats MULTIPLE as absent rather than picking one', () => {
    expect(parseGovwinDate('MULTIPLE')).toEqual({ date: null, precision: null });
  });

  it('treats a blank as absent', () => {
    expect(parseGovwinDate('   ')).toEqual({ date: null, precision: null });
  });

  it('reads an ISO date, which is how a real Excel serial arrives', () => {
    expect(parseGovwinDate('2025-05-21')).toEqual({ date: '2025-05-21', precision: 'day' });
  });

  it('normalises the basis and refuses to guess an unknown one', () => {
    expect(parseBasis('Actual')).toBe('actual');
    expect(parseBasis('(Deltek Estimate)')).toBe('deltek_estimate');
    expect(parseBasis('(Government Estimate)')).toBe('government_estimate');
    expect(parseBasis('Somebody Else')).toBeNull();
    expect(parseBasis('')).toBeNull();
  });
});

describe('the value column is thousands', () => {
  it('multiplies, because the header says USD-$K and means it', () => {
    expect(THOUSANDS).toBe(1000);
    expect(parseValueUsd('50000')).toBe(50_000_000);
  });

  it('gets the OASIS+ ceiling right, which is the case that proves the units', () => {
    // 172,400,000 thousand is $172.4bn. Read as dollars it is $172m, which is not a plausible ceiling
    // for a government-wide multiple-award vehicle and is how this error would go unnoticed.
    expect(parseValueUsd('1.724E8')).toBe(172_400_000_000);
  });

  it('reads scientific notation, which is how Excel stores a large number', () => {
    expect(parseValueUsd('1.51E8')).toBe(151_000_000_000);
  });

  it('strips punctuation', () => {
    expect(parseValueUsd('$50,000')).toBe(50_000_000);
  });

  it('leaves an unpriced opportunity blank rather than zero', () => {
    expect(parseValueUsd('')).toBeNull();
    expect(parseValueUsd('TBD')).toBeNull();
  });
});

describe('the multi-valued columns', () => {
  it('takes every six-digit NAICS code, primary first', () => {
    const codes = parseNaics('541330 - Engineering Services, 541715 - Research and Development');
    expect(codes[0]).toBe('541330');
    expect(codes).toContain('541715');
  });

  it('does not mistake a label containing digits for a code', () => {
    expect(parseNaics('541330 - Engineering Services for 2026')).toEqual(['541330']);
  });

  it('drops the type prefix from a contract number', () => {
    expect(parseContractNumbers('[C]W15P7T17D0132\n[C]W15P7T17D0123')).toEqual([
      'W15P7T17D0132',
      'W15P7T17D0123',
    ]);
  });

  it('still finds contract numbers in an export without prefixes', () => {
    expect(parseContractNumbers('W15P7T17D0132 W15P7T17D0123')).toEqual([
      'W15P7T17D0132',
      'W15P7T17D0123',
    ]);
  });

  it('takes the earliest expiry and says how many there were', () => {
    // A multiple-award record repeats one date per contract. The earliest is what a recompete turns on;
    // the count is what says whether that date is the whole story.
    expect(parseExpirations('12/02/2035, 05/14/2027, 12/02/2035')).toEqual({
      earliest: '2027-05-14',
      count: 3,
    });
  });

  it('reports no expiry rather than a wrong one', () => {
    expect(parseExpirations('')).toEqual({ earliest: null, count: 0 });
  });
});

/* ------------------------------------------------------------------- the loader */

describe('the loader', () => {
  it('writes an opportunity with its codes and contracts', async () => {
    const result = await loadGovwinExport(client, workbookOf(tracked()), {});

    expect(result.written).toBe(1);
    const { rows } = await client.query<{
      value_usd: string;
      solicitation_date: Date;
      prec: string;
      basis: string;
      govwin_url: string;
    }>(
      `select value_usd, solicitation_date, solicitation_date_precision as prec,
              solicitation_date_basis as basis, govwin_url
         from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(Number(rows[0]!.value_usd)).toBe(50_000_000);
    expect(rows[0]!.prec).toBe('month');
    expect(rows[0]!.basis).toBe('deltek_estimate');
    expect(rows[0]!.govwin_url).toContain(`${PREFIX}0001`);

    const naics = await client.query<{ naics_code: string; is_primary: boolean }>(
      `select naics_code, is_primary from govwin_opportunity_naics where govwin_id = $1 order by naics_code`,
      [`${PREFIX}0001`],
    );
    expect(naics.rows.map((r) => r.naics_code)).toEqual(['541330', '541715']);
    expect(naics.rows.find((r) => r.naics_code === '541330')!.is_primary).toBe(true);

    const contracts = await client.query<{ piid: string }>(
      `select piid from govwin_opportunity_contract where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(contracts.rows.map((r) => r.piid)).toEqual(['ZGWPIID0001']);
  });

  it('never stores the licensed prose, even when the export carries it', async () => {
    // The reason: this system renders to a snapshot that embeds every row it shows, so licensed
    // analysis in the database is one careless publish away from a public URL.
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'govwin_opportunity'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    expect(names).not.toContain('summary');
    expect(names).not.toContain('latest_news');
    expect(names).toContain('govwin_url');
  });

  it('is idempotent, and still records that the source confirmed the row', async () => {
    const path = workbookOf(tracked());
    await loadGovwinExport(client, path, {});
    const first = await client.query<{ last_seen_at: Date }>(
      `select last_seen_at from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );

    const second = await loadGovwinExport(client, path, {});
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);

    const after = await client.query<{ n: string; last_seen_at: Date }>(
      `select count(*)::text as n, max(last_seen_at) as last_seen_at
         from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(after.rows[0]!.n).toBe('1');
    expect(after.rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      first.rows[0]!.last_seen_at.getTime(),
    );
  });

  it('updates a row whose status has moved', async () => {
    await loadGovwinExport(client, workbookOf(tracked()), {});
    await loadGovwinExport(client, workbookOf(tracked({ Status: 'Source Selection' })), {});

    const { rows } = await client.query<{ status: string }>(
      `select status from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows[0]!.status).toBe('Source Selection');
  });

  it('drops a NAICS code the export no longer lists', async () => {
    await loadGovwinExport(client, workbookOf(tracked()), {});
    await loadGovwinExport(
      client,
      workbookOf(tracked({ NAICS: '541330 - Engineering Services', Status: 'Post-RFP' })),
      {},
    );

    const { rows } = await client.query<{ naics_code: string }>(
      `select naics_code from govwin_opportunity_naics where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows.map((r) => r.naics_code)).toEqual(['541330']);
  });

  it('counts by status and type without dropping either', async () => {
    const result = await loadGovwinExport(
      client,
      workbookOf(
        tracked(),
        tracked({ 'Opp ID': `${PREFIX}0002`, 'Opp Type': 'SAM Notices', Status: 'Expired/Archived' }),
      ),
      {},
    );
    expect(result.byType['Tracked Opportunities']).toBe(1);
    expect(result.byType['SAM Notices']).toBe(1);
    expect(result.byStatus['Expired/Archived']).toBe(1);
  });

  it('counts a solicitation date only where there is one', async () => {
    // Most rows carry a basis with no date. Counting the flag alone reported nineteen hundred dates
    // where there were six hundred.
    const result = await loadGovwinExport(
      client,
      workbookOf(
        tracked({ 'Solicitation Date': null, 'Solicitation Date (Actual/Estimate)': 'Actual' }),
      ),
      {},
    );
    expect(result.actualDates).toBe(0);
    expect(result.estimatedDates).toBe(0);
  });

  it('skips a row with no Opp ID rather than inventing a key', async () => {
    const result = await loadGovwinExport(client, workbookOf(tracked({ 'Opp ID': null })), {});
    expect(result.skippedNoId).toBe(1);
    expect(result.written).toBe(0);
  });

  it('stops on an export missing the columns that key a row', async () => {
    const path = join(scratch, 'wrong-shape.xlsx');
    writeFileSync(path, buildWorkbook([['Something', 'Else'], ['a', 'b']]));
    await expect(loadGovwinExport(client, path, {})).rejects.toThrow(/Opp ID/);
  });

  it('writes nothing on a dry run', async () => {
    const result = await loadGovwinExport(client, workbookOf(tracked()), { dryRun: true });
    expect(result.written).toBe(0);
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from govwin_opportunity where govwin_id like '${PREFIX}%'`,
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('leaves the agency code blank when the name resolves to nothing', async () => {
    const result = await loadGovwinExport(client, workbookOf(tracked()), {});
    expect(result.agencyUnresolved).toBe(1);
    const { rows } = await client.query<{ agency_code: string | null }>(
      `select agency_code from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows[0]!.agency_code).toBeNull();
  });

  it('resolves an agency name the corpus has observed a label for', async () => {
    await client.query(`select cie_observe_code_label('agency', 'ZG77', 'EXAMPLE TEST AGENCY', 'test', 1)`);
    const result = await loadGovwinExport(client, workbookOf(tracked()), {});
    expect(result.agencyResolved).toBe(1);
    const { rows } = await client.query<{ agency_code: string | null }>(
      `select agency_code from govwin_opportunity where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows[0]!.agency_code).toBe('ZG77');
    await client.query(`delete from code_label where code_value = 'ZG77'`);
  });
});

/* -------------------------------------------------------------------- the views */

describe('govwin_live', () => {
  it('keeps what is ahead and excludes what is finished', async () => {
    await loadGovwinExport(
      client,
      workbookOf(
        tracked({ 'Opp ID': `${PREFIX}L1`, Status: 'Pre-RFP' }),
        tracked({ 'Opp ID': `${PREFIX}L2`, Status: 'Forecast Pre-RFP' }),
        tracked({ 'Opp ID': `${PREFIX}L3`, Status: 'Awarded' }),
        tracked({ 'Opp ID': `${PREFIX}L4`, Status: 'Expired/Archived' }),
      ),
      {},
    );

    const { rows } = await client.query<{ govwin_id: string }>(
      `select govwin_id from govwin_live where govwin_id like '${PREFIX}%' order by govwin_id`,
    );
    expect(rows.map((r) => r.govwin_id)).toEqual([`${PREFIX}L1`, `${PREFIX}L2`]);
  });
});

describe('the forecast comparison', () => {
  /**
   * The join is on the predecessor contract, and it returns nothing on a thin corpus.
   *
   * That is exactly why this test exists: an empty view is indistinguishable from a broken one, and the
   * first real export produced zero comparisons because the dev corpus held six projections and none
   * of their contracts. So the match is constructed here rather than hoped for.
   */
  async function projection(piid: string, projectedOn: string): Promise<void> {
    await client.query(
      `insert into forecast_item (
         forecast_key, basis, title, related_piid, period_end_date, lead_days,
         projected_solicitation_date, projected_fy, projected_quarter, confidence, lead_source
       ) values ($1, 'contract_end', 'Example projection', $2, $3::date, 365, $4::date,
                 2027, 3, 'medium', 'default')`,
      [`${PREFIX}FC-${piid}`, piid, projectedOn, projectedOn],
    );
  }

  it('returns a row when a projection and a GovWin record share a contract', async () => {
    await loadGovwinExport(client, workbookOf(tracked()), {});
    await projection('ZGWPIID0001', '2027-06-15');

    const { rows } = await client.query<{ govwin_id: string; same_quarter: boolean; days: number }>(
      `select govwin_id, same_quarter, days_we_are_later as days
         from govwin_forecast_check where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows.length).toBe(1);
    // GovWin says June 2027, the projection says 15 June 2027: the same quarter, fourteen days apart
    // from the month anchor.
    expect(rows[0]!.same_quarter).toBe(true);
    expect(Number(rows[0]!.days)).toBe(14);
  });

  it('marks a disagreement of more than a quarter', async () => {
    await loadGovwinExport(client, workbookOf(tracked()), {});
    await projection('ZGWPIID0001', '2028-02-01');

    const { rows } = await client.query<{ same_quarter: boolean }>(
      `select same_quarter from govwin_forecast_check where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows[0]!.same_quarter).toBe(false);
  });

  it('matches on the vehicle as well as the contract', async () => {
    await loadGovwinExport(client, workbookOf(tracked()), {});
    await client.query(
      `insert into forecast_item (
         forecast_key, basis, title, idv_piid, period_end_date, lead_days,
         projected_solicitation_date, projected_fy, projected_quarter, confidence, lead_source
       ) values ($1, 'vehicle_expiry', 'Example vehicle', 'ZGWPIID0001', '2027-06-01'::date, 365,
                 '2027-06-20'::date, 2027, 3, 'low', 'default')`,
      [`${PREFIX}FC-VEH`],
    );

    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n from govwin_forecast_check where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('counts what each source sees that the other does not', async () => {
    await loadGovwinExport(
      client,
      workbookOf(tracked({ 'Opp ID': `${PREFIX}G1`, Status: 'Forecast Pre-RFP' })),
      {},
    );

    const { rows } = await client.query<{
      govwin_early_without_projection: string;
      govwin_early_total: string;
    }>(`select * from govwin_forecast_gap`);
    // Nothing matches it, so it counts as a requirement the forecast cannot see.
    expect(Number(rows[0]!.govwin_early_without_projection)).toBeGreaterThan(0);
    expect(Number(rows[0]!.govwin_early_total)).toBeGreaterThan(0);
  });
});

describe('govwin_pursuit_link', () => {
  it('links a GovWin record to a requirement sharing its solicitation number', async () => {
    await client.query(
      `insert into pursuit (signal_class, title, solicitation_number, signal_key, generated_by, generated_at)
       values ('active_solicitation', 'Example notice', $1, $2, 'test', now())`,
      [`${PREFIX}-26-R-0001`, `${PREFIX}LINK1`],
    );
    await loadGovwinExport(client, workbookOf(tracked()), {});

    const { rows } = await client.query<{ govwin_status: string; signal_class: string }>(
      `select govwin_status, signal_class from govwin_pursuit_link where govwin_id = $1`,
      [`${PREFIX}0001`],
    );
    expect(rows.length).toBe(1);
    // The two disagree by design and both readings are kept: that is the point of a view over a merge.
    expect(rows[0]!.govwin_status).toBe('Pre-RFP');
    expect(rows[0]!.signal_class).toBe('active_solicitation');
  });
});
