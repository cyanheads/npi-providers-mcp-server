/**
 * @fileoverview Decide whether the registry matched a search's `taxonomy_description`
 * filter through a given taxonomy.
 * @module services/nppes/taxonomy-match
 *
 * NPPES matches `taxonomy_description` against every taxonomy a provider holds, as a
 * case-insensitive prefix of the taxonomy's classification or of its specialization,
 * in the registry's own wording: `Cardio` reaches Cardiovascular Disease, while
 * `Disease` (a later word), `Cardiothoracic` (inside a parenthesis), and the combined
 * `Classification, Specialization` text match nothing. A served `desc` joins the two
 * parts with `, `, but either part can itself hold `, ` (`Spec/Tech, Cardiovascular`,
 * `Psych/Mental Health, Adult`) and either can be worded differently from NUCC, so the
 * split is anchored on the bundled entry, never on the first comma.
 */

import { taxonomyNamesOf } from '@/services/taxonomy/taxonomy-service.js';
import type { TaxonomyEntry } from '@/services/taxonomy/types.js';

/**
 * The classification and specialization a taxonomy is matched on. A served `desc` splits
 * after the bundled classification and `, ` when it starts with them, else before `, `
 * and the bundled specialization when it ends with them; a code with no specialization,
 * or a `desc` neither split fits, is all classification. With no served `desc`, the
 * bundled entry's parts; with neither, none.
 */
function matchParts(served: string | undefined, entry: TaxonomyEntry | undefined): string[] {
  if (!served) return entry ? taxonomyNamesOf(entry) : [];
  if (entry?.specialization) {
    const head = `${entry.classification}, `;
    if (served.startsWith(head)) return [entry.classification, served.slice(head.length)];
    const tail = `, ${entry.specialization}`;
    if (served.endsWith(tail)) return [served.slice(0, -tail.length), entry.specialization];
  }
  return [served];
}

/**
 * Whether the registry matches `filter` through a taxonomy: `filter` is a
 * case-insensitive prefix of its classification or specialization. `served` is the
 * registry's trimmed `desc` (its wording wins), `entry` the bundled NUCC entry for the
 * code; a taxonomy with neither never matches, so a row is never marked on a guess.
 */
export function matchesTaxonomyFilter(
  filter: string,
  served: string | undefined,
  entry: TaxonomyEntry | undefined,
): boolean {
  const wanted = filter.toLowerCase();
  return matchParts(served, entry).some((part) => part.toLowerCase().startsWith(wanted));
}
