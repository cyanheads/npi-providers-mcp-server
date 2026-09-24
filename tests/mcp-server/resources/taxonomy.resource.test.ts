/**
 * @fileoverview Tests for the npi://taxonomy/{code} resource.
 * @module tests/mcp-server/resources/taxonomy.resource.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
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
    const params = taxonomyResource.params!.parse({ code: '207RC0000X' });
    const result = await taxonomyResource.handler(params, ctx());
    expect(result).toMatchObject({ code: '207RC0000X', specialization: 'Cardiovascular Disease' });
  });

  it('throws no_match for an unknown but well-formed code', async () => {
    const params = taxonomyResource.params!.parse({ code: '000ZZZ000X' });
    // The resource handler is synchronous — capture its throw as a value.
    const err = (await Promise.resolve()
      .then(() => taxonomyResource.handler(params, ctx()))
      .catch((error: unknown) => error)) as McpError;
    expect(err?.data?.reason).toBe('no_match');
  });

  it('rejects a malformed code at the params boundary', () => {
    expect(() => taxonomyResource.params!.parse({ code: '207RC0000' })).toThrow();
  });

  it('returns the trimmed NUCC Notes cell byte for byte (#11)', async () => {
    const result = await taxonomyResource.handler(
      taxonomyResource.params!.parse({ code: '242T00000X' }),
      ctx(),
    );
    expect(result).toHaveProperty(
      'notes',
      'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]',
    );
  });

  it('omits notes for a code with an empty Notes cell (#11)', async () => {
    const read = (code: string) =>
      taxonomyResource.handler(taxonomyResource.params!.parse({ code }), ctx());
    const empty = await read('207QA0505X');
    expect(empty).toMatchObject({ code: '207QA0505X' });
    expect(empty).not.toHaveProperty('notes');
    expect(await read('242T00000X')).toHaveProperty('notes');
  });

  it('flags inactive codes with their replacement, and active codes as active (#16)', async () => {
    const read = (code: string) =>
      taxonomyResource.handler(taxonomyResource.params!.parse({ code }), ctx());
    expect(await read('103GC0700X')).toMatchObject({
      status: 'inactive',
      replacedBy: '103G00000X',
    });
    const noReplacement = await read('1744G0900X');
    expect(noReplacement).toMatchObject({ status: 'inactive' });
    expect(noReplacement).not.toHaveProperty('replacedBy');
    expect(await read('207RC0000X')).toMatchObject({ status: 'active' });
  });
});
