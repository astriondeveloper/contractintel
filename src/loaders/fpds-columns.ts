/**
 * Column mapping for FPDS exports.
 *
 * FPDS data reaches Astrion under several header conventions. The FPDS-NG
 * ezSearch export uses title case with spaces, USAspending uses snake_case, and a
 * DACIS extract uses its own labels. The loader should not care which.
 *
 * So headers are matched on a squashed form: lowercased, with every character
 * that is not a letter or digit removed. 'Award ID', 'award_id', and 'AwardID'
 * all squash to 'awardid'. Each target field lists the squashed header names that
 * may carry it, in preference order.
 *
 * When the real exports land, run:
 *   npm run load:fpds -- --report-headers <file>
 * That prints every header in the file, which target field it mapped to, and
 * every target field left unmapped. Add a candidate here if something is missing.
 * Nothing else in the loader changes.
 */

export type FpdsField =
  | 'awarding_agency_code'
  | 'piid'
  | 'modification_number'
  | 'transaction_number'
  | 'idv_piid'
  | 'idv_agency_code'
  | 'award_type'
  | 'signed_date'
  | 'effective_date'
  | 'current_completion_date'
  | 'ultimate_completion_date'
  | 'action_obligation'
  | 'base_and_all_options'
  | 'contracting_department_code'
  | 'contracting_agency_code'
  | 'contracting_office_code'
  | 'funding_agency_code'
  | 'funding_office_code'
  | 'place_of_performance_state'
  | 'extent_competed'
  | 'set_aside_type'
  | 'number_of_offers_received'
  | 'vendor_name'
  | 'vendor_uei'
  | 'vendor_cage'
  | 'naics_code'
  | 'naics_description'
  | 'psc_code'
  | 'psc_description'
  | 'fiscal_year'
  | 'vendor_parent_name';

/** Squash a header to its match form. */
export function squash(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The Astrion FPDS export packs a code and its label into one cell:
 *
 *   Agency                 6920: EXAMPLE AVIATION ADMINISTRATION
 *   Contracting: Office    ZK9001: ZK9001 CONTRACTING FOR SERVICES
 *   Principal NAICS Code   541330: ENGINEERING SERVICES
 *   Product Service Code   R425: SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL
 *
 * There are no separate description columns. The label is not missing from the
 * corpus, it is riding along in the code column, so one source column feeds two
 * target fields. Split on the FIRST colon only: the PSC label above contains a
 * colon of its own.
 *
 * The split is conservative, because other exports carry bare codes and their own
 * description columns and must pass through untouched. A value splits only when the
 * text before the first colon looks like a code: non-empty, no whitespace, and
 * short. Everything else is returned as a code with no label.
 */
export const CODE_LABEL_MAX_CODE_LENGTH = 24;

export function splitCodeLabel(raw: string | null): { code: string | null; label: string | null } {
  if (raw === null) return { code: null, label: null };
  const value = raw.trim();
  if (value === '') return { code: null, label: null };

  const colon = value.indexOf(':');
  if (colon <= 0) return { code: value, label: null };

  const code = value.slice(0, colon).trim();
  const label = value.slice(colon + 1).trim();
  if (code === '' || label === '') return { code: value, label: null };
  if (/\s/.test(code)) return { code: value, label: null };
  if (code.length > CODE_LABEL_MAX_CODE_LENGTH) return { code: value, label: null };

  return { code, label };
}

/**
 * Fields whose cell may carry `CODE: LABEL`. Ordered by the code_label code_type
 * the extracted label belongs to. Migration 0004 already admits these types.
 *
 * FPDS department and agency codes share one namespace and one hierarchy (6900 is
 * the department, 6920 the agency beneath it), so both record under 'agency'.
 */
export const CODE_BEARING_FIELDS: Array<{
  field: FpdsField;
  labelType: 'naics' | 'psc' | 'agency' | 'office' | null;
}> = [
  { field: 'awarding_agency_code', labelType: 'agency' },
  { field: 'idv_agency_code', labelType: 'agency' },
  { field: 'contracting_department_code', labelType: 'agency' },
  { field: 'contracting_agency_code', labelType: 'agency' },
  { field: 'contracting_office_code', labelType: 'office' },
  { field: 'funding_agency_code', labelType: 'agency' },
  { field: 'funding_office_code', labelType: 'office' },
  { field: 'naics_code', labelType: 'naics' },
  { field: 'psc_code', labelType: 'psc' },
];

export const FPDS_COLUMN_CANDIDATES: Record<FpdsField, string[]> = {
  // The four columns of the natural key. Spec 7.2.
  awarding_agency_code: [
    'awardingagencycode',
    'awardingagencyid',
    'awardingsubagencycode',
    // Astrion FPDS ezSearch export: bare 'Agency', carrying '6920: FEDERAL AVIATION
    // ADMINISTRATION'. Listed ahead of the contracting fallbacks so it wins over
    // 'Contracting: Agency' when both are present.
    'agency',
    'contractingagencyid',
    'contractingagencycode',
    'agencycode',
    'agencyid',
  ],
  piid: ['piid', 'awardidpiid', 'awardid', 'contractid', 'referencedpiid'],
  modification_number: [
    'modificationnumber',
    'modnumber',
    'modificationno',
    'awardmodificationamendmentnumber',
    'mod', // 'Mod #'
  ],
  transaction_number: [
    'transactionnumber',
    'transactionno',
    'transactionnbr',
    'transaction', // 'Transaction #'
  ],

  idv_piid: ['idvpiid', 'referencedidvpiid', 'parentawardid', 'parentawardidpiid', 'referencedidvid'],
  idv_agency_code: [
    'idvagencycode',
    'referencedidvagencyid',
    'parentawardagencyid',
    'idvagencyid',
    'idvagency', // 'IDV: Agency'
  ],
  award_type: ['awardtype', 'typeofcontractpricing', 'contractactiontype', 'awardoridvtype'],

  signed_date: ['datesigned', 'signeddate', 'actiondate', 'awarddate'],
  effective_date: ['effectivedate', 'periodofperformancestartdate', 'startdate'],
  current_completion_date: [
    'currentcompletiondate',
    'completiondate',
    'periodofperformancecurrentenddate',
    'currentenddate',
  ],
  ultimate_completion_date: [
    'ultimatecompletiondate',
    'ultimatecontractcompletiondate',
    'periodofperformancepotentialenddate',
    'potentialenddate',
  ],

  action_obligation: ['actionobligation', 'dollarsobligated', 'federalactionobligation', 'obligatedamount', 'obligation'],
  base_and_all_options: [
    'baseandalloptionsvalue',
    'baseandalloptions',
    'potentialtotalvalueofaward',
    'baseandexercisedoptionsvalue',
  ],

  contracting_department_code: [
    'contractingdepartmentid',
    'contractingdepartmentcode',
    'awardingdepartmentcode',
    'contractingdepartment', // 'Contracting: Department'
  ],
  contracting_agency_code: [
    'contractingagencyid',
    'contractingagencycode',
    'contractingagency', // 'Contracting: Agency'
    'awardingagencycode',
  ],
  contracting_office_code: [
    'contractingofficeid',
    'contractingofficecode',
    'contractingoffice', // 'Contracting: Office'
    'awardingofficecode',
  ],
  funding_agency_code: [
    'fundingagencyid',
    'fundingagencycode',
    'fundingsubagencycode',
    'fundingagency', // 'Funding: Agency'
  ],
  funding_office_code: [
    'fundingofficeid',
    'fundingofficecode',
    'fundingoffice', // 'Funding: Office'
  ],
  place_of_performance_state: [
    'principalplaceofperformancestatecode',
    'placeofperformancestatecode',
    'popstatecode',
    'principalplaceofperformancestate',
    'primaryplaceofperformancestatecode',
    'popstate', // 'POP: State'
  ],

  extent_competed: ['extentcompeted', 'extentcompetedcode'],
  set_aside_type: ['typeofsetaside', 'setasidetype', 'typeofsetasidecode'],
  number_of_offers_received: ['numberofoffersreceived', 'numberofoffers', 'offersreceived'],

  vendor_name: [
    'vendorname',
    'globalvendorname',
    'recipientname',
    'vendorlegalorganizationname',
    'contractorname',
    'awardeename',
    'vendordoingasbusinessname',
  ],
  vendor_uei: [
    'uei',
    'uniqueentityid',
    'recipientuei',
    'vendoruei',
    'awardeeuei',
    'globaluei',
    'contractoruei', // 'Contractor: UEI'
  ],
  vendor_cage: [
    'cagecode',
    'cage',
    'vendorcagecode',
    'recipientcagecode',
    'contractorcage', // 'Contractor: CAGE'
  ],

  /**
   * 'Contractor: DACIS: Parent Name' — Deltek's own view of which parent the
   * contractor rolls up to. Read and reported, never used to resolve: spec 8.2
   * defines the match order and this column is not in it. The load report prints
   * how many rows the authored map missed that this column would have caught, so
   * the question of whether to add it to 8.2 can be answered with a number rather
   * than an opinion.
   */
  vendor_parent_name: ['contractordacisparentname', 'dacisparentname', 'parentcompanyname', 'ultimateparentname'],

  naics_code: ['naicscode', 'principalnaicscode', 'naics'],
  naics_description: ['naicsdescription', 'principalnaicsdescription', 'naicsdesc'],
  psc_code: ['psc', 'psccode', 'productorservicecode', 'productservicecode'],
  psc_description: ['pscdescription', 'productorservicedescription', 'pscdesc', 'productservicedescription'],

  fiscal_year: ['fiscalyear', 'fy'],
};

export interface ColumnMap {
  /** target field -> the actual header string in the file */
  mapped: Map<FpdsField, string>;
  /** headers present in the file that no target field claimed */
  unclaimedHeaders: string[];
  /** target fields that no header satisfied */
  unmappedFields: FpdsField[];
}

/**
 * Build the mapping for one file's headers.
 *
 * A header is claimed by the first target field that lists it, walking the
 * candidate lists in order, so a more specific candidate wins over a shared one.
 * That matters for 'contractingagencyid', which is a fallback for
 * awarding_agency_code but the first choice for contracting_agency_code.
 */
export function buildColumnMap(headers: string[]): ColumnMap {
  const bySquashed = new Map<string, string>();
  for (const header of headers) {
    const key = squash(header);
    if (!bySquashed.has(key)) bySquashed.set(key, header);
  }

  const mapped = new Map<FpdsField, string>();
  const claimed = new Set<string>();
  const fields = Object.keys(FPDS_COLUMN_CANDIDATES) as FpdsField[];

  // Two passes. The first gives every field its unclaimed first-choice candidates,
  // the second lets a field fall back to a header another field already took.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const field of fields) {
      if (mapped.has(field)) continue;
      for (const candidate of FPDS_COLUMN_CANDIDATES[field]) {
        const header = bySquashed.get(candidate);
        if (header === undefined) continue;
        if (pass === 0 && claimed.has(header)) continue;
        mapped.set(field, header);
        claimed.add(header);
        break;
      }
    }
  }

  return {
    mapped,
    unclaimedHeaders: headers.filter((h) => !claimed.has(h)),
    unmappedFields: fields.filter((f) => !mapped.has(f)),
  };
}

/** The fields without which a row cannot be keyed. Spec 7.2. */
export const REQUIRED_FIELDS: FpdsField[] = ['awarding_agency_code', 'piid'];

export function describeColumnMap(map: ColumnMap): string {
  const lines: string[] = ['', 'Mapped fields:'];
  for (const [field, header] of [...map.mapped].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${field.padEnd(30)} <-  ${header}`);
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
