/**
 * @fileoverview Tests for the npi_get_provider tool — single/batch fan-out,
 * partial success (found/notFound), none_found contract, and format() parity.
 * The global `fetch` is stubbed (keyed by the `number=` query param) so no live
 * API is hit.
 * @module tests/mcp-server/tools/get-provider.tool.test
 */

import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { initNppesService, NppesService } from '@/services/nppes/nppes-service.js';
import type { ProviderRecord } from '@/services/nppes/types.js';

beforeAll(() => {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getProviderTool', () => {
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
    const err = await getProviderTool.handler(input, ctx()).catch((e) => e);
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

  it('caps the batch at 10', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => String(1000000000 + i));
    expect(() => getProviderTool.input.parse({ npis: eleven })).toThrow();
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
      ],
      notFound: [{ npi: '1234567893', reason: 'No record in the NPPES registry for this NPI.' }],
      errored: [
        { npi: '1999999984', reason: 'NPPES registry unavailable (failed after 4 attempts)' },
      ],
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
});
