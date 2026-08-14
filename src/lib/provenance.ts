/**
 * Provenance and idempotence. Spec section 7.6 and acceptance test 2.
 *
 * Every loader opens a source_run, records a source_version per source record,
 * and closes the run. The loader compares payload_hash and writes a new version
 * only when the hash changes. Running the same file twice therefore changes no
 * row counts, which is exactly what acceptance test 2 asserts.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export interface RunHandle {
  runId: number;
  sourceSystem: string;
  inserted: number;
  updated: number;
  unchanged: number;
  records: number;
}

/** Stable hash of a source record. Key order does not affect the result. */
export function payloadHash(payload: Record<string, unknown>): string {
  const ordered = Object.keys(payload)
    .sort()
    .map((key) => [key, payload[key] ?? null]);
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

export async function startRun(
  client: PoolClient,
  sourceSystem: string,
  sourceLabel: string,
): Promise<RunHandle> {
  const { rows } = await client.query<{ run_id: string }>(
    `insert into source_run (source_system, source_label, status)
     values ($1, $2, 'running')
     returning run_id`,
    [sourceSystem, sourceLabel],
  );
  return {
    runId: Number(rows[0]!.run_id),
    sourceSystem,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    records: 0,
  };
}

export interface VersionResult {
  sourceVersionId: number;
  changed: boolean;
  /**
   * The hash the payload stored under. Returned so a caller can tell two payloads
   * apart under one source_record_id without hashing a second time. The FPDS loader
   * uses it to count transactions the natural key collapses.
   */
  payloadHash: string;
}

/**
 * Record the observed state of one source record.
 *
 * changed === false means this exact payload was already stored. The caller can
 * skip downstream work, or repeat it idempotently. Either is correct; skipping is
 * faster and is what the loaders do.
 */
export async function recordVersion(
  client: PoolClient,
  run: RunHandle,
  sourceRecordId: string,
  payload: Record<string, unknown>,
): Promise<VersionResult> {
  const hash = payloadHash(payload);
  run.records += 1;

  const existing = await client.query<{ source_version_id: string }>(
    `select source_version_id from source_version
     where source_system = $1 and source_record_id = $2 and payload_hash = $3`,
    [run.sourceSystem, sourceRecordId, hash],
  );

  if (existing.rows.length > 0) {
    run.unchanged += 1;
    return {
      sourceVersionId: Number(existing.rows[0]!.source_version_id),
      changed: false,
      payloadHash: hash,
    };
  }

  const priorCount = await client.query<{ n: string }>(
    `select count(*) as n from source_version
     where source_system = $1 and source_record_id = $2`,
    [run.sourceSystem, sourceRecordId],
  );
  const isFirstSighting = Number(priorCount.rows[0]!.n) === 0;

  const inserted = await client.query<{ source_version_id: string }>(
    `insert into source_version (run_id, source_system, source_record_id, payload_hash, payload)
     values ($1, $2, $3, $4, $5)
     returning source_version_id`,
    [run.runId, run.sourceSystem, sourceRecordId, hash, JSON.stringify(payload)],
  );

  if (isFirstSighting) run.inserted += 1;
  else run.updated += 1;

  return {
    sourceVersionId: Number(inserted.rows[0]!.source_version_id),
    changed: true,
    payloadHash: hash,
  };
}

export async function finishRun(
  client: PoolClient,
  run: RunHandle,
  status: 'succeeded' | 'failed' = 'succeeded',
  errorText?: string,
): Promise<void> {
  await client.query(
    `update source_run
        set finished_at = now(),
            record_count = $2,
            inserted_count = $3,
            updated_count = $4,
            unchanged_count = $5,
            status = $6,
            error_text = $7
      where run_id = $1`,
    [run.runId, run.records, run.inserted, run.updated, run.unchanged, status, errorText ?? null],
  );
}

/** One line of loader output, in a consistent shape across every loader. */
export function summarize(run: RunHandle, label: string): string {
  return (
    `${label.padEnd(28)} ${String(run.records).padStart(6)} records  ` +
    `${String(run.inserted).padStart(5)} new  ` +
    `${String(run.updated).padStart(5)} changed  ` +
    `${String(run.unchanged).padStart(6)} unchanged`
  );
}
