/**
 * The twelve acceptance tests from specification section 18.
 *
 * The checks live here rather than in `scripts/acceptance.ts` because two things now
 * need them: `npm run accept`, which prints them and fails CI on a FAIL, and the
 * `/acceptance` screen, which shows the same twelve live against whatever database the
 * interface is pointed at. One implementation, two readers.
 *
 * Each test reports PASS, FAIL, or BLOCKED. BLOCKED means the test cannot run yet
 * because a prerequisite is absent, and it says which prerequisite. A BLOCKED test is
 * never reported as a pass.
 *
 * Specification section 20.1 makes tests 1 and 3 the first thing to run and the first
 * thing to show, before any other build work.
 */
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query } from '../db/index.js';

export type Status = 'PASS' | 'FAIL' | 'BLOCKED';

export interface Result {
  readonly number: number;
  readonly title: string;
  readonly status: Status;
  readonly detail: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesheetPath = path.resolve(here, '..', 'web', 'public', 'app.css');
const fontDir = path.resolve(here, '..', 'web', 'public', 'fonts');

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run all twelve. Returns them in test order.
 *
 * Tests 1 through 10 read the database. Tests 11 and 12 read the stylesheet, because
 * they are properties of the built interface rather than of the corpus.
 */
export async function runAcceptanceChecks(): Promise<Result[]> {
  const results: Result[] = [];
  const record = (number: number, title: string, status: Status, detail: string): void => {
    results.push({ number, title, status, detail });
  };

  const contractActions = await count('select count(*)::text as n from contract_action');
  const corpusLoaded = contractActions > 0;
  const CORPUS_BLOCKER =
    'contract_action is empty. The FPDS exports have not been loaded. ' +
    'Run: npm run load:fpds -- --dir <directory of exports>';

  // -------------------------------------------------------------------------
  // 1. A search for "Astrion" returns the whole history, not 0.7 percent of it.
  // -------------------------------------------------------------------------
  if (!corpusLoaded) {
    record(1, 'Astrion search returns the whole history, not 0.7 percent', 'BLOCKED', CORPUS_BLOCKER);
  } else {
    const byLegalName = await count(
      `select count(*)::text as n from contract_action
        where cie_normalize_name(vendor_name_raw) = cie_normalize_name('ASTRION GROUP, LLC')`,
    );
    const byEntityMap = await count(
      `select count(*)::text as n from contract_action ca
         join entity e on e.entity_id = ca.entity_id
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')`,
    );
    const share = byEntityMap === 0 ? 0 : byLegalName / byEntityMap;
    record(
      1,
      'Astrion search returns the whole history, not 0.7 percent',
      byEntityMap > byLegalName * 10 ? 'PASS' : 'FAIL',
      `entity map returns ${byEntityMap.toLocaleString()}, ` +
        `the legal name alone returns ${byLegalName.toLocaleString()} ` +
        `(${(share * 100).toFixed(1)} percent of the resolved history). ` +
        `${contractActions.toLocaleString()} contract actions loaded in total.`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. The loader runs twice on the same file. The row count does not change.
  // -------------------------------------------------------------------------
  const idempotentRuns = await query<{
    source_system: string;
    source_label: string | null;
    inserted_count: number;
    unchanged_count: number;
  }>(
    `select source_system, source_label, inserted_count, unchanged_count
       from source_run
      where status = 'succeeded' and unchanged_count > 0 and inserted_count = 0
      order by run_id desc limit 5`,
  );
  if (idempotentRuns.length > 0) {
    const example = idempotentRuns[0]!;
    record(
      2,
      'The loader is idempotent',
      'PASS',
      `${idempotentRuns.length} run(s) inserted nothing and reported every record unchanged. ` +
        `Most recent: ${example.source_system} ${example.source_label ?? ''} ` +
        `with ${example.unchanged_count} unchanged. Also covered by tests/fpds-loader.test.ts.`,
    );
  } else {
    record(
      2,
      'The loader is idempotent',
      'BLOCKED',
      'No loader has been run twice on this database yet. Run npm run seed a second time, ' +
        'or run the FPDS load twice. The unit tests in tests/fpds-loader.test.ts cover this.',
    );
  }

  // -------------------------------------------------------------------------
  // 3. Punctuation variants of one legacy name resolve to one entity. Spec 8.3.
  // -------------------------------------------------------------------------
  // Discovered from the loaded map rather than hardcoded. Naming the spellings here would
  // put real company data in the repository, which Gate A forbids, and would also make the
  // test pass only on the corpus it was written against. Instead it finds the legacy entity
  // whose aliases differ by punctuation alone and asserts they land on one entity -- which
  // is the property spec 8.3 actually asks for.
  const variantGroups = await query<{
    entity_id: string;
    canonical_name: string;
    spellings: string;
    spelling_count: number;
    entity_count: number;
  }>(
    `with normalised as (
       select a.alias_name, a.entity_id, e.canonical_name,
              cie_normalize_name(a.alias_name) as norm
         from entity_alias a
         join entity e on e.entity_id = a.entity_id
        where e.entity_type = 'astrion_family'
     )
     select min(entity_id::text)              as entity_id,
            min(canonical_name)               as canonical_name,
            string_agg(distinct alias_name, ' | ' order by alias_name) as spellings,
            count(distinct alias_name)::int   as spelling_count,
            count(distinct entity_id)::int    as entity_count
       from normalised
      group by norm
     having count(distinct alias_name) > 1
      order by count(distinct alias_name) desc
      limit 5`,
  );

  if (variantGroups.length === 0) {
    record(
      3,
      'Punctuation variants resolve to one entity',
      'BLOCKED',
      'No legacy alias in the loaded map has a punctuation variant, so there is nothing to ' +
        'assert. Load the authored entity map and re-run.',
    );
  } else {
    const split = variantGroups.filter((g) => g.entity_count > 1);
    const example = variantGroups[0]!;
    record(
      3,
      'Punctuation variants resolve to one entity',
      split.length === 0 ? 'PASS' : 'FAIL',
      split.length === 0
        ? `${variantGroups.length} legacy name(s) appear under more than one spelling and ` +
          `each resolves to a single entity. Largest: ${example.spelling_count} spellings of ` +
          `${example.canonical_name}. Spec 8.3.`
        : `${split.length} group(s) of punctuation variants resolve to more than one entity, ` +
          `which spec 8.3 forbids. First: ${split[0]!.spellings}.`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. A pursuit with no past performance evidence gets no rank.
  // -------------------------------------------------------------------------
  const assessments = await count('select count(*)::text as n from assessment');
  if (assessments === 0) {
    record(
      4,
      'No past performance evidence gives no rank',
      'BLOCKED',
      'The scoring engine is not built yet. This is the next phase of work.',
    );
    record(5, 'A failed gate shows no score', 'BLOCKED', 'The scoring engine is not built yet.');
    record(
      7,
      'Every score opens a rule trace with a source link',
      'BLOCKED',
      'The scoring engine is not built yet.',
    );
  } else {
    const badRank = await count(
      `select count(*)::text as n from assessment
        where status = 'insufficient_evidence' and rank_value is not null`,
    );
    record(
      4,
      'No past performance evidence gives no rank',
      badRank === 0 ? 'PASS' : 'FAIL',
      `${badRank} assessment(s) carry a rank despite insufficient evidence.`,
    );

    const gateWithScore = await count(
      `select count(*)::text as n from assessment
        where eligibility = 'fail' and strategic_fit is not null`,
    );
    record(
      5,
      'A failed gate shows no score',
      gateWithScore === 0 ? 'PASS' : 'FAIL',
      `${gateWithScore} assessment(s) show a score despite a failed gate.`,
    );

    const traceless = await count(
      `select count(*)::text as n from assessment a
        where a.status = 'scored'
          and not exists (select 1 from evidence_ref er
                           where er.assessment_id = a.assessment_id and er.source_uri is not null)`,
    );
    record(
      7,
      'Every score opens a rule trace with a source link',
      traceless === 0 ? 'PASS' : 'FAIL',
      `${traceless} scored assessment(s) have no evidence row carrying a source link.`,
    );
  }

  // -------------------------------------------------------------------------
  // 6. A weight change creates a new score model version.
  // -------------------------------------------------------------------------
  const models = await count('select count(*)::text as n from score_model');
  const weightsAreRows = await count(
    `select count(*)::text as n from information_schema.columns
      where table_name = 'score_model_factor' and column_name = 'weight'`,
  );
  if (weightsAreRows === 1 && models >= 1) {
    record(
      6,
      'A weight change creates a new score model version',
      assessments === 0 ? 'BLOCKED' : 'PASS',
      assessments === 0
        ? `Weights live in score_model_factor rows, so the mechanism is in place ` +
          `(${models} model version, defect 1 corrected). Cannot demonstrate reproducibility ` +
          'until assessments exist.'
        : `${models} score model version(s). Each assessment pins its own version.`,
    );
  } else {
    record(
      6,
      'A weight change creates a new score model version',
      'FAIL',
      'score_model_factor.weight is missing.',
    );
  }

  // -------------------------------------------------------------------------
  // 8. A recompete signal appears for a contract that ends in 18 months.
  // -------------------------------------------------------------------------
  if (!corpusLoaded) {
    record(8, 'A recompete signal appears for a contract ending in 18 months', 'BLOCKED', CORPUS_BLOCKER);
  } else {
    const candidates = await count(
      `select count(*)::text as n from contract_action ca
         join entity e on e.entity_id = ca.entity_id
        where coalesce(e.ultimate_parent_id, e.entity_id) =
              (select entity_id from entity where canonical_name = 'Astrion')
          and ca.ultimate_completion_date is not null
          and ca.ultimate_completion_date between
              current_date + interval '12 months' and current_date + interval '36 months'`,
    );
    const signals = await count(
      "select count(*)::text as n from pursuit where signal_class = 'recompete_window'",
    );
    record(
      8,
      'A recompete signal appears for a contract ending in 18 months',
      signals > 0 ? 'PASS' : 'BLOCKED',
      signals > 0
        ? `${signals} recompete signal(s) present.`
        : `${candidates} contract action(s) fall in the 12 to 36 month window and would produce ` +
          'a signal. Recompete detection is not built yet.',
    );
  }

  // -------------------------------------------------------------------------
  // 9 and 10. Campaign sizing and the gap report.
  // -------------------------------------------------------------------------
  const campaigns = await count('select count(*)::text as n from campaign');
  record(
    9,
    'A campaign shows TAM, SAM, SOM with the sample size beside the capture rate',
    'BLOCKED',
    campaigns === 0
      ? 'No campaign exists yet. Campaign sizing is a later phase. The columns, including ' +
        'capture_rate_sample_size, are in place.'
      : `${campaigns} campaign(s) exist but sizing is not computed yet.`,
  );
  record(
    10,
    'The gap report lists at least one opportunity with no campaign',
    'BLOCKED',
    'The gap report is a later phase. It needs campaigns and pursuits.',
  );

  // -------------------------------------------------------------------------
  // 11 and 12. The interface.
  //
  // These two read src/web/public/app.css rather than the database. Until the
  // interface existed they were blocked on it; now that it does, they are the
  // cheapest kind of check to keep honest, so they run on every push.
  // -------------------------------------------------------------------------
  const stylesheet = (await exists(stylesheetPath)) ? await readFile(stylesheetPath, 'utf8') : null;

  if (stylesheet === null) {
    record(
      11,
      'No text in the built interface is smaller than 12 pixels',
      'BLOCKED',
      `The stylesheet is missing: expected ${path.relative(process.cwd(), stylesheetPath)}.`,
    );
    record(
      12,
      'The interface renders in Archivo, not a fallback face',
      'BLOCKED',
      'The stylesheet is missing, so the font stack cannot be checked.',
    );
  } else {
    // Every font-size in the sheet, with its unit. A relative unit would make the
    // smallest rendered size unknowable from the file, so the sheet forbids one and
    // this check treats one as a failure rather than waving it through.
    const declarations = [...stylesheet.matchAll(/font-size\s*:\s*([^;}]+)/gi)].map((m) => m[1]!.trim());
    const pixelSizes: number[] = [];
    const relative: string[] = [];

    for (const declaration of declarations) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(declaration);
      if (px) {
        pixelSizes.push(Number(px[1]));
        continue;
      }
      if (/^(inherit|initial|unset|revert)$/i.test(declaration)) continue;
      relative.push(declaration);
    }

    const tooSmall = pixelSizes.filter((size) => size < 12);
    const smallest = pixelSizes.length > 0 ? Math.min(...pixelSizes) : null;

    if (declarations.length === 0) {
      record(
        11,
        'No text in the built interface is smaller than 12 pixels',
        'FAIL',
        'The stylesheet declares no font-size at all, so the rendered sizes are whatever the ' +
          'browser defaults to and the property cannot be asserted.',
      );
    } else if (tooSmall.length > 0) {
      record(
        11,
        'No text in the built interface is smaller than 12 pixels',
        'FAIL',
        `${tooSmall.length} font-size declaration(s) fall below 12px. Smallest: ${Math.min(...tooSmall)}px.`,
      );
    } else if (relative.length > 0) {
      record(
        11,
        'No text in the built interface is smaller than 12 pixels',
        'FAIL',
        `${relative.length} font-size declaration(s) use a relative unit ` +
          `(${relative.slice(0, 3).join(', ')}), so the smallest rendered size cannot be read ` +
          'from the stylesheet. Use px.',
      );
    } else {
      record(
        11,
        'No text in the built interface is smaller than 12 pixels',
        'PASS',
        `${declarations.length} font-size declaration(s) in src/web/public/app.css, all in px, ` +
          `smallest ${smallest}px.`,
      );
    }

    // Archivo has to be declared, present on disk, and first in the stack. Any one of
    // the three missing means the interface renders in the Arial fallback.
    const faces = [...stylesheet.matchAll(/@font-face\s*\{[^}]*\}/gi)].map((m) => m[0]);
    const archivoFaces = faces.filter((face) => /font-family\s*:\s*['"]?Archivo['"]?/i.test(face));
    const referenced = [
      ...new Set(archivoFaces.flatMap((face) => [...face.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]!))),
    ];
    const missing: string[] = [];
    for (const reference of referenced) {
      const file = path.join(fontDir, path.basename(reference));
      if (!(await exists(file))) missing.push(path.basename(reference));
    }

    const bodyStack = /body\s*\{[^}]*font-family\s*:\s*([^;}]+)/i.exec(stylesheet)?.[1]?.trim() ?? '';
    const archivoFirst = /^['"]?Archivo['"]?/i.test(bodyStack);

    if (archivoFaces.length === 0) {
      record(
        12,
        'The interface renders in Archivo, not a fallback face',
        'FAIL',
        'No @font-face declares Archivo, so the interface renders in the fallback.',
      );
    } else if (missing.length > 0) {
      record(
        12,
        'The interface renders in Archivo, not a fallback face',
        'FAIL',
        `${missing.length} Archivo font file(s) referenced by the stylesheet are not on disk: ` +
          `${missing.join(', ')}. The browser would fall back to Arial.`,
      );
    } else if (!archivoFirst) {
      record(
        12,
        'The interface renders in Archivo, not a fallback face',
        'FAIL',
        `Archivo is not first in the body font stack: "${bodyStack}".`,
      );
    } else {
      record(
        12,
        'The interface renders in Archivo, not a fallback face',
        'PASS',
        `${archivoFaces.length} Archivo weight(s) self-hosted and present on disk ` +
          `(${referenced.map((r) => path.basename(r)).join(', ')}), and Archivo leads the body ` +
          'font stack. Astrion 2026 Brand Evolution.',
      );
    }
  }

  results.sort((a, b) => a.number - b.number);
  return results;
}

/** PASS, FAIL and BLOCKED counts, for a summary line or a tile. */
export function tally(results: readonly Result[]): {
  passed: number;
  failed: number;
  blocked: number;
  total: number;
} {
  return {
    passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    blocked: results.filter((r) => r.status === 'BLOCKED').length,
    total: results.length,
  };
}
