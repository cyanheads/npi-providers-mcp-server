/**
 * @fileoverview Tests for the NPPES service — raw→domain normalization (full and
 * sparse payloads), the Errors[]-on-HTTP-200 detector and reason mapping, and
 * empty-result handling. The global `fetch` is stubbed so no live API is hit.
 * @module tests/services/nppes/nppes-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NppesService } from '@/services/nppes/nppes-service.js';

const svc = new NppesService('https://npiregistry.cms.hhs.gov/api', 15000);
const ctx = createMockContext();

/** Stub global fetch to return a single JSON body as an HTTP 200. */
function stubJson(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

afterEach(() => {
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
          number: 1,
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
              use: 'HIE',
              useDescription: 'Health Information Exchange (HIE)',
              contentTypeDescription: '',
              affiliation: 'Y',
              affiliationName: 'FAMILY PRACTICE CENTER, PC',
              address_1: '225 N Front St',
              address_type: 'DOM',
              city: 'Steelton',
              state: 'PA',
              postal_code: '171132240',
              country_code: 'US',
              country_name: 'United States',
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
      use: 'HIE',
      useDescription: 'Health Information Exchange (HIE)',
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

describe('NppesService Errors[]-on-200 detection', () => {
  it('maps number:04 (no criteria) to no_search_criteria and is non-retryable', async () => {
    stubJson({ Errors: [{ description: 'No valid search criteria', field: '', number: '04' }] });
    const err = await svc.search({ limit: 10, skip: 0 }, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_search_criteria');
    expect(err.data.retryable).toBe(false);
  });

  it('maps number:06 (NPI not 10 digits) to invalid_npi_format', async () => {
    stubJson({ Errors: [{ description: 'NPI must be 10 digits', field: 'number', number: '06' }] });
    const err = await svc.getByNumber('123', ctx).catch((e) => e);
    expect(err.data.reason).toBe('invalid_npi_format');
  });

  it('maps other field errors (e.g. number:07) to invalid_search_field', async () => {
    stubJson({
      Errors: [{ description: 'State requires additional criteria', field: 'state', number: '07' }],
    });
    const err = await svc.search({ state: 'WA', limit: 10, skip: 0 }, ctx).catch((e) => e);
    expect(err.data.reason).toBe('invalid_search_field');
  });
});

describe('NppesService.search', () => {
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
});
