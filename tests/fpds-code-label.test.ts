/**
 * The Astrion FPDS export packs a code and its label into one cell and leaves
 * 'Transaction #' blank on every row. These tests pin both behaviours, because both
 * were discovered on the real corpus rather than anticipated by the spec.
 */
import { describe, it, expect } from 'vitest';
import {
  splitCodeLabel,
  buildColumnMap,
  CODE_BEARING_FIELDS,
} from '../src/loaders/fpds-columns.js';
import { surrogateTransactionNumber, SURROGATE_PREFIX } from '../src/loaders/fpds.js';

describe('splitCodeLabel', () => {
  it('splits an agency cell into code and label', () => {
    expect(splitCodeLabel('6920: EXAMPLE AVIATION ADMINISTRATION')).toEqual({
      code: '6920',
      label: 'EXAMPLE AVIATION ADMINISTRATION',
    });
  });

  it('splits on the first colon only, because a PSC label contains one', () => {
    expect(splitCodeLabel('R425: SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL')).toEqual({
      code: 'R425',
      label: 'SUPPORT- PROFESSIONAL: ENGINEERING/TECHNICAL',
    });
  });

  it('splits an office cell whose label repeats the code', () => {
    expect(splitCodeLabel('ZK9001: ZK9 CONTRACTING FOR SERVICES')).toEqual({
      code: 'ZK9001',
      label: 'ZK9 CONTRACTING FOR SERVICES',
    });
  });

  it('leaves a bare code alone, which is what every other export supplies', () => {
    expect(splitCodeLabel('541330')).toEqual({ code: '541330', label: null });
    expect(splitCodeLabel('R425')).toEqual({ code: 'R425', label: null });
  });

  it('treats a blank or missing cell as absent, not as an empty code', () => {
    expect(splitCodeLabel(null)).toEqual({ code: null, label: null });
    expect(splitCodeLabel('')).toEqual({ code: null, label: null });
    expect(splitCodeLabel('   ')).toEqual({ code: null, label: null });
  });

  it('does not split when the text before the colon is not code shaped', () => {
    // A prose cell that happens to contain a colon must survive intact, or a
    // description would silently become a code.
    const prose = 'ENGINEERING SERVICES: ALL OTHER';
    expect(splitCodeLabel(prose)).toEqual({ code: prose, label: null });
  });

  it('does not split when the label side is empty', () => {
    expect(splitCodeLabel('6920:')).toEqual({ code: '6920:', label: null });
  });

  it('does not split a leading colon', () => {
    expect(splitCodeLabel(': ORPHAN LABEL')).toEqual({ code: ': ORPHAN LABEL', label: null });
  });

  it('does not split when the code side is longer than a code ever is', () => {
    const long = 'THISISFARTOOLONGTOBEACODEVALUE: LABEL';
    expect(splitCodeLabel(long)).toEqual({ code: long, label: null });
  });

  it('trims both sides', () => {
    expect(splitCodeLabel('  6920 :  FAA  ')).toEqual({ code: '6920', label: 'FAA' });
  });
});

describe('the real export headers', () => {
  // The exact header row of fpds_gavin.taylor@astrion.us_*.csv, trimmed to the
  // columns the loader claims. A future export that renames one of these fails here
  // rather than silently loading a column short.
  const REAL_HEADERS = [
    'Agency', 'PIID', 'Mod #', 'Transaction #',
    'IDV: Agency', 'IDV: PIID', 'IDV: Mod #',
    'Award Type', 'Signed Date', 'Effective Date',
    'Current Completion Date', 'Ultimate Completion Date',
    'Action Obligation', 'Base and All Options',
    'Contracting: Department', 'Contracting: Agency', 'Contracting: Office',
    'Funding: Department', 'Funding: Agency', 'Funding: Office',
    'POP: State', 'Extent Competed', 'Type of Set Aside', 'Number of Offers Received',
    'Contractor: Name', 'Contractor: UEI', 'Contractor: CAGE',
    'Contractor: DACIS: Parent Name',
    'Principal NAICS Code', 'Product Service Code', 'Fiscal Year',
  ];

  const map = buildColumnMap(REAL_HEADERS);

  it('maps every part of the natural key', () => {
    expect(map.mapped.get('awarding_agency_code')).toBe('Agency');
    expect(map.mapped.get('piid')).toBe('PIID');
    expect(map.mapped.get('modification_number')).toBe('Mod #');
    expect(map.mapped.get('transaction_number')).toBe('Transaction #');
  });

  it("gives 'Agency' to the awarding agency, not to the contracting agency", () => {
    expect(map.mapped.get('awarding_agency_code')).toBe('Agency');
    expect(map.mapped.get('contracting_agency_code')).toBe('Contracting: Agency');
    expect(map.mapped.get('idv_agency_code')).toBe('IDV: Agency');
  });

  it('maps the contracting and funding hierarchy', () => {
    expect(map.mapped.get('contracting_department_code')).toBe('Contracting: Department');
    expect(map.mapped.get('contracting_office_code')).toBe('Contracting: Office');
    expect(map.mapped.get('funding_agency_code')).toBe('Funding: Agency');
    expect(map.mapped.get('funding_office_code')).toBe('Funding: Office');
  });

  it('maps the contractor identity columns', () => {
    expect(map.mapped.get('vendor_name')).toBe('Contractor: Name');
    expect(map.mapped.get('vendor_uei')).toBe('Contractor: UEI');
    expect(map.mapped.get('vendor_cage')).toBe('Contractor: CAGE');
    expect(map.mapped.get('vendor_parent_name')).toBe('Contractor: DACIS: Parent Name');
  });

  it('maps place of performance state from the POP prefix', () => {
    expect(map.mapped.get('place_of_performance_state')).toBe('POP: State');
  });

  it('leaves only the two description fields unmapped, because they are packed into the code cells', () => {
    expect([...map.unmappedFields].sort()).toEqual(['naics_description', 'psc_description']);
  });

  it('claims no header twice', () => {
    const claimed = [...map.mapped.values()];
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});

describe('code bearing field table', () => {
  it('routes department and agency codes to the agency label type and offices to office', () => {
    const typeOf = (field: string): string | null =>
      CODE_BEARING_FIELDS.find((f) => f.field === field)?.labelType ?? null;

    expect(typeOf('awarding_agency_code')).toBe('agency');
    expect(typeOf('contracting_department_code')).toBe('agency');
    expect(typeOf('contracting_agency_code')).toBe('agency');
    expect(typeOf('idv_agency_code')).toBe('agency');
    expect(typeOf('contracting_office_code')).toBe('office');
    expect(typeOf('funding_office_code')).toBe('office');
    expect(typeOf('naics_code')).toBe('naics');
    expect(typeOf('psc_code')).toBe('psc');
  });

  it('names only label types the code_label check constraint admits', () => {
    const allowed = new Set(['naics', 'psc', 'agency', 'office', 'set_aside', 'extent_competed', 'award_type']);
    for (const { labelType } of CODE_BEARING_FIELDS) {
      if (labelType === null) continue;
      expect(allowed.has(labelType)).toBe(true);
    }
  });
});

describe('surrogateTransactionNumber', () => {
  const base = {
    awarding_agency_code: '9700',
    piid: 'ZT100022F0001',
    modification_number: 'P00120',
    transaction_number: '',
    action_obligation: 16695.57,
    funding_office_code: 'ZO001A',
  };

  it('is deterministic, so a re-run keys the same row the same way', () => {
    expect(surrogateTransactionNumber(base)).toBe(surrogateTransactionNumber(base));
  });

  it('does not depend on key order in the payload object', () => {
    const reordered = {
      funding_office_code: base.funding_office_code,
      action_obligation: base.action_obligation,
      transaction_number: base.transaction_number,
      modification_number: base.modification_number,
      piid: base.piid,
      awarding_agency_code: base.awarding_agency_code,
    };
    expect(surrogateTransactionNumber(reordered)).toBe(surrogateTransactionNumber(base));
  });

  it('ignores transaction_number, so writing the result back does not change it', () => {
    const written = { ...base, transaction_number: surrogateTransactionNumber(base) };
    expect(surrogateTransactionNumber(written)).toBe(surrogateTransactionNumber(base));
  });

  it('separates the two real transactions that collided on ZT100022F0001 P00120', () => {
    // Both rows carry the same agency, PIID and modification. One obligates against
    // USAF funds, the other deobligates against FMS funds. Under the spec key they
    // overwrite each other.
    const usaf = { ...base, action_obligation: 16695.57, funding_office_code: 'ZO001A' };
    const fms = { ...base, action_obligation: -373549.1, funding_office_code: 'ZO001B' };
    expect(surrogateTransactionNumber(usaf)).not.toBe(surrogateTransactionNumber(fms));
  });

  it('is marked as synthetic and short enough for the key column', () => {
    const surrogate = surrogateTransactionNumber(base);
    expect(surrogate.startsWith(SURROGATE_PREFIX)).toBe(true);
    expect(surrogate).toMatch(/^H:[0-9a-f]{12}$/);
  });
});
