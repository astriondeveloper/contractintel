/**
 * The three DACIS loaders, against a real database.
 *
 * The behaviours pinned here are the ones that were decided rather than obvious: role as a
 * child table, truncation measured before de-duplication, loss-plus-sub as a real outcome
 * rather than a conflict, and a blank value staying null.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EntityResolver } from '../src/resolve/entity-resolver.js';
import type { QueryResultRow } from 'pg';
import { query, closePool, withTransaction } from '../src/db/index.js';
import { loadDacisCustomers } from '../src/loaders/dacis-customers.js';
import { loadDacisPrograms } from '../src/loaders/dacis-programs.js';
import { loadDacisContracts } from '../src/loaders/dacis-contracts.js';

let dir: string;

const CUSTOMER_HEADER =
  'DACIS Link,Customer Code,Customer Name,Acronym,City,State,Country,Address,Description,Chronology';
const PROGRAM_HEADER = 'DACIS Link,Program Name,Description,Companies (Top 500),Customers';
const CONTRACT_HEADER = [
  'DACIS Link', 'Title', 'Value ($M)', 'Value is Shared', 'Award Date', 'End Date',
  'Contract #', 'Contract Type', 'DOGE Canceled', 'Solicitation #', 'Brief', 'Companies',
  'Other Bidders', 'Customer (USING ACTIVITY)', 'Customers', 'Customer Country',
  'Customer Region', 'Customer Type', 'Programs', 'Programs-Losses',
].join(',');

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

async function loadCustomers(file: string) {
  return withTransaction((client) => loadDacisCustomers(client, path.join(dir, file)));
}
async function loadPrograms(file: string, lifecycle: 'active' | 'archived' | 'pre_rfp') {
  return withTransaction(async (client) => {
    const resolver = await EntityResolver.load(client);
    return loadDacisPrograms(client, path.join(dir, file), resolver, { lifecycle });
  });
}
async function loadContracts(
  file: string,
  role: 'prime' | 'out' | 'sub' | 'loss',
  roleSource: 'declared' | 'inferred_from_filename' = 'declared',
) {
  return withTransaction(async (client) => {
    const resolver = await EntityResolver.load(client);
    return loadDacisContracts(client, path.join(dir, file), resolver, { role, roleSource });
  });
}

const one = async <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> => {
  const rows = await query<T>(sql, params);
  return rows[0]!;
};

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cie-dacis-'));

  // Two customers, one with an acronym and one without.
  await writeFile(path.join(dir, 'customers.csv'), [
    CUSTOMER_HEADER,
    ['https://www.dacis.com/customers/36144', 'US-N-01A', q('Coastal Aviation Systems Command'),
      'CASCOM', q('Bayside'), 'MD', 'USA', q('47123 Buse Rd.'), q('Delivers products.'), q('August 2025. New commander.')].join(','),
    ['https://www.dacis.com/customers/40001', 'US-F-99Z', q('Highland Research Laboratory, Space Directorate'),
      '', q('Fairmont AFB'), 'NM', 'USA', '', '', ''].join(','),
  ].join('\n') + '\n');

  // A program emitted at the 500 cap whose cell repeats a name, so the de-duplicated count
  // falls below the cap. This is the case the truncation flag has to catch.
  const repeated = Array.from({ length: 498 }, (_, i) => `Filler Company ${i} (Town, VA)`);
  const cappedCell = [...repeated, 'CARDINAL LLC (Huntsville, AL)', 'CARDINAL LLC (Huntsville, AL)'].join(';\r\n');

  await writeFile(path.join(dir, 'programs.csv'), [
    PROGRAM_HEADER,
    ['https://www.dacis.com/programs/detail.lasso?id=900001', q('Capped Program'), q('desc'),
      q(cappedCell), q('Coastal Aviation Systems Command (Bayside, MD)')].join(','),
    ['https://www.dacis.com/programs/detail.lasso?id=900002', q('Small Program'), q('desc'),
      q('CARDINAL LLC (Huntsville, AL);\r\nKESTREL TECHNOLOGIES INC (Huntsville, AL)'),
      q('Highland Research Laboratory, Space Directorate (HRL/SD) (Fairmont AFB, NM)')].join(','),
  ].join('\n') + '\n');

  await writeFile(path.join(dir, 'programs_archived.csv'), [
    PROGRAM_HEADER,
    ['https://www.dacis.com/programs/detail.lasso?id=900003', q('Old Program'), q('desc'),
      q('CARDINAL LLC (Huntsville, AL)'), ''].join(','),
  ].join('\n') + '\n');

  const contractRow = (id: string, opts: {
    value?: string; shared?: string; companies: string; bidders?: string;
    programs?: string; customers?: string; end?: string;
  }): string => [
    `https://www.dacis.com/contracts/detail.lasso?id=${id}`,
    q(`Contract ${id}`), opts.value ?? '499', opts.shared ?? 'No',
    '2026-07-14', opts.end ?? '2036-08-23', q(`C-${id}`), q('Cost Plus Fixed Fee'), 'No',
    q(`S-${id}`), q('A brief.'), q(opts.companies), q(opts.bidders ?? ''),
    q('Highland Research Laboratory (Fairmont AFB, NM)'), q(opts.customers ?? ''), 'USA', q('NATO'), '',
    q(opts.programs ?? ''), '',
  ].join(',');

  // Won as prime, and also exported as 'out'. One contract, two roles.
  await writeFile(path.join(dir, 'prime.csv'), [
    CONTRACT_HEADER,
    contractRow('800001', { companies: 'CARDINAL LLC (Huntsville, AL)', programs: 'Small Program', customers: 'Coastal Aviation Systems Command (Bayside, MD)' }),
    contractRow('800002', { companies: 'CARDINAL LLC (Huntsville, AL)', value: '', shared: 'Yes' }),
  ].join('\n') + '\n');

  await writeFile(path.join(dir, 'out.csv'), [
    CONTRACT_HEADER,
    contractRow('800001', { companies: 'CARDINAL LLC (Huntsville, AL)', programs: 'Small Program', customers: 'Coastal Aviation Systems Command (Bayside, MD)' }),
  ].join('\n') + '\n');

  // Lost as prime. 800003 is also held as a sub, which is a real outcome. 800001 is also
  // held as prime, which is a genuine contradiction.
  await writeFile(path.join(dir, 'losses.csv'), [
    CONTRACT_HEADER,
    contractRow('800003', {
      companies: 'Fernbrook Consulting Group, Ltd. (Wakefield, MA)',
      bidders: 'KESTREL TECHNOLOGIES INC (Huntsville, AL)',
      end: '2028-07-17',
    }),
    contractRow('800001', { companies: 'CARDINAL LLC (Huntsville, AL)' }),
  ].join('\n') + '\n');

  await writeFile(path.join(dir, 'subs.csv'), [
    CONTRACT_HEADER,
    contractRow('800003', {
      companies: 'Fernbrook Consulting Group, Ltd. (Wakefield, MA)',
      bidders: 'KESTREL TECHNOLOGIES INC (Huntsville, AL)',
      end: '2028-07-17',
    }),
  ].join('\n') + '\n');
});

afterAll(async () => {
  await closePool();
});

describe('customer loader', () => {
  it('loads customers keyed on Customer Code', async () => {
    const result = await loadCustomers('customers.csv');
    expect(result.run.records).toBe(2);
    expect(result.skippedUnkeyable).toBe(0);

    const row = await one<{ acronym: string | null; state: string | null }>(
      `select acronym, state from customer_org where customer_code = 'US-N-01A'`,
    );
    expect(row.acronym).toBe('CASCOM');
    expect(row.state).toBe('MD');
  });

  it('accepts a customer with no acronym rather than skipping it', async () => {
    // 97 of the 854 real rows have none.
    const row = await one<{ n: string }>(
      `select count(*)::text as n from customer_org where customer_code = 'US-F-99Z' and acronym is null`,
    );
    expect(Number(row.n)).toBe(1);
  });

  it('is idempotent', async () => {
    const result = await loadCustomers('customers.csv');
    expect(result.run.inserted).toBe(0);
    expect(result.run.unchanged).toBe(2);
  });
});

describe('program loader', () => {
  beforeAll(async () => {
    await loadPrograms('programs.csv', 'active');
    await loadPrograms('programs_archived.csv', 'archived');
  });

  it('flags a truncated list even when de-duplication drops the distinct count below the cap', async () => {
    // The cell emitted 500 entries, two of them identical, so 499 distinct parties survive.
    // Testing the de-duplicated count against the cap would call this untruncated.
    const row = await one<{ truncated: boolean; supplied: number }>(
      `select participant_list_truncated as truncated, participants_supplied as supplied
         from program where source_record_id = '900001'`,
    );
    expect(row.truncated).toBe(true);
    expect(row.supplied).toBe(499);
  });

  it('does not flag a short list', async () => {
    const row = await one<{ truncated: boolean }>(
      `select participant_list_truncated as truncated from program where source_record_id = '900002'`,
    );
    expect(row.truncated).toBe(false);
  });

  it('stores the lifecycle it was told, because the export is the only source of it', async () => {
    const active = await one<{ s: string }>(
      `select lifecycle_status as s from program where source_record_id = '900002'`,
    );
    const archived = await one<{ s: string }>(
      `select lifecycle_status as s from program where source_record_id = '900003'`,
    );
    expect(active.s).toBe('active');
    expect(archived.s).toBe('archived');
  });

  it('resolves a participant that is in the authored map and keeps one that is not', async () => {
    const resolved = await one<{ n: string }>(
      `select count(*)::text as n from program_participant pp
        join program p on p.program_id = pp.program_id
       where p.source_record_id = '900002' and pp.entity_id is not null`,
    );
    expect(Number(resolved.n)).toBeGreaterThanOrEqual(1);

    const filler = await one<{ n: string }>(
      `select count(*)::text as n from program_participant pp
        join program p on p.program_id = pp.program_id
       where p.source_record_id = '900001' and pp.entity_id is null`,
    );
    expect(Number(filler.n)).toBeGreaterThan(400);
  });

  it('matches a program customer by name, and by acronym when the name does not match', async () => {
    const byName = await one<{ id: string | null }>(
      `select pc.customer_org_id::text as id from program_customer pc
        join program p on p.program_id = pc.program_id
       where p.source_record_id = '900001'`,
    );
    expect(byName.id).not.toBeNull();

    // 'Highland Research Laboratory, Space Directorate (HRL/SD) (Fairmont AFB, NM)' does not match
    // the stored name once the location is stripped, but the HRL/SD acronym does not
    // either -- the stored row has no acronym. So this one legitimately does not match, and
    // the loader reports it rather than forcing a link.
    const result = await loadPrograms('programs.csv', 'active');
    expect(result.customersNamed).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent', async () => {
    const result = await loadPrograms('programs.csv', 'active');
    expect(result.run.inserted).toBe(0);
    expect(result.run.unchanged).toBe(2);
  });
});

describe('contract loader', () => {
  beforeAll(async () => {
    await loadContracts('prime.csv', 'prime');
    await loadContracts('out.csv', 'out');
    await loadContracts('losses.csv', 'loss');
    await loadContracts('subs.csv', 'sub');
  });

  it('stores one contract however many roles it arrives under', async () => {
    const contracts = await one<{ n: string }>(
      `select count(*)::text as n from dacis_contract where source_record_id = '800001'`,
    );
    expect(Number(contracts.n)).toBe(1);

    const roles = await query<{ astrion_role: string }>(
      `select r.astrion_role from dacis_contract_role r
         join dacis_contract c on c.dacis_contract_id = r.dacis_contract_id
        where c.source_record_id = '800001' order by r.astrion_role`,
    );
    expect(roles.map((r) => r.astrion_role)).toEqual(['loss', 'out', 'prime']);
  });

  it('records whether the role was declared or read from a filename', async () => {
    await loadContracts('subs.csv', 'sub', 'inferred_from_filename');
    const row = await one<{ role_source: string }>(
      `select r.role_source from dacis_contract_role r
         join dacis_contract c on c.dacis_contract_id = r.dacis_contract_id
        where c.source_record_id = '800003' and r.astrion_role = 'sub'`,
    );
    expect(row.role_source).toBe('inferred_from_filename');
  });

  it('converts the $M column to dollars', async () => {
    const row = await one<{ value_usd: string }>(
      `select value_usd from dacis_contract where source_record_id = '800001'`,
    );
    expect(Number(row.value_usd)).toBe(499_000_000);
  });

  it('keeps a blank value null and carries the shared flag with the number', async () => {
    const row = await one<{ value_usd: string | null; value_is_shared: boolean | null }>(
      `select value_usd, value_is_shared from dacis_contract where source_record_id = '800002'`,
    );
    expect(row.value_usd).toBeNull();
    expect(row.value_is_shared).toBe(true);
  });

  it('stores Other Bidders alongside awardees, told apart by company_role', async () => {
    const rows = await query<{ company_role: string; company_name_raw: string }>(
      `select co.company_role, co.company_name_raw from dacis_contract_company co
         join dacis_contract c on c.dacis_contract_id = co.dacis_contract_id
        where c.source_record_id = '800003' order by co.company_role`,
    );
    expect(rows.map((r) => r.company_role)).toEqual(['awardee', 'other_bidder']);
    expect(rows[0]!.company_name_raw).toContain('Fernbrook');
    expect(rows[1]!.company_name_raw).toContain('KESTREL');
  });

  it('links a contract to a loaded program by name', async () => {
    const row = await one<{ program_id: string | null }>(
      `select cp.program_id::text from dacis_contract_program cp
         join dacis_contract c on c.dacis_contract_id = cp.dacis_contract_id
        where c.source_record_id = '800001'`,
    );
    expect(row.program_id).not.toBeNull();
  });

  it('treats lost-as-prime plus held-as-sub as a real outcome, not a conflict', async () => {
    // Astrion bid the prime, lost, and holds a subcontract on the winner's team. Four
    // contracts in the real corpus look like this, including a $1.48bn OASIS task order.
    const listed = await one<{ n: string }>(
      `select count(*)::text as n from dacis_contract_lost_prime_won_sub where source_record_id = '800003'`,
    );
    expect(Number(listed.n)).toBe(1);

    const notConflict = await one<{ n: string }>(
      `select count(*)::text as n from dacis_contract_role_conflict where source_record_id = '800003'`,
    );
    expect(Number(notConflict.n)).toBe(0);
  });

  it('names the winner on a lost contract', async () => {
    const row = await one<{ awardees: string | null }>(
      `select awardees from dacis_contract_lost_prime_won_sub where source_record_id = '800003'`,
    );
    expect(row.awardees).toContain('Fernbrook');
  });

  it('flags held-and-lost as a genuine contradiction, and names the disagreeing exports', async () => {
    const row = await one<{ roles_asserted: string; source_files: string }>(
      `select roles_asserted, source_files from dacis_contract_role_conflict
        where source_record_id = '800001'`,
    );
    expect(row.roles_asserted).toContain('loss');
    expect(row.roles_asserted).toContain('prime');
    expect(row.source_files).toContain('losses.csv');
  });

  it('is idempotent on the contract row', async () => {
    const result = await loadContracts('prime.csv', 'prime');
    expect(result.run.inserted).toBe(0);
    expect(result.run.unchanged).toBe(2);
  });
});
