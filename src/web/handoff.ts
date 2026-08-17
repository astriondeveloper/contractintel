/**
 * The hand-off. Getting one requirement out of here and into TechnoMile, by hand.
 *
 * There is no integration and that is the decision, not a gap: TechnoMile is the system of record
 * and this feeds it. What that leaves is a copy-and-paste problem, and a copy-and-paste problem
 * done badly is how a tool gets abandoned. Somebody who has to re-type nine fields will do it
 * twice and then stop using the thing that made them.
 *
 * So all four shapes of hand-off are here, because the four are used by different people for
 * different things and none of them substitutes for another:
 *
 *   The field block      Label and value, one per line, in a text area that selects on click.
 *                        For pasting field by field into a form. The values are labels rather
 *                        than codes: nobody pasting into TechnoMile will look up what 6920 means,
 *                        and the record would carry the number for ever.
 *   The written summary  A paragraph a person can paste into a description or an email. Assembled
 *                        from the same fields, so it cannot say something the block does not.
 *   The SAM.gov link     The authoritative source, for the person who wants to read the notice
 *                        rather than a summary of it.
 *   The spreadsheet      A CSV of many requirements at once, for the hand-off that is thirty rows
 *                        rather than one.
 *
 * One rule runs through all four and it is the same rule `src/web/format.ts` enforces on screen:
 * **blank is not zero and blank is not blank**. A field with nothing recorded says "not recorded"
 * rather than being omitted or rendered as an empty string, because a pasted field block with a
 * gap in it reads as a value somebody forgot to fill in.
 */
import type { HandoffRow } from './queries.js';

/** What a null renders as in a hand-off. Longer than the on-screen em dash, and deliberately. */
const NOT_RECORDED = 'not recorded';

function iso(value: Date | null): string {
  return value === null ? NOT_RECORDED : new Date(value).toISOString().slice(0, 10);
}

function money(value: string | null): string {
  if (value === null) return NOT_RECORDED;
  const n = Number(value);
  if (!Number.isFinite(n)) return NOT_RECORDED;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function orNot(value: string | null): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? NOT_RECORDED : trimmed;
}

/** A code and its label together, because either alone loses something. */
function coded(code: string | null, label: string | null): string {
  if (code === null || code.trim() === '') return NOT_RECORDED;
  const name = (label ?? '').trim();
  return name === '' ? code.trim() : `${code.trim()} — ${name}`;
}

const STAGE_WORDS: Record<string, string> = {
  active_solicitation: 'Open solicitation',
  recompete_window: 'Recompete window',
  shaping_target: 'Shaping opportunity',
  market_movement: 'Market movement',
};

export interface HandoffField {
  readonly label: string;
  readonly value: string;
}

/**
 * The field block, in the order somebody filling in a TechnoMile record wants them.
 *
 * Identity first, then the customer, then the dates that drive a decision, then the money, then
 * the classification, then the provenance. Not alphabetical: a person pasting field by field
 * reads down the list once, and an order that matches the form they are filling in is the
 * difference between one pass and nine searches.
 */
export function handoffFields(row: HandoffRow): HandoffField[] {
  return [
    { label: 'Title', value: orNot(row.title) },
    { label: 'Stage', value: STAGE_WORDS[row.signal_class] ?? row.signal_class },
    { label: 'Solicitation number', value: orNot(row.solicitation_number) },
    { label: 'Contract number', value: orNot(row.related_piid) },
    { label: 'Agency', value: coded(row.agency_code, row.agency_label) },
    { label: 'Office', value: coded(row.office_code, row.office_label) },
    { label: 'Notice type', value: orNot(row.notice_type) },
    { label: 'Posted', value: iso(row.posted_date) },
    { label: 'Responses due', value: iso(row.response_date) },
    { label: 'Current period ends', value: iso(row.period_end_date) },
    { label: 'Estimated value', value: money(row.estimated_value) },
    { label: 'NAICS', value: coded(row.naics_code, row.naics_label) },
    { label: 'PSC', value: coded(row.psc_code, row.psc_label) },
    { label: 'Set-aside', value: orNot(row.set_aside_code) },
    { label: 'Place of performance', value: orNot(row.place_of_performance_state) },
    { label: 'Incumbent', value: orNot(row.incumbent_name) },
    {
      label: 'Incumbent confidence',
      value:
        row.incumbent_confidence === null
          ? NOT_RECORDED
          : // Three words, never a percentage. Spec 14.6: a percentage invites a false debate.
            row.incumbent_confidence,
    },
    { label: 'Our position', value: orNot(row.astrion_position) },
    { label: 'Capability areas', value: orNot(row.capabilities) },
    {
      label: 'Strategic fit',
      value:
        row.strategic_fit === null
          ? 'not scored'
          : // Never presented as a probability of win. Spec 10.1.
            `${Number(row.strategic_fit).toFixed(0)} of 100 (not a win probability)`,
    },
    { label: 'Band', value: row.band === null ? 'not scored' : row.band },
    { label: 'SAM.gov', value: orNot(row.notice_url) },
    {
      label: 'Source',
      value:
        'Astrion Contract Intelligence, created by Gavin Taylor. ' +
        'TechnoMile is the system of record.',
    },
  ];
}

/** The field block as the text that goes in the copy box. */
export function handoffBlock(row: HandoffRow): string {
  const fields = handoffFields(row);
  const width = Math.max(...fields.map((f) => f.label.length));
  return fields.map((f) => `${f.label.padEnd(width)}  ${f.value}`).join('\n');
}

/**
 * The written summary.
 *
 * Assembled from the same fields as the block, so the two cannot disagree. Written as prose
 * because that is what it is for: it goes in a description field or an email, and a paragraph
 * that reads like a list of fields would have been better left as the list of fields.
 *
 * Nothing here is inferred. Every sentence is a restatement of something in the record, and where
 * the record is silent the sentence is left out rather than hedged: "the value is unknown" in a
 * summary reads as a finding, when it is an absence.
 */
export function handoffSummary(row: HandoffRow): string {
  const sentences: string[] = [];

  const customer =
    row.agency_label ?? row.agency_code ?? null;
  const office = row.office_label ?? row.office_code ?? null;
  const stage = (STAGE_WORDS[row.signal_class] ?? row.signal_class).toLowerCase();

  const opening = [
    row.title.trim(),
    customer === null ? null : `at ${customer}`,
    office === null ? null : `(${office})`,
  ]
    .filter((part) => part !== null)
    .join(' ');
  // "an open solicitation", not "a open solicitation". The article is chosen rather than fixed,
  // because this paragraph gets pasted into a customer-facing record and reads as sloppy otherwise.
  const article = /^[aeiou]/i.test(stage) ? 'an' : 'a';
  sentences.push(`${opening}. This is ${article} ${stage}.`);

  if (row.solicitation_number !== null && row.solicitation_number.trim() !== '') {
    sentences.push(`Solicitation ${row.solicitation_number.trim()}.`);
  } else if (row.related_piid !== null && row.related_piid.trim() !== '') {
    sentences.push(`Current contract ${row.related_piid.trim()}.`);
  }

  if (row.response_date !== null) {
    sentences.push(`Responses are due ${iso(row.response_date)}.`);
  } else if (row.period_end_date !== null) {
    sentences.push(
      `No solicitation is out yet; the current period of performance ends ${iso(row.period_end_date)}.`,
    );
  }

  if (row.estimated_value !== null) {
    sentences.push(`Estimated value ${money(row.estimated_value)}.`);
  }

  const codes = [
    row.naics_code === null ? null : `NAICS ${coded(row.naics_code, row.naics_label)}`,
    row.psc_code === null ? null : `PSC ${coded(row.psc_code, row.psc_label)}`,
  ].filter((part) => part !== null);
  if (codes.length > 0) sentences.push(`${codes.join(', ')}.`);

  if (row.set_aside_code !== null && row.set_aside_code.trim() !== '') {
    sentences.push(`Set aside: ${row.set_aside_code.trim()}.`);
  }

  if (row.incumbent_name !== null) {
    const confidence =
      row.incumbent_confidence === null ? '' : ` (${row.incumbent_confidence} match)`;
    sentences.push(`Incumbent is ${row.incumbent_name}${confidence}.`);
  }

  if (row.astrion_position === 'prime_incumbent') {
    sentences.push('Astrion holds this work as prime, so this is a recompete to defend.');
  } else if (row.astrion_position === 'subcontractor') {
    sentences.push('Astrion holds a subcontract on this work.');
  }

  if (row.capabilities !== null && row.capabilities.trim() !== '') {
    sentences.push(`Maps to our capability areas: ${row.capabilities.trim()}.`);
  }

  if (row.strategic_fit !== null) {
    sentences.push(
      `Strategic fit scores ${Number(row.strategic_fit).toFixed(0)} of 100 under the current ` +
        'score model, which is a measure of fit and not a probability of win.',
    );
  }

  if (row.notice_url !== null && row.notice_url.trim() !== '') {
    sentences.push(`Source notice: ${row.notice_url.trim()}`);
  }

  return sentences.join(' ');
}

/* --------------------------------------------------------------------- CSV */

/**
 * The spreadsheet columns.
 *
 * Codes and labels in separate columns here, unlike the field block. A spreadsheet gets sorted
 * and filtered, and `6920 — EXAMPLE AVIATION ADMINISTRATION` in one cell sorts as a string and
 * filters as nothing.
 */
const CSV_COLUMNS: readonly { header: string; value: (row: HandoffRow) => string }[] = [
  { header: 'Title', value: (r) => r.title },
  { header: 'Stage', value: (r) => STAGE_WORDS[r.signal_class] ?? r.signal_class },
  { header: 'Solicitation number', value: (r) => r.solicitation_number ?? '' },
  { header: 'Contract number', value: (r) => r.related_piid ?? '' },
  { header: 'Notice ID', value: (r) => r.notice_id ?? '' },
  { header: 'Agency code', value: (r) => r.agency_code ?? '' },
  { header: 'Agency', value: (r) => r.agency_label ?? '' },
  { header: 'Office code', value: (r) => r.office_code ?? '' },
  { header: 'Office', value: (r) => r.office_label ?? '' },
  { header: 'Notice type', value: (r) => r.notice_type ?? '' },
  { header: 'Posted', value: (r) => (r.posted_date === null ? '' : iso(r.posted_date)) },
  { header: 'Responses due', value: (r) => (r.response_date === null ? '' : iso(r.response_date)) },
  { header: 'Period ends', value: (r) => (r.period_end_date === null ? '' : iso(r.period_end_date)) },
  // Unformatted, so a spreadsheet reads it as a number. Empty stays empty rather than becoming 0:
  // a zero in a value column is a claim, and blank is not zero.
  { header: 'Estimated value USD', value: (r) => r.estimated_value ?? '' },
  { header: 'NAICS', value: (r) => r.naics_code ?? '' },
  { header: 'NAICS description', value: (r) => r.naics_label ?? '' },
  { header: 'PSC', value: (r) => r.psc_code ?? '' },
  { header: 'PSC description', value: (r) => r.psc_label ?? '' },
  { header: 'Set-aside', value: (r) => r.set_aside_code ?? '' },
  { header: 'Place of performance', value: (r) => r.place_of_performance_state ?? '' },
  { header: 'Incumbent', value: (r) => r.incumbent_name ?? '' },
  { header: 'Incumbent confidence', value: (r) => r.incumbent_confidence ?? '' },
  { header: 'Our position', value: (r) => r.astrion_position ?? '' },
  { header: 'Capability areas', value: (r) => r.capabilities ?? '' },
  { header: 'Strategic fit', value: (r) => r.strategic_fit ?? '' },
  { header: 'Band', value: (r) => r.band ?? '' },
  { header: 'SAM.gov link', value: (r) => r.notice_url ?? '' },
  { header: 'Summary', value: (row) => handoffSummary(row) },
];

/**
 * One CSV cell.
 *
 * Quoted whenever it holds a comma, a quote or a newline, per RFC 4180, and the leading-character
 * guard is not optional: a title beginning `=`, `+`, `-` or `@` is executed as a formula when the
 * file is opened in Excel. Federal notice titles begin with all four. The value is prefixed with
 * a single quote so the cell shows the text and the spreadsheet does not evaluate it.
 */
export function csvCell(value: string): string {
  const text = value.replace(/\r?\n/g, ' ').trim();
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The whole file.
 *
 * CRLF line endings and a UTF-8 byte order mark, because the file is opened in Excel on Windows
 * and without the mark Excel reads a vendor name carrying an accent as mojibake.
 */
export function handoffCsv(rows: readonly HandoffRow[]): string {
  const lines = [CSV_COLUMNS.map((column) => csvCell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvCell(column.value(row))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** The filename a browser saves it under. Dated, because these get emailed around. */
export function csvFilename(count: number): string {
  const today = new Date().toISOString().slice(0, 10);
  return `astrion-requirements-${today}-${count}-row${count === 1 ? '' : 's'}.csv`;
}
