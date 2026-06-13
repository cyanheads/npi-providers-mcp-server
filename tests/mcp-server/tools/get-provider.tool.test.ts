/**
 * @fileoverview Tests for the npi_get_provider tool — single/batch fan-out,
 * partial success (found/notFound), none_found contract, and format() parity.
 * The global `fetch` is stubbed (keyed by the `number=` query param) so no live
 * API is hit.
 * @module tests/mcp-server/tools/get-provider.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';

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

  it('throws none_found when every NPI misses', async () => {
    stubByNpi(new Set());
    const input = getProviderTool.input.parse({ npis: ['1234567893', '1111111112'] });
    await expect(getProviderTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'none_found' },
    });
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

  it('format: renders the full record and a not-found section', () => {
    const blocks = getProviderTool.format!({
      found: [
        {
          npi: '1720034424',
          type: 'individual',
          status: 'active',
          name: 'TEST PROVIDER',
          taxonomies: [{ code: '207R00000X', description: 'Internal Medicine', primary: true }],
          addresses: [{ purpose: 'LOCATION', city: 'Seattle', state: 'WA' }],
          practiceLocations: [],
          identifiers: [],
          otherNames: [],
          endpoints: [],
        },
      ],
      notFound: [{ npi: '1234567893', reason: 'No record in the NPPES registry for this NPI.' }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('1720034424');
    expect(text).toContain('Internal Medicine');
    expect(text).toContain('Not found');
    expect(text).toContain('1234567893');
  });
});
