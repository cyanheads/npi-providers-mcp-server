/**
 * @fileoverview Tests for the NPPES service — raw→domain normalization (full and
 * sparse payloads), the Errors[]-on-HTTP-200 detector and reason mapping, and
 * empty-result handling. The global `fetch` is stubbed so no live API is hit.
 * @module tests/services/nppes/nppes-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NppesService } from '@/services/nppes/nppes-service.js';

const svc = new NppesService('https://npiregistry.cms.hhs.gov/api', 15000);
const ctx = createMockContext();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stub global fetch to answer one call per body, in order, as HTTP 200. Any call
 * beyond the primed bodies rejects, so no test can reach the live registry.
 */
function primeFetch(...bodies: unknown[]): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
  for (const body of bodies) fetchSpy.mockResolvedValueOnce(jsonResponse(body));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Stub global fetch to return a single JSON body as an HTTP 200. */
function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  return primeFetch(body);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// A reasonably complete individual record.
const FULL_INDIVIDUAL = {
  result_count: 1,
  results: [
    {
      number: 1720034424,
      enumeration_type: 'NPI-1',
      basic: {
        first_name: 'JOSEPH',
        last_name: 'ABATE',
        middle_name: 'A',
        credential: 'MD',
        sex: 'M',
        sole_proprietor: 'NO',
        status: 'A',
        enumeration_date: '2006-05-23',
        last_updated: '2021-02-10',
      },
      taxonomies: [
        {
          code: '207RC0000X',
          desc: 'Internal Medicine, Cardiovascular Disease',
          primary: true,
          license: '12345',
          state: 'WA',
          taxonomy_group: '',
        },
      ],
      addresses: [
        {
          address_purpose: 'LOCATION',
          address_type: 'DOM',
          address_1: '123 Main St',
          city: 'Seattle',
          state: 'WA',
          postal_code: '98101',
          country_code: 'US',
          country_name: 'United States',
          telephone_number: '206-555-0100',
        },
      ],
      identifiers: [{ code: '05', desc: 'MEDICAID', identifier: 'WA999', state: 'WA', issuer: '' }],
      other_names: [],
      endpoints: [],
    },
  ],
};

// A sparse record: many optional fields omitted entirely (the realistic norm).
const SPARSE_INDIVIDUAL = {
  result_count: 1,
  results: [
    {
      number: 1999999984,
      enumeration_type: 'NPI-1',
      basic: {
        first_name: 'JANE',
        last_name: 'DOE',
        status: 'A',
        // no middle_name, credential, sex, license, etc.
      },
      taxonomies: [
        { code: '101Y00000X', desc: 'Counselor', primary: true, license: null, state: null },
      ],
      addresses: [
        {
          address_purpose: 'LOCATION',
          address_1: '1 Elm St',
          city: 'Spokane',
          state: 'WA',
          postal_code: '99201',
          country_code: 'US',
          country_name: 'United States',
        },
      ],
      identifiers: [],
      other_names: [],
      endpoints: [],
    },
  ],
};

describe('NppesService.getByNumber', () => {
  it('normalizes a full individual record', async () => {
    stubJson(FULL_INDIVIDUAL);
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec).not.toBeNull();
    expect(rec?.npi).toBe('1720034424');
    expect(rec?.type).toBe('individual');
    expect(rec?.status).toBe('active');
    expect(rec?.name).toBe('JOSEPH A ABATE');
    expect(rec?.credential).toBe('MD');
    expect(rec?.taxonomies[0]).toMatchObject({
      code: '207RC0000X',
      primary: true,
      license: '12345',
      state: 'WA',
    });
    expect(rec?.addresses[0]).toMatchObject({
      city: 'Seattle',
      state: 'WA',
      telephoneNumber: '206-555-0100',
    });
    expect(rec?.identifiers[0]).toMatchObject({ identifier: 'WA999', description: 'MEDICAID' });
  });

  it('preserves absence on a sparse record (never fabricates)', async () => {
    stubJson(SPARSE_INDIVIDUAL);
    const rec = await svc.getByNumber('1999999984', ctx);
    expect(rec).not.toBeNull();
    // Omitted fields must be absent, not empty strings or null.
    expect(rec?.credential).toBeUndefined();
    expect(rec?.middleName).toBeUndefined();
    expect(rec?.sex).toBeUndefined();
    expect(rec?.taxonomies[0]?.license).toBeUndefined();
    expect(rec?.taxonomies[0]?.state).toBeUndefined();
    expect(rec?.identifiers).toEqual([]);
    expect(rec?.endpoints).toEqual([]);
    // Present fields still resolve.
    expect(rec?.name).toBe('JANE DOE');
    expect(rec?.status).toBe('active');
  });

  it('treats a non-A status as deactivated', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1111111111,
          enumeration_type: 'NPI-1',
          basic: { last_name: 'X', status: 'D' },
          taxonomies: [],
        },
      ],
    });
    const rec = await svc.getByNumber('1111111111', ctx);
    expect(rec?.status).toBe('deactivated');
  });

  it('returns null when the NPI has no record (result_count 0)', async () => {
    stubJson({ result_count: 0, results: [] });
    expect(await svc.getByNumber('1234567893', ctx)).toBeNull();
  });

  it('labels an identity-only record by its NPI and treats null arrays as empty', async () => {
    const fetchSpy = stubJson({
      result_count: 1,
      results: [
        {
          number: '1720034424',
          enumeration_type: 'NPI-1',
          basic: { status: 'A' },
          taxonomies: null,
          addresses: null,
          practiceLocations: null,
          identifiers: null,
          other_names: null,
          endpoints: null,
        },
      ],
    });
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec).toEqual({
      npi: '1720034424',
      type: 'individual',
      status: 'active',
      name: 'NPI 1720034424',
      taxonomies: [],
      addresses: [],
      practiceLocations: [],
      identifiers: [],
      otherNames: [],
      endpoints: [],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps both MAILING and LOCATION rows, in upstream order, on an organization record (#14)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1234567893,
          enumeration_type: 'NPI-2',
          basic: { organization_name: 'SEATTLE CLINIC LLC', status: 'A' },
          addresses: [
            {
              address_purpose: 'MAILING',
              address_1: 'PO BOX 100',
              city: 'TACOMA',
              state: 'WA',
              telephone_number: '253-555-0100',
            },
            {
              address_purpose: 'LOCATION',
              address_1: '500 CLINIC AVE',
              city: 'SEATTLE',
              state: 'WA',
              telephone_number: '206-555-0102',
            },
          ],
          practiceLocations: [
            { address_purpose: 'LOCATION', address_1: '600 SATELLITE WAY', city: 'BELLEVUE' },
          ],
        },
      ],
    });
    const rec = await svc.getByNumber('1234567893', ctx);
    expect(rec?.addresses).toEqual([
      {
        purpose: 'MAILING',
        line1: 'PO BOX 100',
        city: 'TACOMA',
        state: 'WA',
        telephoneNumber: '253-555-0100',
      },
      {
        purpose: 'LOCATION',
        line1: '500 CLINIC AVE',
        city: 'SEATTLE',
        state: 'WA',
        telephoneNumber: '206-555-0102',
      },
    ]);
    expect(rec?.practiceLocations).toEqual([
      { purpose: 'LOCATION', line1: '600 SATELLITE WAY', city: 'BELLEVUE' },
    ]);
  });

  it('normalizes every practiceLocations row on an individual record', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1720034424,
          enumeration_type: 'NPI-1',
          basic: { first_name: 'JOSEPH', last_name: 'ABATE', status: 'A' },
          practiceLocations: [
            {
              address_purpose: 'LOCATION',
              address_1: '600 SATELLITE WAY',
              address_2: 'SUITE 3',
              city: 'BELLEVUE',
              state: 'WA',
              telephone_number: '425-555-0100',
            },
            { address_purpose: 'LOCATION', address_1: '700 OUTREACH ROAD', city: 'TACOMA' },
          ],
        },
      ],
    });
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.practiceLocations).toEqual([
      {
        purpose: 'LOCATION',
        line1: '600 SATELLITE WAY',
        line2: 'SUITE 3',
        city: 'BELLEVUE',
        state: 'WA',
        telephoneNumber: '425-555-0100',
      },
      { purpose: 'LOCATION', line1: '700 OUTREACH ROAD', city: 'TACOMA' },
    ]);
  });

  it('normalizes an organization record with an authorized official', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1234567890,
          enumeration_type: 'NPI-2',
          basic: {
            organization_name: 'SEATTLE CLINIC LLC',
            organizational_subpart: 'NO',
            authorized_official_first_name: 'PAT',
            authorized_official_last_name: 'SMITH',
            authorized_official_title_or_position: 'CEO',
            status: 'A',
          },
          taxonomies: [{ code: '193200000X', desc: 'Multi-Specialty', primary: true }],
          addresses: [],
        },
      ],
    });
    const rec = await svc.getByNumber('1234567890', ctx);
    expect(rec?.type).toBe('organization');
    expect(rec?.name).toBe('SEATTLE CLINIC LLC');
    expect(rec?.authorizedOfficial).toMatchObject({
      firstName: 'PAT',
      lastName: 'SMITH',
      title: 'CEO',
    });
  });

  it('omits malformed identifiers/endpoints and non-finite epoch values', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1720034424,
          enumeration_type: 'NPI-1',
          created_epoch: 'not-an-epoch',
          last_updated_epoch: Number.POSITIVE_INFINITY,
          basic: { first_name: 'JOSEPH', last_name: 'ABATE', status: 'A' },
          taxonomies: [],
          identifiers: [
            { identifier: '  ', desc: 'EMPTY' },
            { identifier: 'WA-123', desc: 'MEDICAID' },
          ],
          endpoints: [
            { endpoint: '  ', endpointType: 'FHIR' },
            { endpoint: 'https://example.test/fhir', endpointType: 'FHIR' },
          ],
        },
      ],
    });
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.createdEpoch).toBeUndefined();
    expect(rec?.lastUpdatedEpoch).toBeUndefined();
    expect(rec?.identifiers).toEqual([{ identifier: 'WA-123', description: 'MEDICAID' }]);
    expect(rec?.endpoints).toEqual([
      { endpoint: 'https://example.test/fhir', endpointType: 'FHIR' },
    ]);
  });

  it('drops the "--" placeholder on individual name prefix/suffix but keeps real values (#6)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1720034424,
          enumeration_type: 'NPI-1',
          basic: {
            first_name: 'JOSEPH',
            last_name: 'ABATE',
            name_prefix: 'Dr.',
            name_suffix: '--',
            status: 'A',
          },
          taxonomies: [],
        },
      ],
    });
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.namePrefix).toBe('Dr.'); // real value preserved
    expect(rec?.nameSuffix).toBeUndefined(); // "--" sentinel treated as absence
  });

  it('preserves a real name suffix like "Jr." (#6 — exact-match guard, not a heuristic)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1111111111,
          enumeration_type: 'NPI-1',
          basic: { first_name: 'JOHN', last_name: 'SMITH', name_suffix: 'Jr.', status: 'A' },
          taxonomies: [],
        },
      ],
    });
    const rec = await svc.getByNumber('1111111111', ctx);
    expect(rec?.nameSuffix).toBe('Jr.');
  });

  it('decodes top-level epochs, other-name parts, and full endpoint fields (#9)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1972944437,
          enumeration_type: 'NPI-1',
          created_epoch: '1373654494000',
          last_updated_epoch: '1767735851000',
          basic: { first_name: 'KATHERINE', last_name: 'SMITH', status: 'A' },
          taxonomies: [],
          other_names: [
            {
              code: '1',
              first_name: 'KATHERINE',
              middle_name: 'ANN',
              last_name: 'SMITH',
              prefix: '--',
              suffix: '--',
              type: 'Former Name',
            },
          ],
          endpoints: [
            {
              endpoint: 'KatherineAbelPA@fpc.medentdirect.com',
              endpointType: 'DIRECT',
              endpointTypeDescription: 'Direct Messaging Address',
              endpointDescription: 'Carequality',
              use: 'HIE',
              useDescription: 'Health Information Exchange (HIE)',
              contentTypeDescription: '',
              contentOtherDescription: 'C-CDA',
              affiliation: 'Y',
              affiliationName: 'FAMILY PRACTICE CENTER, PC',
              address_1: '225 N Front St',
              address_2: 'Suite 100',
              address_type: 'DOM',
              city: 'Steelton',
              state: 'PA',
              postal_code: '171132240',
              country_code: 'US',
              country_name: 'United States',
            },
            {
              endpoint: 'esmd@example.test',
              endpointType: 'DIRECT',
              use: 'OTHER',
              useDescription: 'Other',
              useOtherDescription: 'CMS esMD eMDR',
            },
            {
              endpoint: 'https://example.test/fhir',
              endpointType: 'FHIR',
              endpointDescription: '',
              useOtherDescription: '  ',
              address_1: '1 Plain St',
            },
          ],
        },
      ],
    });
    const rec = await svc.getByNumber('1972944437', ctx);
    expect(rec?.createdEpoch).toBe(1373654494000);
    expect(rec?.lastUpdatedEpoch).toBe(1767735851000);
    expect(rec?.otherNames[0]).toMatchObject({
      firstName: 'KATHERINE',
      middleName: 'ANN',
      lastName: 'SMITH',
      type: 'Former Name',
    });
    // other_names prefix/suffix "--" placeholders dropped via the shared guard.
    expect(rec?.otherNames[0]?.prefix).toBeUndefined();
    expect(rec?.otherNames[0]?.suffix).toBeUndefined();
    expect(rec?.endpoints[0]).toMatchObject({
      endpoint: 'KatherineAbelPA@fpc.medentdirect.com',
      endpointType: 'DIRECT',
      endpointDescription: 'Carequality',
      use: 'HIE',
      useDescription: 'Health Information Exchange (HIE)',
      contentOtherDescription: 'C-CDA',
      line2: 'Suite 100',
      affiliation: 'Y',
      affiliationName: 'FAMILY PRACTICE CENTER, PC',
      addressType: 'DOM',
      line1: '225 N Front St',
      city: 'Steelton',
      state: 'PA',
      postalCode: '171132240',
      countryCode: 'US',
      countryName: 'United States',
    });
    // Empty contentTypeDescription is preserved as absence, never an empty string.
    expect(rec?.endpoints[0]?.contentTypeDescription).toBeUndefined();
    expect(rec?.endpoints[1]).toEqual({
      endpoint: 'esmd@example.test',
      endpointType: 'DIRECT',
      use: 'OTHER',
      useDescription: 'Other',
      useOtherDescription: 'CMS esMD eMDR',
    });
    // An endpoint without the description/second-line fields carries no such keys.
    expect(rec?.endpoints[2]).toEqual({
      endpoint: 'https://example.test/fhir',
      endpointType: 'FHIR',
      line1: '1 Plain St',
    });
  });

  it('decodes authorized-official name prefix/suffix and reuses the "--" guard (#6/#9)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1234567890,
          enumeration_type: 'NPI-2',
          basic: {
            organization_name: 'SEATTLE CLINIC LLC',
            authorized_official_first_name: 'PAT',
            authorized_official_last_name: 'SMITH',
            authorized_official_name_prefix: '--',
            authorized_official_name_suffix: 'Jr.',
            authorized_official_title_or_position: 'CEO',
            status: 'A',
          },
          taxonomies: [],
        },
      ],
    });
    const rec = await svc.getByNumber('1234567890', ctx);
    expect(rec?.authorizedOfficial?.namePrefix).toBeUndefined(); // "--" dropped
    expect(rec?.authorizedOfficial?.nameSuffix).toBe('Jr.'); // real value kept
  });
});

describe('NppesService individual mailing-address withholding (#14)', () => {
  const MAILING = {
    address_purpose: 'MAILING',
    address_type: 'DOM',
    address_1: '123 PRIVATE HOME LANE',
    address_2: 'APT 4',
    city: 'SEATTLE',
    state: 'WA',
    postal_code: '981010000',
    telephone_number: '206-555-0101',
    fax_number: '206-555-0109',
  };
  const LOCATION = {
    address_purpose: 'LOCATION',
    address_type: 'DOM',
    address_1: '500 CLINIC AVE',
    city: 'SEATTLE',
    state: 'WA',
    postal_code: '981020000',
    telephone_number: '206-555-0102',
    fax_number: '206-555-0103',
  };
  const LOCATION_ROW = {
    purpose: 'LOCATION',
    addressType: 'DOM',
    line1: '500 CLINIC AVE',
    city: 'SEATTLE',
    state: 'WA',
    postalCode: '981020000',
    telephoneNumber: '206-555-0102',
    faxNumber: '206-555-0103',
  };

  function individual(addresses: unknown[]) {
    return {
      result_count: 1,
      results: [
        {
          number: '1720034424',
          enumeration_type: 'NPI-1',
          basic: { first_name: 'CASEY', last_name: 'CLINICIAN', status: 'A' },
          addresses,
          practiceLocations: [
            { address_purpose: 'LOCATION', address_1: '600 SATELLITE WAY', city: 'BELLEVUE' },
          ],
        },
      ],
    };
  }

  it.each([
    ['MAILING first', [MAILING, LOCATION]],
    ['LOCATION first', [LOCATION, MAILING]],
  ])('keeps only the LOCATION row of an individual (%s)', async (_order, addresses) => {
    stubJson(individual(addresses));
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.addresses).toEqual([LOCATION_ROW]);
    for (const leaked of [
      'PRIVATE HOME LANE',
      'APT 4',
      '981010000',
      '206-555-0101',
      '206-555-0109',
    ]) {
      expect(JSON.stringify(rec?.addresses)).not.toContain(leaked);
    }
    // practiceLocations are practice data and pass through unchanged.
    expect(rec?.practiceLocations).toEqual([
      { purpose: 'LOCATION', line1: '600 SATELLITE WAY', city: 'BELLEVUE' },
    ]);
  });

  it('withholds an individual address row whose purpose is not LOCATION', async () => {
    const { address_purpose: _purpose, ...unlabelled } = MAILING;
    stubJson(individual([unlabelled, LOCATION]));
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.addresses).toEqual([LOCATION_ROW]);
  });

  it('returns no addresses for an individual whose only row is MAILING', async () => {
    stubJson(individual([MAILING]));
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec?.addresses).toEqual([]);
  });
});

describe('NppesService malformed-response boundary (#15)', () => {
  const GOOD_RESULT = {
    number: '1720034424',
    enumeration_type: 'NPI-1',
    basic: { first_name: 'JOSEPH', last_name: 'ABATE', status: 'A' },
  };

  /**
   * Run a call whose retry backoff is driven by fake timers, so a retried
   * malformed body settles without waiting out the real delays.
   */
  async function outcomeOf<T>(run: () => Promise<T>) {
    vi.useFakeTimers();
    const outcome = run().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  function withResult(overrides: Record<string, unknown>) {
    return { result_count: 1, results: [{ ...GOOD_RESULT, ...overrides }] };
  }

  const ARRAY_KEYS = [
    'taxonomies',
    'addresses',
    'practiceLocations',
    'identifiers',
    'other_names',
    'endpoints',
  ] as const;

  const MALFORMED: [string, unknown][] = [
    ['a null body', null],
    ['an array body', []],
    ['a non-array Errors', { Errors: {} }],
    ['an empty Errors array', { Errors: [] }],
    ['an Errors element that is not an object', { Errors: [null] }],
    ['an envelope with no results', {}],
    ['a zero count with no results', { result_count: 0 }],
    ['an object results', { result_count: 1, results: {} }],
    ['a null result', { result_count: 1, results: [null] }],
    ['an empty result', { result_count: 1, results: [{}] }],
    ['a missing number', withResult({ number: undefined })],
    ['a nine-digit number', withResult({ number: '172003442' })],
    ['a non-numeric number', withResult({ number: '172003442A' })],
    ['an unknown enumeration_type', withResult({ enumeration_type: 'NPI-3' })],
    ['a missing enumeration_type', withResult({ enumeration_type: undefined })],
    ['a missing basic', withResult({ basic: undefined })],
    ['a non-object basic', withResult({ basic: 'A' })],
    ['a missing status', withResult({ basic: { first_name: 'UNKNOWN', last_name: 'STATUS' } })],
    ['an unknown status', withResult({ basic: { last_name: 'X', status: 'X' } })],
    ...ARRAY_KEYS.map((key): [string, unknown] => [
      `a non-array ${key}`,
      withResult({ [key]: {} }),
    ]),
    // A bad element anywhere in the array — after a well-formed one, too.
    ...ARRAY_KEYS.flatMap((key): [string, unknown][] => [
      [`a null ${key} element`, withResult({ [key]: [null] })],
      [`a string ${key} element`, withResult({ [key]: [{}, 'text'] })],
      [`an array ${key} element`, withResult({ [key]: [[]] })],
    ]),
    // A taxonomy's code is its identity; normalization would otherwise fabricate `code: ""`.
    ['a taxonomy with no code', withResult({ taxonomies: [{ desc: 'Internal Medicine' }] })],
    ['a taxonomy with a null code', withResult({ taxonomies: [{ code: null }] })],
    ['a taxonomy with an empty code', withResult({ taxonomies: [{ code: '' }] })],
    ['a taxonomy with a blank code', withResult({ taxonomies: [{ code: '   ' }] })],
    ['a taxonomy with a numeric code', withResult({ taxonomies: [{ code: 207 }] })],
    [
      'a codeless taxonomy after a well-formed one',
      withResult({ taxonomies: [{ code: '207R00000X', primary: true }, { desc: 'Cardiology' }] }),
    ],
  ];

  it.each(MALFORMED)(
    'retries %s, then throws ServiceUnavailable — never a record or a miss',
    async (_label, body) => {
      const fetchSpy = primeFetch(body, body, body, body);
      const outcome = await outcomeOf(() => svc.getByNumber('1720034424', ctx));
      expect(outcome).not.toHaveProperty('value');
      const { error } = outcome as { error: McpError };
      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toMatch(/malformed/i);
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    },
  );

  it('fails the whole search when one row is malformed rather than dropping it', async () => {
    const body = {
      result_count: 2,
      results: [GOOD_RESULT, { ...GOOD_RESULT, number: '1234567893', basic: { status: 'Q' } }],
    };
    primeFetch(body, body, body, body);
    const outcome = await outcomeOf(() =>
      svc.search({ lastName: 'ABATE', limit: 10, skip: 0 }, ctx),
    );
    expect(outcome).not.toHaveProperty('value');
    expect((outcome as { error: McpError }).error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('recovers when a retried attempt returns a well-formed body', async () => {
    const fetchSpy = primeFetch({ result_count: 1, results: [{}] }, withResult({}));
    const outcome = await outcomeOf(() => svc.getByNumber('1720034424', ctx));
    expect(outcome).toMatchObject({ value: { npi: '1720034424', name: 'JOSEPH ABATE' } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats non-string scalars inside well-formed elements as absent, never throwing', async () => {
    stubJson(
      withResult({
        basic: { first_name: 42, last_name: 'ABATE', credential: false, status: 'A' },
        created_epoch: { at: 1 },
        taxonomies: [{ code: '207R00000X', desc: 7, primary: 'yes', license: 123 }],
        addresses: [{ address_purpose: 'LOCATION', address_1: '1 MAIN ST', city: 98101 }],
        practiceLocations: [{ address_purpose: 7, address_1: [] }],
        identifiers: [{ identifier: 12345 }, { identifier: 'WA-1', desc: {} }],
        other_names: [{ first_name: null, type: 'Former Name' }],
        endpoints: [{ endpoint: 99 }, { endpoint: 'https://example.test/fhir', address_2: 5 }],
      }),
    );
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec).toEqual({
      npi: '1720034424',
      type: 'individual',
      status: 'active',
      name: 'ABATE',
      lastName: 'ABATE',
      taxonomies: [{ code: '207R00000X', primary: false }],
      addresses: [{ purpose: 'LOCATION', line1: '1 MAIN ST' }],
      practiceLocations: [{}],
      identifiers: [{ identifier: 'WA-1' }],
      otherNames: [{ type: 'Former Name' }],
      endpoints: [{ endpoint: 'https://example.test/fhir' }],
    });
  });

  it('accepts a deactivated (D) record and passes unrecognized basic keys through untouched', async () => {
    stubJson(withResult({ basic: { last_name: 'X', status: 'D', replacement_npi: '1234567893' } }));
    const rec = await svc.getByNumber('1720034424', ctx);
    expect(rec).toMatchObject({ npi: '1720034424', status: 'deactivated', type: 'individual' });
  });
});

describe('NppesService Errors[]-on-200 detection', () => {
  it('maps number:04 (no criteria) to no_search_criteria and is non-retryable', async () => {
    const fetchSpy = stubJson({
      Errors: [{ description: 'No valid search criteria', field: '', number: '04' }],
    });
    const err = await svc.search({ limit: 10, skip: 0 }, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('no_search_criteria');
    expect(err.data.retryable).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('maps number:06 (NPI not 10 digits) to invalid_npi_format', async () => {
    stubJson({ Errors: [{ description: 'NPI must be 10 digits', field: 'number', number: '06' }] });
    const err = await svc.getByNumber('123', ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_npi_format');
  });

  it('maps other field errors (e.g. number:07) to invalid_search_field', async () => {
    stubJson({
      Errors: [{ description: 'State requires additional criteria', field: 'state', number: '07' }],
    });
    const err = await svc.search({ state: 'WA', limit: 10, skip: 0 }, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('invalid_search_field');
  });
});

describe('NppesService.search', () => {
  /** The query string of the one registry request a search made. */
  function sentQuery(fetchSpy: ReturnType<typeof vi.fn>): Record<string, string> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    return Object.fromEntries(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams);
  }

  it.each([
    ['city + state', { city: 'SEATTLE', state: 'WA' }, { city: 'SEATTLE', state: 'WA' }],
    ['postal code alone', { postalCode: '98195' }, { postal_code: '98195' }],
    ['state + last name', { state: 'WA', lastName: 'SMITH' }, { state: 'WA', last_name: 'SMITH' }],
  ])(
    'restricts a location search (%s) to practice addresses upstream (#19)',
    async (_label, params, expected) => {
      const fetchSpy = stubJson({ result_count: 0, results: [] });
      await svc.search({ ...params, limit: 10, skip: 0 }, ctx);
      expect(sentQuery(fetchSpy)).toEqual({
        version: '2.1',
        limit: '10',
        skip: '0',
        ...expected,
        address_purpose: 'LOCATION',
      });
    },
  );

  it('sends no address_purpose on a search without a location field (#19)', async () => {
    const fetchSpy = stubJson({ result_count: 0, results: [] });
    await svc.search(
      { lastName: 'SMITH', taxonomyDescription: 'Cardiovascular Disease', limit: 10, skip: 0 },
      ctx,
    );
    expect(sentQuery(fetchSpy)).toEqual({
      version: '2.1',
      limit: '10',
      skip: '0',
      last_name: 'SMITH',
      taxonomy_description: 'Cardiovascular Disease',
    });
  });

  it('returns compact summary rows', async () => {
    stubJson(FULL_INDIVIDUAL);
    const rows = await svc.search(
      { taxonomyDescription: 'Cardiovascular Disease', state: 'WA', limit: 10, skip: 0 },
      ctx,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      npi: '1720034424',
      type: 'individual',
      status: 'active',
      name: 'JOSEPH A ABATE',
      credential: 'MD',
      city: 'Seattle',
      state: 'WA',
    });
    expect(rows[0]?.primaryTaxonomy?.code).toBe('207RC0000X');
  });

  it('returns an empty array when the registry returns no results', async () => {
    stubJson({ result_count: 0, results: [] });
    expect(await svc.search({ lastName: 'zzzznosuchname', limit: 10, skip: 0 }, ctx)).toEqual([]);
  });

  it('normalizes an organization summary and falls back to its first taxonomy', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: 1234567893,
          enumeration_type: 'NPI-2',
          basic: { name: 'FALLBACK HEALTH', status: 'A' },
          taxonomies: [
            { code: '193200000X', desc: 'Multi-Specialty', primary: false },
            { code: '193400000X', desc: 'Single Specialty', primary: false },
          ],
          addresses: [
            { address_purpose: 'MAILING', city: 'TACOMA', state: 'WA' },
            { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '98102' },
          ],
        },
      ],
    });
    const rows = await svc.search({ organizationName: 'Fallback Health', limit: 10, skip: 0 }, ctx);
    expect(rows[0]).toMatchObject({
      npi: '1234567893',
      type: 'organization',
      name: 'FALLBACK HEALTH',
      city: 'SEATTLE',
      primaryTaxonomy: { code: '193200000X', description: 'Multi-Specialty' },
    });
  });

  it.each([
    ['individual', 'NPI-1'],
    ['organization', 'NPI-2'],
  ])(
    'takes an %s row location from LOCATION only, in either address order (#14)',
    async (_type, enumerationType) => {
      const mailing = {
        address_purpose: 'MAILING',
        city: 'TACOMA',
        state: 'OR',
        postal_code: '974010000',
      };
      const location = {
        address_purpose: 'LOCATION',
        city: 'SEATTLE',
        state: 'WA',
        postal_code: '981020000',
      };
      const record = (addresses: unknown[]) => ({
        number: '1720034424',
        enumeration_type: enumerationType,
        basic: { last_name: 'ABATE', organization_name: 'ABATE CLINIC', status: 'A' },
        addresses,
      });
      stubJson({
        result_count: 2,
        results: [record([mailing, location]), record([location, mailing])],
      });
      const rows = await svc.search({ lastName: 'ABATE', limit: 10, skip: 0 }, ctx);
      for (const row of rows) {
        expect(row).toMatchObject({ city: 'SEATTLE', state: 'WA', postalCode: '981020000' });
      }
    },
  );

  it("exposes each practice location's city/state/ZIP, in upstream order, preserving absence (#18)", async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: '1679937908',
          enumeration_type: 'NPI-1',
          basic: { last_name: 'SURGEON', status: 'A' },
          addresses: [
            { address_purpose: 'LOCATION', city: 'SAINT LOUIS', state: 'MO' },
            { address_purpose: 'MAILING', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
          ],
          practiceLocations: [
            {
              address_purpose: 'LOCATION',
              address_1: '1959 NE PACIFIC ST',
              city: 'SEATTLE',
              state: 'WA',
              postal_code: '981956410',
              telephone_number: '206-555-0100',
            },
            { address_purpose: 'LOCATION', city: ' TACOMA ', postal_code: '' },
          ],
        },
      ],
    });
    const [row] = await svc.search({ city: 'SEATTLE', limit: 10, skip: 0 }, ctx);
    expect(row).toMatchObject({ city: 'SAINT LOUIS', state: 'MO' });
    expect(row?.practiceLocations).toEqual([
      { city: 'SEATTLE', state: 'WA', postalCode: '981956410' },
      { city: 'TACOMA' },
    ]);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', []],
  ])(
    'gives an empty practiceLocations list when it is %s (#18)',
    async (_label, practiceLocations) => {
      stubJson({
        result_count: 1,
        results: [
          {
            number: '1720034424',
            enumeration_type: 'NPI-1',
            basic: { last_name: 'ABATE', status: 'A' },
            practiceLocations,
          },
        ],
      });
      const [row] = await svc.search({ lastName: 'ABATE', limit: 10, skip: 0 }, ctx);
      expect(row?.practiceLocations).toEqual([]);
    },
  );

  it('leaves city/state/postalCode absent when a row has no LOCATION address (#14)', async () => {
    stubJson({
      result_count: 1,
      results: [
        {
          number: '1720034424',
          enumeration_type: 'NPI-1',
          basic: { last_name: 'ABATE', status: 'A' },
          addresses: [
            { address_purpose: 'MAILING', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
          ],
        },
      ],
    });
    const [row] = await svc.search({ lastName: 'ABATE', limit: 10, skip: 0 }, ctx);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('city');
    expect(row).not.toHaveProperty('state');
    expect(row).not.toHaveProperty('postalCode');
  });
});

// ── #26: rows matched through an other name ──────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/26

describe('NppesService.search other-name matches (#26)', () => {
  type Criteria = { firstName?: string; lastName?: string; organizationName?: string };

  /** One search over a single registry row; returns its summary. */
  async function searchOne(criteria: Criteria, basic: object, otherNames: object[] = []) {
    stubJson({
      result_count: 1,
      results: [
        {
          number: '1437702123',
          enumeration_type: 'organizationName' in criteria ? 'NPI-2' : 'NPI-1',
          basic: { ...basic, status: 'A' },
          other_names: otherNames,
        },
      ],
    });
    const [row] = await svc.search({ ...criteria, limit: 10, skip: 0 }, ctx);
    return row;
  }

  // Row shapes below are live NPPES rows (names, other-name types) from 2026-09-24 probes.
  it.each([
    [
      'current last name differs, a former name matches it',
      { lastName: 'Smith' },
      { first_name: 'MICALA', last_name: 'ABBIATI' },
      [{ code: '1', type: 'Former Name', first_name: 'MICALA', last_name: 'SMITH', prefix: '--' }],
      { name: 'MICALA SMITH', type: 'Former Name' },
    ],
    [
      'a hyphenated current surname is not the requested one',
      { lastName: 'Smith' },
      { first_name: 'KENDRA', last_name: 'BLACK-SMITH' },
      [{ type: 'Former Name', first_name: 'KENDRA', last_name: 'SMITH' }],
      { name: 'KENDRA SMITH', type: 'Former Name' },
    ],
    [
      'a wildcard first name fails the current name and matches an other name',
      { firstName: 'JO*', lastName: 'Smith' },
      { first_name: 'DEBRA', last_name: 'SMITH' },
      [{ type: 'Other Name', first_name: 'JODI', middle_name: 'B', last_name: 'JOHNSON' }],
      { name: 'JODI B JOHNSON', type: 'Other Name' },
    ],
    [
      'a wildcard last name fails the current name',
      { lastName: 'Smit*' },
      { first_name: 'ALEXANDRA', last_name: 'AINSLIE' },
      [{ type: 'Former Name', first_name: 'ALEXANDRA', last_name: 'SMITH' }],
      { name: 'ALEXANDRA SMITH', type: 'Former Name' },
    ],
    [
      'an apostrophe name matched only through an other name',
      { lastName: "O'Brien" },
      { first_name: 'SUSAN', last_name: "BONE O'BRIEN" },
      [{ type: 'Other Name', first_name: 'SUSAN', last_name: "O'BRIEN" }],
      { name: "SUSAN O'BRIEN", type: 'Other Name' },
    ],
    [
      'an organization matched through another organization name',
      { organizationName: 'Swedish Medical Center' },
      { organization_name: 'CAREPOINT HOSPITAL MEDICINE, PLLC' },
      [{ type: 'Other Name', organization_name: 'SWEDISH MEDICAL CENTER' }],
      { name: 'SWEDISH MEDICAL CENTER', type: 'Other Name' },
    ],
    [
      'several other names: the one satisfying every requested field',
      { firstName: 'Anna', lastName: 'Smith' },
      { first_name: 'ANNA', last_name: 'BAKER' },
      [
        { type: 'Former Name', first_name: 'JANE', last_name: 'SMITH' },
        { type: 'Former Name', first_name: 'ANNA', last_name: 'SMITH' },
      ],
      { name: 'ANNA SMITH', type: 'Former Name' },
    ],
    [
      'an other name with no type',
      { lastName: 'Smith' },
      { first_name: 'JAN', last_name: 'DOE' },
      [{ first_name: 'JAN', last_name: 'SMITH' }],
      { name: 'JAN SMITH' },
    ],
  ])('names the other name when %s', async (_label, criteria, basic, otherNames, expected) => {
    const row = await searchOne(criteria, basic, otherNames);
    expect(row?.matchedOtherName).toEqual(expected);
  });

  it.each([
    [
      'the current name matches (other names present)',
      { lastName: 'Smith' },
      { first_name: 'JANE', last_name: 'SMITH' },
      [{ type: 'Former Name', first_name: 'JANE', last_name: 'SMITH' }],
    ],
    [
      'the current first name matches only through a first-name alias',
      { firstName: 'Robert', lastName: 'Smith' },
      { first_name: 'ROB', last_name: 'SMITH' },
      [{ type: 'Professional Name', first_name: 'ROBERT', last_name: 'SMITH' }],
    ],
    [
      'an exact first name differs but the registry may alias it (never decisive)',
      { firstName: 'Robert', lastName: 'Smith' },
      { first_name: 'KENYONA', last_name: 'SMITH' },
      [{ type: 'Professional Name', first_name: 'ROBERT', last_name: 'BUFORD' }],
    ],
    [
      'the current last name matches a wildcard prefix',
      { lastName: 'Smit*' },
      { first_name: 'ANN', last_name: 'SMITHSON' },
      [{ type: 'Former Name', first_name: 'ANN', last_name: 'SMITH' }],
    ],
    [
      'the current name matches ignoring case and punctuation',
      { lastName: 'OBrien' },
      { first_name: 'PAT', last_name: "O'BRIEN" },
      [{ type: 'Other Name', first_name: 'PAT', last_name: 'OBRIEN' }],
    ],
    [
      'the current name matches ignoring spaces',
      { lastName: 'DeLaCruz' },
      { first_name: 'ANA', last_name: 'DE LA CRUZ' },
      [{ type: 'Former Name', first_name: 'ANA', last_name: 'DELACRUZ' }],
    ],
    [
      'no other name explains the match',
      { lastName: 'Smith' },
      { first_name: 'LEE', last_name: 'JONES' },
      [{ type: 'Former Name', first_name: 'LEE', last_name: 'BROWN' }],
    ],
    [
      'the search has no name criterion',
      {},
      { first_name: 'LEE', last_name: 'JONES' },
      [{ type: 'Former Name', first_name: 'LEE', last_name: 'SMITH' }],
    ],
  ])('adds no matchedOtherName when %s', async (_label, criteria, basic, otherNames) => {
    const row = await searchOne(criteria, basic, otherNames);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('matchedOtherName');
  });
});
