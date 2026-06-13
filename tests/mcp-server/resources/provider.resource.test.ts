/**
 * @fileoverview Tests for the npi://provider/{npi} resource. The global `fetch`
 * is stubbed so no live API is hit.
 * @module tests/mcp-server/resources/provider.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { providerResource } from '@/mcp-server/resources/definitions/provider.resource.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';

beforeAll(() => {
  initNppesService();
});

const ctx = () => createMockContext({ errors: providerResource.errors });

function stub(results: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ result_count: results.length, results }), { status: 200 }),
    ),
  );
}

afterEach(() => {
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
    const params = providerResource.params.parse({ npi: '1720034424' });
    const result = await providerResource.handler(params, ctx());
    expect(result).toMatchObject({ npi: '1720034424', name: 'JOSEPH ABATE', status: 'active' });
  });

  it('throws no_record when the NPI has no registry record', async () => {
    stub([]);
    const params = providerResource.params.parse({ npi: '1234567893' });
    await expect(providerResource.handler(params, ctx())).rejects.toMatchObject({
      data: { reason: 'no_record' },
    });
  });

  it('rejects a malformed NPI at the params boundary', () => {
    expect(() => providerResource.params.parse({ npi: '123' })).toThrow();
  });
});
