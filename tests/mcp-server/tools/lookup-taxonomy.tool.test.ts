/**
 * @fileoverview Tests for the npi_lookup_taxonomy tool — resolve/get/browse
 * modes, error contracts, truncation enrichment, and format() parity.
 * @module tests/mcp-server/tools/lookup-taxonomy.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { lookupTaxonomyTool } from '@/mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

beforeAll(() => {
  initTaxonomyService();
});

const ctx = () => createMockContext({ errors: lookupTaxonomyTool.errors });

/** The handler is synchronous; capture its (sync or async) throw as a value. */
async function caught(input: Parameters<typeof lookupTaxonomyTool.handler>[0], c: Context) {
  return Promise.resolve()
    .then(() => lookupTaxonomyTool.handler(input, c))
    .catch((e) => e);
}

describe('lookupTaxonomyTool', () => {
  it('resolve: maps a plain-language specialty to matching entries', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'cardiologist' });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result).toEqual(expect.schemaMatching(lookupTaxonomyTool.output));
  });

  it('resolve: throws no_match for a nonsense term', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'zzzznotaspecialty' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('no_match');
  });

  it('resolve: throws missing_argument when query is absent', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('missing_argument');
  });

  it('resolve: discloses truncation when more matches than the limit', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'physician', limit: 2 });
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(input, c);
    expect(result.matches).toHaveLength(2);
    expect(getEnrichment(c)).toMatchObject({ truncated: true, cap: 2 });
  });

  it('get: returns the entry for an exact code', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '207RC0000X' });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.code).toBe('207RC0000X');
    expect(result.matches[0]?.specialization).toBe('Cardiovascular Disease');
  });

  it('get: throws no_match for an unknown code', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '000ZZZ000X' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('no_match');
  });

  it('get: throws missing_argument when code is absent', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('missing_argument');
  });

  it('browse: filters by grouping and section', async () => {
    const input = lookupTaxonomyTool.input.parse({
      mode: 'browse',
      grouping: 'physicians',
      section: 'Individual',
      limit: 10,
    });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((m) => m.section === 'Individual')).toBe(true);
  });

  it('browse: emits a notice when nothing matches the filters', async () => {
    const input = lookupTaxonomyTool.input.parse({
      mode: 'browse',
      grouping: 'zzzznosuchgrouping',
      limit: 10,
    });
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(input, c);
    expect(result.matches).toEqual([]);
    expect(getEnrichment(c).notice).toBeDefined();
  });

  it('format: renders a single entry with code and hierarchy', () => {
    const blocks = lookupTaxonomyTool.format!({
      matches: [
        {
          code: '207RC0000X',
          grouping: 'Allopathic & Osteopathic Physicians',
          classification: 'Internal Medicine',
          specialization: 'Cardiovascular Disease',
          displayName: 'Cardiovascular Disease Physician',
          section: 'Individual',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('207RC0000X');
    expect(text).toContain('Cardiovascular Disease');
  });
});
