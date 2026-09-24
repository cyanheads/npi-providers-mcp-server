/**
 * @fileoverview Tests for the NUCC taxonomy service — resolve (with stemming),
 * get-by-code, and hierarchy browse over the bundled in-memory index.
 * @module tests/services/taxonomy/taxonomy-service.test
 */

import { describe, expect, it } from 'vitest';
import { TAXONOMY_ENTRIES } from '@/services/taxonomy/taxonomy-data.js';
import {
  PREFERRED_ENTRIES,
  stopWordOnlyQuery,
  TaxonomyService,
} from '@/services/taxonomy/taxonomy-service.js';

const svc = new TaxonomyService();

describe('TaxonomyService', () => {
  it('loads the full bundled code set', () => {
    expect(svc.size).toBe(883);
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
      const hits = svc.resolve('nurse', 3);
      expect(hits.length).toBeLessThanOrEqual(3);
    });

    it('returns empty for a whitespace-only query', () => {
      expect(svc.resolve('   ', 10)).toEqual([]);
    });

    it('normalizes case and surrounding whitespace without changing the match set', () => {
      const canonical = svc.resolve('cardiovascular disease', 20).map((entry) => entry.code);
      const variant = svc.resolve('  CaRdIoVaScUlAr   DiSeAsE  ', 20).map((entry) => entry.code);
      expect(variant).toEqual(canonical);
    });

    it('returns multiple auditable candidates for an ambiguous specialty term', () => {
      const hits = svc.resolve('pain medicine', 20);
      expect(hits.length).toBeGreaterThan(3);
      expect(new Set(hits.map((entry) => entry.code)).size).toBe(hits.length);
      expect(hits.every((entry) => /pain medicine/i.test(entry.displayName))).toBe(true);
    });

    it('returns the several specialties matched by a partial medical term', () => {
      const hits = svc.resolve('medicine', 20);
      expect(hits.length).toBeGreaterThan(5);
      expect(hits.some((entry) => entry.code === '207R00000X')).toBe(true);
      expect(hits.some((entry) => entry.code === '207Q00000X')).toBe(true);
    });

    it('keeps the ranked order of the leading psychologist entries (characterization)', () => {
      expect(svc.resolve('psychologist', 8).map((entry) => entry.code)).toEqual([
        '103T00000X',
        '103G00000X',
        '103TF0000X',
        '103TH0004X',
        '103TS0200X',
        '103TC0700X',
        '103TF0200X',
        '103TC1900X',
      ]);
      expect(svc.resolve('clinical neuropsychologist', 20)[0]?.code).toBe('103G00000X');
    });

    it('excludes inactive taxonomy codes from plain-language resolution (#16)', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/16
      const hits = svc.resolve('graphics designer', 20);
      expect(hits.map((entry) => entry.code)).not.toContain('1744G0900X');
    });

    it('ranks representative general specialties above narrow variants (#10)', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/10
      expect(svc.resolve('oncologist', 1)[0]?.code).toBe('207RX0202X');
      expect(svc.resolve('endocrinologist', 1)[0]?.code).toBe('207RE0101X');
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

    it('a query of only stop-words names no specialty: no match, flagged for the browse hint (#31)', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/31 — replaces the old
      // fallback that matched the stop words' own stems ("physician" → Radiological Physics).
      expect(svc.resolve('physician', 3)).toEqual([]);
      expect(stopWordOnlyQuery('physician')).toBe('physician');
    });
  });

  describe('resolve — behavior the matching changes must keep (characterization)', () => {
    it.each([
      ['dermatologist', '207N00000X'],
      ['pediatrician', '208000000X'],
      ['psychiatrist', '2084P0800X'],
      ['nurse practitioner', '363L00000X'],
      ['chiropractor', '111N00000X'],
      ['podiatrist', '213E00000X'],
      ['optometrist', '152W00000X'],
      ['orthodontist', '1223X0400X'],
      ['physical therapist', '225100000X'],
      ['social worker', '104100000X'],
      ['midwife', '176B00000X'],
      ['gastroenterologist', '207RG0100X'],
      ['rheumatologist', '207RR0500X'],
      ['nephrologist', '207RN0300X'],
      ['anesthesiologist', '207L00000X'],
      ['ophthalmologist', '207W00000X'],
      ['otolaryngologist', '207Y00000X'],
      ['allergist', '207KA0200X'],
      ['plastic surgeon', '208200000X'],
      ['urologist', '208800000X'],
      ['emergency physician', '207P00000X'],
      ['family doctor', '207Q00000X'],
      ['internist', '207R00000X'],
      ['obstetrician', '207V00000X'],
      ['gynecologist', '207V00000X'],
      ['dietitian', '133V00000X'],
      ['audiologist', '231H00000X'],
    ])('"%s" keeps %s as its top hit', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('keeps specialties whose NUCC name is a compound of the queried term', () => {
      // A neuroradiologist is a radiologist, a cytopathologist a pathologist: these words
      // join a combining form to the specialty, so the term still matches mid-word.
      const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);
      expect(codes('radiologist')).toContain('2085N0700X'); // Neuroradiology
      expect(codes('pathologist')).toEqual(
        expect.arrayContaining([
          '207ZC0500X', // Cytopathology
          '207ZD0900X', // Dermatopathology (Pathology)
          '207ND0900X', // Dermatopathology (Dermatology)
          '207ZI0100X', // Immunopathology
          '207ZN0500X', // Neuropathology
        ]),
      );
      expect(codes('psychologist')).toContain('103G00000X'); // Clinical Neuropsychologist
      expect(codes('gynecologist')).toEqual(expect.arrayContaining(['207VF0040X', '2088F0040X']));
      expect(codes('physiology')).toEqual(
        expect.arrayContaining(['2084N0600X', '207RC0001X', '2251E1300X']),
      );
      expect(codes('therapy')).toContain('103TP2701X'); // Group Psychotherapy
      expect(codes('genetic')).toContain('207SC0300X'); // Clinical Cytogenetics
      expect(codes('musculoskeletal')).toContain('204D00000X'); // Neuromusculoskeletal Medicine
      expect(codes('facial')).toContain('1223S0112X'); // Oral and Maxillofacial Surgery
      expect(codes('vascular')).toContain('207RC0000X'); // Cardiovascular Disease
    });

    it('keeps the physician grouping first for "sports physician"', () => {
      const top = svc.resolve('sports physician', 1)[0];
      expect(top?.grouping).toBe('Allopathic & Osteopathic Physicians');
      expect(top?.code).not.toBe('111NS0005X'); // Sports Physician Chiropractor
    });
  });

  describe('resolve — lookup-table keys', () => {
    it('treats a term named like an Object.prototype key as an ordinary unmatched term', () => {
      expect(svc.resolve('constructor', 20)).toEqual([]);
      expect(svc.resolve('constructor doctor', 20)).toEqual([]);
      expect(svc.resolveWithInactive('constructor', 20)).toEqual({
        matches: [],
        inactiveMatches: [],
      });
    });
  });

  describe('resolve — tokens match at word starts (#20)', () => {
    const text = (e: { classification: string; specialization?: string; displayName: string }) =>
      `${e.classification} ${e.specialization ?? ''} ${e.displayName}`;

    it('resolves "dentist" to Dentist, not a word that merely contains "dent"', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/20
      const hits = svc.resolve('dentist', 1000);
      expect(hits[0]?.code).toBe('122300000X');
      expect(hits.map((e) => e.code)).not.toContain('202C00000X'); // Independent Medical Examiner
      expect(hits.filter((e) => /independent|student|residential/i.test(text(e)))).toEqual([]);
    });

    it('keeps the Otolaryngology compounds for "laryngologist"', () => {
      // Oto·laryngology and Oto·rhino·laryngology join combining forms to "laryngology".
      const hits = svc.resolve('laryngologist', 1000).map((e) => e.code);
      expect(hits[0]).toBe('207Y00000X');
      expect([...hits].sort()).toEqual(
        [
          '207Y00000X',
          '207YX0905X',
          '207YP0228X',
          '207YX0901X',
          '207YX0602X',
          '207YS0012X',
          '207YS0123X',
          '207YX0007X',
          '163WX0601X', // Otorhinolaryngology & Head-Neck Registered Nurse
        ].sort(),
      );
    });

    it('resolves "urologist" to Urology with no Neurology entry', () => {
      const hits = svc.resolve('urologist', 1000);
      expect(hits[0]?.code).toBe('208800000X');
      expect(hits.filter((e) => /neurolog/i.test(text(e))).map((e) => e.code)).toEqual([]);
    });
  });

  describe('resolve — a stop word that names the specialty (#21)', () => {
    it('resolves "physician assistant" to Physician Assistant first', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/21
      expect(svc.resolve('physician assistant', 1)[0]?.code).toBe('363A00000X');
    });

    it('reorders only: the match set is the one the query has without the stop word', () => {
      const codes = (query: string) =>
        svc
          .resolve(query, 1000)
          .map((e) => e.code)
          .sort();
      expect(codes('physician assistant')).toEqual(codes('assistant'));
      expect(codes('nurse specialist')).toEqual(codes('nurse'));
    });

    it('ranks the entry named with "specialist" first among non-physician matches', () => {
      expect(svc.resolve('nurse specialist', 1)[0]?.code).toBe('364S00000X');
    });
  });

  describe('resolve — terms NUCC spells or names differently (#22)', () => {
    it.each([
      ['orthopedist', '207X00000X'],
      ['orthopedic', '207X00000X'],
      ['orthopedic surgeon', '207X00000X'],
      ['neurosurgeon', '207T00000X'],
      ['cardiac surgeon', '208G00000X'],
      ['speech therapist', '235Z00000X'],
    ])('"%s" resolves to active %s first', (query, code) => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/22
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
      expect(svc.get(code)?.status).toBe('active');
    });

    it('resolves "primary care doctor" to Family Medicine, then Internal Medicine', () => {
      expect(
        svc
          .resolve('primary care doctor', 2)
          .map((e) => e.code)
          .sort(),
      ).toEqual(['207Q00000X', '207R00000X']);
      expect(svc.resolve('primary care physician', 2).map((e) => e.code)).toEqual([
        '207Q00000X',
        '207R00000X',
      ]);
    });

    it('keeps the entries those terms matched by their own spelling', () => {
      const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);
      expect(codes('orthopedist')).toEqual(
        expect.arrayContaining(['111NX0800X', '2251X0800X', '163WX0800X', '1223X0400X']),
      );
      expect(codes('primary care doctor')).toEqual(
        expect.arrayContaining(['261QP2300X', '363LP2300X']),
      );
    });

    it('leaves a bare term that shares a word with an alias phrase unchanged', () => {
      expect(svc.resolve('speech', 1000).map((e) => e.code)).not.toContain('208G00000X');
      expect(svc.resolve('therapist', 1000).map((e) => e.code)).not.toContain('235Z00000X');
    });
  });

  describe('resolve — preferred general entry for a bare specialist term (#10)', () => {
    const TABLE: readonly (readonly [string, string])[] = [
      ['oncologist', '207RX0202X'],
      ['oncology', '207RX0202X'],
      ['cancer doctor', '207RX0202X'],
      ['endocrinologist', '207RE0101X'],
      ['hematologist', '207RH0000X'],
      ['radiologist', '2085R0202X'],
      ['radiology', '2085R0202X'],
      ['pathologist', '207ZP0102X'],
      ['pathology', '207ZP0102X'],
      ['geriatrician', '207RG0300X'],
      ['pharmacist', '183500000X'],
    ];

    it.each(TABLE)('"%s" resolves to %s first', (query, code) => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/10
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('moves only the preferred entry: the match set and the rest of the order stay put', () => {
      // A repeated token matches exactly what the single token matches but is multi-token,
      // so it bypasses the table: its order is the ranking without the preferred entry.
      for (const [query, code] of TABLE) {
        const token = query.replace(/ doctor$/, '');
        const ranked = svc.resolve(query, 1000).map((e) => e.code);
        const unpreferred = svc.resolve(`${token} ${token}`, 1000).map((e) => e.code);
        expect([...ranked].sort()).toEqual([...unpreferred].sort());
        expect(ranked).toEqual([code, ...unpreferred.filter((c) => c !== code)]);
      }
    });

    it.each([
      ['surgical oncologist', '2086X0206X'],
      ['radiation oncologist', '2085R0001X'],
      ['pediatric endocrinologist', '2080P0205X'],
      ['reproductive endocrinologist', '207VE0102X'],
      ['clinical pharmacologist', '208U00000X'],
      ['forensic pathologist', '207ZF0201X'],
    ])('multi-token "%s" bypasses the table and keeps %s first', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('every preferred code is bundled and active', () => {
      const entries = Object.entries(PREFERRED_ENTRIES);
      expect(entries.length).toBeGreaterThanOrEqual(8);
      for (const [, code] of entries) {
        expect(svc.get(code)?.status).toBe('active');
      }
    });
  });

  describe('resolve — a bare "therapist" names the profession (#24)', () => {
    const text = (e: { classification: string; specialization?: string; displayName: string }) =>
      `${e.classification} ${e.specialization ?? ''} ${e.displayName}`;

    it('returns no physician-grouping code for "therapist"', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/24
      const hits = svc.resolve('therapist', 50);
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.filter((e) => e.grouping === 'Allopathic & Osteopathic Physicians').map((e) => e.code),
      ).toEqual([]);
    });

    it('matches only therapist professions, never a therapy or therapeutic label alone', () => {
      const hits = svc.resolve('therapist', 1000);
      expect(hits.filter((e) => !/therapist/i.test(text(e))).map((e) => e.code)).toEqual([]);
      expect(hits[0]?.displayName).toMatch(/therapist/i);
    });

    it.each([
      ['occupational therapist', '225X00000X'],
      ['respiratory therapist', '227800000X'],
      ['physical therapist', '225100000X'],
      ['speech therapist', '235Z00000X'],
      ['massage therapist', '225700000X'],
      ['radiation therapist', '2471R0002X'],
      ['psychotherapist', '103TP2701X'],
      ['kinesiotherapist', '226300000X'],
    ])('"%s" keeps %s as its top hit (characterization)', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('a qualified therapist query still reaches the matching therapy entries (characterization)', () => {
      const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);
      expect(codes('occupational therapist')).toContain('224Z00000X'); // Occupational Therapy Assistant
      expect(codes('physical therapist')).toEqual(
        expect.arrayContaining(['225200000X', '261QP2000X']), // PT Assistant, PT Clinic
      );
      expect(codes('occupational therapist')).toHaveLength(18);
      expect(codes('physical therapist')).toHaveLength(14);
    });
  });

  describe('resolve — pediatric variants rank after the general specialty (#25)', () => {
    const SPORTS = [
      '207QS0010X',
      '207RS0010X',
      '207PS0010X',
      '2084S0010X',
      '207XX0005X',
      '2083S0010X',
      '204C00000X',
      '2081S0010X',
    ];
    const SLEEP = ['207YS0012X', '207QS1201X', '207RS0012X', '2084S0012X'];

    it('keeps the sports and sleep medicine match sets (characterization)', () => {
      const sorted = (query: string) =>
        svc
          .resolve(query, 1000)
          .map((e) => e.code)
          .sort();
      expect(sorted('sports medicine')).toEqual([...SPORTS, '2080S0010X', '213ES0000X'].sort());
      expect(sorted('sleep medicine')).toEqual([...SLEEP, '2080S0012X'].sort());
    });

    it('leads with a non-pediatric code for sports medicine, sports physician, and sleep medicine', () => {
      // https://github.com/cyanheads/npi-providers-mcp-server/issues/25
      for (const query of ['sports medicine', 'sports physician', 'sleep medicine']) {
        expect(svc.resolve(query, 1)[0]?.code).not.toMatch(/^2080/);
      }
    });

    it('moves only the pediatric entry, to the end of its physician tier', () => {
      expect(svc.resolve('sports medicine', 1000).map((e) => e.code)).toEqual([
        ...SPORTS,
        '2080S0010X',
        '213ES0000X',
      ]);
      expect(svc.resolve('sleep medicine', 1000).map((e) => e.code)).toEqual([
        ...SLEEP,
        '2080S0012X',
      ]);
    });

    it('still leads with the pediatric code when the query names pediatrics (characterization)', () => {
      expect(svc.resolve('pediatric sports medicine', 1)[0]?.code).toBe('2080S0010X');
      expect(svc.resolve('pediatric sleep medicine', 1)[0]?.code).toBe('2080S0012X');
      expect(svc.resolve('pediatrician', 1)[0]?.code).toBe('208000000X');
    });
  });

  describe('resolve — paging stays contiguous under the #24/#25 changes (#7)', () => {
    it.each(['therapist', 'sports physician'])(
      'a skip-walk of "%s" reaches every match exactly once, in rank order',
      (query) => {
        const all = svc.resolve(query, 1000).map((e) => e.code);
        expect(all[0]).not.toBe(query === 'therapist' ? '2085R0203X' : '2080S0010X');
        const walked: string[] = [];
        for (let skip = 0; skip < all.length; skip += 4) {
          walked.push(...svc.resolve(query, 4, skip).map((e) => e.code));
        }
        expect(walked).toEqual(all);
        expect(new Set(walked).size).toBe(walked.length);
      },
    );
  });

  describe('resolve — paging stays contiguous under the new ranking signals (#7)', () => {
    it.each(['oncologist', 'physician assistant', 'primary care doctor', 'dentist'])(
      'a skip-walk of "%s" reaches every match exactly once, in rank order',
      (query) => {
        const all = svc.resolve(query, 1000).map((e) => e.code);
        expect(all.length).toBeGreaterThan(3);
        const walked: string[] = [];
        for (let skip = 0; skip < all.length; skip += 3) {
          const page = svc.resolve(query, 3, skip).map((e) => e.code);
          expect(page.length).toBe(Math.min(3, all.length - skip));
          walked.push(...page);
        }
        expect(walked).toEqual(all);
        expect(svc.resolve(query, 3, all.length)).toEqual([]);
      },
    );
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
      const all = svc.resolve('nurse', 1000);
      const page1 = svc.resolve('nurse', 3, 0);
      const page2 = svc.resolve('nurse', 3, 3);
      expect(page1.map((h) => h.code)).toEqual(all.slice(0, 3).map((h) => h.code));
      expect(page2.map((h) => h.code)).toEqual(all.slice(3, 6).map((h) => h.code));
      expect(page1.some((h) => page2.some((p) => p.code === h.code))).toBe(false);
    });

    it('browse: an unfiltered skip-walk reaches every bundled code exactly once (characterization)', () => {
      const walked: string[] = [];
      for (let skip = 0; ; skip += 50) {
        const page = svc.browse({ limit: 50, skip }).map((h) => h.code);
        if (page.length === 0) break;
        walked.push(...page);
      }
      expect(walked).toHaveLength(svc.size);
      expect(new Set(walked).size).toBe(svc.size);
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

  describe('NUCC Notes (#11)', () => {
    it('get returns the trimmed Notes cell, interior whitespace intact', () => {
      expect(svc.get('242T00000X')?.notes).toBe(
        'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
      );
    });

    it('carries Notes only for codes whose cell is non-empty', () => {
      expect(svc.get('207QA0505X')).toBeDefined();
      expect(svc.get('207QA0505X')).not.toHaveProperty('notes');
      const withNotes = TAXONOMY_ENTRIES.filter((e) => e.notes !== undefined);
      expect(withNotes.length).toBeGreaterThan(0);
      expect(withNotes.every((e) => e.notes === e.notes?.trim() && e.notes !== '')).toBe(true);
    });
  });

  describe('inactive codes (#16)', () => {
    const inactive = TAXONOMY_ENTRIES.filter((entry) => entry.status === 'inactive');
    const activeOnly = new TaxonomyService(
      TAXONOMY_ENTRIES.filter((entry) => entry.status === 'active'),
    );

    it('bundles every NUCC code marked inactive, flagged', () => {
      expect(inactive).toHaveLength(28);
      expect(TAXONOMY_ENTRIES.every((e) => e.status === 'active' || e.status === 'inactive')).toBe(
        true,
      );
    });

    it('get keeps inactive codes, with the replacement NUCC names', () => {
      expect(svc.get('103GC0700X')).toMatchObject({
        status: 'inactive',
        replacedBy: '103G00000X',
      });
      expect(svc.get('1744G0900X')).toMatchObject({ status: 'inactive' });
      expect(svc.get('1744G0900X')).not.toHaveProperty('replacedBy');
      expect(svc.get('207RC0000X')).toMatchObject({ status: 'active' });
    });

    it('names exactly the five replacements NUCC records, each an active code', () => {
      const replacements = Object.fromEntries(
        inactive.filter((e) => e.replacedBy).map((e) => [e.code, e.replacedBy]),
      );
      expect(replacements).toEqual({
        '103GC0700X': '103G00000X',
        '1835G0000X': '183500000X',
        '213EG0000X': '213E00000X',
        '287300000X': '282J00000X',
        '317400000X': '282J00000X',
      });
      for (const target of Object.values(replacements)) {
        expect(svc.get(target as string)?.status).toBe('active');
      }
      expect(TAXONOMY_ENTRIES.some((e) => e.status === 'active' && e.replacedBy)).toBe(false);
    });

    it('keeps every #10 preferred general-specialty code active', () => {
      for (const code of [
        '207RX0202X',
        '207RE0101X',
        '207RH0000X',
        '2085R0202X',
        '207ZP0102X',
        '207RG0300X',
        '183500000X',
      ]) {
        expect(svc.get(code)?.status).toBe('active');
      }
    });

    it('resolve drops the inactive twin of an active code', () => {
      expect(svc.resolve('clinical neuropsychologist', 20).map((e) => e.code)).toEqual([
        '103G00000X',
      ]);
    });

    it('no resolve result carries an inactive code, whatever the query names', () => {
      expect(inactive.length).toBeGreaterThan(0);
      for (const entry of inactive) {
        for (const query of [entry.displayName, entry.specialization ?? entry.classification]) {
          const hits = svc.resolve(query, 1000);
          expect(hits.filter((h) => h.status !== 'active').map((h) => h.code)).toEqual([]);
        }
      }
    });

    it('filters before ranking: the active ranking matches an index built without inactive codes', () => {
      for (const query of [
        'psychologist',
        'podiatrist',
        'psychotherapy',
        'technologist',
        'pharmacist',
      ]) {
        const hits = svc.resolve(query, 1000);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.map((e) => e.code)).toEqual(activeOnly.resolve(query, 1000).map((e) => e.code));
      }
    });

    it('filters before the skip/limit slice, so pages stay contiguous and full (#7)', () => {
      const all = svc.resolve('psychologist', 1000);
      const walked: string[] = [];
      for (let skip = 0; skip < all.length; skip += 3) {
        const page = svc.resolve('psychologist', 3, skip);
        expect(page.length).toBe(Math.min(3, all.length - skip));
        walked.push(...page.map((e) => e.code));
      }
      expect(walked).toEqual(all.map((e) => e.code));
      expect(walked).not.toContain('103TE1000X');
    });

    it('reports the inactive entries a query matched alongside the active page', () => {
      const onlyInactive = svc.resolveWithInactive('graphics designer', 20);
      expect(onlyInactive.matches).toEqual([]);
      expect(onlyInactive.inactiveMatches.map((e) => e.code)).toEqual(['1744G0900X']);

      const mixed = svc.resolveWithInactive('clinical neuropsychologist', 20);
      expect(mixed.matches.map((e) => e.code)).toEqual(['103G00000X']);
      expect(mixed.inactiveMatches.map((e) => [e.code, e.replacedBy])).toEqual([
        ['103GC0700X', '103G00000X'],
      ]);

      const none = svc.resolveWithInactive('zzzznotaspecialty', 20);
      expect(none).toEqual({ matches: [], inactiveMatches: [] });
    });

    it('browse keeps inactive codes in code order, flagged', () => {
      const page = svc.browse({ limit: 20 });
      expect(page.find((e) => e.code === '103GC0700X')).toMatchObject({
        status: 'inactive',
        replacedBy: '103G00000X',
      });
      expect(page.find((e) => e.code === '103TE1000X')).toMatchObject({ status: 'inactive' });
    });
  });

  describe('resolve — credential abbreviations (#27)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/27
    const TABLE: readonly (readonly [string, string])[] = [
      ['rn', '163W00000X'], // Registered Nurse
      ['np', '363L00000X'], // Nurse Practitioner
      ['pa', '363A00000X'], // Physician Assistant
      ['crna', '367500000X'], // Certified Registered Nurse Anesthetist
      ['lpn', '164W00000X'], // Licensed Practical Nurse
      ['lvn', '164X00000X'], // Licensed Vocational Nurse
      ['emt', '146N00000X'], // Basic Emergency Medical Technician
      ['er', '207P00000X'], // Emergency Medicine Physician
      ['er doctor', '207P00000X'],
      ['RN', '163W00000X'],
    ];

    it.each(TABLE)('"%s" resolves to %s first', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('every target is an active bundled code', () => {
      for (const [, code] of TABLE) expect(svc.get(code)?.status).toBe('active');
    });

    it('"rn" never leads with the Non-RN lactation consultant', () => {
      expect(svc.resolve('rn', 1)[0]?.code).not.toBe('174N00000X');
    });

    it('"pa" returns no pathology or pain-medicine code', () => {
      const hits = svc.resolve('pa', 1000);
      expect(hits.length).toBeGreaterThan(0);
      expect(
        hits.filter((e) => /patholog|pain/i.test(`${e.classification} ${e.specialization ?? ''}`)),
      ).toEqual([]);
    });

    it('"er" and "er doctor" never reach the Ergonomics therapist entries', () => {
      for (const query of ['er', 'er doctor']) {
        const codes = svc.resolve(query, 1000).map((e) => e.code);
        expect(codes).not.toContain('2251E1200X');
        expect(codes).not.toContain('225XE1200X');
      }
    });

    it('"emt" reaches every EMT level, Basic first', () => {
      const codes = svc.resolve('emt', 1000).map((e) => e.code);
      expect(codes[0]).toBe('146N00000X');
      expect(codes).toEqual(expect.arrayContaining(['146M00000X', '146L00000X']));
    });

    it.each([
      ['nurse practitioner', '363L00000X'],
      ['registered nurse', '163W00000X'],
      ['physician assistant', '363A00000X'],
      ['emergency medicine', '207P00000X'],
      ['licensed practical nurse', '164W00000X'],
      ['paramedic', '146E00000X'],
      ['pain', '208VP0000X'],
    ])('"%s" keeps %s first (characterization)', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });
  });

  describe('resolve — dotted abbreviations and one-letter tokens (#29)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/29
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it.each([
      ['pa', 3, ['363A00000X', '363AM0700X', '363AS0400X']],
      ['rn', 58, ['163W00000X', '163WR0006X', '174N00000X', '163WF0300X', '163WS0200X']],
      ['np', 18, ['363L00000X', '363LF0000X', '363LS0200X', '363LN0000X', '363LP1700X']],
      ['crna', 1, ['367500000X']],
      ['x ray', 1, ['335V00000X']],
      ['portable x ray', 1, ['335V00000X']],
      ['ent', 8, ['207Y00000X', '207YX0905X', '207YP0228X', '207YX0901X', '207YX0602X']],
      ['ob gyn', 12, ['207V00000X', '207VG0400X', '207VX0000X', '207VX0201X', '207VC0300X']],
      ['dentist', 22, ['122300000X', '122400000X', '124Q00000X', '125J00000X', '126800000X']],
      ['clinical genetics', 4, ['207SC0300X', '207SG0201X', '207SG0203X', '207SG0202X']],
      ['legal medicine', 2, ['209800000X', '173000000X']],
    ] as const)(
      '"%s" keeps its %i matches and leading order (characterization)',
      (query, count, lead) => {
        const hits = codes(query);
        expect(hits).toHaveLength(count);
        expect(hits.slice(0, lead.length)).toEqual(lead);
      },
    );

    it.each([
      ['P.A.', 'pa'],
      ['p.a', 'pa'],
      ['R.N.', 'rn'],
      ['N.P.', 'np'],
      ['C.R.N.A.', 'crna'],
      ['L.P.N.', 'lpn'],
      ['E.M.T.', 'emt'],
      ['E.R. doctor', 'er doctor'],
    ])('"%s" resolves exactly as "%s"', (dotted, plain) => {
      expect(codes(plain).length).toBeGreaterThan(0);
      expect(codes(dotted)).toEqual(codes(plain));
    });

    it.each([
      ['M.D.', 'md'],
      ['D.O.', 'do'],
    ])('"%s" resolves as the stop word "%s", never through its single letters', (dotted, plain) => {
      expect(codes(dotted)).toEqual(codes(plain));
      expect(codes('M.D.')).toEqual([]);
    });

    it.each(['a', 'p a', 'r n', 'q'])('the one-letter query "%s" matches nothing', (query) => {
      expect(codes(query)).toEqual([]);
    });

    it('a one-letter query matches only entries carrying that letter as a whole word', () => {
      const hits = svc.resolve('d', 1000);
      expect(hits.map((e) => e.code).sort()).toEqual(
        ['170100000X', '204E00000X', '207SG0201X', '207SG0205X', '209800000X'].sort(),
      );
    });
  });

  describe('resolve — a query of only stop words names no specialty (#31)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/31
    it.each([
      ['physician assistant', 22, '363A00000X'],
      ['heart doctor', 8, '207RC0000X'],
      ['nurse specialist', 112, '364S00000X'],
      ['sports physician', 15, '207QS0010X'],
      ['family doctor', 19, '207Q00000X'],
      ['primary care physician', 44, '207Q00000X'],
      ['nurse', 112, '376K00000X'],
    ] as const)('"%s" keeps its %i matches, %s first (characterization)', (query, count, top) => {
      const hits = svc.resolve(query, 1000);
      expect(hits).toHaveLength(count);
      expect(hits[0]?.code).toBe(top);
    });

    it.each([
      'physician assistant',
      'heart doctor',
      'nurse specialist',
      'sports physician',
      'family doctor',
      'nurse',
    ])('"%s" carries a non-stop word, so it is not a stop-word-only query', (query) => {
      expect(stopWordOnlyQuery(query)).toBeUndefined();
    });

    it.each([
      ['do', 'physician'],
      ['D.O.', 'physician'],
      ['md', 'physician'],
      ['M.D.', 'physician'],
      ['physician', 'physician'],
      ['Doctor', 'physician'],
      ['physician doctor', 'physician'],
      ['specialist', 'other'],
      ['provider', 'other'],
      ['provider specialist', 'other'],
    ] as const)('"%s" matches nothing and is a stop-word-only query (%s)', (query, kind) => {
      expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
      expect(stopWordOnlyQuery(query)).toBe(kind);
    });

    it('a blank query is not a stop-word-only query', () => {
      expect(stopWordOnlyQuery('   ')).toBeUndefined();
    });
  });

  describe('resolve — plural stop words (#32)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/32
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it.each([
      ['eye doctor', 10, '207W00000X'],
      ['kidney doctor', 7, '207RN0300X'],
    ] as const)('"%s" keeps its %i matches, %s first (characterization)', (query, count, top) => {
      const hits = codes(query);
      expect(hits).toHaveLength(count);
      expect(hits[0]).toBe(top);
    });

    it.each([
      ['heart doctors', 'heart doctor'],
      ['eye doctors', 'eye doctor'],
      ['kidney doctors', 'kidney doctor'],
      ['family doctors', 'family doctor'],
      ['sports physicians', 'sports physician'],
      ['primary care physicians', 'primary care physician'],
      ['nurse specialists', 'nurse specialist'],
      ['health care providers', 'health care provider'],
    ])('"%s" resolves exactly as "%s"', (plural, singular) => {
      expect(codes(singular).length).toBeGreaterThan(0);
      expect(codes(plural)).toEqual(codes(singular));
    });

    it.each([
      ['physicians', 'physician'],
      ['doctors', 'physician'],
      ['Doctors', 'physician'],
      ['MDs', 'physician'],
      ['D.O.s', 'physician'],
      ['physicians doctors', 'physician'],
      ['specialists', 'other'],
      ['providers', 'other'],
      ['providers specialists', 'other'],
    ] as const)('"%s" matches nothing and is a stop-word-only query (%s)', (query, kind) => {
      expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
      expect(stopWordOnlyQuery(query)).toBe(kind);
    });

    it.each(['heart doctors', 'sports physicians', 'nurse specialists'])(
      '"%s" carries a non-stop word, so it is not a stop-word-only query',
      (query) => {
        expect(stopWordOnlyQuery(query)).toBeUndefined();
      },
    );
  });
});
