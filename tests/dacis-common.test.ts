/**
 * Parsers for the DACIS export conventions.
 *
 * Every case here came from a string that is actually in the corpus. Where a rule was
 * chosen over an alternative, the test says which alternative it rules out.
 */
import { describe, it, expect } from 'vitest';
import {
  splitList,
  rawListLength,
  splitNameLocation,
  trailingAcronym,
  parseYesNo,
  parseMillionsToUsd,
  parseDacisDate,
  dacisRecordId,
  parseParties,
  PROGRAM_PARTICIPANT_CAP,
} from '../src/loaders/dacis-common.js';
import { classifyShape, inferLifecycle } from '../src/loaders/shape.js';
import { inferRoleFromFileName } from '../src/loaders/dacis-contracts.js';

describe('splitList', () => {
  it('splits on the semicolon and treats the newline after it as cosmetic', () => {
    expect(splitList('A, LLC (Ashburn, VA);\r\nB Inc (King William, VA)')).toEqual([
      'A, LLC (Ashburn, VA)',
      'B Inc (King William, VA)',
    ]);
  });

  it('collapses internal whitespace so a wrapped entry matches an unwrapped one', () => {
    expect(splitList('Some  Company\r\n  Name, LLC')).toEqual(['Some Company Name, LLC']);
  });

  it('is empty for a blank or missing cell', () => {
    expect(splitList('')).toEqual([]);
    expect(splitList(null)).toEqual([]);
    expect(splitList('  ;  ; ')).toEqual([]);
  });
});

describe('splitNameLocation', () => {
  it('splits the trailing location off a company', () => {
    expect(splitNameLocation('Ledgerstone Technology Corp. (Chevy Chase, MD)')).toEqual({
      name: 'Ledgerstone Technology Corp.',
      location: 'Chevy Chase, MD',
    });
  });

  it('handles a base rather than a city', () => {
    expect(splitNameLocation('Highland Research Laboratory (Fairmont AFB, NM)')).toEqual({
      name: 'Highland Research Laboratory',
      location: 'Fairmont AFB, NM',
    });
  });

  it('keeps a parenthetical that is part of the name, because it has no comma', () => {
    // The authored entity map contains this exact spelling. Stripping it would break
    // resolution for every Dynamic Concepts row.
    expect(splitNameLocation('TESSELLATE CONCEPTS INCORPORATED (5855)')).toEqual({
      name: 'TESSELLATE CONCEPTS INCORPORATED (5855)',
      location: null,
    });
  });

  it('only strips a parenthetical at the end', () => {
    expect(splitNameLocation('Highland Research Laboratory, Space Warfare (HRL/SD) (Fairmont AFB, NM)')).toEqual({
      name: 'Highland Research Laboratory, Space Warfare (HRL/SD)',
      location: 'Fairmont AFB, NM',
    });
  });

  it('leaves a name with no location alone', () => {
    expect(splitNameLocation('CARDINAL LLC')).toEqual({ name: 'CARDINAL LLC', location: null });
  });
});

describe('trailingAcronym', () => {
  it('finds the acronym left behind after the location is stripped', () => {
    expect(trailingAcronym('Highland Research Laboratory, Space Directorate (HRL/SD)')).toBe('HRL/SD');
  });

  it('rejects a parenthetical containing a comma, which is a location', () => {
    expect(trailingAcronym('Something (Chevy Chase, MD)')).toBeNull();
  });

  it('rejects lower case, which is prose rather than an acronym', () => {
    expect(trailingAcronym('Some Command (the old one)')).toBeNull();
  });

  it('is null when there is no parenthetical', () => {
    expect(trailingAcronym('Coastal Aviation Systems Command')).toBeNull();
  });
});

describe('parseYesNo', () => {
  it('reads DACIS Yes and No', () => {
    expect(parseYesNo('Yes')).toBe(true);
    expect(parseYesNo('No')).toBe(false);
  });

  it('treats anything else as unknown rather than false', () => {
    // 'Value is Shared' drives whether a value may be summed. Defaulting an unreadable
    // cell to false would licence summing a shared value.
    expect(parseYesNo('')).toBeNull();
    expect(parseYesNo(null)).toBeNull();
    expect(parseYesNo('Unknown')).toBeNull();
  });
});

describe('parseMillionsToUsd', () => {
  it('converts the $M column to dollars', () => {
    expect(parseMillionsToUsd('499')).toBe(499_000_000);
    expect(parseMillionsToUsd('34.5')).toBe(34_500_000);
  });

  it('treats a blank as unknown, never as zero', () => {
    // 5 of the 434 supplied rows are blank. Zero would be summed as a free contract.
    expect(parseMillionsToUsd('')).toBeNull();
    expect(parseMillionsToUsd(null)).toBeNull();
  });

  it('handles thousands separators and parenthesised negatives', () => {
    expect(parseMillionsToUsd('1,476.9')).toBe(1_476_900_000);
    expect(parseMillionsToUsd('(12.5)')).toBe(-12_500_000);
  });
});

describe('parseDacisDate', () => {
  it('reads the ISO form the exports use', () => {
    expect(parseDacisDate('2026-07-14')).toBe('2026-07-14');
  });

  it('reads the other shapes without inventing a date when it cannot', () => {
    expect(parseDacisDate('7/14/2026')).toBe('2026-07-14');
    expect(parseDacisDate('20260714')).toBe('2026-07-14');
    expect(parseDacisDate('sometime in July')).toBeNull();
  });
});

describe('dacisRecordId', () => {
  it('reads the query form used by contracts and programs', () => {
    expect(dacisRecordId('https://www.dacis.com/contracts/detail.lasso?id=704010')).toBe('704010');
    expect(dacisRecordId('https://www.dacis.com/programs/detail.lasso?id=256854')).toBe('256854');
  });

  it('reads the path form used by customers', () => {
    expect(dacisRecordId('https://www.dacis.com/customers/36144')).toBe('36144');
  });

  it('is null when there is no id, so the caller skips rather than keys on a guess', () => {
    expect(dacisRecordId('https://www.dacis.com/customers/')).toBeNull();
    expect(dacisRecordId('')).toBeNull();
  });
});

describe('parseParties and rawListLength', () => {
  const cell = 'Ledgerstone Technology Corp. (Chevy Chase, MD);\r\nLedgerstone Technology Corp. (Chevy Chase, MD);\r\nMarchmont Consulting LLP (Arlington, VA)';

  it('de-duplicates an identical entry repeated in one cell', () => {
    expect(parseParties(cell)).toHaveLength(2);
  });

  it('keeps two spellings of one company as two parties', () => {
    // 'Ledgerstone Technology Corp.' and 'Ledgerstone Technology Corporation' both appear on the
    // same program. Merging them here would hide a naming variant the resolver needs.
    const two = 'Ledgerstone Technology Corp. (Chevy Chase, MD);\r\nLedgerstone Technology Corporation (Chevy Chase, MD)';
    expect(parseParties(two)).toHaveLength(2);
  });

  it('counts what the export emitted, before de-duplication', () => {
    // This is the distinction the truncation flag depends on. A program emitted at the
    // 500 cap whose cell repeats names yields fewer than 500 distinct parties, so testing
    // the de-duplicated count against the cap misses it. Measured on the corpus: 10
    // programs were emitted at the cap, only 4 have 500 distinct parties.
    expect(rawListLength(cell)).toBe(3);
    expect(parseParties(cell)).toHaveLength(2);
  });

  it('normalises and splits the location on every party', () => {
    const [first] = parseParties(cell);
    expect(first!.name).toBe('Ledgerstone Technology Corp.');
    expect(first!.location).toBe('Chevy Chase, MD');
    expect(first!.nameNormalized).not.toBeNull();
  });

  it('knows the documented cap', () => {
    expect(PROGRAM_PARTICIPANT_CAP).toBe(500);
  });
});

describe('classifyShape', () => {
  it('recognises all five loadable shapes by header, not by filename', () => {
    expect(classifyShape(['ID', 'Prime Name', 'Sub Name', 'Cage Code'])).toBe('subcontract_edge');
    expect(classifyShape(['Agency', 'PIID', 'Mod #', 'Action Obligation'])).toBe('fpds_transaction');
    expect(classifyShape(['DACIS Link', 'Customer Code', 'Customer Name'])).toBe('dacis_customer');
    expect(classifyShape(['DACIS Link', 'Program Name', 'Companies (Top 500)'])).toBe('dacis_program');
    expect(classifyShape(['DACIS Link', 'Title', 'Value ($M)', 'Contract #', 'Companies'])).toBe(
      'dacis_contract',
    );
  });

  it('recognises the BSC company profile it cannot yet load, rather than calling it unknown', () => {
    expect(classifyShape(['DACIS Link', 'Company Code', 'Company Name', 'City'])).toBe(
      'dacis_company_profile',
    );
  });

  it('separates the subcontract edge shape from the DACIS contract shape', () => {
    // Both are 'contracts' by filename. Only the headers tell them apart, and loading one
    // as the other would put prime and sub names into a contract title.
    expect(classifyShape(['ID', 'Award Number', 'Prime Name', 'Sub Name'])).toBe('subcontract_edge');
    expect(classifyShape(['DACIS Link', 'Contract #', 'Companies', 'Value ($M)'])).toBe('dacis_contract');
  });

  it('is unknown for a shape it does not recognise, so nothing is attempted', () => {
    expect(classifyShape(['Some', 'Other', 'File'])).toBe('unknown');
    expect(classifyShape([])).toBe('unknown');
  });
});

describe('filename inference, where headers cannot help', () => {
  it('reads the loss role before the prime role, because the names overlap', () => {
    // 'contractslosses' contains 'contracts'. Checked in the wrong order, every loss
    // export would load as a win.
    expect(inferRoleFromFileName('companies_contractslosses_gavin_2026.csv')).toBe('loss');
    expect(inferRoleFromFileName('companies_contracts-prime_gavin_2026.csv')).toBe('prime');
    expect(inferRoleFromFileName('companies_contracts-out_gavin_2026.csv')).toBe('out');
    expect(inferRoleFromFileName('companies_subcontracts_gavin_2026.csv')).toBe('sub');
  });

  it('survives an upload prefix on the filename', () => {
    expect(inferRoleFromFileName('4178fe6c-companies_contractslosses_gavin.csv')).toBe('loss');
  });

  it('returns null rather than guessing when the name does not say', () => {
    expect(inferRoleFromFileName('export_final_v2.csv')).toBeNull();
  });

  it('reads archived before active, because the names overlap', () => {
    expect(inferLifecycle('companies_programsarchived_gavin.csv')).toBe('archived');
    expect(inferLifecycle('companies_programs_gavin.csv')).toBe('active');
    expect(inferLifecycle('companies_advance_gavin.csv')).toBe('pre_rfp');
  });
});
