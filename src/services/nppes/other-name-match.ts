/**
 * @fileoverview Decide whether a search row matched its name criteria through one
 * of the provider's other names (former, professional, DBA, or other name) rather
 * than its current name.
 * @module services/nppes/other-name-match
 *
 * NPPES matches `first_name`, `last_name`, and `organization_name` against a
 * provider's current name and every `other_names[]` entry, field by field, and
 * sorts by current name — so a name search can return, and fill a page with,
 * providers whose current name is something else entirely. The rule here only
 * flags a row it can prove matched through an other name; anything the registry
 * may have matched on the current name stays unflagged.
 */

import type { ProviderOtherName } from './types.js';

/** The name criteria a search sent. */
export interface NameCriteria {
  firstName?: string;
  lastName?: string;
  organizationName?: string;
}

/** The name fields of one name (current or other) the criteria are checked against. */
type NameFields = Pick<ProviderOtherName, 'firstName' | 'lastName' | 'organizationName'>;

type NameField = keyof NameCriteria;

/**
 * Fold a name for comparison: drop diacritics and every character that is not a
 * letter or digit, then uppercase. The registry matches "OBrien" to O'BRIEN and
 * "DeLaCruz" to DE LA CRUZ, so apostrophes and spaces never decide a match; folding
 * hyphens too only ever makes the current name match more often.
 */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toUpperCase();
}

/**
 * Whether `value` satisfies a requested name: equal once folded, or starting with it
 * when the request carries `*` (the registry treats any `*` as a prefix wildcard).
 */
function satisfies(value: string | undefined, requested: string): boolean {
  if (!value) return false;
  const folded = fold(value);
  const wanted = fold(requested);
  return requested.includes('*') ? folded.startsWith(wanted) : folded === wanted;
}

/**
 * Whether the current name can be shown to fail a requested field. An exact
 * `firstName` never can: the registry also matches first-name aliases (Bob for
 * Robert) whose table it does not publish. A wildcard first name disables that
 * aliasing, so it is compared like the other fields.
 */
function failsOnCurrent(current: NameFields, field: NameField, requested: string): boolean {
  if (field === 'firstName' && !requested.includes('*')) return false;
  return !satisfies(current[field], requested);
}

/**
 * The other name a row matched through, or `undefined` when its current name may
 * have matched. A row counts as an other-name match when its current name fails a
 * requested `lastName`, `organizationName`, or wildcard `firstName`, and an other
 * name satisfies every field the current name fails. Among several such other
 * names, the first that satisfies every requested field wins, else the first.
 */
export function findMatchedOtherName(
  current: NameFields,
  otherNames: readonly ProviderOtherName[],
  criteria: NameCriteria,
): ProviderOtherName | undefined {
  const requested = (Object.entries(criteria) as [NameField, string | undefined][]).filter(
    (entry): entry is [NameField, string] => Boolean(entry[1]),
  );
  const failing = requested.filter(([field, value]) => failsOnCurrent(current, field, value));
  if (failing.length === 0) return;
  const candidates = otherNames.filter((other) =>
    failing.every(([field, value]) => satisfies(other[field], value)),
  );
  return (
    candidates.find((other) =>
      requested.every(([field, value]) => satisfies(other[field], value)),
    ) ?? candidates[0]
  );
}
