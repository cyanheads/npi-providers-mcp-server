/**
 * @fileoverview Tests for the npi://provider/{npi} resource. The global `fetch`
 * is stubbed so no live API is hit.
 * @module tests/mcp-server/resources/provider.resource.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerResource } from '@/mcp-server/resources/definitions/provider.resource.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';

beforeAll(() => {
  initNppesService();
});

const ctx = () => createMockContext({ errors: providerResource.errors });

/** Stub fetch to answer the registry with `results`; any other URL rejects as unmocked. */
function stub(results: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (!String(url).startsWith('https://npiregistry.cms.hhs.gov/api/')) {
        throw new Error('unmocked fetch');
      }
      return new Response(JSON.stringify({ result_count: results.length, results }), {
        status: 200,
      });
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('providerResource', () => {
  it('returns the decoded record for a known NPI', async () => {
    stub([
      {
        number: 1720034424,
        enumeration_type: 'NPI-1',
        basic: { first_name: 'JOSEPH', last_name: 'ABATE', status: 'A' },
        taxonomies: [
          { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
        ],
        addresses: [],
      },
    ]);
    const params = providerResource.params!.parse({ npi: '1720034424' });
    const result = await providerResource.handler(params, ctx());
    expect(result).toMatchObject({ npi: '1720034424', name: 'JOSEPH ABATE', status: 'active' });
  });

  it('throws no_record when the NPI has no registry record', async () => {
    stub([]);
    const params = providerResource.params!.parse({ npi: '1234567893' });
    await expect(providerResource.handler(params, ctx())).rejects.toMatchObject({
      data: { reason: 'no_record' },
    });
  });

  it('rejects a malformed NPI at the params boundary', () => {
    expect(() => providerResource.params!.parse({ npi: '123' })).toThrow();
  });

  it('throws invalid_npi_format for a check-digit failure without a registry request (#13)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('unmocked fetch'));
    vi.stubGlobal('fetch', fetchSpy);
    const params = providerResource.params!.parse({ npi: '1720034425' });
    await expect(providerResource.handler(params, ctx())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'invalid_npi_format',
        recovery: { hint: expect.stringMatching(/check digit/i) },
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('withholds an individual MAILING row and keeps an organization one (#14)', async () => {
    const addresses = [
      {
        address_purpose: 'MAILING',
        address_1: '123 PRIVATE HOME LANE',
        telephone_number: '206-555-0101',
      },
      {
        address_purpose: 'LOCATION',
        address_1: '500 CLINIC AVE',
        telephone_number: '206-555-0102',
      },
    ];
    stub([
      {
        number: '1720034424',
        enumeration_type: 'NPI-1',
        basic: { first_name: 'CASEY', last_name: 'CLINICIAN', status: 'A' },
        addresses,
      },
    ]);
    const individual = await providerResource.handler(
      providerResource.params!.parse({ npi: '1720034424' }),
      ctx(),
    );
    expect(JSON.stringify(individual)).not.toContain('PRIVATE HOME LANE');
    expect(JSON.stringify(individual)).not.toContain('206-555-0101');
    expect(individual).toMatchObject({
      addresses: [
        { purpose: 'LOCATION', line1: '500 CLINIC AVE', telephoneNumber: '206-555-0102' },
      ],
    });

    stub([
      {
        number: '1234567893',
        enumeration_type: 'NPI-2',
        basic: { organization_name: 'EXAMPLE HEALTH SYSTEM', status: 'A' },
        addresses,
      },
    ]);
    const organization = await providerResource.handler(
      providerResource.params!.parse({ npi: '1234567893' }),
      ctx(),
    );
    expect(organization).toMatchObject({
      addresses: [{ purpose: 'MAILING' }, { purpose: 'LOCATION' }],
    });
  });

  it('returns endpoint descriptions and line2 in the resource JSON (#9)', async () => {
    stub([
      {
        number: '1679603807',
        enumeration_type: 'NPI-2',
        basic: { organization_name: 'EXAMPLE CLINIC', status: 'A' },
        endpoints: [
          {
            endpoint: 'esmd@example.test',
            endpointDescription: 'esMD gateway',
            use: 'OTHER',
            useOtherDescription: 'CMS esMD eMDR',
            contentOtherDescription: 'C-CDA',
            address_1: '1 MAIN ST',
            address_2: 'Suite 100',
          },
        ],
      },
    ]);
    const record = await providerResource.handler(
      providerResource.params!.parse({ npi: '1679603807' }),
      ctx(),
    );
    expect(record).toMatchObject({
      endpoints: [
        {
          endpointDescription: 'esMD gateway',
          useOtherDescription: 'CMS esMD eMDR',
          contentOtherDescription: 'C-CDA',
          line1: '1 MAIN ST',
          line2: 'Suite 100',
        },
      ],
    });
  });

  it('throws the upstream error for a malformed registry body, not no_record (#15)', async () => {
    vi.useFakeTimers();
    stub([{ number: '1720034424', enumeration_type: 'NPI-1', basic: {} }]);
    const outcome = Promise.resolve(
      providerResource.handler(providerResource.params!.parse({ npi: '1720034424' }), ctx()),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const settled = await outcome;
    expect(settled).toMatchObject({ error: { code: JsonRpcErrorCode.ServiceUnavailable } });
    expect((settled as { error: McpError }).error.data?.reason).not.toBe('no_record');
  });
});
