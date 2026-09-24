/**
 * @fileoverview Offline integration tests for correctness-critical provider,
 * taxonomy, pagination, lifecycle, and public-data boundaries. Only the NPPES
 * HTTP boundary is faked; project-owned tools, resources, and services run as-is.
 * @module tests/integration/correctness-boundaries.integration.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
      use: 'OTHER',
      useOtherDescription: 'Referral routing',
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
    if (url.origin !== 'https://npiregistry.cms.hhs.gov') throw new Error('unmocked fetch');
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

  it('reports a check-digit failure at both public boundaries without a registry request (#13)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/13
    const fetchSpy = stubNppes(() => [INDIVIDUAL_RESULT]);
    // The schemas keep only the 10-digit shape; the check digit is a handler rule.
    expect(getProviderTool.input.safeParse({ npis: '1720034425' }).success).toBe(true);
    expect(providerResource.params!.safeParse({ npi: '1720034425' }).success).toBe(true);

    const toolResult = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: [VALID_NPI, '1720034425'] }),
      createMockContext({ errors: getProviderTool.errors }),
    );
    expect(toolResult.found.map((record) => record.npi)).toEqual([VALID_NPI]);
    expect(toolResult.invalid.map((entry) => entry.npi)).toEqual(['1720034425']);
    expect(toolResult.notFound).toEqual([]);

    await expect(
      providerResource.handler(
        providerResource.params!.parse({ npi: '1720034425' }),
        createMockContext({ errors: providerResource.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_npi_format' } });

    const requested = fetchSpy.mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get('number'),
    );
    expect(requested).toEqual([VALID_NPI]);
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

  it('preserves live endpoint description and second address line fields (#9)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/9
    stubNppes(() => [INDIVIDUAL_RESULT]);
    const result = await getProviderTool.handler(
      getProviderTool.input.parse({ npis: VALID_NPI }),
      createMockContext({ errors: getProviderTool.errors }),
    );
    expect(result.found[0]?.endpoints[0]).toMatchObject({
      endpointDescription: 'Clinic FHIR endpoint',
      useOtherDescription: 'Referral routing',
      contentOtherDescription: 'US Core',
      line2: 'SUITE 200',
    });
    const text = getProviderTool.format!(result)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    for (const value of ['Clinic FHIR endpoint', 'Referral routing', 'US Core', 'SUITE 200']) {
      expect(text).toContain(value);
    }

    const resourceRecord = (await providerResource.handler(
      providerResource.params!.parse({ npi: VALID_NPI }),
      createMockContext({ errors: providerResource.errors }),
    )) as ProviderRecord;
    expect(resourceRecord.endpoints[0]).toMatchObject({
      endpointDescription: 'Clinic FHIR endpoint',
      line2: 'SUITE 200',
    });
  });
});

describe('public professional-data boundary', () => {
  it('omits an individual provider mailing/home address from tool and resource output (#14)', async () => {
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
    const text = getProviderTool.format!(toolResult)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).not.toContain('PRIVATE HOME LANE');
    expect(text).toContain('500 CLINIC AVE');
    expect(resourceResult.addresses).toContainEqual(
      expect.objectContaining({ purpose: 'LOCATION', line1: '500 CLINIC AVE' }),
    );
  });

  it('does not fall back to a mailing/home address in compact search rows (#14)', async () => {
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

  it('matches a location search on any practice location, never on the mailing address (#18)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/18
    const fetchSpy = stubNppes(() => [INDIVIDUAL_RESULT]);

    // 98101 is only the individual's MAILING (home) ZIP: the row is dropped.
    const mailingOnly = await runToolContract(searchProvidersTool, {
      postal_code: '98101',
      limit: 10,
    });
    expect(mailingOnly.structuredContent).toMatchObject({ providers: [] });

    // TACOMA is the second practice location: the row is kept and names it.
    const secondary = await runToolContract(searchProvidersTool, {
      city: 'Tacoma',
      state: 'WA',
      limit: 10,
    });
    expect(secondary.structuredContent).toMatchObject({
      providers: [
        {
          npi: VALID_NPI,
          city: 'SEATTLE',
          postalCode: '981020000',
          matchedLocation: { city: 'TACOMA', state: 'WA', postalCode: '984020000' },
        },
      ],
    });
    const text = secondary.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Matched practice location:** TACOMA, WA 984020000');
    for (const surface of [JSON.stringify(secondary.structuredContent), text]) {
      expect(surface).not.toContain('PRIVATE HOME LANE');
      expect(surface).not.toContain('981010000');
    }

    const queries = fetchSpy.mock.calls.map(([url]) =>
      Object.fromEntries(new URL(String(url)).searchParams),
    );
    // A location search asks NPPES for practice-address matches only (#19).
    expect(queries).toEqual([
      { version: '2.1', limit: '10', skip: '0', postal_code: '98101', address_purpose: 'LOCATION' },
      {
        version: '2.1',
        limit: '10',
        skip: '0',
        city: 'Tacoma',
        state: 'WA',
        address_purpose: 'LOCATION',
      },
    ]);
  });
});

describe('taxonomy completeness and search pagination honesty', () => {
  it('returns NUCC Notes on exact tool and resource lookups (#11)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/11
    const toolResult = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'get', code: '242T00000X' }),
      createMockContext({ errors: lookupTaxonomyTool.errors }),
    );
    const resourceResult = await taxonomyResource.handler(
      taxonomyResource.params!.parse({ code: '242T00000X' }),
      createMockContext({ errors: taxonomyResource.errors }),
    );
    // The NUCC cell has two spaces after "Source:"; the bundle keeps them.
    expect(toolResult.matches[0]).toHaveProperty(
      'notes',
      'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
    );
    expect(resourceResult).toHaveProperty(
      'notes',
      'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
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
