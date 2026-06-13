/**
 * @fileoverview Tests for the npi://taxonomy/{code} resource.
 * @module tests/mcp-server/resources/taxonomy.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { taxonomyResource } from '@/mcp-server/resources/definitions/taxonomy.resource.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

beforeAll(() => {
  initTaxonomyService();
});

const ctx = () => createMockContext({ errors: taxonomyResource.errors });

describe('taxonomyResource', () => {
  it('returns the entry for a valid code', async () => {
    const params = taxonomyResource.params.parse({ code: '207RC0000X' });
    const result = await taxonomyResource.handler(params, ctx());
    expect(result).toMatchObject({ code: '207RC0000X', specialization: 'Cardiovascular Disease' });
  });

  it('throws no_match for an unknown but well-formed code', async () => {
    const params = taxonomyResource.params.parse({ code: '000ZZZ000X' });
    // The resource handler is synchronous — capture its throw as a value.
    const err = await Promise.resolve()
      .then(() => taxonomyResource.handler(params, ctx()))
      .catch((e) => e);
    expect(err?.data?.reason).toBe('no_match');
  });

  it('rejects a malformed code at the params boundary', () => {
    expect(() => taxonomyResource.params.parse({ code: '207RC0000' })).toThrow();
  });
});
