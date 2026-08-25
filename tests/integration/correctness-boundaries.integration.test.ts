/**
 * @fileoverview Offline integration tests for correctness-critical provider,
 * taxonomy, pagination, lifecycle, and public-data boundaries. Only the NPPES
 * HTTP boundary is faked; project-owned tools, resources, and services run as-is.
 * @module tests/integration/correctness-boundaries.integration.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerResource } from '@/mcp-server/resources/definitions/provider.resource.js';
import { taxonomyResource } from '@/mcp-server/resources/definitions/taxonomy.resource.js';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { lookupTaxonomyTool } from '@/mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import type { ProviderRecord } from '@/services/nppes/types.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

const VALID_NPI = '1720034424';
const ORGANIZATION_NPI = '1234567893';

const INDIVIDUAL_RESULT = {
  number: Number(VALID_NPI),
  enumeration_type: 'NPI-1',
  basic: {
    first_name: 'CASEY',
    middle_name: 'A',
    last_name: 'CLINICIAN',
    credential: 'MD',
    status: 'D',
    replacement_npi: ORGANIZATION_NPI,
    deactivation_reason_code: '1',
    deactivation_date: '2024-03-01',
    reactivation_date: '2024-05-15',
  },
  taxonomies: [
    {
      code: '207R00000X',
      desc: 'Internal Medicine',
      primary: true,
      license: 'WA-123',
      state: 'WA',
    },
    {
      code: '207RC0000X',
      desc: 'Internal Medicine, Cardiovascular Disease',
      primary: false,
      license: 'WA-456',
      state: 'WA',
    },
  ],
  addresses: [
    {
      address_purpose: 'MAILING',
      address_type: 'DOM',
      address_1: '123 PRIVATE HOME LANE',
      city: 'SEATTLE',
      state: 'WA',
      postal_code: '981010000',
      telephone_number: '206-555-0101',
    },
    {
      address_purpose: 'LOCATION',
      address_type: 'DOM',
      address_1: '500 CLINIC AVE',
      city: 'SEATTLE',
      state: 'WA',
      postal_code: '981020000',
      telephone_number: '206-555-0102',
    },
  ],
  practiceLocations: [
    {
      address_purpose: 'LOCATION',
      address_type: 'DOM',
      address_1: '600 SATELLITE WAY',
      city: 'BELLEVUE',
      state: 'WA',
      postal_code: '980040000',
    },
    {
      address_purpose: 'LOCATION',
      address_type: 'DOM',
      address_1: '700 OUTREACH ROAD',
      city: 'TACOMA',
      state: 'WA',
      postal_code: '984020000',
    },
  ],
  endpoints: [
    {
      endpoint: 'https://clinic.example/fhir',
      endpointType: 'FHIR',
      endpointDescription: 'Clinic FHIR endpoint',
      contentOtherDescription: 'US Core',
      address_1: '500 CLINIC AVE',
      address_2: 'SUITE 200',
      city: 'SEATTLE',
      state: 'WA',
    },
  ],
};

const ORGANIZATION_RESULT = {
  number: Number(ORGANIZATION_NPI),
  enumeration_type: 'NPI-2',
  basic: {
    organization_name: 'EXAMPLE HEALTH SYSTEM',
    organizational_subpart: 'NO',
    authorized_official_first_name: 'ALEX',
    authorized_official_last_name: 'ADMIN',
    authorized_official_title_or_position: 'DIRECTOR',
    status: 'A',
  },
  taxonomies: [{ code: '193200000X', desc: 'Multi-Specialty', primary: true }],
  addresses: [
    {
      address_purpose: 'LOCATION',
      address_1: '800 HOSPITAL DRIVE',
      city: 'SEATTLE',
      state: 'WA',
    },
  ],
};

function stubNppes(resultsFor: (url: URL) => unknown[]): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const results = resultsFor(url);
    return new Response(JSON.stringify({ result_count: results.length, results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

beforeAll(() => {
  initNppesService();
  initTaxonomyService();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NPI validation at both public boundaries', () => {
  it('rejects unknown tool arguments instead of silently stripping them', () => {
    expect(getProviderTool.input.safeParse({ npis: VALID_NPI, npi: VALID_NPI }).success).toBe(
      false,
    );
    expect(
      searchProvidersTool.input.safeParse({ last_name: 'SMITH', lastName: 'SMITH' }).success,
    ).toBe(false);
    expect(
      lookupTaxonomyTool.input.safeParse({ mode: 'get', code: '207RC0000X', query: 'ignored' })
        .success,
    ).toBe(false);
  });

  it('accepts a checksum-valid, assigned-range NPI', () => {
    expect(getProviderTool.input.safeParse({ npis: VALID_NPI }).success).toBe(true);
    expect(providerResource.params!.safeParse({ npi: VALID_NPI }).success).toBe(true);
  });

  it('rejects wrong-length and non-numeric identifiers', () => {
    for (const npi of ['123456789', '12345678901', '172003442A']) {
      expect(getProviderTool.input.safeParse({ npis: npi }).success).toBe(false);
      expect(providerResource.params!.safeParse({ npi }).success).toBe(false);
    }
  });

  it.skip('rejects a checksum failure and a leading-zero identifier before fetch (#13)', () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/13
    const fetchSpy = stubNppes(() => []);
    for (const npi of ['1720034425', '0123456788']) {
      expect(getProviderTool.input.safeParse({ npis: npi }).success).toBe(false);
      expect(providerResource.params!.safeParse({ npi }).success).toBe(false);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('provider identity and record state', () => {
  it('preserves deactivation status, provider type, multiple taxonomies, and practice locations', async () => {
    stubNppes((url) =>
      url.searchParams.get('number') === ORGANIZATION_NPI
        ? [ORGANIZATION_RESULT]
        : [INDIVIDUAL_RESULT],
    );

    const individual = (await providerResource.handler(
      providerResource.params!.parse({ npi: VALID_NPI }),
      createMockContext({ errors: providerResource.errors }),
    )) as ProviderRecord;
    expect(individual).toMatchObject({
      npi: VALID_NPI,
      type: 'individual',
      status: 'deactivated',
    });
    expect(individual.taxonomies).toHaveLength(2);
    expect(individual.taxonomies.filter((taxonomy) => taxonomy.primary)).toHaveLength(1);
    expect(individual.practiceLocations).toHaveLength(2);

    const organization = await providerResource.handler(
      providerResource.params!.parse({ npi: ORGANIZATION_NPI }),
      createMockContext({ errors: providerResource.errors }),
    );
    expect(organization).toMatchObject({
      npi: ORGANIZATION_NPI,
      type: 'organization',
      status: 'active',
      organizationName: 'EXAMPLE HEALTH SYSTEM',
      authorizedOfficial: { firstName: 'ALEX', lastName: 'ADMIN', title: 'DIRECTOR' },
    });
  });

  it('normalizes a sparse but identifiable record without inventing optional facts', async () => {
    stubNppes(() => [
      {
        number: Number(VALID_NPI),
        enumeration_type: 'NPI-1',
        basic: { first_name: 'SPARSE', last_name: 'PROVIDER', status: 'A' },
      },
    ]);

    const record = (await providerResource.handler(
      providerResource.params!.parse({ npi: VALID_NPI }),
      createMockContext({ errors: providerResource.errors }),
    )) as ProviderRecord;
    expect(record).toMatchObject({
      npi: VALID_NPI,
      name: 'SPARSE PROVIDER',
      status: 'active',
      taxonomies: [],
      addresses: [],
      practiceLocations: [],
      identifiers: [],
      otherNames: [],
      endpoints: [],
    });
    expect(record.credential).toBeUndefined();
  });

  it.skip('preserves replacement and lifecycle fields instead of returning stale registration state (#9)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/9
    stubNppes(() => [INDIVIDUAL_RESULT]);
    const record = await providerResource.handler(
      providerResource.params!.parse({ npi: VALID_NPI }),
      createMockContext({ errors: providerResource.errors }),
    );
    expect(record).toHaveProperty('replacementNpi', ORGANIZATION_NPI);
    expect(record).toHaveProperty('deactivationReasonCode', '1');
    expect(record).toHaveProperty('deactivationDate', '2024-03-01');
    expect(record).toHaveProperty('reactivationDate', '2024-05-15');
  });

  it.skip('preserves live endpoint description and second address line fields (#9)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/9
    stubNppes(() => [INDIVIDUAL_RESULT]);
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: VALID_NPI }),
      createMockContext({ errors: getProviderTool.errors }),
    );
    expect(result.found[0]?.endpoints[0]).toMatchObject({
      endpointDescription: 'Clinic FHIR endpoint',
      contentOtherDescription: 'US Core',
      line2: 'SUITE 200',
    });
  });
});

describe('public professional-data boundary', () => {
  it.skip('omits an individual provider mailing/home address from tool and resource output (#14)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/14
    stubNppes(() => [INDIVIDUAL_RESULT]);

    const toolResult = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: VALID_NPI }),
      createMockContext({ errors: getProviderTool.errors }),
    );
    const resourceResult = (await providerResource.handler(
      providerResource.params!.parse({ npi: VALID_NPI }),
      createMockContext({ errors: providerResource.errors }),
    )) as ProviderRecord;

    for (const addresses of [toolResult.found[0]?.addresses ?? [], resourceResult.addresses]) {
      expect(addresses.every((address) => address.purpose !== 'MAILING')).toBe(true);
      expect(JSON.stringify(addresses)).not.toContain('PRIVATE HOME LANE');
      expect(JSON.stringify(addresses)).not.toContain('206-555-0101');
    }
    expect(resourceResult.addresses).toContainEqual(
      expect.objectContaining({ purpose: 'LOCATION', line1: '500 CLINIC AVE' }),
    );
  });

  it.skip('does not fall back to a mailing/home address in compact search rows (#14)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/14
    stubNppes(() => [
      {
        ...INDIVIDUAL_RESULT,
        addresses: [INDIVIDUAL_RESULT.addresses[0]],
      },
    ]);
    const result = await searchProvidersTool.handler(
      searchProvidersTool.input.parse({ last_name: 'CLINICIAN', limit: 10 }),
      createMockContext({ errors: searchProvidersTool.errors }),
    );
    expect(result.providers[0]).not.toHaveProperty('city');
    expect(result.providers[0]).not.toHaveProperty('state');
    expect(result.providers[0]).not.toHaveProperty('postalCode');
  });
});

describe('taxonomy completeness and search pagination honesty', () => {
  it.skip('returns NUCC Notes on exact tool and resource lookups (#11)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/11
    const toolResult = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'get', code: '242T00000X' }),
      createMockContext({ errors: lookupTaxonomyTool.errors }),
    );
    const resourceResult = await taxonomyResource.handler(
      taxonomyResource.params!.parse({ code: '242T00000X' }),
      createMockContext({ errors: taxonomyResource.errors }),
    );
    expect(toolResult.matches[0]).toHaveProperty(
      'notes',
      'Source: Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
    );
    expect(resourceResult).toHaveProperty(
      'notes',
      'Source: Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
    );
  });

  it('sends and discloses the terminal reachable search window without claiming a total', async () => {
    const terminalPage = Array.from({ length: 200 }, (_, index) => ({
      ...INDIVIDUAL_RESULT,
      number: 1000000000 + index,
      basic: { first_name: 'BROAD', last_name: `MATCH${index}`, status: 'A' },
      addresses: [INDIVIDUAL_RESULT.addresses[1]],
    }));
    const fetchSpy = stubNppes(() => terminalPage);
    const ctx = createMockContext({ errors: searchProvidersTool.errors });
    const result = await searchProvidersTool.handler(
      searchProvidersTool.input.parse({ last_name: 'SMITH', skip: 1000, limit: 200 }),
      ctx,
    );
    expect(result.providers).toHaveLength(200);
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('skip')).toBe('1000');
    expect(calledUrl.searchParams.get('limit')).toBe('200');
    expect(getEnrichment(ctx)).toMatchObject({ truncated: true, shown: 200, cap: 200 });
    expect(getEnrichment(ctx).notice).toMatch(
      /never reports the true match count|not a grand total/i,
    );
    expect(getEnrichment(ctx).notice).toMatch(/first 1200 matches are reachable/i);
  });

  it.skip('does not recommend an impossible next page at the terminal window (#12)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/12
    const terminalPage = Array.from({ length: 200 }, () => INDIVIDUAL_RESULT);
    stubNppes(() => terminalPage);
    const ctx = createMockContext({ errors: searchProvidersTool.errors });
    await searchProvidersTool.handler(
      searchProvidersTool.input.parse({ last_name: 'SMITH', skip: 1000, limit: 200 }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).not.toMatch(/page with skip/i);
    expect(getEnrichment(ctx).notice).toMatch(/no further live-api page|terminal window/i);
  });
});
