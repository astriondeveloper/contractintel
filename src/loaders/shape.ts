/**
 * Which shape is this export?
 *
 * Separated from run-load.ts because that file is an entry point: it calls main() at
 * module load, so importing it for a helper runs a whole load and, on failure, calls
 * process.exit. A test importing classifyShape brought the test runner down that way.
 * Anything importable belongs here; run-load.ts keeps only the command.
 */
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { CUSTOMER_REQUIRED_HEADERS } from './dacis-customers.js';
import { PROGRAM_REQUIRED_HEADERS, type ProgramLifecycle } from './dacis-programs.js';
import { CONTRACT_REQUIRED_HEADERS } from './dacis-contracts.js';

export type Shape =
  | 'fpds_transaction'
  | 'subcontract_edge'
  | 'dacis_customer'
  | 'dacis_program'
  | 'dacis_contract'
  | 'dacis_company_profile'
  | 'unknown';

/**
 * Shapes in dependency order. Customers before programs because program_customer matches
 * against them, programs before contracts because dacis_contract_program links to them.
 * The two FPDS shapes are independent of all three.
 */
export const LOAD_ORDER: Shape[] = [
  'dacis_customer',
  'dacis_program',
  'fpds_transaction',
  'subcontract_edge',
  'dacis_contract',
];

export const SHAPE_LABEL: Record<Shape, string> = {
  fpds_transaction: 'FPDS transactions',
  subcontract_edge: 'FPDS subcontract edges',
  dacis_customer: 'DACIS customers',
  dacis_program: 'DACIS programs',
  dacis_contract: 'DACIS contracts',
  dacis_company_profile: 'DACIS company profile (BSC)',
  unknown: 'unrecognised',
};

/** Read only the header row. Cheap: the largest export in the corpus is 35 MB. */
export async function readHeaders(filePath: string): Promise<string[]> {
  const parser = createReadStream(filePath).pipe(
    parse({ bom: true, to_line: 1, relax_column_count: true, trim: true }),
  );
  for await (const row of parser as AsyncIterable<string[]>) return row;
  return [];
}

const has = (headers: string[], names: string[]): boolean =>
  names.every((n) => headers.some((h) => h.trim().toLowerCase() === n.toLowerCase()));

/**
 * Classify by header signature, not by filename.
 *
 * Filenames are used for exactly one thing headers cannot supply: Astrion's role on a
 * DACIS contract export, which is not derivable from the row. Everything else is decided
 * by what the file contains, so a renamed export still loads correctly.
 *
 * Order matters. The DACIS contract shape and the subcontract edge shape are both
 * 'contracts' by filename and only the headers tell them apart, so the discriminating
 * headers are checked most-specific first.
 */
export function classifyShape(headers: string[]): Shape {
  if (has(headers, ['Prime Name', 'Sub Name'])) return 'subcontract_edge';
  if (has(headers, ['PIID', 'Action Obligation'])) return 'fpds_transaction';
  if (has(headers, CUSTOMER_REQUIRED_HEADERS)) return 'dacis_customer';
  if (has(headers, PROGRAM_REQUIRED_HEADERS)) return 'dacis_program';
  if (has(headers, CONTRACT_REQUIRED_HEADERS)) return 'dacis_contract';
  if (has(headers, ['Company Code', 'Company Name'])) return 'dacis_company_profile';
  return 'unknown';
}

/**
 * Programs arrive in three lifecycles sharing one header shape, so the filename is the
 * only discriminator. Order matters: 'programsarchived' contains 'programs'.
 */
export function inferLifecycle(fileName: string): ProgramLifecycle {
  const lower = fileName.toLowerCase();
  if (lower.includes('programsarchived') || lower.includes('programs-archived')) return 'archived';
  if (lower.includes('advance')) return 'pre_rfp';
  return 'active';
}
