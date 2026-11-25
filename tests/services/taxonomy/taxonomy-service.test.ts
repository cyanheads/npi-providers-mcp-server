/**
 * @fileoverview Tests for the NUCC taxonomy service — resolve (with stemming),
 * get-by-code, and hierarchy browse over the bundled in-memory index.
 * @module tests/services/taxonomy/taxonomy-service.test
 */

import { describe, expect, it } from 'vitest';
import { TAXONOMY_ENTRIES } from '@/services/taxonomy/taxonomy-data.js';
import {
  type BrowseFilters,
  PREFERRED_ENTRIES,
  resolvedCodeSet,
  specialtyCandidates,
  stopWordOnlyQuery,
  TaxonomyService,
  taxonomyDescriptionOf,
  taxonomyNamesOf,
} from '@/services/taxonomy/taxonomy-service.js';
import type { TaxonomyEntry } from '@/services/taxonomy/types.js';

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

  describe('resolve — a qualified "therapy" names the therapist profession (#50)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/50
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it('"physical therapy" leads with Physical Therapist, the assistant and clinic still matched', () => {
      const hits = codes('physical therapy');
      expect(hits[0]).toBe('225100000X');
      expect(hits).toEqual(expect.arrayContaining(['225200000X', '261QP2000X']));
    });

    it('"occupational therapy" leads with Occupational Therapist, the assistant still matched', () => {
      const hits = codes('occupational therapy');
      expect(hits[0]).toBe('225X00000X');
      expect(hits).toContain('224Z00000X');
    });

    it.each([
      ['respiratory therapy', '227800000X'],
      ['massage therapy', '225700000X'],
      ['music therapy', '225A00000X'],
      ['art therapy', '221700000X'],
      ['recreational therapy', '225800000X'],
      ['recreational therapist', '225800000X'],
      ['recreation therapy', '225800000X'],
      ['drama therapy', '101200000X'],
      ['dance therapy', '225600000X'],
      ['poetry therapy', '102X00000X'],
      ['marriage and family therapy', '106H00000X'],
      ['hand therapy', '2251H1200X'],
      ['feeding therapy', '225XF0002X'],
    ])('"%s" resolves to %s first', (query, code) => {
      expect(codes(query)[0]).toBe(code);
    });

    it.each([
      ['physical therapy clinic', '261QP2000X'],
      ['therapy clinic', '261QI0500X'],
      ['infusion therapy', '261QI0500X'],
    ])('the facility "%s" names keeps the lead: %s', (query, code) => {
      // "Therapist" matches as the word "therapy" itself, never as an alias that would outrank it.
      expect(codes(query)[0]).toBe(code);
    });

    it('a bare "therapy" keeps its 16 matches led by 207UN0902X, stop words aside (characterization)', () => {
      const hits = codes('therapy');
      expect(hits).toHaveLength(16);
      expect(hits[0]).toBe('207UN0902X');
      expect(codes('therapy doctor')).toEqual(hits);
    });

    it.each([
      ['speech therapy', '235Z00000X'],
      ['radiation therapy', '2471R0002X'],
    ])('"%s" keeps %s first (characterization)', (query, code) => {
      expect(codes(query)[0]).toBe(code);
    });

    it.each(['radiology therapy', 'therapy radiology'])(
      '"%s" resolves to 2471R0002X alone: the word form "therap" never reaches Therapeutic Radiology',
      (query) => {
        // Therapeutic (2085R0203X) is the one bundled word besides Therapy and Therapist starting "therap".
        expect(codes(query)).toEqual(['2471R0002X']);
      },
    );

    it.each(['physical therapy', 'EMS', 'DMD'])(
      'a skip-walk of "%s" reaches every match exactly once, in rank order (#7)',
      (query) => {
        const all = codes(query);
        expect(all.length).toBeGreaterThan(10);
        const walked: string[] = [];
        for (let skip = 0; skip < all.length; skip += 4) {
          walked.push(...svc.resolve(query, 4, skip).map((e) => e.code));
        }
        expect(walked).toEqual(all);
        expect(svc.resolve(query, 4, all.length)).toEqual([]);
      },
    );
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

  describe('listGroupings and listClassifications (#47)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/47
    const sum = (rows: readonly { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);
    const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name);

    it('lists every grouping once, sorted by name, counting all 883 entries', () => {
      const groupings = svc.listGroupings();
      expect(groupings).toHaveLength(29);
      expect(sum(groupings)).toBe(883);
      expect(new Set(names(groupings)).size).toBe(29);
      expect(names(groupings)).toEqual([...names(groupings)].sort((a, b) => a.localeCompare(b)));
    });

    it('a grouping filter reaching one grouping lists it and its 37 classifications', () => {
      expect(svc.listGroupings({ grouping: 'physicians' })).toEqual([
        { name: 'Allopathic & Osteopathic Physicians', count: 238 },
      ]);
      const classifications = svc.listClassifications({ grouping: 'physicians' });
      expect(classifications).toHaveLength(37);
      expect(sum(classifications)).toBe(238);
      expect(classifications).toContainEqual({ name: 'Internal Medicine', count: 31 });
      expect(names(classifications)).toEqual(
        [...names(classifications)].sort((a, b) => a.localeCompare(b)),
      );
    });

    it('a grouping substring reaching two groupings lists both', () => {
      expect(names(svc.listGroupings({ grouping: 'physician' }))).toEqual([
        'Allopathic & Osteopathic Physicians',
        'Physician Assistants & Advanced Practice Nursing Providers',
      ]);
    });

    it('counts under the section filter, inactive codes included', () => {
      const groupings = svc.listGroupings({ section: 'Non-Individual' });
      expect(groupings).toHaveLength(12);
      expect(sum(groupings)).toBe(185);
      expect(groupings).toContainEqual({ name: 'Other Service Providers', count: 2 });
      const technologists = 'Technologists, Technicians & Other Technical Service Providers';
      expect(
        TAXONOMY_ENTRIES.filter((e) => e.grouping === technologists && e.status === 'inactive'),
      ).toHaveLength(14);
      expect(svc.listGroupings()).toContainEqual({ name: technologists, count: 65 });
    });

    it('lists nothing when the filters reach no entry', () => {
      expect(svc.listGroupings({ grouping: 'zzzznosuchgrouping' })).toEqual([]);
      expect(svc.listClassifications({ grouping: 'zzzznosuchgrouping' })).toEqual([]);
    });

    it.each([
      [{}],
      [{ section: 'Non-Individual' as const }],
      [{ section: 'Individual' as const, grouping: 'providers' }],
    ])('every grouping row counts what browse pages under %j', (filters) => {
      for (const row of svc.listGroupings(filters)) {
        const entries = svc.browse({ ...filters, grouping: row.name, limit: 1000 });
        expect(entries).toHaveLength(row.count);
        expect(entries.every((e) => e.grouping === row.name)).toBe(true);
      }
    });

    it.each(['physicians', 'Nursing Service Providers', 'Hospitals'])(
      'every classification row of grouping "%s" counts what browse pages for that name',
      (grouping) => {
        const rows = svc.listClassifications({ grouping });
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          const entries = svc.browse({ grouping, classification: row.name, limit: 1000 });
          expect(entries).toHaveLength(row.count);
          expect(entries.every((e) => e.classification === row.name)).toBe(true);
        }
      },
    );
  });

  describe('browse — exact classification filter (#47)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/47
    const codes = (opts: Parameters<typeof svc.browse>[0]) => svc.browse(opts).map((e) => e.code);

    it.each([
      ['Urology', 3],
      ['surgery', 10],
      ['Internal Medicine', 31],
      ['Legal Medicine', 2],
    ] as const)('"%s" returns only its %i codes, matched case-insensitively', (name, count) => {
      const entries = svc.browse({ classification: name, limit: 1000 });
      expect(entries).toHaveLength(count);
      expect(entries.every((e) => e.classification.toLowerCase() === name.toLowerCase())).toBe(
        true,
      );
    });

    it('"Urology" never pulls in Psychiatry & Neurology', () => {
      const entries = svc.browse({ classification: 'Urology', limit: 1000 });
      expect(entries.filter((e) => /neurology/i.test(e.classification))).toEqual([]);
    });

    it('"Legal Medicine" spans two groupings unless a grouping narrows it', () => {
      const entries = svc.browse({ classification: 'Legal Medicine', limit: 1000 });
      expect(new Set(entries.map((e) => e.grouping)).size).toBe(2);
      expect(
        codes({ classification: 'Legal Medicine', grouping: 'physicians', limit: 1000 }),
      ).toEqual(['209800000X']);
    });

    it('an unknown classification returns an empty page', () => {
      expect(svc.browse({ classification: 'Uro', limit: 1000 })).toEqual([]);
      expect(svc.browse({ classification: 'zzzznosuchclass', limit: 1000 })).toEqual([]);
    });

    it('combines with section and pages contiguously by skip (#7)', () => {
      const all = codes({ classification: 'Internal Medicine', limit: 1000 });
      expect(all).toHaveLength(31);
      expect(all).toEqual([...all].sort((a, b) => a.localeCompare(b)));
      const walked: string[] = [];
      for (let skip = 0; skip < 40; skip += 10) {
        walked.push(...codes({ classification: 'Internal Medicine', limit: 10, skip }));
      }
      expect(walked).toEqual(all);
      expect(
        codes({ classification: 'Internal Medicine', section: 'Non-Individual', limit: 1000 }),
      ).toEqual([]);
    });

    it('every NUCC classification name returns exactly its own entries', () => {
      const byName = new Map<string, string[]>();
      for (const e of TAXONOMY_ENTRIES) {
        byName.set(e.classification, [...(byName.get(e.classification) ?? []), e.code]);
      }
      expect(byName.size).toBe(245);
      for (const [name, expected] of byName) {
        expect(codes({ classification: name, limit: 1000 })).toEqual(
          [...expected].sort((a, b) => a.localeCompare(b)),
        );
      }
    });
  });

  describe('browse — "and" compares like "&" in grouping and classification (#47)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/47
    const codes = (filters: BrowseFilters) =>
      svc.browse({ ...filters, limit: 1000 }).map((e) => e.code);
    /** The name with "&" spelled "and", or a standalone "and" spelled "&". */
    const swap = (name: string) =>
      name.includes('&') ? name.replaceAll('&', 'and') : name.replace(/\band\b/g, '&');

    it('reaches the physician grouping spelled with "and"', () => {
      expect(codes({ grouping: 'Allopathic and Osteopathic Physicians' })).toHaveLength(238);
      expect(codes({ grouping: 'Allopathic and Osteopathic Physicians' })).toEqual(
        codes({ grouping: 'Allopathic & Osteopathic Physicians' }),
      );
    });

    it('reaches a grouping NUCC spells with "and" when the filter says "&"', () => {
      const name = 'Speech, Language and Hearing Service Providers';
      expect(codes({ grouping: name }).length).toBeGreaterThan(0);
      expect(codes({ grouping: 'Speech, Language & Hearing' })).toEqual(codes({ grouping: name }));
    });

    it('every grouping and classification name spelled the other way returns the same entries', () => {
      const groupings = new Set(TAXONOMY_ENTRIES.map((e) => e.grouping));
      const classifications = new Set(TAXONOMY_ENTRIES.map((e) => e.classification));
      const swapped = [...groupings, ...classifications].filter((n) => swap(n) !== n);
      expect(swapped.length).toBeGreaterThanOrEqual(20);
      for (const name of groupings) {
        expect(codes({ grouping: name })).toEqual(
          TAXONOMY_ENTRIES.filter((e) => e.grouping === name)
            .map((e) => e.code)
            .sort((a, b) => a.localeCompare(b)),
        );
        expect(codes({ grouping: swap(name) })).toEqual(codes({ grouping: name }));
      }
      for (const name of classifications) {
        expect(codes({ classification: swap(name) })).toEqual(codes({ classification: name }));
      }
    });

    /** Codes of the named groupings, sorted — read from the bundled data, not from browse. */
    const groupingCodes = (...names: string[]) =>
      TAXONOMY_ENTRIES.filter((e) => names.includes(e.grouping))
        .map((e) => e.code)
        .sort((a, b) => a.localeCompare(b));

    it.each(['nd hearing', 'language an', 'Language and Hearing'])(
      'a grouping filter cutting through "and" keeps its plain substring match: "%s" (characterization)',
      (filter) => {
        expect(codes({ grouping: filter })).toEqual(
          groupingCodes('Speech, Language and Hearing Service Providers'),
        );
      },
    );

    /**
     * The groupings whose name contains the filter once both are lower-cased with every
     * non-alphanumeric run read as one space: the plain substring rule, read from the bundled data.
     */
    const substringGroupings = (filter: string) => {
      const plain = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      return [...new Set(TAXONOMY_ENTRIES.map((e) => e.grouping))].filter((g) =>
        plain(g).includes(plain(filter)),
      );
    };

    it.each([
      ['e and', 108],
      ['and H', 9],
      [' and R', 82],
      ['ge and', 9],
      ['e and R', 82],
      ['e R', 13],
    ] as const)(
      'a word fragment beside "and" matches only its plain substring: "%s" (%i entries)',
      (filter, count) => {
        const hits = codes({ grouping: filter });
        expect(hits).toEqual(groupingCodes(...substringGroupings(filter)));
        expect(hits).toHaveLength(count);
      },
    );

    it.each(['and', 'AND'])(
      'a bare "%s" grouping keeps its substring match, never every grouping (characterization)',
      (filter) => {
        const hits = codes({ grouping: filter });
        expect(hits).toEqual(
          groupingCodes(
            'Eye and Vision Services Providers',
            'Respiratory, Developmental, Rehabilitative and Restorative Service Providers',
            'Speech, Language and Hearing Service Providers',
          ),
        );
        expect(hits).toHaveLength(108);
      },
    );

    it.each(['&', 'and', 'AND', ' and & and '])(
      'a classification that folds to nothing matches nothing: "%s"',
      (filter) => {
        expect(codes({ classification: filter })).toEqual([]);
        expect(svc.listGroupings({ classification: filter })).toEqual([]);
      },
    );
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
      expect(withNotes.every((e) => e.notes !== '')).toBe(true);
      expect(withNotes.every((e) => !/<br\/>|<\/?ul>|<li>/.test(e.notes ?? ''))).toBe(true);
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
      // #53: Clinical Genetics (M.D.) leads once its "(M.D.)" indexes as one word.
      ['clinical genetics', 4, ['207SG0201X', '207SC0300X', '207SG0203X', '207SG0202X']],
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
      // #53: "(M.D.)", "(D.M.D.)", and "(M.D./D.O.)" index as joined words, leaving Ph.D.'s "d".
      const hits = svc.resolve('d', 1000);
      expect(hits.map((e) => e.code).sort()).toEqual(['170100000X', '207SG0205X']);
    });
  });

  describe('resolve — two-letter tokens match whole words (#49)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/49
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);
    const text = (code: string) => {
      const e = svc.get(code);
      return `${e?.classification} ${e?.specialization ?? ''} ${e?.displayName}`;
    };

    it.each(['im', 'IM', 'ma', 'ed', 'dr', 'st', 'IM doctor', 'ED doctor'])(
      '"%s" matches nothing rather than every word it starts',
      (query) => {
        expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
      },
    );

    // 0.5.1 reached these through a word start; the `mr` and `gy` rows keep each answer.
    const MRI = ['207RM1200X', '261QM1200X'];
    const GYNECOLOGY = [
      '207V00000X',
      '207VG0400X',
      '207VX0201X',
      '2088F0040X',
      '207VF0040X',
      '207VX0000X',
      '207VC0300X',
      '207VM0101X',
      '207VE0102X',
      '207VB0002X',
      '207VC0200X',
      '207VH0002X',
      '363LX0001X',
    ];
    const OB_GYNECOLOGY = [
      '207V00000X',
      '207VG0400X',
      '207VX0000X',
      '207VX0201X',
      '207VC0300X',
      '207VM0101X',
      '207VE0102X',
      '207VB0002X',
      '207VC0200X',
      '207VH0002X',
      '207VF0040X',
      '363LX0001X',
    ];
    it.each([
      ['mr', MRI],
      ['MR', MRI],
      ['M.R.', MRI],
      ['MR imaging', MRI],
      ['mr clinic', ['261QM1200X']],
      ['gy', GYNECOLOGY],
      ['GY', GYNECOLOGY],
      ['ob gy', OB_GYNECOLOGY],
      ['OB/GY', OB_GYNECOLOGY],
      ['gy onc', ['207VX0201X']],
    ])('"%s" resolves as it did before two-letter tokens went whole-word', (query, expected) => {
      expect(codes(query)).toEqual(expected);
    });

    it.each(['ob', 'OB', 'O.B.', 'ob doctor'])(
      '"%s" leads with Obstetrics & Gynecology and reaches only Obstetrics labels',
      (query) => {
        const hits = codes(query);
        expect(hits[0]).toBe('207V00000X');
        expect(hits).not.toContain('207QB0002X'); // Obesity Medicine (Family Medicine)
        expect(hits.filter((code) => !/obstetric/i.test(text(code)))).toEqual([]);
      },
    );

    it.each(['em', 'EMS', 'E.M.S.'])('"%s" leads with Emergency Medicine', (query) => {
      expect(codes(query)[0]).toBe('207P00000X');
    });

    it('"EMS" reaches every Emergency label, the EMT levels included, and no other word', () => {
      const hits = codes('EMS');
      expect(hits).toEqual(
        expect.arrayContaining(['146N00000X', '146M00000X', '146L00000X', '207PE0004X']),
      );
      expect(hits).toEqual(codes('emergency'));
      expect(hits).toHaveLength(20);
      expect(hits).not.toContain('322D00000X'); // Emotionally Disturbed Childrens' Residential…
    });

    it('"at" resolves to Athletic Trainer alone', () => {
      expect(codes('at')).toEqual(['2255A2300X']);
    });

    it('labels keep their own two-letter words: "va" and "Ph.D." reach only the entries that say them', () => {
      expect(codes('va')).toEqual(['261QV0200X', '332100000X']);
      expect([...codes('Ph.D.')].sort()).toEqual(['170100000X', '207SG0205X']);
    });

    it.each([
      ['pa', 3, '363A00000X', 'P.A.'],
      ['rn', 58, '163W00000X', 'R.N.'],
      ['np', 18, '363L00000X', 'N.P.'],
      ['pt', 13, '225100000X', 'P.T.'],
      ['ot', 18, '225X00000X', 'O.T.'],
      ['gi', 3, '207RG0100X', 'G.I.'],
      ['id', 3, '207RI0200X', 'I.D.'],
      ['gp', 3, '208D00000X', 'G.P.'],
      ['er', 9, '207P00000X', 'E.R.'],
    ] as const)(
      'aliased "%s" keeps its %i matches led by %s, and "%s" resolves the same (characterization)',
      (key, count, top, dotted) => {
        const hits = codes(key);
        expect(hits).toHaveLength(count);
        expect(hits[0]).toBe(top);
        expect(codes(dotted)).toEqual(hits);
      },
    );
  });

  describe('resolve — dotted credentials in NUCC labels (#53)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/53
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it.each([
      'Clinical Genetics (M.D.) Physician',
      'Clinical Genetics (M.D.)',
      'Clinical Genetics (MD)',
      'clinical genetics md',
    ])('"%s" leads with Clinical Genetics (M.D.) and keeps its 4 matches', (query) => {
      const hits = codes(query);
      expect(hits[0]).toBe('207SG0201X');
      expect([...hits].sort()).toEqual(['207SC0300X', '207SG0201X', '207SG0202X', '207SG0203X']);
    });

    it('"Oral & Maxillofacial Surgery (D.M.D.)" resolves to its own entry first', () => {
      expect(codes('Oral & Maxillofacial Surgery (D.M.D.)')[0]).toBe('204E00000X');
    });

    it('every active display name with dotted single letters (M.D., D.M.D., U.S.) resolves to its own entry first', () => {
      const dotted = TAXONOMY_ENTRIES.filter(
        (e) => e.status === 'active' && /\b\p{L}\.\p{L}\b/u.test(e.displayName),
      );
      expect(dotted).toHaveLength(11);
      for (const e of dotted) expect(codes(e.displayName)[0], e.displayName).toBe(e.code);
    });

    it.each(['DMD', 'D.M.D.', 'DDS', 'D.D.S.'])('"%s" leads with Dentist', (query) => {
      expect(codes(query)[0]).toBe('122300000X');
    });

    it('"DDS" matches what "dentist" matches; "DMD" adds the one label carrying its letters', () => {
      expect(codes('DDS')).toEqual(codes('dentist'));
      expect([...codes('DMD')].sort()).toEqual([...codes('dentist'), '204E00000X'].sort());
    });

    it('"M.S." returns only Genetic Counselor (M.S.)', () => {
      expect(codes('M.S.')).toEqual(['170300000X']);
    });

    it.each([
      ['Legal Medicine (M.D./D.O.) Physician', '209800000X'],
      ['Genetic Counselor (M.S.)', '170300000X'],
    ])('"%s" still resolves to %s first (characterization)', (query, code) => {
      expect(codes(query)[0]).toBe(code);
    });

    it.each(['M.D.', 'D.O.', 'MD'])(
      '"%s" stays a stop-word-only query now that labels index it (characterization)',
      (query) => {
        expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
        expect(stopWordOnlyQuery(query)).toBe('physician');
      },
    );
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

  describe('resolve — "dr" abbreviates doctor (stop word)', () => {
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it.each([
      ['eye dr', 'eye doctor'],
      ['heart dr', 'heart doctor'],
      ['Eye Dr.', 'eye doctor'],
      ['eye drs', 'eye doctors'],
    ])('"%s" resolves exactly as "%s"', (abbreviated, spelled) => {
      expect(codes(spelled).length).toBeGreaterThan(0);
      expect(codes(abbreviated)).toEqual(codes(spelled));
      expect(stopWordOnlyQuery(abbreviated)).toBeUndefined();
    });

    it.each(['dr', 'Dr.', 'DRs', 'dr physician'])(
      '"%s" matches nothing and is a stop-word-only query (physician)',
      (query) => {
        expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
        expect(stopWordOnlyQuery(query)).toBe('physician');
      },
    );
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

  describe('resolve — everyday terms for a provider type (#46)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/46
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);
    const TABLE: readonly (readonly [string, string])[] = [
      ['skin doctor', '207N00000X'], // Dermatology
      ['general practitioner', '208D00000X'], // General Practice
      ['GP', '208D00000X'],
      ['stomach doctor', '207RG0100X'], // Gastroenterology
      ['GI doctor', '207RG0100X'],
      ['lung doctor', '207RP1001X'], // Pulmonary Disease
      ['ear nose throat', '207Y00000X'], // Otolaryngology
      ['ear doctor', '207Y00000X'],
      ['nose doctor', '207Y00000X'],
      ['throat doctor', '207Y00000X'],
      ['ID doctor', '207RI0200X'], // Infectious Disease
      ['PT', '225100000X'], // Physical Therapist
      ['OT', '225X00000X'], // Occupational Therapist
      ['bone doctor', '207X00000X'], // Orthopaedic Surgery
      ['brain doctor', '2084N0400X'], // Neurology
      ['nerve doctor', '2084N0400X'],
      ['foot doctor', '213E00000X'], // Podiatrist
      ['pain management', '208VP0000X'], // Pain Medicine
      ['nursing home', '314000000X'], // Skilled Nursing Facility
      ['liver doctor', '207RI0008X'], // Hepatology
      ['tooth doctor', '122300000X'], // Dentist
      ['teeth doctor', '122300000X'],
      ['arthritis doctor', '207RR0500X'], // Rheumatology
      ['hormone doctor', '207RE0101X'], // Endocrinology, Diabetes & Metabolism
      ['thyroid doctor', '207RE0101X'],
      ['prostate doctor', '208800000X'], // Urology
      ['bladder doctor', '208800000X'],
      ['PCP', '207Q00000X'], // Family Medicine
    ];

    it.each(TABLE)('"%s" resolves to %s first', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it('every target is an active bundled code', () => {
      for (const [, code] of TABLE) expect(svc.get(code)?.status).toBe('active');
    });

    it('"PCP" resolves to Family Medicine, then Internal Medicine', () => {
      expect(svc.resolve('PCP', 2).map((e) => e.code)).toEqual(['207Q00000X', '207R00000X']);
    });

    it('"nursing home" reaches both nursing facilities and no supplier', () => {
      const hits = svc.resolve('nursing home', 1000);
      expect(hits[0]?.code).toBe('314000000X');
      expect(hits.map((e) => e.code)).toContain('313M00000X'); // Nursing Facility/Intermediate Care
      expect(hits.map((e) => e.code)).not.toContain('332BN1400X'); // Nursing Facility Supplies
      expect(hits.filter((e) => e.grouping === 'Suppliers')).toEqual([]);
    });

    it.each(['OT', 'O.T.', 'ot'])('"%s" returns no Otolaryngology code', (query) => {
      const hits = svc.resolve(query, 1000);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.filter((e) => e.classification === 'Otolaryngology')).toEqual([]);
    });

    it('"ear" never reaches the Early Intervention entries', () => {
      expect(codes('ear')).not.toContain('252Y00000X');
      expect(codes('ear doctor')).not.toContain('252Y00000X');
    });

    it.each([
      ['P.T.', 'PT'],
      ['G.I.', 'GI'],
      ['I.D.', 'ID'],
      ['G.P.', 'GP'],
      ['O.T.', 'OT'],
    ])('"%s" resolves exactly as "%s" (#29)', (dotted, plain) => {
      expect(codes(plain).length).toBeGreaterThan(0);
      expect(codes(dotted)).toEqual(codes(plain));
    });

    it.each([
      ['foot', '213E00000X'],
      ['hormone', '207RE0101X'],
      ['thyroid', '207RE0101X'],
    ])('"%s" moves only the preferred entry %s (#10)', (token, code) => {
      // A repeated token matches exactly what the single token matches but bypasses the table.
      const ranked = codes(token);
      const unpreferred = codes(`${token} ${token}`);
      expect([...ranked].sort()).toEqual([...unpreferred].sort());
      expect(ranked).toEqual([code, ...unpreferred.filter((c) => c !== code)]);
    });

    it.each([
      ['optometrist', 9, ['152W00000X', '156FX1202X', '156FX1201X', '152WS0006X', '152WV0400X']],
      ['otolaryngologist', 8, ['207Y00000X', '207YX0905X', '207YP0228X', '207YX0901X']],
      ['otologist', 1, ['207YX0901X']],
      ['pediatrician', 53, ['208000000X', '2088P0231X', '2086S0120X', '207ZP0213X', '2085P0229X']],
      ['patient', 2, ['2278P4000X', '2279P4000X']],
      ['brain injury', 2, ['2084P0301X', '2081P0301X']],
      ['bone densitometry', 1, ['2471B0102X']],
      ['foot surgeon', 3, ['207XX0004X', '213ES0131X', '213ES0103X']],
      ['nursing home administrator', 1, ['376G00000X']],
      ['pain management pharmacist', 1, ['1835P1400X']],
      ['pain management nurse', 1, ['163WP0000X']],
      ['pain medicine', 5, ['208VP0000X', '207LP2900X', '2084P2900X', '208VP0014X', '2081P2900X']],
      [
        'pain',
        9,
        [
          '208VP0000X',
          '207LP2900X',
          '2084P2900X',
          '208VP0014X',
          '2081P2900X',
          '261QP3300X',
          '1223X2210X',
          '1835P1400X',
          '163WP0000X',
        ],
      ],
    ] as const)(
      '"%s" keeps its %i matches and leading order (characterization)',
      (query, count, lead) => {
        const hits = codes(query);
        expect(hits).toHaveLength(count);
        expect(hits.slice(0, lead.length)).toEqual(lead);
      },
    );
  });

  describe('resolve — "and" is a stop word (#46)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/46 — NUCC writes most
    // two-part names with "&", which normalizes away, so a spelled-out "and" was a required term.
    const codes = (query: string) => svc.resolve(query, 1000).map((e) => e.code);

    it.each([
      ['obstetrics and gynecology', '207V00000X'],
      ['allergy and immunology', '207K00000X'],
      ['physical medicine and rehabilitation', '208100000X'],
      ['colon and rectal surgeon', '208C00000X'],
      ['ear nose and throat', '207Y00000X'],
    ])('"%s" resolves to %s first', (query, code) => {
      expect(svc.resolve(query, 1)[0]?.code).toBe(code);
    });

    it.each([
      // The Dentist and Clinic/Center specialization NUCC spells with "and".
      ['Oral and Maxillofacial Surgery', ['1223S0112X', '261QS0112X', '204E00000X']],
      ['oral and maxillofacial surgery', ['1223S0112X', '261QS0112X', '204E00000X']],
      // The physician classification NUCC spells with "&".
      ['Oral & Maxillofacial Surgery', ['204E00000X', '1223S0112X', '261QS0112X']],
    ])('"%s" leads with the entry whose own label it spells: %j', (query, order) => {
      expect(codes(query)).toEqual(order);
    });

    it('every NUCC classification or specialization spelled with "and" resolves first to an entry it names', () => {
      const names = [...new Set(TAXONOMY_ENTRIES.flatMap(taxonomyNamesOf))].filter((name) =>
        /\band\b/i.test(name),
      );
      expect(names).toHaveLength(27);
      for (const name of names) {
        const top = svc.resolve(name, 1)[0];
        expect(top?.specialization ?? top?.classification, name).toBe(name);
      }
    });

    it.each([
      ['obstetrics and gynecology', 'obstetrics gynecology'],
      ['allergy and immunology', 'allergy immunology'],
      ['Oral and Maxillofacial Surgery', 'Oral Maxillofacial Surgery'],
      ['Plastic Surgery Within the Head and Neck', 'Plastic Surgery Within the Head Neck'],
    ])('reorders only: "%s" matches what "%s" matches', (withAnd, without) => {
      expect(codes(withAnd).length).toBeGreaterThan(0);
      expect([...codes(withAnd)].sort()).toEqual([...codes(without)].sort());
    });

    it('"Plastic Surgery Within the Head and Neck" keeps its lead and gains the "&" twin', () => {
      // 207YX0007X is NUCC's "Plastic Surgery within the Head & Neck" under Otolaryngology.
      expect(codes('Plastic Surgery Within the Head and Neck')).toEqual([
        '2082S0099X',
        '207YX0007X',
      ]);
    });

    it.each([
      ['and', 'other'],
      ['AND', 'other'],
      ['and doctor', 'physician'],
    ] as const)('"%s" matches nothing and is a stop-word-only query (%s)', (query, kind) => {
      expect(svc.resolveWithInactive(query, 1000)).toEqual({ matches: [], inactiveMatches: [] });
      expect(stopWordOnlyQuery(query)).toBe(kind);
    });
  });

  describe('taxonomyDescriptionOf — the text that searches the registry for a code (#48)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/48 — the registry rejects
    // these codes' NUCC v26.1 text (error 14) and matches its own wording.
    const REGISTRY_WORDING_ROWS = [
      ['363LP0808X', 'Psych/Mental Health'],
      ['163WP0808X', 'Psych/Mental Health'],
      ['364SP0808X', 'Psych/Mental Health'],
      ['163WP0809X', 'Psych/Mental Health, Adult'],
      ['364SP0809X', 'Psych/Mental Health, Adult'],
      ['163WP0807X', 'Psych/Mental Health, Child & Adolescent'],
      ['364SP0807X', 'Psych/Mental Health, Child & Adolescent'],
      ['364SP0810X', 'Psych/Mental Health, Child & Family'],
      ['364SP0811X', 'Psych/Mental Health, Chronically Ill'],
      ['364SP0812X', 'Psych/Mental Health, Community'],
      ['364SP0813X', 'Psych/Mental Health, Geropsychiatric'],
      ['207SC0300X', 'Clinical Cytogenetic'],
      ['1223D0004X', 'Dentist Anesthesiologist Speciality'],
      ['261QM1100X', 'MilitaryU.S. Coast Guard Outpatient'],
      ['332000000X', 'MilitaryU.S. Coast Guard Pharmacy'],
      ['341800000X', 'MilitaryU.S. Coast Guard Transport'],
      ['251T00000X', 'PACE Provider Organization'],
      ['246Y00000X', 'Spec/Tech, Health Info'],
      ['246Q00000X', 'Spec/Tech, Pathology'],
      ['246X00000X', 'Spec/Tech, Cardiovascular'],
      ['332S00000X', 'Hearing  Aid Equipment'], // two spaces, as the registry stores it
    ] as const;

    it('tables 21 distinct active codes', () => {
      const codes = REGISTRY_WORDING_ROWS.map(([code]) => code);
      expect(new Set(codes).size).toBe(21);
      expect(codes.every((code) => svc.get(code)?.status === 'active')).toBe(true);
    });

    it.each(REGISTRY_WORDING_ROWS)('%s searches the registry wording "%s"', (code, wording) => {
      const entry = svc.get(code)!;
      expect(taxonomyDescriptionOf(entry)).toBe(wording);
      // The NUCC text the registry rejects, so the row is a real override.
      expect(entry.specialization ?? entry.classification).not.toBe(wording);
    });

    it.each([
      ['207RC0000X', 'Cardiovascular Disease'], // specialization
      ['207R00000X', 'Internal Medicine'], // classification, no specialization
      ['222Z00000X', 'Orthotist'],
      ['282NC0060X', 'Critical Access'],
      ['261QM2800X', 'Methadone'],
    ])('%s searches its specialization, else its classification: "%s"', (code, text) => {
      expect(taxonomyDescriptionOf(svc.get(code)!)).toBe(text);
    });

    it('every other active code searches specialization ?? classification (characterization)', () => {
      const overridden = new Set<string>(REGISTRY_WORDING_ROWS.map(([code]) => code));
      const others = TAXONOMY_ENTRIES.filter(
        (e) => e.status === 'active' && !overridden.has(e.code),
      );
      expect(others).toHaveLength(834);
      for (const entry of others) {
        expect(taxonomyDescriptionOf(entry)).toBe(entry.specialization ?? entry.classification);
      }
    });
  });

  describe('searchedBy — the active codes a registry search text stands for', () => {
    const codes = (text: string) => svc.searchedBy(text).map((e) => e.code);

    it.each([
      ['Diabetology', ['207QB0505X', '207QD0401X']],
      ['diabetology', ['207QB0505X', '207QD0401X']],
      ['Community Paramedic', ['146E00000X']],
      ['Psych/Mental Health', ['163WP0808X', '363LP0808X', '364SP0808X']],
      ['Cardiovascular Disease', ['207RC0000X']],
    ])('"%s" stands for %j', (text, expected) => {
      expect(codes(text)).toEqual(expected);
    });

    it.each([
      'Psychiatric/Mental Health', // NUCC's text, replaced by the registry's wording
      'Internal Medicine, Cardiovascular Disease', // the combined form, which no code sends
      'Graphics Designer', // sent only by the inactive 1744G0900X
      'Cardiovascular Disease Physician', // a display name
    ])('"%s" stands for no code', (text) => {
      expect(codes(text)).toEqual([]);
    });
  });

  describe('decodeTaxonomyDescription (#48)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/48
    const decode = (value: string) => svc.decodeTaxonomyDescription(value);
    const decoded = (code: string, taxonomyDescription: string) => ({
      kind: 'decoded',
      entry: svc.get(code),
      taxonomyDescription,
    });

    it.each([
      ['207RC0000X', '207RC0000X', 'Cardiovascular Disease'],
      ['207rc0000x', '207RC0000X', 'Cardiovascular Disease'],
      ['  207Rc0000X ', '207RC0000X', 'Cardiovascular Disease'],
      ['222Z00000X', '222Z00000X', 'Orthotist'],
      ['363lp0808x', '363LP0808X', 'Psych/Mental Health'],
      ['332S00000X', '332S00000X', 'Hearing  Aid Equipment'],
    ])('code %j decodes to %s, searching "%s"', (value, code, text) => {
      expect(decode(value)).toEqual(decoded(code, text));
    });

    it.each([
      ['207RZ9999X', '207RZ9999X'],
      ['207rz9999x', '207RZ9999X'],
      ['000000000X', '000000000X'],
    ])('unknown code %j is unknown_code %s', (value, code) => {
      expect(decode(value)).toEqual({ kind: 'unknown_code', code });
    });

    it('an inactive code with a named replacement is inactive_code, naming it', () => {
      expect(decode('103gc0700x')).toEqual({ kind: 'inactive_code', entry: svc.get('103GC0700X') });
      const result = decode('103GC0700X');
      expect(result.kind === 'inactive_code' && result.entry.replacedBy).toBe('103G00000X');
    });

    it('an inactive code with no named replacement is inactive_code', () => {
      const result = decode('1744G0900X');
      expect(result).toEqual({ kind: 'inactive_code', entry: svc.get('1744G0900X') });
      expect(result.kind === 'inactive_code' && result.entry.replacedBy).toBeUndefined();
    });

    it.each([
      ['Cardiovascular Disease Physician', '207RC0000X', 'Cardiovascular Disease'],
      ['  cardiovascular DISEASE physician  ', '207RC0000X', 'Cardiovascular Disease'],
      ['Psychiatric/Mental Health Nurse Practitioner', '363LP0808X', 'Psych/Mental Health'],
      // The three non-prefix display names the registry accepts as written decode to the same
      // request (PACE, Hearing Aid) or to one returning the same rows (Methadone).
      ['PACE Provider Organization', '251T00000X', 'PACE Provider Organization'],
      ['Hearing  Aid Equipment', '332S00000X', 'Hearing  Aid Equipment'],
      ['Methadone Clinic', '261QM2800X', 'Methadone'],
    ])('display name %j decodes to %s, searching "%s"', (value, code, text) => {
      expect(decode(value)).toEqual(decoded(code, text));
    });

    it.each([
      ['Critical Access Hospital', 'Critical Access Hospital'],
      ['critical access hospital', 'critical access hospital'],
      ['Ph.D. Medical Genetics', 'Ph.D. Medical Genetics'],
      ['Pharmacist', 'Pharmacist'],
      ['  PHARMACIST ', 'PHARMACIST'],
    ])('display name %j, a prefix of a bundled name, stays free text', (value, text) => {
      expect(decode(value)).toEqual({ kind: 'free_text', text });
    });

    it.each([
      ['Cardiovascular Disease', 'Cardiovascular Disease'],
      ['Psych/Mental Health', 'Psych/Mental Health'],
      ['  Cardio  ', 'Cardio'],
      ['Hearing Aid Equipment', 'Hearing Aid Equipment'], // one space: NUCC's classification
      ['207RC0000', '207RC0000'], // nine characters
      ['207RC0000XX', '207RC0000XX'],
      ['207RC00001', '207RC00001'], // ten characters, no trailing X
      ['207RC 0000X', '207RC 0000X'],
      ['Veterinary Technician', 'Veterinary Technician'], // inactive 2472V0600X's display name
      ['', ''],
    ])('%j is free_text', (value, text) => {
      expect(decode(value)).toEqual({ kind: 'free_text', text });
    });

    it('decodes every active display name that is no prefix to its own entry, and only those', () => {
      const registryNames = TAXONOMY_ENTRIES.flatMap((e) =>
        e.specialization ? [e.classification, e.specialization] : [e.classification],
      ).map((n) => n.toLowerCase());
      const isPrefix = (name: string) =>
        registryNames.some((n) => n.startsWith(name.toLowerCase()));
      let decodedCount = 0;
      for (const entry of TAXONOMY_ENTRIES.filter((e) => e.status === 'active')) {
        const result = decode(entry.displayName);
        if (isPrefix(entry.displayName)) {
          expect(result).toEqual({ kind: 'free_text', text: entry.displayName });
        } else {
          expect(result).toEqual({
            kind: 'decoded',
            entry,
            taxonomyDescription: taxonomyDescriptionOf(entry),
          });
          decodedCount += 1;
        }
      }
      expect(decodedCount).toBe(654);
    });

    it('a display name that only starts another entry’s classification stays free text', () => {
      // No bundled display name is a strict prefix of a name it doesn't equal; pin the rule.
      const named: TaxonomyEntry = {
        classification: 'Test Classification',
        code: '999A00001X',
        displayName: 'Alpha Beta',
        grouping: 'Test Grouping',
        section: 'Individual',
        specialization: 'Delta',
        status: 'active',
      };
      const longer: TaxonomyEntry = {
        classification: 'Alpha Beta Gamma',
        code: '999B00000X',
        displayName: 'Alpha Beta Gamma Provider',
        grouping: 'Test Grouping',
        section: 'Individual',
        status: 'active',
      };
      expect(new TaxonomyService([named]).decodeTaxonomyDescription('Alpha Beta')).toEqual({
        kind: 'decoded',
        entry: named,
        taxonomyDescription: 'Delta',
      });
      expect(new TaxonomyService([named, longer]).decodeTaxonomyDescription('Alpha Beta')).toEqual({
        kind: 'free_text',
        text: 'Alpha Beta',
      });
    });

    it('never decodes an inactive entry by display name', () => {
      const activeNames = new Set(
        TAXONOMY_ENTRIES.filter((e) => e.status === 'active').map((e) => e.displayName),
      );
      const inactiveOnly = TAXONOMY_ENTRIES.filter(
        (e) => e.status === 'inactive' && !activeNames.has(e.displayName),
      );
      expect(inactiveOnly).toHaveLength(23);
      for (const entry of inactiveOnly) {
        expect(decode(entry.displayName)).toEqual({ kind: 'free_text', text: entry.displayName });
      }
    });

    describe('display names shared by several entries', () => {
      it('the bundled duplicates are five active + inactive pairs, each a prefix, so free text', () => {
        const codesByName = new Map<string, string[]>();
        for (const e of TAXONOMY_ENTRIES) {
          codesByName.set(e.displayName, [...(codesByName.get(e.displayName) ?? []), e.code]);
        }
        const duplicates = [...codesByName].filter(([, codes]) => codes.length > 1);
        expect(Object.fromEntries(duplicates)).toEqual({
          'Clinical Neuropsychologist': ['103G00000X', '103GC0700X'],
          Psychologist: ['103T00000X', '103TE1000X'],
          Pharmacist: ['183500000X', '1835G0000X'],
          Podiatrist: ['213E00000X', '213EG0000X'],
          'Military Hospital': ['286500000X', '2865C1500X'],
        });
        for (const [name] of duplicates) {
          expect(decode(name)).toEqual({ kind: 'free_text', text: name });
        }
      });

      const entry = (
        code: string,
        specialization: string,
        status: TaxonomyEntry['status'] = 'active',
      ): TaxonomyEntry => ({
        classification: 'Test Classification',
        code,
        displayName: 'Shared Name',
        grouping: 'Test Grouping',
        section: 'Individual',
        specialization,
        status,
      });

      it('active entries that would send different texts leave the name free text', () => {
        const service = new TaxonomyService([
          entry('999A00001X', 'Alpha'),
          entry('999A00002X', 'Beta'),
        ]);
        expect(service.decodeTaxonomyDescription('shared name')).toEqual({
          kind: 'free_text',
          text: 'shared name',
        });
      });

      it('active entries that send the same text decode to the first', () => {
        const first = entry('999A00001X', 'Alpha');
        const service = new TaxonomyService([first, entry('999A00002X', 'Alpha')]);
        expect(service.decodeTaxonomyDescription('Shared Name')).toEqual({
          kind: 'decoded',
          entry: first,
          taxonomyDescription: 'Alpha',
        });
      });

      it('an inactive entry never takes part: the active one decodes, an inactive one alone does not', () => {
        const active = entry('999A00001X', 'Alpha');
        const inactive = entry('999A00002X', 'Beta', 'inactive');
        expect(
          new TaxonomyService([inactive, active]).decodeTaxonomyDescription('Shared Name'),
        ).toEqual({
          kind: 'decoded',
          entry: active,
          taxonomyDescription: 'Alpha',
        });
        expect(new TaxonomyService([inactive]).decodeTaxonomyDescription('Shared Name')).toEqual({
          kind: 'free_text',
          text: 'Shared Name',
        });
      });
    });
  });
});

// ── #51: the codes a resolved specialty search keeps ─────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/51

describe('specialtyCandidates (#51)', () => {
  const SPORTS_MEDICINE = [
    '207QS0010X',
    '207RS0010X',
    '207PS0010X',
    '2084S0010X',
    '207XX0005X',
    '2083S0010X',
    '2081S0010X',
    '2080S0010X',
    '213ES0000X',
  ];

  it('lists every later candidate that sends the first one’s text at its level, in rank order', () => {
    expect(specialtyCandidates(svc, 'sports medicine', 5).matches.map((e) => e.code)).toEqual(
      SPORTS_MEDICINE,
    );
    // Ranked seventh, the Neuromusculoskeletal classification sends its own text.
    expect(svc.resolve('sports medicine', 10).map((e) => e.code)).toContain('204C00000X');
  });

  it('starts from the limit: one candidate still brings every same-text one', () => {
    expect(specialtyCandidates(svc, 'sports medicine', 1).matches.map((e) => e.code)).toEqual(
      SPORTS_MEDICINE,
    );
    expect(specialtyCandidates(svc, 'cardiologist', 1).matches.map((e) => e.code)).toEqual([
      '207RC0000X',
    ]);
  });

  it('lists all ten Hospice and Palliative Medicine candidates', () => {
    const { matches } = specialtyCandidates(svc, 'hospice and palliative medicine', 5);
    expect(matches).toHaveLength(10);
    for (const entry of matches) {
      expect(taxonomyDescriptionOf(entry)).toBe('Hospice and Palliative Medicine');
    }
  });

  it.each([
    'pediatrician',
    'psychiatrist',
    'cardiologist',
    'family nurse practitioner',
    'pediatric nurse practitioner',
  ])('keeps resolve’s first five for %j, whose later candidates send other text', (query) => {
    expect(specialtyCandidates(svc, query, 5).matches).toEqual(svc.resolve(query, 5));
  });

  it('never appends a candidate at the other level: pediatrician leaves nursing Pediatrics out', () => {
    const later = svc.resolve('pediatrician', 1000).slice(5);
    expect(
      later.filter((e) => taxonomyDescriptionOf(e) === 'Pediatrics').map((e) => e.code),
    ).toContain('363LP0200X');
    expect(specialtyCandidates(svc, 'pediatrician', 5).matches.map((e) => e.code)).not.toContain(
      '363LP0200X',
    );
  });

  it('passes inactive matches through, and a miss through empty', () => {
    expect(specialtyCandidates(svc, 'christian science', 5)).toEqual(
      svc.resolveWithInactive('christian science', 5),
    );
    expect(specialtyCandidates(svc, 'christian science', 5).inactiveMatches).toHaveLength(2);
    expect(specialtyCandidates(svc, 'zzzznotaspecialty', 5)).toEqual({
      matches: [],
      inactiveMatches: [],
    });
  });
});

describe('resolvedCodeSet (#51)', () => {
  /** The sorted codes the bundled entries `entryCodes` stand for. */
  const codesFor = (...entryCodes: string[]) =>
    [
      ...resolvedCodeSet(
        svc,
        entryCodes.map((code) => svc.get(code) as TaxonomyEntry),
      ),
    ].sort();

  it('a specialization code stands for itself', () => {
    expect(codesFor('363LF0000X')).toEqual(['363LF0000X']);
    expect(codesFor('207RH0000X')).toEqual(['207RH0000X']);
  });

  it('a classification code stands for every code of its classification', () => {
    const nursePractitioner = codesFor('363L00000X');
    expect(nursePractitioner).toHaveLength(18);
    expect(nursePractitioner).toEqual(expect.arrayContaining(['363L00000X', '363LF0000X']));
    expect(nursePractitioner).not.toContain('364SP0200X');
    expect(codesFor('207R00000X')).toHaveLength(31);
    expect(codesFor('207R00000X')).toEqual(expect.arrayContaining(['207RC0000X', '207RH0003X']));
  });

  it('counts the inactive codes of a classification', () => {
    expect(codesFor('103T00000X')).toEqual(expect.arrayContaining(['103TF0000X', '103TP2700X']));
  });

  it('keeps a classification name another grouping reuses to its own grouping', () => {
    expect(codesFor('225500000X')).toEqual(['225500000X', '2255A2300X', '2255R0406X']);
    expect(codesFor('235500000X')).toEqual(['235500000X', '2355A2700X', '2355S0801X']);
    expect(codesFor('209800000X')).toEqual(['209800000X']);
  });

  it('unites every entry, and is empty for none', () => {
    expect(codesFor('363LF0000X', '207RH0000X')).toEqual(['207RH0000X', '363LF0000X']);
    expect(codesFor()).toEqual([]);
  });
});
