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

  describe('resolve — lay terms, noise words, and abbreviations (#1)', () => {
    it('strips generic noise words so "heart doctor" resolves to Cardiovascular Disease', () => {
      // "doctor" appears in no NUCC entry; stripped, "heart" reaches the general
      // cardiology entry via its alias rather than a heart-named sub-specialty.
      expect(svc.resolve('heart doctor', 1)[0]?.code).toBe('207RC0000X');
    });

    it('resolves lay terms/abbreviations to the right general physician entry', () => {
      expect(svc.resolve('eye doctor', 1)[0]?.code).toBe('207W00000X'); // Ophthalmology
      expect(svc.resolve('kidney doctor', 1)[0]?.code).toBe('207RN0300X'); // Nephrology
      expect(svc.resolve('obgyn', 1)[0]?.code).toBe('207V00000X'); // Obstetrics & Gynecology
    });

    it('resolves "cancer doctor" to a physician oncology entry (not a nurse/pharmacist)', () => {
      const top = svc.resolve('cancer doctor', 1)[0];
      expect(top?.grouping).toMatch(/Allopathic & Osteopathic Physicians/);
      expect(`${top?.classification} ${top?.specialization ?? ''}`).toMatch(/oncology/i);
    });

    it('resolves "ent" to Otolaryngology and never Gastroenterology (whole-word gating)', () => {
      // Bare "ent" used to substring-hit "gastroENTerology"; aliased tokens now match
      // as whole words, so the abbreviation reaches Otolaryngology and nothing else.
      const hits = svc.resolve('ent', 20);
      expect(hits[0]?.code).toBe('207Y00000X'); // Otolaryngology
      expect(
        hits.some((h) => /gastroenterology/i.test(`${h.classification} ${h.specialization ?? ''}`)),
      ).toBe(false);
    });

    it('does not break a real gastroenterology query (regression guard for the ent fix)', () => {
      expect(svc.resolve('gastroenterologist', 1)[0]?.code).toBe('207RG0100X');
    });

    it('a query of only stop-words still resolves rather than becoming empty', () => {
      expect(svc.resolve('physician', 3).length).toBeGreaterThan(0);
    });
  });

  describe('pagination via skip (#7)', () => {
    it('browse: skip returns the next contiguous page with no overlap or gap', () => {
      const all = svc.browse({ limit: 1000 });
      const page1 = svc.browse({ limit: 2, skip: 0 });
      const page2 = svc.browse({ limit: 2, skip: 2 });
      expect(page1.map((h) => h.code)).toEqual(all.slice(0, 2).map((h) => h.code));
      expect(page2.map((h) => h.code)).toEqual(all.slice(2, 4).map((h) => h.code));
      expect(page1.some((h) => page2.some((p) => p.code === h.code))).toBe(false);
    });

    it('browse: a full skip-walk of a >50-entry grouping reaches every entry exactly once', () => {
      const grouping = 'Allopathic & Osteopathic Physicians';
      const full = svc.browse({ grouping, limit: 100000 }).map((h) => h.code);
      expect(full.length).toBeGreaterThan(50);
      const walked: string[] = [];
      for (let skip = 0; ; skip += 50) {
        const page = svc.browse({ grouping, limit: 50, skip }).map((h) => h.code);
        if (page.length === 0) break;
        walked.push(...page);
      }
      expect(walked).toEqual(full);
      expect(new Set(walked).size).toBe(walked.length);
    });

    it('resolve: skip pages the ranked result set deterministically with no overlap', () => {
      const all = svc.resolve('physician', 1000);
      const page1 = svc.resolve('physician', 3, 0);
      const page2 = svc.resolve('physician', 3, 3);
      expect(page1.map((h) => h.code)).toEqual(all.slice(0, 3).map((h) => h.code));
      expect(page2.map((h) => h.code)).toEqual(all.slice(3, 6).map((h) => h.code));
      expect(page1.some((h) => page2.some((p) => p.code === h.code))).toBe(false);
    });

    it('resolve/browse: skip past the end returns an empty page (no throw)', () => {
      expect(svc.resolve('cardiologist', 10, 5000)).toEqual([]);
      expect(svc.browse({ limit: 10, skip: 5000 })).toEqual([]);
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
