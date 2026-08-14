/**
 * Column mapping for the FPDS subcontract exports.
 *
 * Same approach as fpds-columns.ts, and for the same reason: headers are matched on a
 * squashed form so a renamed column is a one line addition here rather than a change
 * to the loader. `squash` is imported rather than reimplemented, so the two mappings
 * can never disagree about what a header name means.
 *
 * The supplied shape is companies_fpds-subcontracts-in and -out, fourteen columns:
 *
 *   ID, Award Number, Description, Value, Date, Prime Name, Prime PIID,
 *   Prime IDVPIID, Cage Code, Sub Name, Sub Cage Code, Agency Name, Office Name,
 *   Customer Name
 *
 * One trap worth naming. 'Cage Code' is the *prime's* CAGE, and the sub's is the
 * separately named 'Sub Cage Code'. Nothing in the header says so. Reading 'Cage Code'
 * as the record's CAGE, or as the sub's, silently inverts every edge. Verified against
 * the data: on the -out files 'Cage Code' is ZC001, which is ERC, the prime named in
 * 'Prime Name'.
 */
import { squash } from './fpds-columns.js';

export type SubcontractField =
  | 'source_record_id'
  | 'award_number'
  | 'description'
  | 'value_usd'
  | 'award_date'
  | 'prime_name'
  | 'prime_piid'
  | 'prime_idv_piid'
  | 'prime_cage_code'
  | 'sub_name'
  | 'sub_cage_code'
  | 'agency_name'
  | 'office_name'
  | 'customer_name';

export const SUBCONTRACT_COLUMN_CANDIDATES: Record<SubcontractField, string[]> = {
  source_record_id: ['id', 'recordid', 'subcontractid', 'dacisid'],
  award_number: ['awardnumber', 'subcontractnumber', 'subawardnumber', 'ponumber'],
  description: ['description', 'brief', 'title', 'subawarddescription'],
  value_usd: ['value', 'amount', 'subawardamount', 'subcontractvalue'],
  award_date: ['date', 'awarddate', 'subawarddate', 'actiondate'],

  prime_name: ['primename', 'primecontractorname', 'primecompany'],
  prime_piid: ['primepiid', 'primeawardid', 'primecontractnumber'],
  prime_idv_piid: ['primeidvpiid', 'primeidv', 'primeparentawardid'],
  // Unprefixed 'Cage Code' belongs to the prime. See the note above.
  prime_cage_code: ['primecagecode', 'primecage', 'cagecode', 'cage'],

  sub_name: ['subname', 'subcontractorname', 'subcompany', 'subawardeename'],
  sub_cage_code: ['subcagecode', 'subcage', 'subcontractorcagecode'],

  agency_name: ['agencyname', 'agency', 'fundingagencyname'],
  office_name: ['officename', 'office', 'contractingofficename'],
  customer_name: ['customername', 'customer', 'usingactivity'],
};

export interface SubcontractColumnMap {
  mapped: Map<SubcontractField, string>;
  unclaimedHeaders: string[];
  unmappedFields: SubcontractField[];
}

/**
 * Build the mapping for one file's headers.
 *
 * Single pass, first claim wins, and the field order in the record above is the
 * precedence order. prime_cage_code is declared before sub_cage_code, so on a file
 * carrying both 'Cage Code' and 'Sub Cage Code' the prime takes the unprefixed one and
 * the sub takes its own. A file carrying only 'Cage Code' gives it to the prime and
 * leaves the sub without one, which is the honest outcome: it is the prime's column.
 */
export function buildSubcontractColumnMap(headers: string[]): SubcontractColumnMap {
  const bySquashed = new Map<string, string>();
  for (const header of headers) {
    const key = squash(header);
    // Duplicate headers do occur in these exports. The BSC company files repeat
    // 'DACIS Link' twice. First occurrence wins so the mapping is stable.
    if (!bySquashed.has(key)) bySquashed.set(key, header);
  }

  const mapped = new Map<SubcontractField, string>();
  const claimed = new Set<string>();
  const fields = Object.keys(SUBCONTRACT_COLUMN_CANDIDATES) as SubcontractField[];

  for (const field of fields) {
    for (const candidate of SUBCONTRACT_COLUMN_CANDIDATES[field]) {
      const header = bySquashed.get(candidate);
      if (header === undefined || claimed.has(header)) continue;
      mapped.set(field, header);
      claimed.add(header);
      break;
    }
  }

  return {
    mapped,
    unclaimedHeaders: headers.filter((h) => !claimed.has(h)),
    unmappedFields: fields.filter((f) => !mapped.has(f)),
  };
}

/**
 * Without a prime and a sub there is no edge. Everything else is detail, and a file
 * missing the record id loads without being deduplicable rather than failing.
 */
export const SUBCONTRACT_REQUIRED_FIELDS: SubcontractField[] = ['prime_name', 'sub_name'];

export function describeSubcontractColumnMap(map: SubcontractColumnMap): string {
  const lines: string[] = ['', 'Mapped fields:'];
  for (const [field, header] of [...map.mapped].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${field.padEnd(20)} <-  ${header}`);
  }
  if (map.unmappedFields.length > 0) {
    lines.push('', 'Target fields with no matching header:');
    for (const field of map.unmappedFields) lines.push(`  ${field}`);
  }
  if (map.unclaimedHeaders.length > 0) {
    lines.push('', 'Headers in the file that nothing claimed:');
    for (const header of map.unclaimedHeaders) lines.push(`  ${header}`);
  }
  return lines.join('\n');
}
