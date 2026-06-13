/**
 * @fileoverview Tests for the npi_search_providers tool — criteria validation,
 * specialty resolution + echo, pagination/ceiling disclosure, and error contracts.
 * The global `fetch` is stubbed so no live API is hit.
 * @module tests/mcp-server/tools/search-providers.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

beforeAll(() => {
  initTaxonomyService();
  initNppesService();
});

const ctx = () => createMockContext({ errors: searchProvidersTool.errors });

function stubResults(results: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ result_count: results.length, results }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

const ROW = {
  number: 1720034424,
  enumeration_type: 'NPI-1',
  basic: { first_name: 'JOSEPH', last_name: 'ABATE', credential: 'MD', status: 'A' },
  taxonomies: [
    { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
  ],
  addresses: [{ address_purpose: 'LOCATION', city: 'Seattle', state: 'WA' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchProvidersTool', () => {
  it('searches by specialty, resolves the taxonomy, and echoes it', async () => {
    stubResults([ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({
      specialty: 'cardiologist',
      state: 'WA',
      limit: 10,
    });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      npi: '1720034424',
      status: 'active',
      city: 'Seattle',
    });
    const enrich = getEnrichment(c);
    expect(enrich.resolvedTaxonomies?.length).toBeGreaterThan(0);
    expect(enrich.appliedTaxonomyDescription).toBeDefined();
    // Must resolve to the API-accepted description, not the "... Physician" display name.
    expect(enrich.appliedTaxonomyDescription).not.toMatch(/physician/i);
    // "cardiologist" must send the canonical general cardiologist description upstream —
    // not "Cardiology" (a pharmacist specialization that substring-matches differently).
    expect(enrich.appliedTaxonomyDescription).toBe('Cardiovascular Disease');
    expect(enrich.resolvedTaxonomies?.[0]?.code).toBe('207RC0000X');
  });

  it('throws no_search_criteria when nothing effective is provided', async () => {
    const input = searchProvidersTool.input.parse({ limit: 10 });
    await expect(searchProvidersTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'no_search_criteria' },
    });
  });

  it('treats state-only as no effective criterion', async () => {
    const input = searchProvidersTool.input.parse({ state: 'WA', limit: 10 });
    await expect(searchProvidersTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'no_search_criteria' },
    });
  });

  it('throws conflicting_specialty when both specialty and taxonomy_description are set', async () => {
    const input = searchProvidersTool.input.parse({
      specialty: 'cardiology',
      taxonomy_description: 'Cardiovascular Disease',
      limit: 10,
    });
    await expect(searchProvidersTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'conflicting_specialty' },
    });
  });

  it('throws unresolved_specialty when the specialty matches no taxonomy', async () => {
    const input = searchProvidersTool.input.parse({
      specialty: 'zzzznotaspecialty',
      city: 'Seattle',
      limit: 10,
    });
    await expect(searchProvidersTool.handler(input, ctx())).rejects.toMatchObject({
      data: { reason: 'unresolved_specialty' },
    });
  });

  it('passes a raw taxonomy_description through unresolved', async () => {
    stubResults([ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({
      taxonomy_description: 'Cardiovascular Disease',
      city: 'Seattle',
      limit: 10,
    });
    await searchProvidersTool.handler(input, c);
    expect(getEnrichment(c).appliedTaxonomyDescription).toBe('Cardiovascular Disease');
    expect(getEnrichment(c).resolvedTaxonomies).toBeUndefined();
  });

  it('discloses truncation and the page-size-not-total caveat on a full page', async () => {
    stubResults([ROW, ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({ last_name: 'smith', limit: 2 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(2);
    const enrich = getEnrichment(c);
    expect(enrich.truncated).toBe(true);
    expect(enrich.notice).toMatch(/1200|page size|narrow/i);
  });

  it('emits a broaden notice on an empty result', async () => {
    stubResults([]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({ last_name: 'zzzznosuchname', limit: 10 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toEqual([]);
    expect(getEnrichment(c).notice).toBeDefined();
  });

  it('uses the name_search shortcut to derive first/last', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ name_search: 'Joseph Abate', limit: 10 });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('first_name=Joseph');
    expect(calledUrl).toContain('last_name=Abate');
  });

  it('format: renders provider rows with NPI, specialty, status', () => {
    const blocks = searchProvidersTool.format!({
      providers: [
        {
          npi: '1720034424',
          type: 'individual',
          name: 'JOSEPH A ABATE',
          credential: 'MD',
          primaryTaxonomy: {
            code: '207RC0000X',
            description: 'Internal Medicine, Cardiovascular Disease',
          },
          city: 'Seattle',
          state: 'WA',
          status: 'active',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('1720034424');
    expect(text).toContain('active');
    expect(text).toContain('Seattle');
  });
});
