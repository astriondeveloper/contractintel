/**
 * DACIS customer reference loader.
 *
 * 854 rows, 10 columns, keyed on Customer Code. Measured on the supplied export:
 * 854 distinct codes, none blank, so the key is real. 97 rows carry no acronym and 96 no
 * state. 755 are in the USA and the rest span 30 other countries.
 *
 * This is the dimension the FPDS agency and office codes were missing. FPDS supplies
 * '6920: EXAMPLE AVIATION ADMINISTRATION' and nothing else; this supplies the acronym,
 * the address, and a chronology of who commands the organisation, which is what the
 * evidence rail in section 15 has to show.
 */
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { PoolClient } from 'pg';
import { startRun, finishRun, recordVersion, summarize, type RunHandle } from '../lib/provenance.js';
import { optional, normalizeName } from '../lib/normalize.js';
import { dacisRecordId } from './dacis-common.js';

export const CUSTOMER_SOURCE_SYSTEM = 'dacis_customer';

/** Header signature used by the router to recognise this shape. */
export const CUSTOMER_REQUIRED_HEADERS = ['Customer Code', 'Customer Name'];

export interface LoadCustomersResult {
  run: RunHandle;
  /** Rows with no Customer Code. Skipped: without it there is no key. */
  skippedUnkeyable: number;
  withAcronym: number;
  countries: number;
}

export async function loadDacisCustomers(
  client: PoolClient,
  filePath: string,
  options: { limit?: number } = {},
): Promise<LoadCustomersResult> {
  const fileName = filePath.split('/').pop() ?? filePath;
  const parser = createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true }),
  );

  const run = await startRun(client, CUSTOMER_SOURCE_SYSTEM, fileName);
  let skippedUnkeyable = 0;
  let withAcronym = 0;
  let rowNumber = 0;
  const countries = new Set<string>();

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rowNumber += 1;
    if (options.limit !== undefined && rowNumber > options.limit) break;

    const code = optional(row['Customer Code']);
    const name = optional(row['Customer Name']);
    if (code === null || name === null) {
      skippedUnkeyable += 1;
      continue;
    }

    const acronym = optional(row['Acronym']);
    if (acronym !== null) withAcronym += 1;
    const country = optional(row['Country']);
    if (country !== null) countries.add(country);

    const payload = {
      customer_code: code,
      customer_name: name,
      acronym,
      city: optional(row['City']),
      state: optional(row['State']),
      country,
      address: optional(row['Address']),
      description: optional(row['Description']),
      chronology: optional(row['Chronology']),
      dacis_url: optional(row['DACIS Link']),
      dacis_record_id: dacisRecordId(row['DACIS Link']),
    };

    const version = await recordVersion(client, run, code, payload);
    if (!version.changed) continue;

    await client.query(
      `insert into customer_org (
         source_system, customer_code, customer_name, name_normalized, acronym,
         city, state, country, address, description, chronology, dacis_url, source_version_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (source_system, customer_code) do update set
         customer_name = excluded.customer_name,
         name_normalized = excluded.name_normalized,
         acronym = excluded.acronym,
         city = excluded.city,
         state = excluded.state,
         country = excluded.country,
         address = excluded.address,
         description = excluded.description,
         chronology = excluded.chronology,
         dacis_url = excluded.dacis_url,
         source_version_id = excluded.source_version_id`,
      [
        CUSTOMER_SOURCE_SYSTEM, code, name, normalizeName(name), acronym,
        payload.city, payload.state, country, payload.address,
        payload.description, payload.chronology, payload.dacis_url, version.sourceVersionId,
      ],
    );
  }

  await finishRun(client, run);
  console.log(summarize(run, fileName.slice(0, 27)));

  return { run, skippedUnkeyable, withAcronym, countries: countries.size };
}
