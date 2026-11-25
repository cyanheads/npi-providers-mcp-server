/**
 * @fileoverview Tests for the npi_get_provider tool — single/batch fan-out,
 * partial success (found/notFound), none_found contract, and format() parity.
 * The global `fetch` is stubbed (keyed by the `number=` query param) so no live
 * API is hit.
 * @module tests/mcp-server/tools/get-provider.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createGetProviderTool,
  getProviderTool,
} from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { initNppesService, NppesService } from '@/services/nppes/nppes-service.js';
import type { ProviderRecord } from '@/services/nppes/types.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import {
  blockTypes,
  expectReadsBack,
  PRESETS,
  readLines,
  readMarkdown,
} from '../../helpers/markdown-readback.js';

beforeAll(() => {
  initTaxonomyService();
  initNppesService();
});

const ctx = () => createMockContext({ errors: getProviderTool.errors });

function recordFor(npi: string) {
  return {
    number: Number(npi),
    enumeration_type: 'NPI-1',
    basic: { first_name: 'TEST', last_name: 'PROVIDER', status: 'A' },
    taxonomies: [{ code: '207R00000X', desc: 'Internal Medicine', primary: true }],
    addresses: [{ address_purpose: 'LOCATION', city: 'Seattle', state: 'WA' }],
  };
}

/** Stub fetch so specific NPIs resolve and others return empty results. */
function stubByNpi(knownNpis: Set<string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const number = new URL(String(url)).searchParams.get('number') ?? '';
      const results = knownNpis.has(number) ? [recordFor(number)] : [];
      return new Response(JSON.stringify({ result_count: results.length, results }), {
        status: 200,
      });
    }),
  );
}

/**
 * Stub fetch keyed by the `number=` param: a raw result answers with that record,
 * `null` answers with a confirmed miss, and any other NPI rejects — so an NPI the
 * handler should never look up surfaces as a failure, and nothing reaches the live registry.
 */
function stubRaw(byNpi: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (url: string | URL) => {
    const number = new URL(String(url)).searchParams.get('number') ?? '';
    if (!(number in byNpi)) throw new Error('unmocked fetch');
    const raw = byNpi[number];
    const results = raw === null ? [] : [raw];
    return new Response(JSON.stringify({ result_count: results.length, results }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function requestedNpis(fetchSpy: ReturnType<typeof vi.fn>): string[] {
  return fetchSpy.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('number') ?? '');
}

function textOf(blocks: ReturnType<NonNullable<typeof getProviderTool.format>>): string {
  return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** Ten distinct NPIs with valid check digits. */
const TEN_VALID_NPIS = [
  '1720034408',
  '1720034416',
  '1720034424',
  '1720034432',
  '1720034440',
  '1720034457',
  '1720034465',
  '1720034473',
  '1720034481',
  '1720034499',
];

const MAILING = {
  address_purpose: 'MAILING',
  address_1: '123 PRIVATE HOME LANE',
  city: 'SEATTLE',
  state: 'WA',
  postal_code: '981010000',
  telephone_number: '206-555-0101',
};
const LOCATION = {
  address_purpose: 'LOCATION',
  address_1: '500 CLINIC AVE',
  city: 'SEATTLE',
  state: 'WA',
  postal_code: '981020000',
  telephone_number: '206-555-0102',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getProviderTool', () => {
  it('characterizes confirmed misses separately from operational failures', async () => {
    vi.spyOn(NppesService.prototype, 'getByNumber').mockImplementation(async (npi) => {
      if (npi === '1720034424') return null;
      throw serviceUnavailable('Registry unavailable', {
        reason: 'upstream_probe',
        retryable: true,
      });
    });
    const result = await runToolContract(getProviderTool, { npis: ['1720034424', '1999999984'] });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_probe', retryable: true },
        },
      },
    });
    expect(textOf(result.content)).toContain('Registry unavailable');
  });
  it('decodes a single NPI', async () => {
    stubByNpi(new Set(['1720034424']));
    const input = getProviderTool.input.parse({ npis: '1720034424' });
    const c = ctx();
    const result = await getProviderTool.handler(input, c);
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.npi).toBe('1720034424');
    expect(result.notFound).toEqual([]);
    expect(getEnrichment(c)).toMatchObject({ totalCount: 1 });
  });

  it('reports partial success: some found, some not', async () => {
    stubByNpi(new Set(['1720034424']));
    const input = getProviderTool.input.parse({ npis: ['1720034424', '1234567893'] });
    const c = ctx();
    const result = await getProviderTool.handler(input, c);
    expect(result.found).toHaveLength(1);
    expect(result.notFound).toHaveLength(1);
    expect(result.notFound[0]?.npi).toBe('1234567893');
    expect(getEnrichment(c).notice).toBeDefined();
  });

  it('throws none_found only when every NPI is a confirmed miss (result_count 0)', async () => {
    stubByNpi(new Set());
    const input = getProviderTool.input.parse({ npis: ['1234567893', '1111111112'] });
    await expect(getProviderTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'none_found' },
    });
  });

  it('surfaces the real upstream error, not none_found, when every lookup fails (#8)', async () => {
    vi.spyOn(NppesService.prototype, 'getByNumber').mockRejectedValue(
      serviceUnavailable('NPPES registry unavailable — connection refused.'),
    );
    const input = getProviderTool.input.parse({ npis: ['1720034424', '1999999984'] });
    const err = (await Promise.resolve(getProviderTool.handler(input, ctx())).catch(
      (error: unknown) => error,
    )) as McpError;
    // An operational failure must never masquerade as a confirmed miss.
    expect(err?.data?.reason).not.toBe('none_found');
    expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(String(err?.message)).toContain('unavailable');
  });

  it('returns found records and surfaces failed NPIs in errored on a mixed batch (#8)', async () => {
    vi.spyOn(NppesService.prototype, 'getByNumber').mockImplementation(async (npi: string) => {
      if (npi === '1720034424') {
        return {
          npi,
          type: 'individual',
          status: 'active',
          name: 'TEST PROVIDER',
          taxonomies: [],
          addresses: [],
          practiceLocations: [],
          identifiers: [],
          otherNames: [],
          endpoints: [],
        } satisfies ProviderRecord;
      }
      throw serviceUnavailable('NPPES registry timed out.');
    });
    const input = getProviderTool.input.parse({ npis: ['1720034424', '1999999984'] });
    const c = ctx();
    const result = await getProviderTool.handler(input, c);
    expect(result.found).toHaveLength(1);
    expect(result.found[0]?.npi).toBe('1720034424');
    // The failed NPI is surfaced honestly — not silently dropped, not a confirmed miss.
    expect(result.notFound).toEqual([]);
    expect(result.errored).toHaveLength(1);
    expect(result.errored[0]?.npi).toBe('1999999984');
    expect(result.errored[0]?.reason).toContain('timed out');
    expect(getEnrichment(c).notice).toBeDefined();
  });

  it('de-duplicates repeated NPIs', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const number = new URL(String(url)).searchParams.get('number') ?? '';
      return new Response(JSON.stringify({ result_count: 1, results: [recordFor(number)] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const input = getProviderTool.input.parse({ npis: ['1720034424', '1720034424'] });
    const result = await getProviderTool.handler(input, ctx());
    expect(result.found).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed NPI at the schema boundary (before any call)', () => {
    expect(() => getProviderTool.input.parse({ npis: '123' })).toThrow();
    expect(() => getProviderTool.input.parse({ npis: ['1720034424', 'abc'] })).toThrow();
  });

  it('deduplicates eleven raw copies before limiting lookups', async () => {
    const fetchSpy = stubRaw({ '1720034424': recordFor('1720034424') });
    const result = await runToolContract(getProviderTool, { npis: Array(11).fill('1720034424') });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ found: [{ npi: '1720034424' }] });
    expect(result.structuredContent).not.toHaveProperty('unprocessed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('partitions invalid NPIs before limiting ten distinct valid lookups', async () => {
    const fetchSpy = stubRaw(Object.fromEntries(TEN_VALID_NPIS.map((n) => [n, recordFor(n)])));
    const result = await runToolContract(getProviderTool, {
      npis: ['1720034425', ...TEN_VALID_NPIS, '1548603301', '1234567893', '1720034423'],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: expect.any(Array),
      invalid: [{ npi: '1720034425' }, { npi: '1720034423' }],
      unprocessed: ['1548603301', '1234567893'],
    });
    expect(requestedNpis(fetchSpy)).toEqual(TEN_VALID_NPIS);
    const text = textOf(result.content);
    for (const npi of ['1548603301', '1234567893', '1720034425', '1720034423'])
      expect(text).toContain(npi);
    expect(text).toContain('Unprocessed');
  });

  it('keeps invalid and unprocessed identifiers on both none_found error surfaces', async () => {
    const fetchSpy = stubRaw(Object.fromEntries(TEN_VALID_NPIS.map((n) => [n, null])));
    const result = await runToolContract(getProviderTool, {
      npis: [...TEN_VALID_NPIS, '1548603301', '1720034425'],
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'none_found',
            invalid: [{ npi: '1720034425' }],
            unprocessed: ['1548603301'],
            recovery: { hint: expect.any(String) },
          },
        },
      },
    });
    expect(textOf(result.content)).toContain('1548603301');
    expect(textOf(result.content)).toContain('1720034425');
    expect(requestedNpis(fetchSpy)).toEqual(TEN_VALID_NPIS);
  });

  it('preserves upstream classification, recovery and cause with invalids and overflow', async () => {
    const failure = serviceUnavailable('Registry unavailable', {
      reason: 'upstream_probe',
      retryable: true,
      recovery: { hint: 'Retry the registry later.' },
    });
    const lookup = vi
      .spyOn(NppesService.prototype, 'getByNumber')
      .mockImplementation(async (npi) => {
        if (npi === TEN_VALID_NPIS[0]) throw failure;
        return null;
      });
    const input = { npis: [...TEN_VALID_NPIS, '1548603301', '1720034425'] };
    const caught = await Promise.resolve(
      getProviderTool.handler(getProviderTool.input.parse(input), ctx()),
    ).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: failure.code,
      cause: failure,
      data: {
        reason: 'upstream_probe',
        retryable: true,
        recovery: failure.data?.recovery,
        invalid: [{ npi: '1720034425' }],
        unprocessed: ['1548603301'],
      },
    });
    const result = await runToolContract(getProviderTool, input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: failure.code,
          data: { reason: 'upstream_probe', retryable: true, recovery: failure.data?.recovery },
        },
      },
    });
    for (const value of [
      'Registry unavailable',
      '1720034425',
      '1548603301',
      'Retry the registry later.',
    ])
      expect(textOf(result.content)).toContain(value);
    expect(lookup).toHaveBeenCalledTimes(20);
  });

  it('retains every partial-success partition alongside the unprocessed remainder', async () => {
    vi.spyOn(NppesService.prototype, 'getByNumber').mockImplementation(async (npi) => {
      if (npi === TEN_VALID_NPIS[0]) throw serviceUnavailable('Unavailable');
      if (npi === TEN_VALID_NPIS[1]) return null;
      return {
        npi,
        type: 'individual',
        status: 'active',
        name: 'TEST',
        taxonomies: [],
        addresses: [],
        practiceLocations: [],
        identifiers: [],
        otherNames: [],
        endpoints: [],
      };
    });
    const result = await runToolContract(getProviderTool, {
      npis: [...TEN_VALID_NPIS, '1548603301', '1720034425'],
    });
    expect(result.structuredContent).toMatchObject({
      found: expect.any(Array),
      notFound: [{ npi: TEN_VALID_NPIS[1] }],
      errored: [{ npi: TEN_VALID_NPIS[0] }],
      invalid: [{ npi: '1720034425' }],
      unprocessed: ['1548603301'],
    });
    const text = textOf(result.content);
    for (const value of [...TEN_VALID_NPIS, '1548603301', '1720034425', 'Attempted 10'])
      expect(text).toContain(value);
  });

  it('enforces raw-entry boundaries and restores the ten-entry opt-out schema', () => {
    expect(getProviderTool.input.safeParse({ npis: Array(100).fill('1720034424') }).success).toBe(
      true,
    );
    for (const npis of [[], Array(101).fill('1720034424'), ['bad']])
      expect(getProviderTool.input.safeParse({ npis }).success).toBe(false);
    const strict = createGetProviderTool(false);
    expect(strict.input.safeParse({ npis: Array(10).fill('1720034424') }).success).toBe(true);
    expect(strict.input.safeParse({ npis: Array(11).fill('1720034424') }).success).toBe(false);
  });

  it('logs only actual valid overflow using distinct-valid and attempted counts', async () => {
    stubRaw(Object.fromEntries(TEN_VALID_NPIS.map((npi) => [npi, recordFor(npi)])));
    const overflow = ctx();
    const overflowLog = vi.spyOn(overflow.log, 'notice');
    await getProviderTool.handler(
      getProviderTool.input.parse({
        npis: ['1720034425', ...TEN_VALID_NPIS, '1548603301', '1548603301'],
      }),
      overflow,
    );
    expect(overflowLog).toHaveBeenCalledExactlyOnceWith('Tool limit clamped.', {
      tool: 'npi_get_provider',
      requested: 11,
      applied: 10,
    });
    for (const npis of [
      Array(11).fill(TEN_VALID_NPIS[0]),
      [...TEN_VALID_NPIS, '1720034425', '1720034423'],
    ]) {
      const context = ctx();
      const notice = vi.spyOn(context.log, 'notice');
      await getProviderTool.handler(getProviderTool.input.parse({ npis }), context);
      expect(notice).not.toHaveBeenCalled();
    }
  });

  it('format: renders the full record, new fields, and not-found/errored sections', () => {
    const blocks = getProviderTool.format!({
      found: [
        {
          npi: '1972944437',
          type: 'individual',
          status: 'active',
          name: 'KATHERINE SMITH',
          createdEpoch: 1373654494000,
          lastUpdatedEpoch: 1767735851000,
          taxonomies: [{ code: '207R00000X', description: 'Internal Medicine', primary: true }],
          addresses: [{ purpose: 'LOCATION', city: 'Seattle', state: 'WA' }],
          practiceLocations: [],
          identifiers: [],
          otherNames: [
            { type: 'Former Name', firstName: 'KATHERINE', middleName: 'ANN', lastName: 'SMITH' },
          ],
          endpoints: [
            {
              endpoint: 'katherine@example.com',
              endpointType: 'DIRECT',
              useDescription: 'Health Information Exchange (HIE)',
              affiliationName: 'FAMILY PRACTICE CENTER, PC',
              addressType: 'DOM',
              line1: '225 N Front St',
              city: 'Steelton',
              state: 'PA',
              postalCode: '171132240',
              countryName: 'United States',
            },
          ],
        },
        {
          npi: '1111111112',
          type: 'organization',
          status: 'active',
          name: 'MINIMAL CLINIC',
          authorizedOfficial: {},
          taxonomies: [],
          addresses: [],
          practiceLocations: [],
          identifiers: [],
          otherNames: [],
          endpoints: [],
        },
      ],
      notFound: [{ npi: '1234567893', reason: 'No record in the NPPES registry for this NPI.' }],
      errored: [
        { npi: '1999999984', reason: 'NPPES registry unavailable (failed after 4 attempts)' },
      ],
      invalid: [],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('1972944437');
    expect(text).toContain('Internal Medicine');
    // #9 new fields render (format-parity)
    expect(text).toContain('1373654494000'); // createdEpoch
    expect(text).toContain('ANN'); // other-name middle name
    expect(text).toContain('Health Information Exchange (HIE)'); // endpoint useDescription
    expect(text).toContain('225 N Front St'); // endpoint address line1
    expect(text).toContain('FAMILY PRACTICE CENTER, PC'); // endpoint affiliationName
    // Confirmed-miss partition
    expect(text).toContain('Not found');
    expect(text).toContain('1234567893');
    // #8 errored partition renders, distinct from not-found
    expect(text).toContain('Errored');
    expect(text).toContain('1999999984');
  });

  it('format: renders organization identity and every populated professional record section', () => {
    const blocks = getProviderTool.format!({
      found: [
        {
          npi: '1234567893',
          type: 'organization',
          status: 'active',
          name: 'EXAMPLE HEALTH SYSTEM',
          organizationName: 'EXAMPLE HEALTH SYSTEM LLC',
          soleProprietor: 'NO',
          organizationalSubpart: 'YES',
          enumerationDate: '2006-05-23',
          lastUpdated: '2026-01-01',
          certificationDate: '2026-01-02',
          authorizedOfficial: {
            namePrefix: 'Dr.',
            firstName: 'ALEX',
            middleName: 'Q',
            lastName: 'ADMIN',
            nameSuffix: 'Jr.',
            credential: 'MD',
            title: 'DIRECTOR',
            telephoneNumber: '206-555-0100',
          },
          taxonomies: [
            {
              code: '193200000X',
              description: 'Multi-Specialty',
              primary: false,
              license: 'ORG-123',
              state: 'WA',
              taxonomyGroup: '193200000X MULTI-SPECIALTY GROUP',
            },
          ],
          addresses: [
            {
              purpose: 'LOCATION',
              addressType: 'DOM',
              line1: '500 CLINIC AVE',
              line2: 'SUITE 200',
              city: 'SEATTLE',
              state: 'WA',
              postalCode: '98102',
              countryCode: 'US',
              countryName: 'United States',
              telephoneNumber: '206-555-0101',
              faxNumber: '206-555-0102',
            },
          ],
          practiceLocations: [
            {
              purpose: 'LOCATION',
              line1: '600 SATELLITE WAY',
              city: 'BELLEVUE',
              state: 'WA',
            },
          ],
          identifiers: [
            {
              code: '05',
              description: 'MEDICAID',
              identifier: 'WA-999',
              issuer: 'Washington HCA',
              state: 'WA',
            },
          ],
          otherNames: [
            {
              type: 'Former Legal Business Name',
              organizationName: 'EXAMPLE CLINIC',
              credential: 'DBA',
            },
          ],
          endpoints: [
            {
              endpoint: 'https://example.test/fhir',
              endpointType: 'FHIR',
              endpointTypeDescription: 'FHIR URL',
              use: 'HIE',
              useDescription: 'Health Information Exchange',
              contentType: 'FHIR',
              contentTypeDescription: 'FHIR R4',
              affiliation: 'Y',
              affiliationName: 'EXAMPLE HEALTH SYSTEM',
              addressType: 'DOM',
              line1: '500 CLINIC AVE',
              city: 'SEATTLE',
              state: 'WA',
              postalCode: '98102',
              countryCode: 'US',
              countryName: 'United States',
            },
          ],
        },
      ],
      notFound: [],
      errored: [],
      invalid: [],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    for (const expected of [
      'EXAMPLE HEALTH SYSTEM LLC',
      'Dr. ALEX Q ADMIN Jr.',
      'ORG-123',
      'SUITE 200',
      'Washington HCA',
      'EXAMPLE CLINIC',
      'FHIR R4',
      'United States',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('keeps an organization MAILING row in structuredContent and the rendered text (#14)', async () => {
    stubRaw({
      '1234567893': {
        number: '1234567893',
        enumeration_type: 'NPI-2',
        basic: { organization_name: 'EXAMPLE HEALTH SYSTEM', status: 'A' },
        addresses: [
          { ...MAILING, address_1: 'PO BOX 100' },
          { ...LOCATION, address_1: '800 HOSPITAL DRIVE' },
        ],
      },
    });
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: '1234567893' }),
      ctx(),
    );
    expect(result.found[0]?.addresses.map((a) => a.purpose)).toEqual(['MAILING', 'LOCATION']);
    const text = textOf(getProviderTool.format!(result));
    expect(text).toContain('- MAILING: PO BOX 100, SEATTLE WA 981010000 — tel 206-555-0101');
    expect(text).toContain('- LOCATION: 800 HOSPITAL DRIVE');
  });

  it('withholds an individual MAILING row from structuredContent and the rendered text (#14)', async () => {
    stubRaw({
      '1720034424': {
        number: '1720034424',
        enumeration_type: 'NPI-1',
        basic: { first_name: 'CASEY', last_name: 'CLINICIAN', status: 'A' },
        addresses: [MAILING, LOCATION],
        practiceLocations: [{ address_purpose: 'LOCATION', address_1: '600 SATELLITE WAY' }],
      },
    });
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: '1720034424' }),
      ctx(),
    );
    const record = result.found[0];
    expect(record?.addresses).toEqual([
      {
        purpose: 'LOCATION',
        line1: '500 CLINIC AVE',
        city: 'SEATTLE',
        state: 'WA',
        postalCode: '981020000',
        telephoneNumber: '206-555-0102',
      },
    ]);
    expect(record?.practiceLocations).toEqual([
      { purpose: 'LOCATION', line1: '600 SATELLITE WAY' },
    ]);
    const text = textOf(getProviderTool.format!(result));
    for (const leaked of ['MAILING', 'PRIVATE HOME LANE', '206-555-0101', '981010000']) {
      expect(text).not.toContain(leaked);
      expect(JSON.stringify(result)).not.toContain(leaked);
    }
    expect(text).toContain('- LOCATION: 500 CLINIC AVE, SEATTLE WA 981020000 — tel 206-555-0102');
    expect(text).toContain('600 SATELLITE WAY');
  });

  it('carries endpoint descriptions and line2 to structuredContent and the rendered text (#9)', async () => {
    stubRaw({
      '1790935419': {
        number: '1790935419',
        enumeration_type: 'NPI-2',
        basic: { organization_name: 'EXAMPLE HIE MEMBER', status: 'A' },
        endpoints: [
          {
            endpoint: 'https://carequality.example/fhir',
            endpointType: 'FHIR',
            endpointDescription: 'Carequality',
            contentType: 'OTHER',
            contentTypeDescription: 'Other',
            contentOtherDescription: 'C-CDA',
            address_1: '1 MAIN ST',
            address_2: 'Anesthesia',
            city: 'SEATTLE',
          },
          {
            endpoint: 'esmd@example.test',
            endpointType: 'DIRECT',
            use: 'OTHER',
            useDescription: 'Other',
            useOtherDescription: 'CMS esMD eMDR',
            endpointDescription: '',
          },
        ],
      },
    });
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: '1790935419' }),
      ctx(),
    );
    const [first, second] = result.found[0]?.endpoints ?? [];
    expect(first).toMatchObject({
      endpointDescription: 'Carequality',
      contentOtherDescription: 'C-CDA',
      line1: '1 MAIN ST',
      line2: 'Anesthesia',
    });
    expect(first).not.toHaveProperty('useOtherDescription');
    expect(second).toMatchObject({ use: 'OTHER', useOtherDescription: 'CMS esMD eMDR' });
    expect(second).not.toHaveProperty('endpointDescription');
    expect(second).not.toHaveProperty('line2');
    const text = textOf(getProviderTool.format!(result));
    for (const expected of ['Carequality', 'C-CDA', 'Anesthesia', 'CMS esMD eMDR']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('1 MAIN ST, Anesthesia, SEATTLE');
  });

  it('reports a check-digit failure in invalid and resolves the rest without looking it up (#13)', async () => {
    const fetchSpy = stubRaw({ '1720034424': recordFor('1720034424') });
    const c = ctx();
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: ['1720034424', '1720034425'] }),
      c,
    );
    expect(result.found.map((r) => r.npi)).toEqual(['1720034424']);
    expect(result.invalid).toEqual([
      { npi: '1720034425', reason: expect.stringMatching(/check digit/i) },
    ]);
    expect(result.notFound).toEqual([]);
    expect(result.errored).toEqual([]);
    expect(requestedNpis(fetchSpy)).toEqual(['1720034424']);
    expect(getEnrichment(c).notice).toMatch(/1 of 2 NPI\(s\) failed the NPI check digit/);
    expect(getEnrichment(c).notice).not.toMatch(/deactivated/);
    const text = textOf(getProviderTool.format!(result));
    expect(text).toMatch(/## Invalid/);
    expect(text).toContain('**1720034425**');
  });

  it.each([
    ['a single invalid NPI', '1720034425'],
    ['an all-invalid batch', ['1720034425', '1720034423']],
  ])('throws invalid_npi_format without any lookup for %s (#13)', async (_label, npis) => {
    const fetchSpy = stubRaw({});
    // runToolContract applies the declared-recovery fill the production factory does.
    const result = await runToolContract(getProviderTool, { npis });
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        message: string;
        data: { reason: string; recovery?: { hint: string } };
      };
    };
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_npi_format',
        recovery: { hint: expect.stringMatching(/check digit/i) },
      },
    });
    expect(error.message).toContain('1720034425');
    const distinct = [...new Set(Array.isArray(npis) ? npis : [npis])];
    expect(error).toMatchObject({ data: { invalid: distinct.map((npi) => ({ npi })) } });
    for (const npi of distinct) expect(textOf(result.content)).toContain(npi);
    expect(error.data).not.toHaveProperty('unprocessed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws none_found, naming the invalid NPIs, when the rest are confirmed misses (#13)', async () => {
    const fetchSpy = stubRaw({ '1234567893': null });
    const err = (await Promise.resolve(
      getProviderTool.handler(
        getProviderTool.input.parse({ npis: ['1720034425', '1234567893'] }),
        ctx(),
      ),
    ).catch((error: unknown) => error)) as McpError;
    expect(err).toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'none_found' } });
    expect(err.message).toContain('1720034425');
    expect(requestedNpis(fetchSpy)).toEqual(['1234567893']);
  });

  it('keeps a check-digit-valid NPI with no record in notFound (#13)', async () => {
    stubRaw({ '1720034424': recordFor('1720034424'), '1234567893': null });
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: ['1720034424', '1234567893'] }),
      ctx(),
    );
    expect(result.notFound.map((n) => n.npi)).toEqual(['1234567893']);
    expect(result.invalid).toEqual([]);
  });

  it('resolves a full 10-NPI batch, and skips only the invalid member of a capped batch (#13)', async () => {
    const fetchSpy = stubRaw(Object.fromEntries(TEN_VALID_NPIS.map((n) => [n, recordFor(n)])));
    const full = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: TEN_VALID_NPIS }),
      ctx(),
    );
    expect(full.found).toHaveLength(10);
    expect(full.invalid).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(10);

    fetchSpy.mockClear();
    const withTypo = [...TEN_VALID_NPIS.slice(0, 9), '1720034425'];
    const partial = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: withTypo }),
      ctx(),
    );
    expect(partial.found).toHaveLength(9);
    expect(partial.invalid.map((i) => i.npi)).toEqual(['1720034425']);
    expect(requestedNpis(fetchSpy)).not.toContain('1720034425');
    expect(fetchSpy).toHaveBeenCalledTimes(9);
  });

  it('format: renders invalid rows alongside found records (#13)', () => {
    const text = textOf(
      getProviderTool.format!({
        found: [],
        notFound: [],
        errored: [],
        invalid: [{ npi: '1720034425', reason: 'Fails the NPI check digit.' }],
      }),
    );
    expect(text).toContain('**1720034425**: Fails the NPI check digit.');
  });

  describe('malformed registry bodies (#15)', () => {
    /** Settle a handler call whose retry backoff is driven by fake timers. */
    async function settle<T>(run: () => Promise<T> | T) {
      vi.useFakeTimers();
      const outcome = Promise.resolve(run()).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      return outcome;
    }

    const MALFORMED = {
      number: '1999999984',
      enumeration_type: 'NPI-1',
      basic: { last_name: 'X' },
    };

    it('lands a malformed lookup in errored, never notFound', async () => {
      stubRaw({ '1720034424': recordFor('1720034424'), '1999999984': MALFORMED });
      const outcome = await settle(() =>
        getProviderTool.handler(
          getProviderTool.input.parse({ npis: ['1720034424', '1999999984'] }),
          ctx(),
        ),
      );
      const result = (outcome as { value: Awaited<ReturnType<typeof getProviderTool.handler>> })
        .value;
      expect(result.found.map((r) => r.npi)).toEqual(['1720034424']);
      expect(result.notFound).toEqual([]);
      expect(result.errored).toEqual([
        { npi: '1999999984', reason: expect.stringMatching(/malformed/i) },
      ]);
    });

    it('propagates the upstream error for an all-malformed batch, not none_found', async () => {
      stubRaw({ '1999999984': MALFORMED });
      const outcome = await settle(() =>
        getProviderTool.handler(getProviderTool.input.parse({ npis: '1999999984' }), ctx()),
      );
      expect(outcome).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable },
      });
      expect((outcome as { error: McpError }).error.data?.reason).not.toBe('none_found');
    });
  });
});

// ── #43: taxonomy descriptions the registry serves blank ─────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/43

describe('getProviderTool taxonomy descriptions the registry leaves blank (#43)', () => {
  const NPI = '1073637286';

  /** Look `NPI` up through the public contract with one primary taxonomy; return both surfaces. */
  async function decodeTaxonomy(code: string, desc: string | null) {
    stubRaw({
      [NPI]: {
        number: NPI,
        enumeration_type: 'NPI-1',
        basic: { first_name: 'VASCULAR', last_name: 'SURGEON', status: 'A' },
        taxonomies: [{ code, desc, primary: true, license: 'MD61452023', state: 'WA' }],
      },
    });
    const result = await runToolContract(getProviderTool, { npis: NPI });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { found: ProviderRecord[] };
    return {
      taxonomy: structured.found[0]?.taxonomies[0],
      text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    };
  }

  it('decodes a null-desc taxonomy from NUCC on both surfaces, naming the source', async () => {
    const { taxonomy, text } = await decodeTaxonomy('2086S0129X', null);
    expect(taxonomy).toEqual({
      code: '2086S0129X',
      description: 'Surgery, Vascular Surgery',
      descriptionSource: 'nucc',
      primary: true,
      license: 'MD61452023',
      state: 'WA',
    });
    expect(text).toContain(
      '- Surgery, Vascular Surgery (2086S0129X) — primary, description from NUCC, license MD61452023, state WA',
    );
  });

  it('renders a registry-served description unmarked (characterization)', async () => {
    const { taxonomy, text } = await decodeTaxonomy('208600000X', 'Surgery');
    expect(taxonomy).toEqual({
      code: '208600000X',
      description: 'Surgery',
      primary: true,
      license: 'MD61452023',
      state: 'WA',
    });
    expect(text).toContain('- Surgery (208600000X) — primary, license MD61452023, state WA');
    expect(text).not.toContain('description from NUCC');
  });

  it('reads Unknown for a blank code the bundled set lacks (characterization)', async () => {
    const { taxonomy, text } = await decodeTaxonomy('207RX9999X', null);
    expect(taxonomy).toEqual({
      code: '207RX9999X',
      primary: true,
      license: 'MD61452023',
      state: 'WA',
    });
    expect(text).toContain('- Unknown (207RX9999X) — primary, license MD61452023, state WA');
  });
});

// ── #55: registry text in content[] reads back as CommonMark ─────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/55

type GetOutput = z.infer<typeof getProviderTool.output>;

const renderGet = (output: GetOutput) => textOf(getProviderTool.format!(output));

describe('getProviderTool content[] Markdown read-back (#55)', () => {
  /**
   * Look `raw` up through the public contract; return the output structuredContent
   * carries (enrichment aside) and the format() block content[] carries for it.
   */
  async function lookUp(raw: { number: string } & Record<string, unknown>) {
    stubRaw({ [raw.number]: raw });
    const result = await runToolContract(getProviderTool, { npis: raw.number });
    expect(result.isError).not.toBe(true);
    const {
      totalCount: _total,
      notice: _notice,
      ...output
    } = result.structuredContent as GetOutput & {
      notice?: string;
      totalCount?: number;
    };
    const [rendered] = result.content;
    expect(rendered).toEqual(getProviderTool.format!(output)[0]);
    return { output, text: rendered?.type === 'text' ? rendered.text : '' };
  }

  const organization = (basic: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    number: '1234567893',
    enumeration_type: 'NPI-2',
    basic: { status: 'A', ...basic },
    ...extra,
  });

  it('reads back Markdown in an organization name, and an identifier code with no description', async () => {
    const { output, text } = await lookUp(
      organization(
        { organization_name: 'A*B*C [X](y) _Z_' },
        { identifiers: [{ code: '05', identifier: '123456789' }] },
      ),
    );
    // structuredContent carries the registry's text as served.
    expect(output.found[0]?.organizationName).toBe('A*B*C [X](y) _Z_');
    expect(output.found[0]?.identifiers).toEqual([{ identifier: '123456789', code: '05' }]);
    for (const preset of PRESETS) {
      const lines = readLines(text, preset);
      expect(lines).toContain('A*B*C [X](y) _Z_');
      expect(lines).toContain('⟨strong⟩Organization:⟨/strong⟩ A*B*C [X](y) _Z_');
      expect(lines).toContain('(05): 123456789');
    }
    expectReadsBack(getProviderTool.output, output, renderGet);
  });

  it('opens no ordered list when a value ends in a line of digits before an authored )', async () => {
    const { output, text } = await lookUp({
      number: '1720034424',
      enumeration_type: 'NPI-1',
      basic: { first_name: 'JANE', last_name: 'DOE', status: 'A' },
      other_names: [{ type: 'x\n1', first_name: 'JANE', last_name: 'ROE' }],
    });
    expect(output.found[0]?.otherNames).toEqual([
      { type: 'x\n1', firstName: 'JANE', lastName: 'ROE' },
    ]);
    for (const preset of PRESETS) {
      expect(blockTypes(text, preset)).not.toContain('ordered_list_open');
      expect(readLines(text, preset)).toContain('JANE ROE (x\n1)');
    }
    expectReadsBack(getProviderTool.output, output, renderGet);
  });

  it('reads &amp; back as written, not as an entity', async () => {
    const { output, text } = await lookUp(organization({ organization_name: 'AT&amp;T' }));
    expect(output.found[0]?.organizationName).toBe('AT&amp;T');
    for (const preset of PRESETS) {
      expect(readLines(text, preset)).toContain('⟨strong⟩Organization:⟨/strong⟩ AT&amp;T');
    }
  });

  it('collapses a line-broken name to one heading line and keeps the break elsewhere', async () => {
    const { output, text } = await lookUp(organization({ organization_name: 'ACME\nHEALTH' }));
    expect(output.found[0]?.name).toBe('ACME\nHEALTH');
    for (const preset of PRESETS) {
      const headings = readMarkdown(text, preset).filter((n) => n.kind === 'text' && n.heading);
      expect(headings).toEqual([{ kind: 'text', text: 'ACME HEALTH', heading: true }]);
      expect(readLines(text, preset)).toContain('⟨strong⟩Organization:⟨/strong⟩ ACME\nHEALTH');
    }
    expectReadsBack(getProviderTool.output, output, renderGet);
  });

  it('leaves a value with no Markdown-active character unchanged, with no added backslash', async () => {
    const { text } = await lookUp({
      number: '1720034424',
      enumeration_type: 'NPI-1',
      basic: { first_name: 'JANE', last_name: 'DOE', credential: 'MD', status: 'A' },
      taxonomies: [{ code: '207R00000X', desc: 'Internal Medicine', primary: true }],
      other_names: [{ type: 'snake_case', first_name: 'JANE', last_name: 'ROE' }],
      endpoints: [{ endpoint: 'jane_doe@direct.example.org', endpointType: 'DIRECT' }],
    });
    for (const literal of [
      '## JANE DOE, MD',
      '**NPI:** 1720034424 |',
      '- Internal Medicine (207R00000X) — primary',
      '- JANE ROE (snake_case)',
      '- jane_doe@direct.example.org — DIRECT',
    ]) {
      expect(text).toContain(literal);
    }
    expect(text).not.toContain('\\');
  });

  it('reads back upstream error text in an errored reason', async () => {
    const message = '*Registry* <b>down</b>\n- retry [later](x)';
    vi.spyOn(NppesService.prototype, 'getByNumber').mockImplementation(async (npi) => {
      if (npi === '1720034424') throw serviceUnavailable(message);
      return {
        npi,
        type: 'organization',
        status: 'active',
        name: 'EXAMPLE CLINIC',
        taxonomies: [],
        addresses: [],
        practiceLocations: [],
        identifiers: [],
        otherNames: [],
        endpoints: [],
      };
    });
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: ['1720034424', '1234567893'] }),
      ctx(),
    );
    expect(result.errored).toEqual([{ npi: '1720034424', reason: message }]);
    const text = renderGet(result);
    for (const preset of PRESETS) {
      expect(readLines(text, preset)).toContain(`⟨strong⟩1720034424⟨/strong⟩: ${message}`);
    }
    expectReadsBack(getProviderTool.output, result, renderGet);
  });
});

// ── #56: npi and npi_numbers reach npis ──────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/56

describe('getProviderTool input aliases (#56)', () => {
  /** Run `args` as a client sends them, past the typed input the aliases rewrite into. */
  const call = (clamp: boolean, args: Record<string, unknown>) =>
    runToolContract(createGetProviderTool(clamp), args as never);

  const RECORDS = {
    '1053388736': recordFor('1053388736'),
    '1720034424': recordFor('1720034424'),
    '1720034416': null,
  };

  it.each([true, false])(
    'answers npi and npi_numbers as it answers npis (NPI_CLAMP_LIMITS %s)',
    async (clamp) => {
      for (const [args, canonical] of [
        [{ npi: '1053388736' }, '1053388736'],
        [{ npi: ['1053388736'] }, ['1053388736']],
        [{ npi_numbers: ['1053388736', '1720034424'] }, ['1053388736', '1720034424']],
        [
          { npi_numbers: ['1053388736', '1720034416', '1053388737'] },
          ['1053388736', '1720034416', '1053388737'],
        ],
      ] as const) {
        stubRaw(RECORDS);
        const viaAlias = await call(clamp, args);
        stubRaw(RECORDS);
        const viaNpis = await call(clamp, { npis: canonical });
        expect(viaAlias.isError).not.toBe(true);
        expect(viaAlias.structuredContent).toEqual(viaNpis.structuredContent);
        expect(viaAlias.content).toEqual(viaNpis.content);
      }
      stubRaw(RECORDS);
      const mixed = await call(clamp, { npi_numbers: ['1053388736', '1720034416', '1053388737'] });
      expect(mixed.structuredContent).toMatchObject({
        found: [{ npi: '1053388736' }],
        notFound: [{ npi: '1720034416' }],
        invalid: [{ npi: '1053388737' }],
      });
    },
  );

  it('still validates the check digit and the NPI format under npi', async () => {
    stubRaw(RECORDS);
    const badDigit = await call(true, { npi: '1053388737' });
    expect(badDigit).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'invalid_npi_format' },
        },
      },
    });
    const short = await call(true, { npi: '105338873' });
    expect(short).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(textOf(short.content)).toContain('npis');
  });

  it.each([
    [
      { npi: '1053388736', npis: ['1720034424'] },
      'npi is an alias of npis; send one of them, not both.',
    ],
    [
      { npi: '1053388736', npi_numbers: ['1720034424'] },
      'npi and npi_numbers are aliases of npis; send one of them, not both.',
    ],
  ])('rejects an alias sent beside another key for npis: %o', async (args, hint) => {
    const fetchSpy = stubRaw(RECORDS);
    const result = await call(true, args);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
    expect(textOf(result.content)).toContain(hint);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
