/**
 * Shared parsing for the DACIS export shapes.
 *
 * DACIS writes list columns as semicolon-separated entries, one per line, and formats
 * each company or customer as `Name (City, ST)`. Both conventions appear in the
 * customers, programs and contract exports, so they are parsed in one place.
 */
import { normalizeName, optional } from '../lib/normalize.js';

/**
 * Split a DACIS list column.
 *
 * The separator is a semicolon; the newline after it is cosmetic. Verified on the
 * programs export, where one row carries 500 entries separated by ';\r\n'.
 */
export function splitList(raw: string | null | undefined): string[] {
  const value = optional(raw);
  if (value === null) return [];
  return value
    .split(';')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '');
}

/**
 * Trailing location parenthetical, e.g. '(Chevy Chase, MD)' or '(Fairmont AFB, NM)'.
 *
 * Anchored to the end and required to contain a comma, so a parenthetical that is part
 * of the name survives. That matters: the authored entity map contains
 * 'TESSELLATE CONCEPTS INCORPORATED (5855)', which has no comma and is not a location.
 *
 * Verified against 2,180 distinct company mentions from the programs exports: every one
 * had its location split off, and none lost part of its name.
 */
const TRAILING_LOCATION = /\s*\(([^()]*,[^()]*)\)\s*$/;

export interface NameAndLocation {
  name: string;
  location: string | null;
}

export function splitNameLocation(entry: string): NameAndLocation {
  const value = entry.trim();
  const match = TRAILING_LOCATION.exec(value);
  if (match === null) return { name: value, location: null };
  return { name: value.slice(0, match.index).trim(), location: match[1]!.trim() };
}

/**
 * An acronym in a parenthetical that is not a location, e.g. the 'HRL/SD' in
 * 'U.S. HRL, Space Warfare Directorate (HRL/SD) (Fairmont AFB, NM)'.
 *
 * Used as a second chance when a customer string does not match customer_org by name.
 * Returns null unless the parenthetical looks like an acronym: short, and containing no
 * lowercase letters beyond the odd connector.
 */
export function trailingAcronym(name: string): string | null {
  const match = /\(([^()]{2,24})\)\s*$/.exec(name.trim());
  if (match === null) return null;
  const candidate = match[1]!.trim();
  if (candidate.includes(',')) return null;
  if (!/^[A-Z0-9][A-Z0-9/&.\- ]*$/.test(candidate)) return null;
  return candidate;
}

/** 'Yes' / 'No' as DACIS writes them. Anything else is unknown, not false. */
export function parseYesNo(raw: string | null | undefined): boolean | null {
  const value = optional(raw);
  if (value === null) return null;
  const lower = value.toLowerCase();
  if (lower === 'yes' || lower === 'y' || lower === 'true') return true;
  if (lower === 'no' || lower === 'n' || lower === 'false') return false;
  return null;
}

/**
 * 'Value ($M)' to dollars.
 *
 * Stored in dollars so a DACIS contract value is comparable with
 * contract_action.action_obligation without a unit conversion at every use. 429 of the
 * 434 supplied rows carry a number, 5 are blank; a blank is null, never zero.
 */
export function parseMillionsToUsd(raw: string | null | undefined): number | null {
  const value = optional(raw);
  if (value === null) return null;
  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  const dollars = parsed * 1_000_000;
  return negative ? -Math.abs(dollars) : dollars;
}

/** ISO first, then the other shapes DACIS and FPDS have been seen to use. */
export function parseDacisDate(raw: string | null | undefined): string | null {
  const value = optional(raw);
  if (value === null) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (us) {
    const month = us[1]!.padStart(2, '0');
    const day = us[2]!.padStart(2, '0');
    let year = us[3]!;
    if (year.length === 2) year = Number(year) >= 90 ? `19${year}` : `20${year}`;
    return `${year}-${month}-${day}`;
  }

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return null;
}

/** The numeric record id inside a DACIS URL, which is the key on every shape. */
export function dacisRecordId(url: string | null | undefined): string | null {
  const value = optional(url);
  if (value === null) return null;
  const withQuery = /[?&]id=(\d+)/.exec(value);
  if (withQuery) return withQuery[1]!;
  // The customers export uses a path form: https://www.dacis.com/customers/36144
  const path = /\/(\d+)\/?$/.exec(value);
  if (path) return path[1]!;
  return null;
}

/** One parsed entry from a company or customer list column. */
export interface ListedParty {
  raw: string;
  name: string;
  nameNormalized: string | null;
  location: string | null;
}

/**
 * How many entries the export actually emitted in a list cell, before de-duplication.
 *
 * The 500-participant cap applies to what DACIS wrote, not to what survives de-duplication.
 * A program truncated at 500 whose cell repeats six company names yields 494 distinct
 * parties, so testing the de-duplicated count against the cap misses it. Measured on the
 * supplied exports: 10 programs were emitted at the cap, but only 4 have 500 distinct
 * parties -- so the de-duplicated test under-reports truncation by more than half.
 */
export function rawListLength(raw: string | null | undefined): number {
  return splitList(raw).length;
}

export function parseParties(raw: string | null | undefined): ListedParty[] {
  const seen = new Set<string>();
  const out: ListedParty[] = [];
  for (const entry of splitList(raw)) {
    // The exports repeat a company within one cell. 'Abacus Technology Corp.' and
    // 'Abacus Technology Corporation' are separate entries and both are kept, but the
    // identical string twice is one party.
    if (seen.has(entry)) continue;
    seen.add(entry);
    const { name, location } = splitNameLocation(entry);
    if (name === '') continue;
    out.push({ raw: entry, name, nameNormalized: normalizeName(name), location });
  }
  return out;
}

/**
 * The documented cap on the programs export's participant column, which is headed
 * 'Companies (Top 500)'. A program supplying exactly this many was truncated, and its
 * real participant count is unknown.
 */
export const PROGRAM_PARTICIPANT_CAP = 500;
