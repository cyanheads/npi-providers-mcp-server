/**
 * @fileoverview Offline smoke coverage for all three tools and both resources.
 * The NPPES HTTP boundary is faked; the taxonomy index remains the real bundle.
 * @module tests/smoke/public-surface.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerResource } from '@/mcp-server/resources/definitions/provider.resource.js';
import { taxonomyResource } from '@/mcp-server/resources/definitions/taxonomy.resource.js';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { lookupTaxonomyTool } from '@/mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

const NPI = '1720034424';
const RESULT = {
  number: Number(NPI),
  enumeration_type: 'NPI-1',
  basic: { first_name: 'OFFLINE', last_name: 'CLINICIAN', credential: 'MD', status: 'A' },
  taxonomies: [
    { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
  ],
  addresses: [
    {
      address_purpose: 'LOCATION',
      address_1: '500 CLINIC AVE',
      city: 'SEATTLE',
      state: 'WA',
      postal_code: '981020000',
    },
  ],
};

beforeAll(() => {
  initNppesService();
  initTaxonomyService();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ result_count: 1, results: [RESULT] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('public MCP surface', () => {
  it('smokes npi_search_providers', async () => {
    const result = await searchProvidersTool.handler(
      searchProvidersTool.input.parse({ specialty: 'cardiologist', city: 'SEATTLE' }),
      createMockContext({ errors: searchProvidersTool.errors }),
    );
    expect(result.providers[0]).toMatchObject({ npi: NPI, status: 'active', city: 'SEATTLE' });
  });

  it('smokes npi_get_provider', async () => {
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: NPI }),
      createMockContext({ errors: getProviderTool.errors }),
    );
    expect(result.found[0]).toMatchObject({ npi: NPI, name: 'OFFLINE CLINICIAN' });
  });

  it('smokes npi_lookup_taxonomy', async () => {
    const result = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'cardiologist' }),
      createMockContext({ errors: lookupTaxonomyTool.errors }),
    );
    expect(result.matches[0]?.code).toBe('207RC0000X');
  });

  it('smokes npi://provider/{npi}', async () => {
    const result = await providerResource.handler(
      providerResource.params!.parse({ npi: NPI }),
      createMockContext({ errors: providerResource.errors }),
    );
    expect(result).toMatchObject({ npi: NPI, status: 'active' });
  });

  it('smokes npi://taxonomy/{code}', () => {
    const result = taxonomyResource.handler(
      taxonomyResource.params!.parse({ code: '207RC0000X' }),
      createMockContext({ errors: taxonomyResource.errors }),
    );
    expect(result).toMatchObject({ code: '207RC0000X', specialization: 'Cardiovascular Disease' });
  });
});
