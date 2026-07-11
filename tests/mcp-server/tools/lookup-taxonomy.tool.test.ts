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

  it('resolve: strips noise words so "heart doctor" resolves to Cardiovascular Disease (#1)', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'heart doctor' });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches[0]?.code).toBe('207RC0000X');
  });

  it('resolve: "ent" resolves to Otolaryngology and never Gastroenterology (#1)', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'ent', limit: 20 });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches[0]?.code).toBe('207Y00000X');
    expect(
      result.matches.some((m) =>
        /gastroenterology/i.test(`${m.classification} ${m.specialization ?? ''}`),
      ),
    ).toBe(false);
  });

  it('browse: skip returns the next contiguous page with no overlap (#7)', async () => {
    const page1 = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'browse', limit: 2, skip: 0 }),
      ctx(),
    );
    const page2 = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'browse', limit: 2, skip: 2 }),
      ctx(),
    );
    expect(page2.matches).toHaveLength(2);
    const p1 = page1.matches.map((m) => m.code);
    const p2 = page2.matches.map((m) => m.code);
    expect(p1.some((c) => p2.includes(c))).toBe(false);
  });

  it('resolve: truncation guidance points at skip as the continuation mechanism (#7)', async () => {
    const c = ctx();
    await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'physician', limit: 2 }),
      c,
    );
    expect(getEnrichment(c).notice).toMatch(/skip=2/);
  });

  it('resolve: skip past the end returns an empty page with a notice, not no_match (#7)', async () => {
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'cardiologist', skip: 500 }),
      c,
    );
    expect(result.matches).toEqual([]);
    expect(getEnrichment(c).notice).toBeDefined();
  });

  it('get: ignores skip and still returns the exact entry (#7)', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '207RC0000X', skip: 9 });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.code).toBe('207RC0000X');
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
