/**
 * FPDS header mapping.
 *
 * FPDS data reaches Astrion under more than one header convention. This test
 * pins the behaviour for the three that matter, so that when the real exports
 * land the mapping either works or fails with a message that says which header is
 * missing. It never silently maps the wrong column.
 */
import { describe, it, expect } from 'vitest';
import { buildColumnMap, squash, REQUIRED_FIELDS } from '../src/loaders/fpds-columns.js';

const FPDS_NG_HEADERS = [
  'Award ID',
  'Modification Number',
  'Transaction Number',
  'Awarding Agency Code',
  'Referenced IDV PIID',
  'Date Signed',
  'Effective Date',
  'Current Completion Date',
  'Ultimate Completion Date',
  'Action Obligation',
  'Base And All Options Value',
  'Contracting Department ID',
  'Contracting Agency ID',
  'Contracting Office ID',
  'Funding Agency ID',
  'Principal Place of Performance State Code',
  'Extent Competed',
  'Type of Set Aside',
  'Number of Offers Received',
  'Global Vendor Name',
  'Unique Entity ID',
  'CAGE Code',
  'Principal NAICS Code',
  'NAICS Description',
  'PSC',
  'PSC Description',
  'Fiscal Year',
];

const USASPENDING_HEADERS = [
  'award_id_piid',
  'modification_number',
  'transaction_number',
  'awarding_agency_code',
  'parent_award_id_piid',
  'action_date',
  'period_of_performance_start_date',
  'period_of_performance_current_end_date',
  'period_of_performance_potential_end_date',
  'federal_action_obligation',
  'base_and_all_options_value',
  'awarding_sub_agency_code',
  'awarding_office_code',
  'funding_agency_code',
  'primary_place_of_performance_state_code',
  'extent_competed',
  'type_of_set_aside',
  'number_of_offers_received',
  'recipient_name',
  'recipient_uei',
  'naics_code',
  'naics_description',
  'product_or_service_code',
  'product_or_service_description',
];

describe('squash', () => {
  it('reduces every convention to the same key', () => {
    expect(squash('Award ID')).toBe('awardid');
    expect(squash('award_id')).toBe('awardid');
    expect(squash('AwardID')).toBe('awardid');
    expect(squash('  Award-ID  ')).toBe('awardid');
  });
});

describe('the FPDS-NG ezSearch convention', () => {
  const map = buildColumnMap(FPDS_NG_HEADERS);

  it('maps every field needed to key a row', () => {
    for (const field of REQUIRED_FIELDS) {
      expect(map.mapped.get(field), `${field} did not map`).toBeDefined();
    }
  });

  it('maps the natural key to the right four headers', () => {
    expect(map.mapped.get('piid')).toBe('Award ID');
    expect(map.mapped.get('modification_number')).toBe('Modification Number');
    expect(map.mapped.get('transaction_number')).toBe('Transaction Number');
    expect(map.mapped.get('awarding_agency_code')).toBe('Awarding Agency Code');
  });

  it('keeps the two completion dates apart', () => {
    // Confusing these two breaks recompete detection, which reads the ultimate
    // date. Spec 9.1 step 1.
    expect(map.mapped.get('current_completion_date')).toBe('Current Completion Date');
    expect(map.mapped.get('ultimate_completion_date')).toBe('Ultimate Completion Date');
  });

  it('separates the contracting office chain from the awarding agency', () => {
    expect(map.mapped.get('contracting_department_code')).toBe('Contracting Department ID');
    expect(map.mapped.get('contracting_office_code')).toBe('Contracting Office ID');
  });

  it('finds the vendor identity columns', () => {
    expect(map.mapped.get('vendor_name')).toBe('Global Vendor Name');
    expect(map.mapped.get('vendor_uei')).toBe('Unique Entity ID');
    expect(map.mapped.get('vendor_cage')).toBe('CAGE Code');
  });

  it('separates a code from its description', () => {
    // Spec 4.1: store the code, version the label. Mapping a description into a
    // code column would defeat that.
    expect(map.mapped.get('psc_code')).toBe('PSC');
    expect(map.mapped.get('psc_description')).toBe('PSC Description');
    expect(map.mapped.get('naics_code')).toBe('Principal NAICS Code');
    expect(map.mapped.get('naics_description')).toBe('NAICS Description');
  });
});

describe('the USAspending convention', () => {
  const map = buildColumnMap(USASPENDING_HEADERS);

  it('maps every field needed to key a row', () => {
    for (const field of REQUIRED_FIELDS) {
      expect(map.mapped.get(field), `${field} did not map`).toBeDefined();
    }
  });

  it('maps snake_case names to the same targets', () => {
    expect(map.mapped.get('piid')).toBe('award_id_piid');
    expect(map.mapped.get('idv_piid')).toBe('parent_award_id_piid');
    expect(map.mapped.get('signed_date')).toBe('action_date');
    expect(map.mapped.get('ultimate_completion_date')).toBe('period_of_performance_potential_end_date');
    expect(map.mapped.get('action_obligation')).toBe('federal_action_obligation');
    expect(map.mapped.get('vendor_name')).toBe('recipient_name');
    expect(map.mapped.get('vendor_uei')).toBe('recipient_uei');
    expect(map.mapped.get('psc_code')).toBe('product_or_service_code');
  });

  it('reports a CAGE column as unmapped rather than inventing one', () => {
    // USAspending contract files often carry no CAGE. Resolution then runs on UEI
    // and name, which is fine, but the loader must not pretend otherwise.
    expect(map.unmappedFields).toContain('vendor_cage');
  });
});

describe('failure reporting', () => {
  it('names the fields it could not map', () => {
    const map = buildColumnMap(['Some Column', 'Another Column']);
    expect(map.unmappedFields).toContain('piid');
    expect(map.unmappedFields).toContain('awarding_agency_code');
    expect(map.unclaimedHeaders).toEqual(['Some Column', 'Another Column']);
  });

  it('does not claim a header twice on the first pass', () => {
    // 'Contracting Agency ID' is a fallback for awarding_agency_code and the first
    // choice for contracting_agency_code. With a dedicated awarding column present,
    // each field takes its own header.
    const map = buildColumnMap(['Award ID', 'Awarding Agency Code', 'Contracting Agency ID']);
    expect(map.mapped.get('awarding_agency_code')).toBe('Awarding Agency Code');
    expect(map.mapped.get('contracting_agency_code')).toBe('Contracting Agency ID');
  });

  it('falls back to a shared header when no dedicated one exists', () => {
    // With only one agency column, both fields may legitimately read it.
    const map = buildColumnMap(['Award ID', 'Contracting Agency ID']);
    expect(map.mapped.get('awarding_agency_code')).toBe('Contracting Agency ID');
    expect(map.mapped.get('contracting_agency_code')).toBe('Contracting Agency ID');
  });
});
