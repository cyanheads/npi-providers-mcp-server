/**
 * @fileoverview Seeded and adversarial tests for the external NPPES response
 * boundary. Global fetch is the only fake; NppesService parses every body.
 * @module tests/fuzz/nppes-response.fuzz.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NppesService } from '@/services/nppes/nppes-service.js';
import { TaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

const NPI = '1720034424';
const service = new NppesService(
  'https://npiregistry.cms.hhs.gov/api',
  15000,
  new TaxonomyService(),
);

/** Answer every registry request with `body` as an HTTP 200; any other URL rejects as unmocked. */
function stubText(body: string): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (url: string | URL) => {
    if (!String(url).startsWith('https://npiregistry.cms.hhs.gov/api/')) {
      throw new Error('unmocked fetch');
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  return stubText(JSON.stringify(body));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NPPES response parser fuzzing', () => {
  it('handles the empty success envelope deterministically', async () => {
    const ctx = createMockContext();
    stubJson({ result_count: 0, results: [] });
    await expect(service.search({ lastName: 'NONE', limit: 10, skip: 0 }, ctx)).resolves.toEqual(
      [],
    );
    stubJson({ result_count: 0, results: [] });
    await expect(service.getByNumber(NPI, ctx)).resolves.toBeNull();
  });

  it('normalizes generated sparse optional-field variants without fabricating absent values', async () => {
    const ctx = createMockContext();
    const optional = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | null | undefined> =>
      fc.oneof(fc.constant(undefined), fc.constant(null), arbitrary);
    const variant = fc.record({
      index: fc.integer({ min: 0, max: 100_000 }),
      individual: fc.boolean(),
      active: fc.boolean(),
      middleName: optional(fc.constant('Q')),
      credential: optional(fc.constant('MD')),
      officialFirstName: optional(fc.constant('ALEX')),
      officialLastName: optional(fc.constant('ADMIN')),
      taxonomyDescription: optional(fc.constant('Internal Medicine')),
      license: optional(fc.constant('WA-123')),
      taxonomyState: optional(fc.constant('WA')),
      address1: optional(fc.constant('500 CLINIC AVE')),
      address2: optional(fc.constant('SUITE 200')),
      city: optional(fc.constant('SEATTLE')),
      addressState: optional(fc.constant('WA')),
      postalCode: optional(fc.constant('981020000')),
    });

    await fc.assert(
      fc.asyncProperty(variant, async (sample) => {
        const raw = {
          number: Number(NPI),
          enumeration_type: sample.individual ? 'NPI-1' : 'NPI-2',
          basic: sample.individual
            ? {
                first_name: 'FUZZ',
                last_name: `PROVIDER${sample.index}`,
                status: sample.active ? 'A' : 'D',
                middle_name: sample.middleName,
                credential: sample.credential,
              }
            : {
                organization_name: `FUZZ HEALTH ${sample.index}`,
                status: sample.active ? 'A' : 'D',
                authorized_official_first_name: sample.officialFirstName,
                authorized_official_last_name: sample.officialLastName,
              },
          taxonomies: [
            {
              code: '207R00000X',
              desc: sample.taxonomyDescription,
              primary: true,
              license: sample.license,
              state: sample.taxonomyState,
            },
          ],
          addresses: [
            {
              address_purpose: 'LOCATION',
              address_1: sample.address1,
              address_2: sample.address2,
              city: sample.city,
              state: sample.addressState,
              postal_code: sample.postalCode,
            },
          ],
          identifiers: [],
          other_names: [],
          endpoints: [],
          practiceLocations: [],
        };
        stubJson({ result_count: 1, results: [raw] });
        try {
          const record = await service.getByNumber(NPI, ctx);
          expect(record?.npi).toBe(NPI);
          expect(record?.type).toBe(sample.individual ? 'individual' : 'organization');
          expect(record?.status).toBe(sample.active ? 'active' : 'deactivated');
          expect(record?.name.length).toBeGreaterThan(0);
          expect(record?.taxonomies[0]?.code).toBe('207R00000X');
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 75, seed: 0x4e505045 },
    );
  });

  it('names a generated authorized official from its recorded parts, on official searches only (#45)', async () => {
    const ctx = createMockContext();
    const part = (value: string) =>
      fc.constantFrom<unknown>(undefined, null, '', ' \t ', 42, value, ` ${value} `);
    /** A part's recorded text: a non-blank string, trimmed; anything else is unrecorded. */
    const recorded = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined;
    const sample = fc.record({
      first: part('JUDY'),
      middle: part('L'),
      last: part('SMITH'),
      prefix: part('Mrs.'),
      credential: part('RN'),
      title: part('Office Manager'),
      telephone: part('3178902300'),
      officialSearch: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(sample, async (s) => {
        const raw = {
          number: Number(NPI),
          enumeration_type: 'NPI-2',
          basic: {
            organization_name: 'FUZZ HEALTH',
            status: 'A',
            authorized_official_first_name: s.first,
            authorized_official_middle_name: s.middle,
            authorized_official_last_name: s.last,
            authorized_official_name_prefix: s.prefix,
            authorized_official_credential: s.credential,
            authorized_official_title_or_position: s.title,
            authorized_official_telephone_number: s.telephone,
          },
        };
        // A middle name joins the name only beside a first or last name.
        const named = Boolean(recorded(s.first) || recorded(s.last));
        const name = [s.first, s.middle, s.last].map(recorded).filter(Boolean).join(' ');
        const title = recorded(s.title);
        try {
          stubJson({ result_count: 1, results: [raw] });
          const [row] = await service.search(
            {
              lastName: 'SMITH',
              limit: 10,
              skip: 0,
              ...(s.officialSearch
                ? ({ namePurpose: 'AO', enumerationType: 'NPI-2' } as const)
                : {}),
            },
            ctx,
          );
          if (s.officialSearch && named) {
            expect(row?.authorizedOfficial).toEqual(title ? { name, title } : { name });
          } else {
            expect(row).not.toHaveProperty('authorizedOfficial');
          }
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 200, seed: 0x4e50492d },
    );
  });

  it('decodes generated taxonomy desc variants: served text verbatim, else marked NUCC text, else none (#43)', async () => {
    const ctx = createMockContext();
    // Bundled NUCC text per code; 103GC0700X is inactive, 207RX9999X is not in the bundle.
    const NUCC_TEXT: Record<string, string> = {
      '207R00000X': 'Internal Medicine',
      '2086S0129X': 'Surgery, Vascular Surgery',
      '103GC0700X': 'Clinical Neuropsychologist, Clinical',
    };
    const taxonomy = fc.record({
      code: fc.constantFrom('207R00000X', ' 2086S0129X ', '103GC0700X', '207RX9999X'),
      desc: fc.constantFrom<unknown>(
        undefined,
        null,
        '',
        ' \t ',
        7,
        ' Nurse Practitioner, Psych/Mental Health ',
      ),
      primary: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(taxonomy, { minLength: 1, maxLength: 4 }), async (taxonomies) => {
        const raw = {
          number: Number(NPI),
          enumeration_type: 'NPI-1',
          basic: { first_name: 'FUZZ', last_name: 'PROVIDER', status: 'A' },
          taxonomies,
        };
        const expected = taxonomies.map(({ code, desc }) => {
          const trimmedCode = code.trim();
          const served = typeof desc === 'string' ? desc.trim() : '';
          if (served) return { code: trimmedCode, description: served };
          const nucc = NUCC_TEXT[trimmedCode];
          return nucc
            ? { code: trimmedCode, description: nucc, descriptionSource: 'nucc' }
            : { code: trimmedCode };
        });
        const primaryIndex = Math.max(
          taxonomies.findIndex((t) => t.primary),
          0,
        );
        try {
          stubJson({ result_count: 1, results: [raw] });
          const record = await service.getByNumber(NPI, ctx);
          expect(
            record?.taxonomies.map(({ code, description, descriptionSource }) => ({
              code,
              ...(description === undefined ? {} : { description }),
              ...(descriptionSource === undefined ? {} : { descriptionSource }),
            })),
          ).toEqual(expected);
          stubJson({ result_count: 1, results: [raw] });
          const [row] = await service.search({ lastName: 'PROVIDER', limit: 10, skip: 0 }, ctx);
          expect(row?.primaryTaxonomy).toEqual(expected[primaryIndex]);
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 100, seed: 0x4e554343 },
    );
  });

  it('names the first non-primary taxonomy a generated filter matches, never the primary (#44)', async () => {
    const ctx = createMockContext();
    /**
     * Taxonomies with their classification/specialization written out by hand (the
     * registry's wording, else NUCC's for a blank desc) and the reference a row carries.
     */
    const POOL = [
      {
        raw: { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease' },
        parts: ['Internal Medicine', 'Cardiovascular Disease'],
        reference: { code: '207RC0000X', description: 'Internal Medicine, Cardiovascular Disease' },
      },
      {
        raw: { code: '207RH0003X', desc: 'Internal Medicine, Hematology & Oncology' },
        parts: ['Internal Medicine', 'Hematology & Oncology'],
        reference: { code: '207RH0003X', description: 'Internal Medicine, Hematology & Oncology' },
      },
      {
        raw: { code: '2086S0129X', desc: null },
        parts: ['Surgery', 'Vascular Surgery'],
        reference: {
          code: '2086S0129X',
          description: 'Surgery, Vascular Surgery',
          descriptionSource: 'nucc',
        },
      },
      {
        raw: { code: '208600000X', desc: 'Surgery' },
        parts: ['Surgery'],
        reference: { code: '208600000X', description: 'Surgery' },
      },
      {
        raw: { code: '208G00000X', desc: 'Thoracic Surgery (Cardiothoracic Vascular Surgery)' },
        parts: ['Thoracic Surgery (Cardiothoracic Vascular Surgery)'],
        reference: {
          code: '208G00000X',
          description: 'Thoracic Surgery (Cardiothoracic Vascular Surgery)',
        },
      },
      {
        raw: { code: '363LP0808X', desc: 'Nurse Practitioner, Psych/Mental Health' },
        parts: ['Nurse Practitioner', 'Psych/Mental Health'],
        reference: { code: '363LP0808X', description: 'Nurse Practitioner, Psych/Mental Health' },
      },
      {
        raw: {
          code: '246XC2901X',
          desc: 'Spec/Tech, Cardiovascular, Cardiovascular Invasive Specialist',
        },
        parts: ['Spec/Tech, Cardiovascular', 'Cardiovascular Invasive Specialist'],
        reference: {
          code: '246XC2901X',
          description: 'Spec/Tech, Cardiovascular, Cardiovascular Invasive Specialist',
        },
      },
      // No NUCC specialization: the served desc is one classification holding ", ".
      {
        raw: { code: '246X00000X', desc: 'Spec/Tech, Cardiovascular' },
        parts: ['Spec/Tech, Cardiovascular'],
        reference: { code: '246X00000X', description: 'Spec/Tech, Cardiovascular' },
      },
      {
        raw: { code: '222Z00000X' },
        parts: ['Orthotist'],
        reference: { code: '222Z00000X', description: 'Orthotist', descriptionSource: 'nucc' },
      },
      { raw: { code: '207RX9999X', desc: null }, parts: [], reference: { code: '207RX9999X' } },
    ];
    const FILTERS = [
      'Cardio',
      'cardiovascular disease',
      'Surgery',
      'Vascular Surgery',
      'Internal Medicine',
      'Psych',
      'Psychiatric',
      'Disease',
      'Spec/Tech, Cardio',
      'orthotist',
      'Thoracic',
    ];
    const held = fc.record({ entry: fc.constantFrom(...POOL), primary: fc.boolean() });

    await fc.assert(
      fc.asyncProperty(
        fc.array(held, { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...FILTERS),
        async (taxonomies, filter) => {
          const raw = {
            number: Number(NPI),
            enumeration_type: 'NPI-1',
            basic: { first_name: 'FUZZ', last_name: 'PROVIDER', status: 'A' },
            taxonomies: taxonomies.map(({ entry, primary }) => ({ ...entry.raw, primary })),
          };
          const passes = ({ entry }: (typeof taxonomies)[number]) =>
            entry.parts.some((part) => part.toLowerCase().startsWith(filter.toLowerCase()));
          const primary = taxonomies.find((t) => t.primary) ?? taxonomies[0];
          const expected =
            primary && passes(primary) ? undefined : taxonomies.find(passes)?.entry.reference;
          try {
            stubJson({ result_count: 1, results: [raw] });
            const [filtered] = await service.search(
              { taxonomyDescription: filter, limit: 10, skip: 0 },
              ctx,
            );
            if (expected) expect(filtered?.matchedTaxonomy).toEqual(expected);
            else expect(filtered).not.toHaveProperty('matchedTaxonomy');
            stubJson({ result_count: 1, results: [raw] });
            const [unfiltered] = await service.search(
              { lastName: 'PROVIDER', limit: 10, skip: 0 },
              ctx,
            );
            expect(unfiltered).not.toHaveProperty('matchedTaxonomy');
          } finally {
            vi.unstubAllGlobals();
          }
        },
      ),
      { numRuns: 150, seed: 0x4d415443 },
    );
  });

  it('maps a partial Errors envelope to a typed, non-retryable validation error', async () => {
    const fetchSpy = stubJson({ Errors: [{}] });
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_search_field', retryable: false },
    });
    expect(error.message).toBe('Validation error');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies malformed JSON as a typed upstream failure rather than returning empty data', async () => {
    const fetchSpy = stubText('{"result_count":1,"results":[');
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/parse NPPES response as JSON/i);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('classifies an HTML error page as a typed upstream failure', async () => {
    const fetchSpy = stubText('<!doctype html><html><body>upstream error</body></html>');
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/returned HTML instead of JSON/i);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  // https://github.com/cyanheads/npi-providers-mcp-server/issues/15 — one body per test. Each
  // body is retried by the real withRetry loop; fake timers stand in for the ~3.5 s backoff
  // (the malformed-JSON and HTML cases above exercise the same loop on real timers).
  it.each<[string, unknown]>([
    ['a null body', null],
    ['a non-array Errors', { Errors: {} }],
    ['an object results', { result_count: 1, results: {} }],
    ['a null result', { result_count: 1, results: [null] }],
    ['an empty result', { result_count: 1, results: [{}] }],
    [
      'a result with no status',
      {
        result_count: 1,
        results: [
          {
            number: Number(NPI),
            enumeration_type: 'NPI-1',
            basic: { first_name: 'UNKNOWN', last_name: 'STATUS' },
          },
        ],
      },
    ],
    ['an envelope with no results', {}],
    ['a zero count with no results', { result_count: 0 }],
  ])('rejects %s with a retried, typed upstream error (#15)', async (_label, body) => {
    const fetchSpy = stubJson(body);
    vi.useFakeTimers();
    const pending = service
      .getByNumber(NPI, createMockContext())
      .then((record) => ({ record }))
      .catch((error: unknown) => ({ error }));
    await vi.runAllTimersAsync();
    const outcome = await pending;
    expect(outcome).not.toHaveProperty('record');
    const { error } = outcome as { error: McpError };
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/malformed/i);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
