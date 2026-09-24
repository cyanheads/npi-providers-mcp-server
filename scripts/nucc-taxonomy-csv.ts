/**
 * @fileoverview Parses the NUCC Health Care Provider Taxonomy CSV into bundled taxonomy
 * entries. The pure half of `generate-taxonomy-data.ts`, kept apart from its file I/O so
 * the parsing and derivation rules can be tested over small fixture CSVs.
 * @module scripts/nucc-taxonomy-csv
 */

import type { TaxonomyEntry } from '../src/services/taxonomy/types.js';

/** Minimal RFC 4180 CSV parser — handles quoted fields, embedded commas, and `""` escapes. */
export function parseCsv(text: string): string[][] {
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

/** The NUCC CSV header, in column order. */
export const NUCC_COLUMNS = [
  'Code',
  'Grouping',
  'Classification',
  'Specialization',
  'Definition',
  'Notes',
  'Display Name',
  'Section',
] as const;

const CODE_PATTERN = /^\d{3}[A-Z0-9]{6}X$/;

/** NUCC's inactivity marker, e.g. `[1/1/2007: marked inactive, use  103G00000X]`. */
const INACTIVE_MARKER = /\bmarked inactive\b/i;

/** A named replacement: `use <code>` or `use value <code>` (NUCC writes both). */
const REPLACEMENT_PATTERN = /\buse\s+(?:value\s+)?(\d{3}[A-Z0-9]{6}X)\b/i;

/**
 * Parse NUCC CSV text into taxonomy entries sorted by code. Every field is trimmed and
 * optional fields are omitted when their cell is empty. `status` is `inactive` when the
 * Notes cell says `marked inactive`; an inactive entry's `replacedBy` is the code its Notes,
 * else its Definition, names after `use`. Throws on an unexpected header, a short or long
 * row, a malformed code, an unknown section, or a replacement that is missing or inactive.
 */
export function buildTaxonomyEntries(csvText: string): TaxonomyEntry[] {
  const [header, ...body] = parseCsv(csvText);

  if (!header || header.length !== NUCC_COLUMNS.length) {
    throw new Error(`Unexpected header: ${header?.join(',')}`);
  }
  NUCC_COLUMNS.forEach((col, idx) => {
    if (header[idx]?.trim() !== col) {
      throw new Error(`Column ${idx} expected "${col}", got "${header[idx]}"`);
    }
  });

  const entries: TaxonomyEntry[] = [];
  for (const cols of body) {
    if (cols.length === 1 && cols[0]?.trim() === '') continue; // blank trailing line
    if (cols.length !== NUCC_COLUMNS.length) {
      throw new Error(
        `Row has ${cols.length} columns, expected ${NUCC_COLUMNS.length}: ${cols.join(',')}`,
      );
    }
    const code = (cols[0] ?? '').trim();
    if (!CODE_PATTERN.test(code)) throw new Error(`Invalid taxonomy code: "${code}"`);
    const section = (cols[7] ?? '').trim();
    if (section !== 'Individual' && section !== 'Non-Individual') {
      throw new Error(`Invalid section "${section}" for code ${code}`);
    }
    const specialization = (cols[3] ?? '').trim();
    const definition = (cols[4] ?? '').trim();
    const notes = (cols[5] ?? '').trim();
    const status = INACTIVE_MARKER.test(notes) ? 'inactive' : 'active';
    const replacedBy =
      status === 'inactive'
        ? (REPLACEMENT_PATTERN.exec(notes) ?? REPLACEMENT_PATTERN.exec(definition))?.[1]
        : undefined;
    entries.push({
      code,
      grouping: (cols[1] ?? '').trim(),
      classification: (cols[2] ?? '').trim(),
      ...(specialization ? { specialization } : {}),
      displayName: (cols[6] ?? '').trim(),
      ...(definition ? { definition } : {}),
      ...(notes ? { notes } : {}),
      section,
      status,
      ...(replacedBy ? { replacedBy } : {}),
    });
  }

  const byCode = new Map(entries.map((entry) => [entry.code, entry]));
  for (const { code, replacedBy } of entries) {
    if (!replacedBy) continue;
    const target = byCode.get(replacedBy);
    if (!target) {
      throw new Error(`${code} names replacement ${replacedBy}, which is not in the code set`);
    }
    if (target.status !== 'active') {
      throw new Error(`${code} names replacement ${replacedBy}, which is itself inactive`);
    }
  }

  return entries.sort((a, b) => a.code.localeCompare(b.code));
}
