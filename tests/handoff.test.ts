/**
 * The hand-off: the field block, the written summary, and the spreadsheet. src/web/handoff.ts.
 *
 * No database here. These are pure functions over one row, and the properties worth pinning are the
 * ones that make a paste-into-TechnoMile safe rather than the ones that make it pretty.
 *
 * Two of them are the sort of thing that is discovered in production and never written down.
 *
 * **A CSV cell beginning `=`, `+`, `-` or `@` is executed as a formula when Excel opens the file.**
 * Federal notice titles begin with all four, and a set-aside code of `-` is not unusual. The guard
 * is asserted directly, because "we escape quotes" is the part everybody remembers and the formula
 * prefix is the part nobody does.
 *
 * **Blank is not zero and blank is not blank.** In the field block a missing value reads "not
 * recorded", because a gap in a pasted block reads as something the sender forgot. In the CSV the
 * same value is an empty cell, because a spreadsheet sums a column and "not recorded" is not a
 * number. The two are different on purpose and both are asserted.
 */
import { describe, it, expect } from 'vitest';
import {
  csvCell,
  csvFilename,
  handoffBlock,
  handoffCsv,
  handoffFields,
  handoffSummary,
} from '../src/web/handoff.js';
import type { HandoffRow } from '../src/web/queries.js';

/** A row with everything present. Every value here is invented. */
const FULL: HandoffRow = {
  pursuit_id: '1',
  title: 'Hypersonic flight test instrumentation and range support services',
  signal_class: 'active_solicitation',
  agency_code: '5700',
  agency_label: 'EXAMPLE AIR SERVICE',
  office_code: 'ZOFF02',
  office_label: 'EXAMPLE RANGE OPERATIONS',
  solicitation_number: 'ZDEMO-SOL-0001',
  notice_id: 'zdemo-notice-1',
  related_piid: null,
  naics_code: '541330',
  naics_label: 'ENGINEERING SERVICES',
  psc_code: 'ZT2',
  psc_label: 'RANGE INSTRUMENTATION',
  set_aside_code: 'SBA',
  place_of_performance_state: 'CA',
  estimated_value: '48000000.00',
  response_date: new Date('2026-09-10T00:00:00Z'),
  posted_date: new Date('2026-08-14T00:00:00Z'),
  period_end_date: null,
  notice_url: 'https://sam.gov/opp/zdemo-notice-1/view',
  notice_type: 'Solicitation',
  incumbent_name: 'Example Range Services',
  incumbent_confidence: 'probable',
  astrion_position: 'subcontractor',
  band: 'pursue',
  strategic_fit: '72.4',
  capabilities: 'Range operations and instrumentation',
};

/** A row with nothing recorded beyond a title and a stage. The state most rows are in. */
const SPARSE: HandoffRow = {
  ...FULL,
  pursuit_id: '2',
  title: 'Recompete: ZDEMO-B1',
  signal_class: 'recompete_window',
  agency_code: null,
  agency_label: null,
  office_code: null,
  office_label: null,
  solicitation_number: null,
  notice_id: null,
  related_piid: 'ZDEMO-B1',
  naics_code: null,
  naics_label: null,
  psc_code: null,
  psc_label: null,
  set_aside_code: null,
  place_of_performance_state: null,
  estimated_value: null,
  response_date: null,
  posted_date: null,
  period_end_date: new Date('2028-05-18T00:00:00Z'),
  notice_url: null,
  notice_type: null,
  incumbent_name: null,
  incumbent_confidence: null,
  astrion_position: null,
  band: null,
  strategic_fit: null,
  capabilities: null,
};

/**
 * Split one CSV line into cells.
 *
 * Written out rather than done with a regex. A regex that looks right splits `a,"b,c",` into the
 * wrong number of cells often enough that a test using one can pass while asserting the wrong
 * column, which is worse than no test.
 */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const character = line[i]!;
    if (inQuotes) {
      if (character === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') inQuotes = true;
    else if (character === ',') {
      cells.push(cell);
      cell = '';
    } else cell += character;
  }
  cells.push(cell);
  return cells;
}

function fieldValue(row: HandoffRow, label: string): string {
  const field = handoffFields(row).find((f) => f.label === label);
  if (field === undefined) throw new Error(`No field called ${label}`);
  return field.value;
}

/* =============================================================== field block */

describe('the field block', () => {
  it('carries a code and its label together', () => {
    // Nobody pasting into TechnoMile will look up what 5700 means, and the record would carry the
    // number for ever.
    expect(fieldValue(FULL, 'Agency')).toBe('5700 — EXAMPLE AIR SERVICE');
    expect(fieldValue(FULL, 'NAICS')).toBe('541330 — ENGINEERING SERVICES');
    expect(fieldValue(FULL, 'PSC')).toBe('ZT2 — RANGE INSTRUMENTATION');
  });

  it('falls back to the bare code when no label has been observed', () => {
    const noLabel: HandoffRow = { ...FULL, agency_label: null };
    expect(fieldValue(noLabel, 'Agency')).toBe('5700');
  });

  it('says "not recorded" rather than leaving a gap', () => {
    // A gap in a pasted block reads as something the sender forgot to fill in.
    expect(fieldValue(SPARSE, 'Estimated value')).toBe('not recorded');
    expect(fieldValue(SPARSE, 'Responses due')).toBe('not recorded');
    expect(fieldValue(SPARSE, 'Agency')).toBe('not recorded');
    expect(fieldValue(SPARSE, 'Incumbent')).toBe('not recorded');
  });

  it('never renders an absent value as zero', () => {
    const block = handoffBlock(SPARSE);
    expect(block).not.toMatch(/\$0\b/);
    expect(block).not.toMatch(/: 0$/m);
  });

  it('never presents the strategic fit as a probability of win', () => {
    // Spec 10.1. The number is a measure of fit, and a record that carries it as a percentage of
    // anything invites a conversation nobody can win.
    expect(fieldValue(FULL, 'Strategic fit')).toBe('72 of 100 (not a win probability)');
    expect(fieldValue(SPARSE, 'Strategic fit')).toBe('not scored');
  });

  it('carries the incumbent confidence as a word, never a percentage', () => {
    // Spec 14.6: three states only.
    expect(fieldValue(FULL, 'Incumbent confidence')).toBe('probable');
    expect(fieldValue(FULL, 'Incumbent confidence')).not.toMatch(/%/);
  });

  it('says where it came from, so the record does not look like a system of record', () => {
    expect(fieldValue(FULL, 'Source')).toMatch(/TechnoMile is the system of record/);
  });

  it('aligns the labels, so the block reads as a block', () => {
    const lines = handoffBlock(FULL).split('\n');
    const valueStarts = new Set(
      lines.map((line) => line.length - line.replace(/^\S+(?: \S+)*?\s{2,}/, '').length),
    );
    expect(valueStarts.size).toBe(1);
  });

  it('formats money with separators and no cents', () => {
    expect(fieldValue(FULL, 'Estimated value')).toBe('$48,000,000');
  });
});

/* ============================================================ written summary */

describe('the written summary', () => {
  it('reads as prose and names the customer, the number and the deadline', () => {
    const summary = handoffSummary(FULL);
    expect(summary).toContain('EXAMPLE AIR SERVICE');
    expect(summary).toContain('ZDEMO-SOL-0001');
    expect(summary).toContain('2026-09-10');
    expect(summary).toContain('$48,000,000');
  });

  it('gets the article right', () => {
    // "an open solicitation", not "a open solicitation". This paragraph gets pasted into a
    // customer-facing record.
    expect(handoffSummary(FULL)).toContain('This is an open solicitation.');
    expect(handoffSummary(SPARSE)).toContain('This is a recompete window.');
  });

  it('leaves a silent field out rather than reporting the silence as a finding', () => {
    const summary = handoffSummary(SPARSE);
    expect(summary).not.toMatch(/not recorded/);
    expect(summary).not.toMatch(/unknown/);
    expect(summary).not.toMatch(/Estimated value/);
  });

  it('says there is no solicitation out yet when there is not', () => {
    const summary = handoffSummary(SPARSE);
    expect(summary).toContain('No solicitation is out yet');
    expect(summary).toContain('2028-05-18');
  });

  it('says nothing the field block does not', () => {
    // The two are assembled from the same row on purpose, so they cannot disagree about a date.
    const block = handoffBlock(FULL);
    for (const fragment of ['ZDEMO-SOL-0001', '2026-09-10', '$48,000,000', 'EXAMPLE AIR SERVICE']) {
      expect(block).toContain(fragment);
      expect(handoffSummary(FULL)).toContain(fragment);
    }
  });

  it('states our position where there is one', () => {
    expect(handoffSummary(FULL)).toContain('subcontract');
    expect(handoffSummary({ ...FULL, astrion_position: 'prime_incumbent' })).toContain('as prime');
    expect(handoffSummary({ ...FULL, astrion_position: 'none' })).not.toMatch(/as prime|subcontract on/);
  });

  it('qualifies the strategic fit in the same breath as reporting it', () => {
    expect(handoffSummary(FULL)).toContain('not a probability of win');
  });
});

/* ======================================================================= CSV */

describe('the spreadsheet', () => {
  it('quotes a cell holding a comma or a quote, per RFC 4180', () => {
    expect(csvCell('one, two')).toBe('"one, two"');
    expect(csvCell('he said "no"')).toBe('"he said ""no"""');
    expect(csvCell('plain')).toBe('plain');
  });

  it('defuses a cell Excel would execute as a formula', () => {
    // Federal notice titles begin with all four of these, and a set-aside of "-" is not unusual.
    for (const hostile of ['=1+1', '+SUM(A1)', '-2+3', '@import', '=cmd|\' /c calc\'!A1']) {
      const cell = csvCell(hostile);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });

  it('collapses a newline rather than breaking the row in two', () => {
    expect(csvCell('line one\nline two')).toBe('line one line two');
    expect(csvCell('line one\r\nline two')).toBe('line one line two');
  });

  it('writes a byte order mark and CRLF, so Excel on Windows reads it right', () => {
    const csv = handoffCsv([FULL]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
  });

  it('keeps the code and its label in separate columns, so the sheet can be sorted', () => {
    const [header, row] = handoffCsv([FULL]).split('\r\n');
    const columns = csvCells(header!.replace('﻿', ''));
    const cells = csvCells(row!);
    expect(cells[columns.indexOf('Agency code')]).toBe('5700');
    expect(cells[columns.indexOf('Agency')]).toBe('EXAMPLE AIR SERVICE');
  });

  it('leaves an absent value as an empty cell, never as a zero', () => {
    const [header, row] = handoffCsv([SPARSE]).split('\r\n');
    const columns = csvCells(header!.replace('﻿', ''));
    const cells = csvCells(row!);
    expect(cells).toHaveLength(columns.length);

    for (const column of ['Estimated value USD', 'NAICS', 'Agency', 'Responses due']) {
      const at = columns.indexOf(column);
      expect(at).toBeGreaterThan(-1);
      expect(cells[at]).toBe('');
    }
  });

  it('writes the value column unformatted, so the spreadsheet reads it as a number', () => {
    // The Summary column carries the same figure as prose and formats it, which is correct: a
    // sentence reads "$48,000,000" and a value column has to be a number. The assertion is on the
    // column rather than the row, because both are true at once.
    const [header, row] = handoffCsv([FULL]).split('\r\n');
    const columns = csvCells(header!.replace('﻿', ''));
    const cells = csvCells(row!);
    const value = cells[columns.indexOf('Estimated value USD')];

    expect(value).toBe('48000000.00');
    expect(value).not.toMatch(/[$,]/);
  });

  it('carries a header even when there are no rows', () => {
    const csv = handoffCsv([]);
    expect(csv.replace('﻿', '').split('\r\n')[0]).toContain('Title');
    expect(csv.trim().split('\r\n')).toHaveLength(1);
  });

  it('carries the written summary as its last column', () => {
    const header = csvCells(handoffCsv([FULL]).split('\r\n')[0]!.replace('﻿', ''));
    expect(header[header.length - 1]).toBe('Summary');
  });

  it('names the file with a date and a row count', () => {
    expect(csvFilename(1)).toMatch(/^astrion-requirements-\d{4}-\d{2}-\d{2}-1-row\.csv$/);
    expect(csvFilename(12)).toMatch(/-12-rows\.csv$/);
  });
});
