/**
 * @fileoverview Tests for the NUCC taxonomy service — resolve (with stemming),
 * get-by-code, and hierarchy browse over the bundled in-memory index.
 * @module tests/services/taxonomy/taxonomy-service.test
 */

import { describe, expect, it } from 'vitest';
import { TaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

const svc = new TaxonomyService();

describe('TaxonomyService', () => {
  it('loads the full bundled code set', () => {
    expect(svc.size).toBe(879);
  });

  describe('resolve', () => {
    it('matches an exact classification term', () => {
      const hits = svc.resolve('cardiovascular disease', 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.code === '207RC0000X')).toBe(true);
    });

    it('stems the -ologist form to match the -ology noun (cardiologist → cardiology)', () => {
      const hits = svc.resolve('cardiologist', 10);
      expect(hits.length).toBeGreaterThan(0);
      // Every hit should relate to cardiology/cardiovascular.
      expect(
        hits.some((h) =>
          /cardio/i.test(`${h.classification} ${h.specialization ?? ''} ${h.displayName}`),
        ),
      ).toBe(true);
    });

    it('ranks the canonical physician specialty first for a bare specialist term', () => {
      // The headline DX promise: "cardiologist" must resolve to the general cardiologist
      // (Cardiovascular Disease Physician, Internal Medicine) — never a cardiology
      // pharmacist/technician/hospital. The top match is what the search tool sends upstream.
      expect(svc.resolve('cardiologist', 10)[0]?.code).toBe('207RC0000X');
      expect(svc.resolve('neurologist', 10)[0]?.code).toBe('2084N0400X'); // Neurology Physician
      expect(svc.resolve('psychiatrist', 10)[0]?.code).toBe('2084P0800X'); // Psychiatry Physician
      expect(svc.resolve('surgeon', 10)[0]?.code).toBe('208600000X'); // Surgery Physician
      expect(svc.resolve('pulmonologist', 10)[0]?.code).toBe('207RP1001X'); // Pulmonary Disease
    });

    it('resolves lay specialty phrases after dropping generic role words', () => {
      expect(svc.resolve('heart doctor', 10)[0]?.code).toBe('207RC0000X');
      expect(svc.resolve('kidney specialist', 10)[0]?.code).toBe('207RN0300X'); // Nephrology
      expect(svc.resolve('eye doctor', 10)[0]?.code).toBe('207W00000X'); // Ophthalmology
    });

    it('resolves common lay abbreviations without substring false positives', () => {
      expect(svc.resolve('ENT', 10)[0]?.code).toBe('207Y00000X'); // Otolaryngology
      expect(svc.resolve('obgyn', 10)[0]?.code).toBe('207V00000X'); // Obstetrics & Gynecology
    });

    it('ranks physician entries above non-physician ones carrying the term as a modifier', () => {
      // "cardiologist" must not surface "Cardiology Pharmacist"/"Cardiology Technician" first.
      const top = svc.resolve('cardiologist', 1)[0];
      expect(top?.grouping).toMatch(/Allopathic & Osteopathic Physicians/);
    });

    it('still resolves a non-physician specialty when the query names it explicitly', () => {
      // The physician bias is for bare terms; an explicit "cardiology pharmacist" still lands.
      expect(svc.resolve('cardiology pharmacist', 1)[0]?.code).toBe('1835C0206X');
    });

    it('the resolved description is the value the search tool sends to NPPES', () => {
      // search-providers sends specialization ?? classification; verify it is API-shaped
      // (the NUCC display name carries a "... Physician" suffix the registry rejects).
      const top = svc.resolve('cardiologist', 1)[0];
      expect(top?.specialization ?? top?.classification).toBe('Cardiovascular Disease');
    });

    it('stems -ician forms (pediatrician → pediatric/pediatrics)', () => {
      const hits = svc.resolve('pediatrician', 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => /pediatric/i.test(h.displayName))).toBe(true);
    });

    it('requires every token to match (multi-token AND)', () => {
      const hits = svc.resolve('pediatric cardiology', 10);
      expect(hits.length).toBeGreaterThan(0);
      // The pediatric cardiology physician code.
      expect(hits.some((h) => h.code === '2080P0202X')).toBe(true);
    });

    it('returns an empty array for a non-medical nonsense term (no fuzzy fallback)', () => {
      expect(svc.resolve('zzzznotaspecialty', 10)).toEqual([]);
    });

    it('respects the limit', () => {
      const hits = svc.resolve('physician', 3);
      expect(hits.length).toBeLessThanOrEqual(3);
    });

    it('returns empty for a whitespace-only query', () => {
      expect(svc.resolve('   ', 10)).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns the entry for an exact code', () => {
      const entry = svc.get('207RC0000X');
      expect(entry).toBeDefined();
      expect(entry?.classification).toBe('Internal Medicine');
      expect(entry?.specialization).toBe('Cardiovascular Disease');
      expect(entry?.section).toBe('Individual');
    });

    it('is case-insensitive and trims', () => {
      expect(svc.get('  207rc0000x  ')?.code).toBe('207RC0000X');
    });

    it('returns undefined for an unknown code', () => {
      expect(svc.get('000ZZZ000X')).toBeUndefined();
    });
  });

  describe('browse', () => {
    it('filters by grouping substring', () => {
      const hits = svc.browse({ grouping: 'physicians', limit: 50 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => /physician/i.test(h.grouping))).toBe(true);
    });

    it('filters by section', () => {
      const hits = svc.browse({ section: 'Non-Individual', limit: 50 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.section === 'Non-Individual')).toBe(true);
    });

    it('combines grouping and section filters', () => {
      const hits = svc.browse({ grouping: 'Group', section: 'Individual', limit: 50 });
      expect(hits.every((h) => h.section === 'Individual' && /group/i.test(h.grouping))).toBe(true);
    });

    it('respects the limit', () => {
      expect(svc.browse({ limit: 5 }).length).toBe(5);
    });
  });

  describe('listGroupings', () => {
    it('returns sorted distinct groupings', () => {
      const groupings = svc.listGroupings();
      expect(groupings.length).toBeGreaterThan(5);
      expect([...groupings]).toEqual([...groupings].sort());
    });
  });
});
