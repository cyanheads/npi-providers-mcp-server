/**
 * @fileoverview Tests for the npi_search_providers tool — criteria validation,
 * specialty resolution + echo, pagination/ceiling disclosure, and error contracts.
 * The global `fetch` is stubbed so no live API is hit.
 * @module tests/mcp-server/tools/search-providers.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

beforeAll(() => {
  initTaxonomyService();
  initNppesService();
});

const ctx = () => createMockContext({ errors: searchProvidersTool.errors });

interface SearchEnrichment {
  appliedTaxonomyDescription?: string;
  cap?: number;
  notice?: string;
  resolvedTaxonomies?: { code: string; description: string }[];
  shown?: number;
  truncated?: boolean;
}

function enrichment(c: ReturnType<typeof ctx>): SearchEnrichment {
  return getEnrichment(c) as SearchEnrichment;
}

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
    const enrich = enrichment(c);
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
    expect(enrichment(c).appliedTaxonomyDescription).toBe('Cardiovascular Disease');
    expect(enrichment(c).resolvedTaxonomies).toBeUndefined();
  });

  it('discloses truncation and the page-size-not-total caveat on a full page', async () => {
    stubResults([ROW, ROW]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({ last_name: 'smith', limit: 2 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toHaveLength(2);
    const enrich = enrichment(c);
    expect(enrich.truncated).toBe(true);
    expect(enrich.notice).toMatch(/1200|page size|narrow/i);
  });

  it('emits a broaden notice on an empty result', async () => {
    stubResults([]);
    const c = ctx();
    const input = searchProvidersTool.input.parse({ last_name: 'zzzznosuchname', limit: 10 });
    const result = await searchProvidersTool.handler(input, c);
    expect(result.providers).toEqual([]);
    expect(enrichment(c).notice).toBeDefined();
  });

  it('uses the name_search shortcut to derive first/last', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ name_search: 'Joseph Abate', limit: 10 });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('first_name=Joseph');
    expect(calledUrl).toContain('last_name=Abate');
  });

  it('uses a one-token name_search as the last name only', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ name_search: 'Abate', limit: 10 });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('last_name=Abate');
    expect(calledUrl).not.toContain('first_name=');
  });

  it('infers organization enumeration and forwards all populated criteria', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({
      organization_name: 'Example Health',
      taxonomy_description: 'Multi-Specialty',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      skip: 20,
      limit: 25,
    });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(Object.fromEntries(calledUrl.searchParams)).toMatchObject({
      enumeration_type: 'NPI-2',
      organization_name: 'Example Health',
      taxonomy_description: 'Multi-Specialty',
      city: 'Seattle',
      state: 'WA',
      postal_code: '98101',
      skip: '20',
      limit: '25',
    });
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

  it('format: renders an honest empty response and sparse provider row', () => {
    expect(searchProvidersTool.format!({ providers: [] })).toEqual([
      { type: 'text', text: 'No providers matched.' },
    ]);
    const blocks = searchProvidersTool.format!({
      providers: [
        {
          npi: '1234567893',
          type: 'organization',
          name: 'EXAMPLE HEALTH',
          status: 'deactivated',
        },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain('1234567893');
    expect(text).toContain('deactivated');
    expect(text).not.toContain('Primary specialty');
    expect(text).not.toContain('Location:');
  });

  // ── #5: blank optional state from form clients ──────────────────────────────

  it('accepts a blank state from a form client and omits it from the query (#5)', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
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
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
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
    expect(enrichment(c).notice).toMatch(/1 out-of-location row/i);
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
    const notice = enrichment(c).notice ?? '';
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
    const enrich = enrichment(c);
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

  it('post-filters a 9-digit request against a 5-digit row ZIP prefix (#4)', async () => {
    const fiveDigitZip = {
      ...ROW,
      addresses: [
        { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '98101' },
      ],
    };
    stubResults([fiveDigitZip]);
    const input = searchProvidersTool.input.parse({ postal_code: '981012345', limit: 10 });
    const result = await searchProvidersTool.handler(input, ctx());
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.postalCode).toBe('98101');
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

// ── #18: location post-filter over every professional location ──────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/18

describe('searchProvidersTool location matching across practice locations (#18)', () => {
  /** Answer registry requests with one page of `results`; any other URL rejects as unmocked. */
  function stubRegistryPage(results: unknown[]): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).origin !== 'https://npiregistry.cms.hhs.gov') {
        throw new Error('unmocked fetch');
      }
      return new Response(JSON.stringify({ result_count: results.length, results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  /** Run the tool through its public contract: handler, output parse, format, enrichment. */
  async function run(input: z.input<typeof searchProvidersTool.input>) {
    const result = await runToolContract(searchProvidersTool, input);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      providers: Record<string, unknown>[];
      notice?: string;
      shown?: number;
      truncated?: boolean;
    };
    const text = result.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    return { structured, text };
  }

  // Primary LOCATION in St. Louis, a Seattle mailing address, and a Seattle practice location.
  const SECONDARY_SEATTLE = {
    number: 1679937908,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'ALEX', last_name: 'SURGEON', credential: 'MD', status: 'A' },
    taxonomies: [{ code: '207T00000X', desc: 'Neurological Surgery', primary: true }],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SAINT LOUIS', state: 'MO', postal_code: '631041016' },
      { address_purpose: 'MAILING', city: 'SEATTLE', state: 'WA', postal_code: '981956410' },
    ],
    practiceLocations: [
      {
        address_purpose: 'LOCATION',
        address_1: '1959 NE PACIFIC ST',
        city: 'SEATTLE',
        state: 'WA',
        postal_code: '981956410',
      },
    ],
  };

  // Primary LOCATION in Seattle, plus a practice location elsewhere.
  const PRIMARY_SEATTLE = {
    number: 1720034424,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'JOSEPH', last_name: 'ABATE', credential: 'MD', status: 'A' },
    taxonomies: [
      { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
    ],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981012345' },
    ],
    practiceLocations: [
      { address_purpose: 'LOCATION', city: 'BELLEVUE', state: 'WA', postal_code: '980040000' },
    ],
  };

  // Seattle only on the MAILING row: the registry returns it, the server must not.
  const MAILING_ONLY_SEATTLE = {
    number: 1234567893,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'MAIL', last_name: 'ONLY', status: 'A' },
    taxonomies: [{ code: '207R00000X', desc: 'Internal Medicine', primary: true }],
    addresses: [
      { address_purpose: 'MAILING', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
      { address_purpose: 'LOCATION', city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
    ],
    practiceLocations: [],
  };

  // Several practice locations; only the second is in Seattle.
  const SECOND_PRACTICE_SEATTLE = {
    number: 1174905814,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'MULTI', last_name: 'SITE', status: 'A' },
    taxonomies: [{ code: '207Q00000X', desc: 'Family Medicine', primary: true }],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SPOKANE', state: 'WA', postal_code: '992010000' },
    ],
    practiceLocations: [
      { address_purpose: 'LOCATION', city: 'TACOMA', state: 'WA', postal_code: '984020000' },
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981040000' },
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981090000' },
    ],
  };

  it('keeps a row whose primary LOCATION matches, without a matchedLocation (characterization)', async () => {
    stubRegistryPage([PRIMARY_SEATTLE]);
    const { structured, text } = await run({ city: 'Seattle', state: 'WA', limit: 10 });
    expect(structured.providers).toEqual([
      {
        npi: '1720034424',
        type: 'individual',
        name: 'JOSEPH ABATE',
        credential: 'MD',
        primaryTaxonomy: {
          code: '207RC0000X',
          description: 'Internal Medicine, Cardiovascular Disease',
        },
        city: 'SEATTLE',
        state: 'WA',
        postalCode: '981012345',
        status: 'active',
      },
    ]);
    expect(structured.notice).toBeUndefined();
    expect(text).toContain('**Location:** SEATTLE, WA 981012345');
    expect(text).not.toContain('BELLEVUE');
  });

  it('drops a row that matches only on its MAILING address (characterization)', async () => {
    stubRegistryPage([PRIMARY_SEATTLE, MAILING_ONLY_SEATTLE]);
    const { structured, text } = await run({ city: 'Seattle', state: 'WA', limit: 10 });
    expect(structured.providers.map((p) => p.npi)).toEqual(['1720034424']);
    expect(structured.notice).toMatch(/1 out-of-location row/i);
    expect(text).not.toContain('1234567893');
    expect(text).not.toContain('981010000');
  });

  it('drops a row whose requested city and ZIP match two different locations (characterization)', async () => {
    // City SEATTLE is only on the primary LOCATION; ZIP 98004 is only on the practice location.
    stubRegistryPage([PRIMARY_SEATTLE]);
    const { structured, text } = await run({ city: 'Seattle', postal_code: '98004', limit: 10 });
    expect(structured.providers).toEqual([]);
    expect(structured.notice).toMatch(/none were in the requested location/i);
    expect(text).toContain('No providers matched.');
  });

  it('does not filter or add a matchedLocation when no location is requested (characterization)', async () => {
    stubRegistryPage([SECONDARY_SEATTLE, MAILING_ONLY_SEATTLE]);
    const { structured } = await run({ last_name: 'SURGEON', limit: 10 });
    expect(structured.providers.map((p) => p.npi)).toEqual(['1679937908', '1234567893']);
    for (const row of structured.providers) {
      expect(row).not.toHaveProperty('matchedLocation');
      expect(row).not.toHaveProperty('practiceLocations');
    }
    expect(structured.notice).toBeUndefined();
  });

  it('reports an empty upstream page for a location search with the broaden notice (characterization)', async () => {
    stubRegistryPage([]);
    const { structured, text } = await run({ city: 'Seattle', state: 'WA', limit: 10 });
    expect(structured.providers).toEqual([]);
    expect(structured.notice).toMatch(/No providers matched/);
    expect(structured.notice).not.toMatch(/requested location/i);
    expect(text).toContain('No providers matched.');
  });

  it('keeps a row that matches only on a secondary practice location and shows that location', async () => {
    stubRegistryPage([SECONDARY_SEATTLE]);
    const { structured, text } = await run({
      city: 'SEATTLE',
      state: 'WA',
      provider_type: 'individual',
      limit: 10,
    });
    expect(structured.providers).toEqual([
      {
        npi: '1679937908',
        type: 'individual',
        name: 'ALEX SURGEON',
        credential: 'MD',
        primaryTaxonomy: { code: '207T00000X', description: 'Neurological Surgery' },
        // city/state/postalCode keep their meaning: the primary LOCATION address.
        city: 'SAINT LOUIS',
        state: 'MO',
        postalCode: '631041016',
        matchedLocation: { city: 'SEATTLE', state: 'WA', postalCode: '981956410' },
        status: 'active',
      },
    ]);
    expect(structured.notice).toBeUndefined();
    expect(text).toContain('**Location:** SAINT LOUIS, MO 631041016');
    expect(text).toContain('**Matched practice location:** SEATTLE, WA 981956410');
  });

  it('matches the second of several practice locations and reports that one', async () => {
    stubRegistryPage([SECOND_PRACTICE_SEATTLE]);
    const { structured, text } = await run({ city: 'seattle', state: 'WA', limit: 10 });
    expect(structured.providers).toHaveLength(1);
    expect(structured.providers[0]).toMatchObject({
      npi: '1174905814',
      city: 'SPOKANE',
      matchedLocation: { city: 'SEATTLE', state: 'WA', postalCode: '981040000' },
    });
    expect(text).toContain('**Matched practice location:** SEATTLE, WA 981040000');
    expect(text).not.toContain('TACOMA');
  });

  it('matches a postal_code prefix against a secondary practice location', async () => {
    stubRegistryPage([SECONDARY_SEATTLE, MAILING_ONLY_SEATTLE]);
    const { structured, text } = await run({ postal_code: '98195', limit: 10 });
    expect(structured.providers.map((p) => p.npi)).toEqual(['1679937908']);
    expect(structured.providers[0]?.matchedLocation).toEqual({
      city: 'SEATTLE',
      state: 'WA',
      postalCode: '981956410',
    });
    expect(text).toContain('**Matched practice location:** SEATTLE, WA 981956410');
  });

  it('keeps primary and secondary matches, drops mailing-only, and keys truncation on the raw page', async () => {
    stubRegistryPage([SECONDARY_SEATTLE, MAILING_ONLY_SEATTLE, PRIMARY_SEATTLE]);
    const { structured } = await run({ city: 'Seattle', state: 'WA', limit: 3 });
    expect(structured.providers.map((p) => p.npi)).toEqual(['1679937908', '1720034424']);
    expect(structured.truncated).toBe(true);
    expect(structured.shown).toBe(2);
    expect(structured.notice).toMatch(/1 out-of-location row/i);
    expect(structured.notice).toMatch(/1200/);
  });

  it('describes why a row was dropped by practice location, blaming neither specialty nor mailing matches', async () => {
    // Upstream now matches practice addresses only (#19); a dropped row is one whose
    // practice locations don't satisfy every requested field on the same location.
    stubRegistryPage([PRIMARY_SEATTLE, MAILING_ONLY_SEATTLE]);
    const kept = await run({ city: 'Seattle', state: 'WA', limit: 10 });
    expect(kept.structured.notice).toMatch(/practice location matches every requested/i);
    expect(kept.structured.notice).not.toMatch(/specialty|mailing/i);

    stubRegistryPage([MAILING_ONLY_SEATTLE]);
    const none = await run({ city: 'Seattle', state: 'WA', limit: 10 });
    expect(none.structured.notice).toMatch(/none were in the requested location/i);
    expect(none.structured.notice).toMatch(/practice location matches every requested/i);
    expect(none.structured.notice).not.toMatch(/specialty|mailing/i);
    expect(none.text).toMatch(/practice location matches every requested/i);
  });

  it('format: renders a matched practice location alongside the primary location', () => {
    const text = searchProvidersTool.format!({
      providers: [
        {
          npi: '1679937908',
          type: 'individual',
          name: 'ALEX SURGEON',
          city: 'SAINT LOUIS',
          state: 'MO',
          matchedLocation: { city: 'SEATTLE', state: 'WA' },
          status: 'active',
        },
      ],
    })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Location:** SAINT LOUIS, MO');
    expect(text).toContain('**Matched practice location:** SEATTLE, WA');
  });
});
