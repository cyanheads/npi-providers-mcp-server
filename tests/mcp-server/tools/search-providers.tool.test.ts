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

// A cardiologist NPPES returns for a Seattle, WA query despite the LOCATION address
// being Salt Lake City, UT — the exact out-of-location leak from issue #4 (NPI 1245792779).
const OUT_OF_LOCATION_ROW = {
  number: 1245792779,
  enumeration_type: 'NPI-1',
  basic: { first_name: 'ALEKSANDRA', last_name: 'ABRAHAMOWICZ', credential: 'MD', status: 'A' },
  taxonomies: [
    { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
  ],
  addresses: [
    { address_purpose: 'LOCATION', city: 'SALT LAKE CITY', state: 'UT', postal_code: '841021234' },
  ],
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

  // ── #5: blank optional state from form clients ──────────────────────────────

  it('accepts a blank state from a form client and omits it from the query (#5)', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ last_name: 'Abate', state: '', limit: 1 });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('last_name=Abate');
    expect(calledUrl).not.toContain('state=');
  });

  it('applies a valid state to the query (#5)', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ last_name: 'Abate', state: 'WA', limit: 1 });
    await searchProvidersTool.handler(input, ctx());
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('state=WA');
  });

  it('rejects a malformed state at schema validation (#5)', () => {
    for (const bad of ['washington', 'wa']) {
      expect(() =>
        searchProvidersTool.input.parse({ last_name: 'Abate', state: bad, limit: 1 }),
      ).toThrow();
    }
  });

  // ── #4: location post-filtering ─────────────────────────────────────────────

  it('post-filters out-of-location rows for a location-constrained search (#4)', async () => {
    // Upstream returns the Salt Lake City row first, then the Seattle row.
    stubResults([OUT_OF_LOCATION_ROW, ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({
      specialty: 'cardiologist',
      city: 'Seattle',
      state: 'WA',
      limit: 10,
    });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({ npi: '1720034424', city: 'Seattle', state: 'WA' });
    expect(result.providers.some((p) => p.state === 'UT')).toBe(false);
    expect(getEnrichment(c).notice).toMatch(/1 out-of-location row/i);
  });

  it('emits a distinct notice when upstream matched but nothing was in the location (#4)', async () => {
    stubResults([OUT_OF_LOCATION_ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({
      specialty: 'cardiologist',
      city: 'Seattle',
      state: 'WA',
      limit: 10,
    });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toEqual([]);
    const notice = getEnrichment(c).notice ?? '';
    expect(notice).toMatch(/none were in the requested location/i);
    // Must NOT be the generic "broaden the specialty" notice — the specialty DID match.
    expect(notice).not.toMatch(/substring matching on specialty/i);
  });

  it('keys truncation on the raw upstream page size, not the post-filtered count (#4)', async () => {
    // A full page (limit 2): one in-location, one out. The post-filter drops one,
    // but `truncated` must still fire because the raw upstream page was full.
    stubResults([ROW, OUT_OF_LOCATION_ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({
      specialty: 'cardiologist',
      city: 'Seattle',
      state: 'WA',
      limit: 2,
    });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(1);
    const enrich = getEnrichment(c);
    expect(enrich.truncated).toBe(true);
    expect(enrich.shown).toBe(1); // kept count, not the raw page size
  });

  it('exposes the LOCATION postal code on the summary row (#4)', async () => {
    const rowWithZip = {
      ...ROW,
      addresses: [
        { address_purpose: 'LOCATION', city: 'Seattle', state: 'WA', postal_code: '981012345' },
      ],
    };
    stubResults([rowWithZip]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({ last_name: 'Abate', limit: 10 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers[0]?.postalCode).toBe('981012345');
  });

  it('post-filters by postal_code with 5-vs-9-digit ZIP+4 tolerance (#4)', async () => {
    const seattleZip = {
      ...ROW,
      addresses: [
        { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981012345' },
      ],
    };
    const portlandZip = {
      number: 1999999999,
      enumeration_type: 'NPI-1',
      basic: { last_name: 'OTHER', status: 'A' },
      taxonomies: [],
      addresses: [
        { address_purpose: 'LOCATION', city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
      ],
    };
    stubResults([seattleZip, portlandZip]);
    const c = ctx();
    // A 5-digit request must match the row's 9-digit ZIP+4 by prefix.
    const input = searchProvidersTool.input.parse({ postal_code: '98101', limit: 10 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.postalCode).toBe('981012345');
  });

  it('format: renders the postal code on the location line (#4)', () => {
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
          postalCode: '98101',
          status: 'active',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Seattle, WA 98101');
  });
});
