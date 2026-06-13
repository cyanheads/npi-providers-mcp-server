/**
 * @fileoverview Generates the bundled NUCC taxonomy data module from the source CSV.
 * @module scripts/generate-taxonomy-data
 *
 * Parses `src/services/taxonomy/data/nucc_taxonomy_<version>.csv` (RFC 4180) and
 * emits `src/services/taxonomy/taxonomy-data.ts` — a typed, in-memory data module
 * the service indexes at startup. Bundling as a `.ts` module (rather than reading
 * the CSV at runtime) keeps the data Workers-portable and survives `tsc` builds,
 * which copy no non-TS assets into `dist/`.
 *
 * Refresh on NUCC's twice-yearly release cadence: drop the new CSV under
 * `data/`, update `CSV_FILE`, and re-run `bun run scripts/generate-taxonomy-data.ts`.
 *
 * @example
 * // bun run scripts/generate-taxonomy-data.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV_VERSION = '250'; // NUCC v25.0
const CSV_FILE = join(ROOT, 'src/services/taxonomy/data', `nucc_taxonomy_${CSV_VERSION}.csv`);
const OUT_FILE = join(ROOT, 'src/services/taxonomy/taxonomy-data.ts');

/** Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas, and `""` escapes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Normalize CRLF/CR to LF up front so row breaks are uniform.
  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Trailing field/row (file may not end with a newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const COLUMNS = [
  'Code',
  'Grouping',
  'Classification',
  'Specialization',
  'Definition',
  'Notes',
  'Display Name',
  'Section',
] as const;

type Section = 'Individual' | 'Non-Individual';

interface Entry {
  classification: string;
  code: string;
  definition?: string;
  displayName: string;
  grouping: string;
  section: Section;
  specialization?: string;
}

function main(): void {
  const raw = readFileSync(CSV_FILE, 'utf-8');
  const rows = parseCsv(raw);
  const [header, ...body] = rows;

  if (!header || header.length !== COLUMNS.length) {
    throw new Error(`Unexpected header: ${header?.join(',')}`);
  }
  COLUMNS.forEach((col, idx) => {
    if (header[idx]?.trim() !== col) {
      throw new Error(`Column ${idx} expected "${col}", got "${header[idx]}"`);
    }
  });

  const codePattern = /^\d{3}[A-Z0-9]{6}X$/;
  const entries: Entry[] = [];
  for (const cols of body) {
    if (cols.length === 1 && cols[0]?.trim() === '') continue; // blank trailing line
    if (cols.length !== COLUMNS.length) {
      throw new Error(
        `Row has ${cols.length} columns, expected ${COLUMNS.length}: ${cols.join(',')}`,
      );
    }
    const code = (cols[0] ?? '').trim();
    if (!codePattern.test(code)) throw new Error(`Invalid taxonomy code: "${code}"`);
    const section = (cols[7] ?? '').trim();
    if (section !== 'Individual' && section !== 'Non-Individual') {
      throw new Error(`Invalid section "${section}" for code ${code}`);
    }
    const specialization = (cols[3] ?? '').trim();
    const definition = (cols[4] ?? '').trim();
    entries.push({
      code,
      grouping: (cols[1] ?? '').trim(),
      classification: (cols[2] ?? '').trim(),
      ...(specialization ? { specialization } : {}),
      displayName: (cols[6] ?? '').trim(),
      ...(definition ? { definition } : {}),
      section,
    });
  }

  entries.sort((a, b) => a.code.localeCompare(b.code));

  const banner = `/**
 * @fileoverview Bundled NUCC Healthcare Provider Taxonomy data (v${CSV_VERSION[0]}${CSV_VERSION.slice(1)}, ${entries.length} codes).
 * @module services/taxonomy/taxonomy-data
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   bun run scripts/generate-taxonomy-data.ts
 *
 * Source: https://www.nucc.org/images/stories/CSV/nucc_taxonomy_${CSV_VERSION}.csv
 * Columns kept: Code, Grouping, Classification, Specialization, Display Name, Definition, Section.
 * The upstream Notes column (citations/revision history) is intentionally dropped.
 */

import type { TaxonomyEntry } from './types.js';

/** All ${entries.length} NUCC taxonomy entries, sorted by code. */
export const TAXONOMY_ENTRIES: readonly TaxonomyEntry[] = `;

  const json = JSON.stringify(entries, null, 2);
  writeFileSync(OUT_FILE, `${banner}${json} as const;\n`, 'utf-8');
  process.stdout.write(`Generated ${OUT_FILE} with ${entries.length} entries.\n`);
}

main();
