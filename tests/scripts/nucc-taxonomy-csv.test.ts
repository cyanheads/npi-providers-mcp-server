/**
 * @fileoverview Tests for the NUCC taxonomy CSV parser behind the bundled data generator —
 * field parsing, Notes carry-through, inactive-status and replacement derivation, and the
 * build-time guard on replacement codes. Runs over small fixture CSVs plus the bundled CSV.
 * @module tests/scripts/nucc-taxonomy-csv.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAXONOMY_ENTRIES } from '@/services/taxonomy/taxonomy-data.js';
import { buildTaxonomyEntries } from '../../scripts/nucc-taxonomy-csv.js';

const HEADER = 'Code,Grouping,Classification,Specialization,Definition,Notes,Display Name,Section';

interface Row {
  classification?: string;
  code: string;
  definition?: string;
  displayName?: string;
  grouping?: string;
  notes?: string;
  section?: string;
  specialization?: string;
}

/** Quote every cell RFC 4180-style so commas and quotes in fixture text survive. */
function csv(rows: Row[]): string {
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const lines = rows.map((r) =>
    [
      r.code,
      r.grouping ?? 'Behavioral Health & Social Service Providers',
      r.classification ?? 'Psychologist',
      r.specialization ?? '',
      r.definition ?? '',
      r.notes ?? '',
      r.displayName ?? 'Psychologist',
      r.section ?? 'Individual',
    ]
      .map(cell)
      .join(','),
  );
  return [HEADER, ...lines].join('\r\n');
}

function byCode(rows: Row[]) {
  return new Map(buildTaxonomyEntries(csv(rows)).map((entry) => [entry.code, entry]));
}

describe('buildTaxonomyEntries', () => {
  describe('field parsing (characterization)', () => {
    it('trims kept fields, omits empty optional cells, and sorts by code', () => {
      const entries = buildTaxonomyEntries(
        csv([
          { code: '103T00000X', classification: '  Psychologist ', definition: '' },
          {
            code: '103G00000X',
            classification: 'Clinical Neuropsychologist',
            specialization: ' Clinical ',
            definition: ' A definition, with a comma and a "quote". ',
            displayName: 'Clinical Neuropsychologist',
          },
        ]),
      );
      expect(entries.map((e) => e.code)).toEqual(['103G00000X', '103T00000X']);
      expect(entries[0]).toMatchObject({
        classification: 'Clinical Neuropsychologist',
        specialization: 'Clinical',
        definition: 'A definition, with a comma and a "quote".',
      });
      expect(entries[1]).toMatchObject({ classification: 'Psychologist' });
      expect(entries[1]).not.toHaveProperty('specialization');
      expect(entries[1]).not.toHaveProperty('definition');
    });

    it('rejects a malformed header, code, section, or row width', () => {
      expect(() => buildTaxonomyEntries(`Code,Grouping\n103T00000X,x`)).toThrow(/header/i);
      expect(() => buildTaxonomyEntries(csv([{ code: '103T0000X' }]))).toThrow(/code/i);
      expect(() => buildTaxonomyEntries(csv([{ code: '103T00000X', section: 'Group' }]))).toThrow(
        /section/i,
      );
      expect(() => buildTaxonomyEntries(`${HEADER}\n103T00000X,a,b`)).toThrow(/columns/i);
    });

    it('reproduces the bundled data module from the bundled CSV', () => {
      const dataDir = join(import.meta.dirname, '../../src/services/taxonomy/data');
      const csvFiles = readdirSync(dataDir).filter((f) => /^nucc_taxonomy_\d+\.csv$/.test(f));
      expect(csvFiles).toHaveLength(1);
      const text = readFileSync(join(dataDir, csvFiles[0] as string), 'utf-8');
      expect(buildTaxonomyEntries(text)).toEqual(TAXONOMY_ENTRIES);
    });
  });

  describe('Notes (#11)', () => {
    it('carries the trimmed Notes cell with its interior whitespace intact', () => {
      const entries = byCode([
        {
          code: '242T00000X',
          notes:
            '  Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new] ',
        },
      ]);
      expect(entries.get('242T00000X')?.notes).toBe(
        'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
      );
    });

    it('omits notes for an empty or whitespace-only cell, never "" or null', () => {
      const entries = byCode([
        { code: '103T00000X', notes: '' },
        { code: '103G00000X', notes: '   ' },
        { code: '242T00000X', notes: 'Source: NUCC' },
      ]);
      expect(entries.get('103T00000X')).not.toHaveProperty('notes');
      expect(entries.get('103G00000X')).not.toHaveProperty('notes');
      expect(entries.get('242T00000X')?.notes).toBe('Source: NUCC');
    });
  });

  describe('status and replacement (#16)', () => {
    it('marks a code inactive only when its Notes say "marked inactive"', () => {
      const entries = byCode([
        { code: '1744G0900X', notes: '1/1/2025: marked inactive' },
        { code: '207KI0005X', notes: 'This certification was, but is no longer, issued.' },
        // The display-name prefix is not a marker: NUCC dropped it in v26.1.
        { code: '103TE1000X', displayName: 'Deactivated - Psychologist' },
        { code: '103T00000X' },
      ]);
      expect(entries.get('1744G0900X')?.status).toBe('inactive');
      expect(entries.get('207KI0005X')?.status).toBe('active');
      expect(entries.get('103TE1000X')?.status).toBe('active');
      expect(entries.get('103T00000X')?.status).toBe('active');
    });

    it('reads replacedBy from "use <code>" or "use value <code>" in Notes, then Definition', () => {
      const entries = byCode([
        { code: '103G00000X' },
        { code: '183500000X' },
        { code: '282J00000X' },
        { code: '103GC0700X', notes: '[1/1/2007: marked inactive, use  103G00000X]' },
        { code: '1835G0000X', notes: '[1/1/2006: marked inactive, use value 183500000X]' },
        {
          code: '287300000X',
          definition: 'Inactive, use 282J00000X',
          notes: ' [7/1/2009: marked inactive]',
        },
        // Notes wins over Definition when both name a code.
        {
          code: '317400000X',
          definition: 'Inactive, use 282J00000X',
          notes: '[7/1/2009: marked inactive, use 103G00000X]',
        },
        { code: '1744G0900X', notes: '1/1/2025: marked inactive' },
      ]);
      expect(entries.get('103GC0700X')?.replacedBy).toBe('103G00000X');
      expect(entries.get('1835G0000X')?.replacedBy).toBe('183500000X');
      expect(entries.get('287300000X')?.replacedBy).toBe('282J00000X');
      expect(entries.get('317400000X')?.replacedBy).toBe('103G00000X');
      expect(entries.get('1744G0900X')).not.toHaveProperty('replacedBy');
      expect(entries.get('103G00000X')).not.toHaveProperty('replacedBy');
    });

    it('never gives an active code a replacement, even when its text says "use <code>"', () => {
      const entries = byCode([
        { code: '103G00000X' },
        { code: '2085R0203X', definition: 'Therapeutic radiology. Use 103G00000X instead.' },
      ]);
      expect(entries.get('2085R0203X')?.status).toBe('active');
      expect(entries.get('2085R0203X')).not.toHaveProperty('replacedBy');
    });

    it('fails the build when a replacement code is missing from the code set', () => {
      expect(() =>
        buildTaxonomyEntries(
          csv([{ code: '103GC0700X', notes: '[1/1/2007: marked inactive, use 103G00000X]' }]),
        ),
      ).toThrow(/103GC0700X.*103G00000X/);
    });

    it('fails the build when a replacement code is itself inactive', () => {
      expect(() =>
        buildTaxonomyEntries(
          csv([
            { code: '103G00000X', notes: '1/1/2025: marked inactive' },
            { code: '103GC0700X', notes: '[1/1/2007: marked inactive, use 103G00000X]' },
          ]),
        ),
      ).toThrow(/103GC0700X.*103G00000X.*inactive/);
    });
  });
});
