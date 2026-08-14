/**
 * Name normalisation, in TypeScript.
 *
 * These functions mirror cie_normalize_name and cie_core_name in
 * migrations/0001_helpers.sql exactly. tests/normalize.test.ts asserts that the
 * TypeScript and the SQL agree on every alias in the seed corpus. If the two
 * ever diverge, that test fails.
 *
 * Two levels, and the difference matters. Spec section 8.1.
 */

/**
 * Case, punctuation, and whitespace only. Deterministic and safe for automatic
 * lookup. This is the level that makes acceptance test 3 pass.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const out = raw
    .toUpperCase()
    // Drop a trailing parenthesised numeric token: 'TESSELLATE CONCEPTS INCORPORATED (5855)'.
    .replace(/\(\s*[0-9]+\s*\)/g, ' ')
    // Fold every character that is not a letter, digit, or space. This is the step
    // that makes the comma in 'LARKSPUR, INCORPORATED' stop mattering.
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out === '' ? null : out;
}

const SUFFIX_PATTERN =
  /(\s+(INCORPORATED|INCORORATED|INC|LLC|LLP|LP|LTD|CORPORATION|CORP|COMPANY|CO|THE|PLC|GMBH|SA|NV|AG))+$/g;

/**
 * Suffix-stripped name. Used ONLY to propose merge candidates for a human to
 * confirm. It never merges anything by itself.
 *
 * Spec 8.1: 'A merge from name similarity alone is not permitted.'
 */
export function coreName(raw: string | null | undefined): string | null {
  const normalized = normalizeName(raw);
  if (normalized === null) return null;
  const out = normalized.replace(SUFFIX_PATTERN, '').replace(/^THE\s+/, '').trim();
  return out === '' ? null : out;
}

/**
 * Split a seed-file multi-value cell. The entity map carries
 * 'ZZ2TESTUEI02;ZZ3TESTUEI03' in uei_observed and 'ZC002;ZC003' in cage_observed.
 */
export function splitMulti(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read a seed cell as a value or as absent.
 *
 * The seed files carry a single space in growth_priority_TBD and an empty string
 * in fy19plus_obligations_musd for three nodes. Neither means zero. Spec 10.5:
 * unknown, not_applicable, and a score of zero are three different states.
 */
export function optional(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function optionalNumber(raw: string | null | undefined): number | null {
  const value = optional(raw);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function optionalInteger(raw: string | null | undefined): number | null {
  const parsed = optionalNumber(raw);
  return parsed === null ? null : Math.trunc(parsed);
}

/** The seed files use the literal strings YES and NO in confirmed_by_bd_ops. */
export function isConfirmedFlag(raw: string | null | undefined): boolean {
  return (optional(raw) ?? '').toUpperCase() === 'YES';
}
