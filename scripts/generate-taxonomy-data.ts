/**
 * @fileoverview Generates the bundled NUCC taxonomy data module from the source CSV.
 * @module scripts/generate-taxonomy-data
 *
 * Parses `src/services/taxonomy/data/nucc_taxonomy_<version>.csv` (RFC 4180, via
 * `nucc-taxonomy-csv.ts`) and emits `src/services/taxonomy/taxonomy-data.ts` — a typed,
 * in-memory data module the service indexes at startup. Bundling as a `.ts` module
 * (rather than reading the CSV at runtime) keeps the data Workers-portable and survives
 * `tsc` builds, which copy no non-TS assets into `dist/`.
 *
 * Refresh on NUCC's twice-yearly release cadence: replace the CSV under `data/` with
 * the new release, update `CSV_VERSION`, and re-run `bun run scripts/generate-taxonomy-data.ts`.
 *
 * @example
 * // bun run scripts/generate-taxonomy-data.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaxonomyEntries } from './nucc-taxonomy-csv.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_VERSION = '261'; // NUCC v26.1 — NUCC's file name drops the dot
const CSV_FILE = join(ROOT, 'src/services/taxonomy/data', `nucc_taxonomy_${CSV_VERSION}.csv`);
const OUT_FILE = join(ROOT, 'src/services/taxonomy/taxonomy-data.ts');

function main(): void {
  const entries = buildTaxonomyEntries(readFileSync(CSV_FILE, 'utf-8'));
  const inactive = entries.filter((entry) => entry.status === 'inactive').length;

  const banner = `/**
 * @fileoverview Bundled NUCC Healthcare Provider Taxonomy data (v${CSV_VERSION.slice(0, -1)}.${CSV_VERSION.slice(-1)}, ${entries.length} codes).
 * @module services/taxonomy/taxonomy-data
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   bun run scripts/generate-taxonomy-data.ts
 *
 * Source: https://www.nucc.org/images/stories/CSV/nucc_taxonomy_${CSV_VERSION}.csv
 * Columns kept: Code, Grouping, Classification, Specialization, Display Name, Definition,
 * Notes, Section. Derived from Notes/Definition: status (${inactive} codes marked inactive)
 * and, for an inactive code, the replacement code NUCC names.
 *
 * © American Medical Association on behalf of the National Uniform Claim
 * Committee (NUCC). Used under the NUCC permission (royalty-free, non-exclusive)
 * on the condition that this notice accompanies any copy; redistributed
 * unmodified beyond formatting. See the repository NOTICE file.
 */

import type { TaxonomyEntry } from './types.js';

/** All ${entries.length} NUCC taxonomy entries, sorted by code. */
export const TAXONOMY_ENTRIES: readonly TaxonomyEntry[] = `;

  const json = JSON.stringify(entries, null, 2);
  writeFileSync(OUT_FILE, `${banner}${json} as const;\n`, 'utf-8');
  process.stdout.write(
    `Generated ${OUT_FILE} with ${entries.length} entries (${inactive} inactive).\n`,
  );
}

main();
