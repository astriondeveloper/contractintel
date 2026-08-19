/**
 * Enough of the XLSX format to read an export, and no more.
 *
 * GovWin exports arrive as `.xlsx`. Asking whoever runs the weekly pull to convert each one to CSV
 * first is the kind of manual step that gets skipped, and a skipped step is a stale corpus, so the
 * loader reads the workbook directly.
 *
 * **Why this is hand-rolled rather than a dependency.** A spreadsheet library is a large amount of code
 * to carry for one file format read once a week, and this build has held a deliberate line on
 * dependencies — three at the time of writing, none of them a framework. A workbook is a ZIP of XML,
 * Node ships `zlib.inflateRawSync`, and what is missing is the ZIP container itself: about sixty lines
 * of header parsing. That trade seemed right. It also means there is nothing here to keep up to date.
 *
 * **What it does not do**, deliberately, because guessing at these silently is worse than refusing:
 *
 *   Formulas. Cell values are read as stored, which is what a data export contains. A workbook of
 *   live formulas with no cached values reads as empty and says so.
 *   Styles, merged cells, multiple sheets beyond the one asked for.
 *   ZIP64 and encryption, both of which throw rather than return partial data.
 *
 * **The trap this format sets.** Empty cells are *absent* from the XML rather than present and blank,
 * so a row is a sparse list and the column a value belongs to comes from the cell reference (`D7`),
 * never from its position among its siblings. Reading them positionally shifts every column after the
 * first gap, which produces a file that parses cleanly and means something else entirely. Rows here are
 * therefore built by reference and padded.
 */
import { inflateRawSync } from 'node:zlib';

interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * The entries of a ZIP archive, read from the local file headers.
 *
 * Walking the local headers rather than the central directory keeps this short. It is sound for a
 * generated workbook, where entries appear once and in order; a hand-edited archive with a stale local
 * header would be misread, which no spreadsheet application produces.
 */
function unzip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break; // Past the last local header.

    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    let compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;

    if ((flags & 0x0001) !== 0) {
      throw new Error(`${name} is encrypted. Save the workbook without a password.`);
    }

    // A streamed entry writes its sizes to a trailing descriptor rather than the header, so the
    // compressed length has to be found by scanning to the next signature.
    if (compressedSize === 0 && (flags & 0x0008) !== 0) {
      const next = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataStart);
      if (next === -1) throw new Error(`${name} has no data descriptor. The workbook looks truncated.`);
      compressedSize = next - dataStart;
    }

    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (data === null) {
      throw new Error(`${name} uses compression method ${method}, which this reader does not handle.`);
    }

    entries.push({ name, data });

    offset = dataStart + compressedSize;
    if ((flags & 0x0008) !== 0) offset += 16; // Skip the data descriptor.
  }

  if (entries.length === 0) throw new Error('Not a readable workbook: no ZIP entries found.');
  return entries;
}

/** `D7` to a zero-based column index. Column letters are base-26 with no zero digit. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase());
  if (letters === null) return -1;
  let index = 0;
  for (const character of letters[1]!) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Ampersand last, so an encoded entity is not decoded twice.
    .replace(/&amp;/g, '&');
}

/**
 * The shared string table.
 *
 * A string appearing in more than one cell is stored once here and referenced by index. Rich text
 * splits one string across several `<t>` runs, which are concatenated: a cell reading "Pre-RFP" with
 * the first three characters in bold is still "Pre-RFP".
 */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const item of xml.split(/<si[\s>]/).slice(1)) {
    const runs = [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]!);
    out.push(decodeEntities(runs.join('')));
  }
  return out;
}

/**
 * An Excel serial date as an ISO day.
 *
 * The epoch is 1899-12-30 rather than 1900-01-01, which absorbs the leap-year bug Excel keeps for
 * compatibility with Lotus. Only whole days are returned: a serial carrying a time is truncated,
 * because every date in these exports is a day and a spurious 00:00:00 invites reading a timezone into
 * something that never had one.
 */
export function serialToIsoDay(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.floor(serial) * 86_400_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export interface ReadSheetOptions {
  /** Which sheet, by position. Defaults to the first, which is what an export contains. */
  readonly sheetIndex?: number;
  /**
   * Treat a bare number that looks like a date serial as a date.
   *
   * Off by default: a value of 45000 is far more likely to be a dollar figure than a date, and
   * guessing wrong turns money into 2023. The GovWin loader turns it on for the columns it knows are
   * dates and nowhere else.
   */
  readonly serialDateColumns?: readonly number[];
}

/**
 * Every row of one sheet, as strings.
 *
 * Strings rather than typed values on purpose: the caller knows which of its columns are money, which
 * are dates and which are lists, and this layer guessing at that is how a thousands column becomes
 * dollars. Absent cells come back as the empty string, and rows are padded so that
 * `row[n]` is always the nth column.
 */
export function readSheet(buffer: Buffer, options: ReadSheetOptions = {}): string[][] {
  const entries = unzip(buffer);
  const find = (name: string): ZipEntry | undefined => entries.find((e) => e.name === name);

  const strings = (() => {
    const table = find('xl/sharedStrings.xml');
    return table === undefined ? [] : sharedStrings(table.data.toString('utf8'));
  })();

  const index = options.sheetIndex ?? 0;
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const n = (name: string) => Number(/(\d+)\.xml$/.exec(name)![1]);
      return n(a.name) - n(b.name);
    });

  const sheet = sheets[index];
  if (sheet === undefined) {
    throw new Error(
      `The workbook has ${sheets.length} sheet(s); sheet ${index + 1} was asked for.`,
    );
  }

  const serialColumns = new Set(options.serialDateColumns ?? []);
  const xml = sheet.data.toString('utf8');
  const rows: string[][] = [];

  for (const rowXml of xml.split(/<row[\s>]/).slice(1)) {
    const cells: string[] = [];
    let widest = -1;

    for (const cellMatch of rowXml.matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1]!;
      const body = cellMatch[3] ?? '';

      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
      // Without a reference there is no way to know which column this is, and assuming the next one
      // is the mistake this reader exists to avoid.
      if (reference === undefined) continue;
      const column = columnIndex(reference);
      if (column < 0) continue;

      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
      let value = '';

      if (type === 's') {
        const at = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = strings[at] ?? '';
      } else if (type === 'inlineStr') {
        const runs = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]!);
        value = decodeEntities(runs.join(''));
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = decodeEntities(raw);
        if (value !== '' && serialColumns.has(column)) {
          const asDay = serialToIsoDay(Number(value));
          if (asDay !== null) value = asDay;
        }
      }

      cells[column] = value;
      if (column > widest) widest = column;
    }

    // Pad, so a caller can index by column without checking for holes.
    const row: string[] = [];
    for (let i = 0; i <= widest; i += 1) row.push(cells[i] ?? '');
    rows.push(row);
  }

  return rows;
}
