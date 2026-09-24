/**
 * @fileoverview Tests for the npi_search_providers tool — criteria validation,
 * specialty resolution + echo, pagination/ceiling disclosure, and error contracts.
 * The global `fetch` is stubbed so no live API is hit.
 * @module tests/mcp-server/tools/search-providers.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { getTaxonomyService, initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

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

  it('throws unresolved_specialty naming the inactive code before any upstream call (#16)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(searchProvidersTool, {
      specialty: 'graphics designer',
      city: 'Seattle',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as { error: { message: string; data: { reason: string } } }
    ).error;
    expect(error.data.reason).toBe('unresolved_specialty');
    expect(error.message).toContain('1744G0900X');
    expect(error.message).toMatch(/inactive/i);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('1744G0900X');
    expect(text).toMatch(/Recovery:/);
  });

  it('names the replacement when an inactive-only specialty has one (#16)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({ specialty: 'christian science', limit: 10 });
    const err = await Promise.resolve(searchProvidersTool.handler(input, ctx())).catch((e) => e);
    expect(err?.data?.reason).toBe('unresolved_specialty');
    expect(err?.message).toContain('287300000X');
    expect(err?.message).toContain('282J00000X');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws unresolved_specialty for a specialty named like an Object.prototype key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(searchProvidersTool, { specialty: 'constructor' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const error = (
      result.structuredContent as { error: { message: string; data: { reason: string } } }
    ).error;
    expect(error.data.reason).toBe('unresolved_specialty');
    expect(error.message).toBe('Specialty "constructor" matched no NUCC taxonomy.');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('Specialty "constructor" matched no NUCC taxonomy.');
  });

  it('lists each inactive code, name, and replacement in the unresolved_specialty message (characterization)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const result = await runToolContract(searchProvidersTool, { specialty: 'christian science' });
    const message =
      'Specialty "christian science" matched no active NUCC taxonomy. It matched only codes NUCC marks inactive: 287300000X Christian Science Sanitorium (replaced by 282J00000X); 317400000X Christian Science Facility (replaced by 282J00000X).';
    expect((result.structuredContent as { error: { message: string } }).error.message).toBe(
      message,
    );
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(message);
    const none = await runToolContract(searchProvidersTool, { specialty: 'graphics designer' });
    expect((none.structuredContent as { error: { message: string } }).error.message).toBe(
      'Specialty "graphics designer" matched no active NUCC taxonomy. It matched only codes NUCC marks inactive: 1744G0900X Graphics Designer (no replacement named).',
    );
  });

  it('never resolves a specialty to an inactive code (#16)', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const c = ctx();
    // NUCC's top plain-text hit for "psychotherapy" is the inactive 103TP2700X.
    const input = searchProvidersTool.input.parse({ specialty: 'psychotherapy', limit: 10 });
    await searchProvidersTool.handler(input, c);
    const enrich = enrichment(c);
    const codes = enrich.resolvedTaxonomies?.map((t) => t.code) ?? [];
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).not.toContain('103TP2700X');
    expect(codes).not.toContain('103TW0100X');
    for (const code of codes) {
      expect(getTaxonomyService().get(code)?.status).toBe('active');
    }
    expect(enrich.appliedTaxonomyDescription).toBe(enrich.resolvedTaxonomies?.[0]?.description);
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('taxonomy_description')).toBe(
      enrich.appliedTaxonomyDescription,
    );
  });

  it('still passes an inactive taxonomy_description through unchanged (#16, characterization)', async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const input = searchProvidersTool.input.parse({
      taxonomy_description: 'Graphics Designer',
      limit: 10,
    });
    await searchProvidersTool.handler(input, ctx());
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('taxonomy_description')).toBe('Graphics Designer');
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

// ── #10/#20/#21/#22: specialty resolution sends the representative description ──

describe('searchProvidersTool specialty resolution (#10, #20, #21, #22)', () => {
  /** Answer every registry request with an empty page; capture the outgoing URLs. */
  function stubEmptyRegistry(): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it.each([
    ['oncologist', '207RX0202X', 'Medical Oncology'],
    ['dentist', '122300000X', 'Dentist'],
    ['physician assistant', '363A00000X', 'Physician Assistant'],
    ['orthopedist', '207X00000X', 'Orthopaedic Surgery'],
    ['neurosurgeon', '207T00000X', 'Neurological Surgery'],
  ])('"%s" applies %s (%s) and sends it upstream', async (specialty, code, description) => {
    const fetchSpy = stubEmptyRegistry();
    const result = await runToolContract(searchProvidersTool, { specialty, city: 'Seattle' });
    const structured = result.structuredContent as SearchEnrichment;
    expect(structured.resolvedTaxonomies?.[0]).toEqual({ code, description });
    expect(structured.appliedTaxonomyDescription).toBe(description);
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('taxonomy_description')).toBe(description);
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(`**Resolved specialty →** ${description} (${code})`);
  });
});

describe('searchProvidersTool specialty resolution (#24, #25)', () => {
  function stubEmptyRegistry(): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(JSON.stringify({ result_count: 0, results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it('"therapist" never sends a physician description upstream', async () => {
    const fetchSpy = stubEmptyRegistry();
    const result = await runToolContract(searchProvidersTool, { specialty: 'therapist' });
    const structured = result.structuredContent as SearchEnrichment;
    expect(structured.appliedTaxonomyDescription).not.toBe('Therapeutic Radiology');
    expect(structured.appliedTaxonomyDescription).toMatch(/therapist/i);
    for (const candidate of structured.resolvedTaxonomies ?? []) {
      expect(getTaxonomyService().get(candidate.code)?.grouping).not.toBe(
        'Allopathic & Osteopathic Physicians',
      );
    }
    const calledUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('taxonomy_description')).toBe(
      structured.appliedTaxonomyDescription,
    );
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).not.toContain('Therapeutic Radiology');
  });

  it('"sports medicine" lists the Family Medicine code first', async () => {
    stubEmptyRegistry();
    const result = await runToolContract(searchProvidersTool, { specialty: 'sports medicine' });
    const structured = result.structuredContent as SearchEnrichment;
    expect(structured.resolvedTaxonomies?.[0]).toEqual({
      code: '207QS0010X',
      description: 'Sports Medicine',
    });
    expect(structured.resolvedTaxonomies?.map((t) => t.code)).not.toContain('2080S0010X');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Resolved specialty →** Sports Medicine (207QS0010X)');
  });
});

// ── #26 / #12: shared helpers ────────────────────────────────────────────────

/** Answer every registry request with one page of `results`; any other URL rejects as unmocked. */
function pageStub(results: unknown[]): ReturnType<typeof vi.fn> {
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

interface SearchSurface {
  continuationPostalCodes?: string[];
  nextPage?: { skip: number; limit: number };
  notice?: string;
  providers: Record<string, unknown>[];
  shown?: number;
  truncated?: boolean;
}

/** Run the tool through its public contract; return both client surfaces. */
async function contract(input: z.input<typeof searchProvidersTool.input>) {
  const result = await runToolContract(searchProvidersTool, input);
  expect(result.isError).not.toBe(true);
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return { structured: result.structuredContent as unknown as SearchSurface, text };
}

/** The query string of the first registry request. */
function sentQuery(fetchSpy: ReturnType<typeof vi.fn>): Record<string, string> {
  return Object.fromEntries(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams);
}

/** An individual row with one primary practice location and optional secondary ones. */
function practiceRow(
  npi: number,
  primary: { city: string; state: string; postal_code: string },
  practice: { city: string; state: string; postal_code: string }[] = [],
) {
  return {
    number: npi,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'PAT', last_name: 'SMITH', status: 'A' },
    addresses: [{ address_purpose: 'LOCATION', ...primary }],
    practiceLocations: practice.map((location) => ({ address_purpose: 'LOCATION', ...location })),
  };
}

/** `count` distinct rows all practicing at `postal`. */
function pageAt(count: number, postal = '981011234') {
  return Array.from({ length: count }, (_, index) =>
    practiceRow(1100000000 + index, { city: 'SEATTLE', state: 'WA', postal_code: postal }),
  );
}

// ── #26: other-name matches ──────────────────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/26

describe('searchProvidersTool other-name matches (#26)', () => {
  // Live row shape: current name ABBIATI, former name SMITH (2026-09-24).
  const FORMER_SMITH = {
    number: 1437702123,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'MICALA', last_name: 'ABBIATI', credential: 'RN', status: 'A' },
    other_names: [
      {
        code: '1',
        type: 'Former Name',
        first_name: 'MICALA',
        last_name: 'SMITH',
        prefix: '--',
        suffix: '--',
      },
    ],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SPOKANE', state: 'WA', postal_code: '992010000' },
    ],
  };
  const CURRENT_SMITH = {
    number: 1720034424,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
    other_names: [{ code: '1', type: 'Former Name', first_name: 'JANE', last_name: 'DOE' }],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
    ],
  };

  it('names the other name a row matched through, in structuredContent and content', async () => {
    pageStub([FORMER_SMITH, CURRENT_SMITH]);
    const { structured, text } = await contract({ last_name: 'Smith', limit: 5 });
    expect(structured.providers[0]?.matchedOtherName).toEqual({
      name: 'MICALA SMITH',
      type: 'Former Name',
    });
    expect(structured.providers[1]).not.toHaveProperty('matchedOtherName');
    expect(text).toContain('**Matched other name:** MICALA SMITH (Former Name)');
    expect(text.split('**Matched other name:**')).toHaveLength(2);
  });

  it('says in the notice that other names match and results sort by current name', async () => {
    pageStub([FORMER_SMITH, CURRENT_SMITH]);
    const { structured, text } = await contract({ last_name: 'Smith', limit: 5 });
    expect(structured.notice).toMatch(/1 of 2 row\(s\) matched through an other name/i);
    expect(structured.notice).toMatch(/sorts? by current name/i);
    expect(text).toMatch(/sorts? by current name/i);
  });

  it('adds no other-name notice when every row matched its current name', async () => {
    pageStub([CURRENT_SMITH]);
    const { structured } = await contract({ last_name: 'Smith', limit: 5 });
    expect(structured.providers[0]).not.toHaveProperty('matchedOtherName');
    expect(structured.notice).toBeUndefined();
  });

  it('keeps every row, in upstream order, and sends the same query (characterization)', async () => {
    const fetchSpy = pageStub([FORMER_SMITH, CURRENT_SMITH]);
    const { structured } = await contract({ last_name: 'Smith', skip: 40, limit: 5 });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1437702123', '1720034424']);
    expect(sentQuery(fetchSpy)).toEqual({
      version: '2.1',
      limit: '5',
      skip: '40',
      last_name: 'Smith',
    });
  });

  it('format: renders a matched other name with and without a type', () => {
    const text = searchProvidersTool.format!({
      providers: [
        {
          npi: '1437702123',
          type: 'individual',
          name: 'MICALA ABBIATI',
          matchedOtherName: { name: 'MICALA SMITH', type: 'Former Name' },
          status: 'active',
        },
        {
          npi: '1720034424',
          type: 'individual',
          name: 'JAN DOE',
          matchedOtherName: { name: 'JAN SMITH' },
          status: 'active',
        },
      ],
    })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain('**Matched other name:** MICALA SMITH (Former Name)');
    expect(text).toMatch(/\*\*Matched other name:\*\* JAN SMITH$/m);
  });
});

// ── #12: trailing-wildcard postal_code / city ────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/12

describe('searchProvidersTool wildcard postal_code and city (#12)', () => {
  const SEATTLE_ZIP4 = practiceRow(1000000001, {
    city: 'SEATTLE',
    state: 'WA',
    postal_code: '981011234',
  });
  const SEATTLE_ZIP5 = practiceRow(1000000002, {
    city: 'SEATTLE',
    state: 'WA',
    postal_code: '98101',
  });
  const PORTLAND_WITH_BELLEVUE = practiceRow(
    1000000003,
    { city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
    [{ city: 'BELLEVUE', state: 'WA', postal_code: '980040000' }],
  );
  const PORTLAND = practiceRow(1000000004, {
    city: 'PORTLAND',
    state: 'OR',
    postal_code: '972050000',
  });
  const SEATAC = practiceRow(1000000005, { city: 'SEATAC', state: 'WA', postal_code: '981880000' });

  it('matches a trailing-* postal_code as a ZIP prefix on any practice location', async () => {
    const fetchSpy = pageStub([SEATTLE_ZIP4, SEATTLE_ZIP5, PORTLAND_WITH_BELLEVUE, PORTLAND]);
    const { structured, text } = await contract({
      last_name: 'Smith',
      postal_code: '98*',
      limit: 10,
    });
    expect(structured.providers.map((row) => row.npi)).toEqual([
      '1000000001',
      '1000000002',
      '1000000003',
    ]);
    expect(structured.providers[2]?.matchedLocation).toEqual({
      city: 'BELLEVUE',
      state: 'WA',
      postalCode: '980040000',
    });
    expect(structured.notice).toMatch(/1 out-of-location row/i);
    expect(text).toContain('**Matched practice location:** BELLEVUE, WA 980040000');
    expect(sentQuery(fetchSpy)).toMatchObject({ postal_code: '98*', address_purpose: 'LOCATION' });
  });

  it('keeps a ZIP+4 prefix off rows recorded with only a 5-digit ZIP, as the registry does', async () => {
    pageStub([SEATTLE_ZIP4, SEATTLE_ZIP5]);
    const { structured } = await contract({ last_name: 'Smith', postal_code: '981011*' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000001']);
  });

  it('matches a trailing-* city as a case-insensitive prefix', async () => {
    const fetchSpy = pageStub([SEATTLE_ZIP4, SEATAC, PORTLAND_WITH_BELLEVUE]);
    const { structured } = await contract({ last_name: 'Smith', city: 'se*', state: 'WA' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000001', '1000000005']);
    expect(sentQuery(fetchSpy)).toMatchObject({ city: 'se*', state: 'WA' });
  });

  it('keeps exact postal_code and city matching as before (characterization)', async () => {
    pageStub([SEATTLE_ZIP4, SEATTLE_ZIP5, SEATAC]);
    const zip = await contract({ last_name: 'Smith', postal_code: '98101' });
    expect(zip.structured.providers.map((row) => row.npi)).toEqual(['1000000001', '1000000002']);
    const city = await contract({ last_name: 'Smith', city: 'Seattle' });
    expect(city.structured.providers.map((row) => row.npi)).toEqual(['1000000001', '1000000002']);
  });

  it.each(['9*', '*', '98**', '9*8', '98*1', 'AB*', '1234567890*'])(
    'rejects postal_code %s at the schema',
    (postal_code) => {
      expect(searchProvidersTool.input.safeParse({ last_name: 'Smith', postal_code }).success).toBe(
        false,
      );
    },
  );

  it.each(['S*', '*', 'SE*TTLE', 'SE**'])('rejects city %s at the schema', (city) => {
    expect(searchProvidersTool.input.safeParse({ last_name: 'Smith', city }).success).toBe(false);
  });

  it.each(['98*', '981011234*', '98101', '981011234', '', 'T2C 1N6'])(
    'accepts postal_code "%s"',
    (postal_code) => {
      expect(searchProvidersTool.input.safeParse({ last_name: 'Smith', postal_code }).success).toBe(
        true,
      );
    },
  );

  it.each(['SE*', 'SAN F*', 'Seattle', ''])('accepts city "%s"', (city) => {
    expect(searchProvidersTool.input.safeParse({ last_name: 'Smith', city }).success).toBe(true);
  });

  it('names the accepted wildcard shape when it rejects one, before any registry request', async () => {
    const fetchSpy = pageStub([]);
    const result = await runToolContract(searchProvidersTool, {
      last_name: 'Smith',
      postal_code: '9*',
    });
    expect(result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('postal_code');
    expect(text).toMatch(/2.9 digits followed by one trailing "\*"/);
  });
});

// ── #12: the next page and the terminal window ───────────────────────────────

describe('searchProvidersTool next page (#12)', () => {
  it.each([
    [0, 10, { skip: 10, limit: 10 }],
    [990, 10, { skip: 1000, limit: 10 }],
    [800, 200, { skip: 1000, limit: 200 }],
    [0, 200, { skip: 200, limit: 200 }],
  ])('a full page at skip %i, limit %i names the next page %o', async (skip, limit, next) => {
    pageStub(pageAt(limit));
    const { structured, text } = await contract({ last_name: 'Smith', skip, limit });
    expect(structured.nextPage).toEqual(next);
    expect(structured.notice).toContain(`skip ${next.skip}`);
    expect(structured.notice).not.toMatch(/page with skip/i);
    expect(structured.notice).not.toMatch(/repeat/i);
    expect(structured).not.toHaveProperty('continuationPostalCodes');
    expect(text).toContain(`**Next page:** skip ${next.skip}, limit ${next.limit}`);
  });

  it.each([
    [900, 200, 100],
    [1000, 10, 10],
    [1000, 50, 50],
    [999, 2, 1],
  ])(
    'past skip 1000 the next page from skip %i, limit %i is skip 1000, limit 200, repeating %i rows',
    async (skip, limit, repeats) => {
      pageStub(pageAt(limit));
      const { structured } = await contract({ last_name: 'Smith', skip, limit });
      expect(structured.nextPage).toEqual({ skip: 1000, limit: 200 });
      expect(structured.notice).toContain(`first ${repeats} row`);
      expect(structured.notice).toMatch(/dedupe by NPI/i);
      expect(structured).not.toHaveProperty('continuationPostalCodes');
    },
  );

  it('never names a next page the schema would reject', async () => {
    for (const [skip, limit] of [
      [0, 1],
      [999, 1],
      [1000, 1],
      [1000, 199],
      [801, 200],
    ] as const) {
      pageStub(pageAt(limit));
      const { structured } = await contract({ last_name: 'Smith', skip, limit });
      expect(
        searchProvidersTool.input.safeParse({ last_name: 'Smith', ...structured.nextPage }).success,
      ).toBe(true);
    }
  });

  it('a partial page names no next page, no continuation, and no notice', async () => {
    pageStub(pageAt(3));
    const { structured } = await contract({ last_name: 'Smith', skip: 20, limit: 10 });
    expect(structured).not.toHaveProperty('nextPage');
    expect(structured).not.toHaveProperty('continuationPostalCodes');
    expect(structured.notice).toBeUndefined();
  });

  it('an empty page past the end says the matches end before that skip', async () => {
    pageStub([]);
    const { structured, text } = await contract({ last_name: 'Smith', skip: 20, limit: 10 });
    expect(structured.providers).toEqual([]);
    expect(structured.notice).toContain('skip 20');
    expect(structured.notice).not.toMatch(/No providers matched/);
    expect(text).toContain('skip 20');
  });

  it('an empty first page keeps the broaden notice (characterization)', async () => {
    pageStub([]);
    const { structured } = await contract({ last_name: 'Smith', limit: 10 });
    expect(structured.notice).toMatch(/^No providers matched\. The registry uses substring/);
  });

  it('the full-page caveat names no field the response lacks', async () => {
    pageStub(pageAt(10));
    const { structured, text } = await contract({ last_name: 'Smith', limit: 10 });
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toMatch(/not a grand total/);
      expect(surface).not.toContain('result_count');
    }
  });
});

describe('searchProvidersTool terminal window continuation (#12)', () => {
  const digits = [...'0123456789'];

  it('with no postal_code, continues over every 2-digit ZIP prefix', async () => {
    pageStub(pageAt(200));
    const { structured, text } = await contract({ last_name: 'Smith', skip: 1000, limit: 200 });
    const codes = structured.continuationPostalCodes ?? [];
    expect(codes).toEqual(digits.flatMap((a) => digits.map((b) => `${a}${b}*`)));
    expect(structured).not.toHaveProperty('nextPage');
    const notice = structured.notice ?? '';
    expect(notice).toMatch(/no further live-API page/i);
    expect(notice).toMatch(/first 1200 matches are reachable/i);
    expect(notice).toMatch(/continuationPostalCodes/);
    expect(notice).toMatch(/skip 0/);
    // A page the location filter trimmed below limit can still name a nextPage, so the
    // procedure pages by nextPage, never by a short page.
    expect(notice).toMatch(/follow each one's nextPage until a response names none/);
    expect(notice).not.toMatch(/until a page returns fewer than limit/i);
    expect(notice).toMatch(/dedupe by NPI/i);
    expect(notice).toMatch(/outside the US/i);
    expect(notice).not.toMatch(/page with skip/i);
    expect(notice).not.toMatch(/total of|\d+ total/i);
    expect(text).toContain('**Continue with postal_code:** 00*, 01*, 02*');
    expect(text).toContain('98*, 99*');
  });

  it.each([
    ['98*', '98'],
    ['9810*', '9810'],
    ['981011*', '981011'],
    ['98101123*', '98101123'],
  ])('splits postal_code %s by one more digit', async (postal_code, prefix) => {
    pageStub(pageAt(200, '981011234'));
    const { structured } = await contract({
      last_name: 'Smith',
      postal_code,
      skip: 1000,
      limit: 200,
    });
    expect(structured.continuationPostalCodes).toEqual(digits.map((d) => `${prefix}${d}*`));
  });

  it.each([
    ['98101', '981011234', /5-digit ZIP/],
    ['98101*', '981011234', /5-digit ZIP/],
    ['981011234', '981011234', /ZIP\+4/],
    ['981011234*', '981011234', /ZIP\+4/],
    ['T2C1N6', 'T2C1N6', /numeric/],
  ])('at postal_code %s says no postal split remains', async (postal_code, rowPostal, reason) => {
    pageStub(pageAt(200, rowPostal));
    const { structured, text } = await contract({
      last_name: 'Smith',
      postal_code,
      skip: 1000,
      limit: 200,
    });
    expect(structured.continuationPostalCodes).toEqual([]);
    expect(structured.providers).toHaveLength(200);
    const notice = structured.notice ?? '';
    expect(notice).toMatch(/no further live-API page/i);
    expect(notice).toMatch(/no postal split remains/i);
    expect(notice).toMatch(reason);
    expect(notice).toMatch(/not guaranteed/i);
    expect(text).toContain('**Continue with postal_code:** none');
  });

  it('keys the continuation on the raw page even when the location filter dropped rows', async () => {
    const page = [
      ...pageAt(199),
      practiceRow(1200000000, { city: 'PORTLAND', state: 'OR', postal_code: '972010000' }),
    ];
    pageStub(page);
    const { structured } = await contract({
      last_name: 'Smith',
      postal_code: '98*',
      skip: 1000,
      limit: 200,
    });
    expect(structured.providers).toHaveLength(199);
    expect(structured.truncated).toBe(true);
    expect(structured.continuationPostalCodes).toEqual(digits.map((d) => `98${d}*`));
    expect(structured.notice).toMatch(/1 out-of-location row/i);
  });
});

// ── #29: dotted specialty abbreviations ──────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/29

describe('searchProvidersTool dotted specialty abbreviations (#29)', () => {
  it('sends "P.A." upstream as Physician Assistant, never a pathology description', async () => {
    const fetchSpy = pageStub([]);
    const { structured, text } = await contract({ specialty: 'P.A.', city: 'Seattle' });
    expect((structured as unknown as SearchEnrichment).resolvedTaxonomies?.[0]).toEqual({
      code: '363A00000X',
      description: 'Physician Assistant',
    });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe('Physician Assistant');
    expect(text).toContain('**Resolved specialty →** Physician Assistant (363A00000X)');
  });
});

// ── #30: individual and organization criteria can't be mixed ─────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/30

describe('searchProvidersTool mixed individual and organization criteria (#30)', () => {
  /** What NPPES answers for every mixed combination (live, 2026-09-24). */
  function stubMixedTypeError(): ReturnType<typeof vi.fn> {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            Errors: [
              {
                description: 'Cannot mix type 1 and type 2 search criteria',
                field: 'generic',
                number: '13',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  it.each([
    [{ last_name: 'Smith', provider_type: 'organization' }, ['last_name', 'provider_type']],
    [{ first_name: 'John', provider_type: 'organization' }, ['first_name', 'provider_type']],
    [
      { name_search: 'John Smith', provider_type: 'organization' },
      ['name_search', 'provider_type'],
    ],
    [
      { organization_name: 'Swedish', provider_type: 'individual' },
      ['organization_name', 'provider_type'],
    ],
    [{ organization_name: 'Swedish*', last_name: 'Smith' }, ['organization_name', 'last_name']],
    [{ organization_name: 'Swedish*', first_name: 'John' }, ['organization_name', 'first_name']],
    [
      { organization_name: 'Swedish*', last_name: 'Smith', provider_type: 'organization' },
      ['organization_name', 'last_name', 'provider_type'],
    ],
    [
      { organization_name: 'Swedish*', name_search: 'Smith', provider_type: 'individual' },
      ['organization_name', 'name_search', 'provider_type'],
    ],
  ] as const)('rejects %o before any registry request, naming %o', async (input, fields) => {
    const fetchSpy = stubMixedTypeError();
    const result = await runToolContract(searchProvidersTool, input);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery?: { hint: string } } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('mixed_provider_criteria');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toMatch(/Recovery:/);
    for (const field of fields) {
      expect(error.data.recovery?.hint).toContain(field);
      expect(text).toContain(field);
    }
    expect(text).toMatch(/individual/i);
    expect(text).toMatch(/organization/i);
    expect(text).not.toMatch(/wildcard/i);
  });

  it.each([
    [{ last_name: 'Smith' }, { last_name: 'Smith' }],
    [
      { last_name: 'Smith', provider_type: 'individual' },
      { last_name: 'Smith', enumeration_type: 'NPI-1' },
    ],
    [
      { first_name: 'John', provider_type: 'individual' },
      { first_name: 'John', enumeration_type: 'NPI-1' },
    ],
    [{ name_search: 'John Smith' }, { first_name: 'John', last_name: 'Smith' }],
    [
      { organization_name: 'Swedish*' },
      { organization_name: 'Swedish*', enumeration_type: 'NPI-2' },
    ],
    [
      { organization_name: 'Swedish*', provider_type: 'organization' },
      { organization_name: 'Swedish*', enumeration_type: 'NPI-2' },
    ],
    [
      { organization_name: 'Swedish*', last_name: '', first_name: '  ', name_search: '' },
      { organization_name: 'Swedish*', enumeration_type: 'NPI-2' },
    ],
    [
      { city: 'Seattle', provider_type: 'organization' },
      { city: 'Seattle', enumeration_type: 'NPI-2' },
    ],
  ] as const)('%o still searches as before (characterization)', async (input, sent) => {
    const fetchSpy = pageStub([]);
    await contract({ ...input, limit: 5 });
    const query = sentQuery(fetchSpy);
    expect(query).toMatchObject(sent);
    if (!('enumeration_type' in sent)) expect(query).not.toHaveProperty('enumeration_type');
    for (const key of ['first_name', 'last_name', 'organization_name']) {
      if (!(key in sent)) expect(query).not.toHaveProperty(key);
    }
  });
});

// ── #31: a specialty made only of stop words ─────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/31

describe('searchProvidersTool stop-word-only specialty (#31)', () => {
  type ErrorData = { reason?: string; recovery?: { hint?: string } };

  it.each([
    ['doctor', true],
    ['physician', true],
    ['do', true],
    ['M.D.', true],
    ['specialist', false],
  ] as const)(
    'specialty "%s" fails with unresolved_specialty before any registry request',
    async (specialty, physician) => {
      const fetchSpy = pageStub([]);
      const result = await runToolContract(searchProvidersTool, {
        specialty,
        city: 'Seattle',
        state: 'WA',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { message: string; data: ErrorData } })
        .error;
      expect(error.data.reason).toBe('unresolved_specialty');
      expect(error.message).toBe(`Specialty "${specialty}" names no specialty on its own.`);
      expect(error.data.recovery?.hint).toMatch(/npi_lookup_taxonomy mode browse/);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain('Recovery:');
      expect(text).toContain('npi_lookup_taxonomy mode browse');
      expect(text.includes('grouping "Allopathic & Osteopathic Physicians"')).toBe(physician);
    },
  );

  it.each([
    ['physician assistant', 'Physician Assistant'],
    ['heart doctor', 'Cardiovascular Disease'],
    ['family doctor', 'Family Medicine'],
  ])(
    'specialty "%s" still sends %s upstream (characterization)',
    async (specialty, description) => {
      const fetchSpy = pageStub([]);
      await contract({ specialty, city: 'Seattle' });
      expect(sentQuery(fetchSpy).taxonomy_description).toBe(description);
    },
  );
});

// ── #32: plural stop words ───────────────────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/32

describe('searchProvidersTool plural stop words in specialty (#32)', () => {
  type ErrorData = { reason?: string; recovery?: { hint?: string } };

  it.each([
    ['physicians', true],
    ['doctors', true],
    ['specialists', false],
    ['providers', false],
  ] as const)(
    'specialty "%s" fails with unresolved_specialty before any registry request',
    async (specialty, physician) => {
      const fetchSpy = pageStub([]);
      const result = await runToolContract(searchProvidersTool, { specialty, city: 'Seattle' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as { error: { code: number; message: string; data: ErrorData } }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unresolved_specialty');
      expect(error.message).toBe(`Specialty "${specialty}" names no specialty on its own.`);
      expect(error.data.recovery?.hint).toMatch(/npi_lookup_taxonomy mode browse/);
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).toContain(`Specialty "${specialty}" names no specialty on its own.`);
      expect(text).toContain('Recovery:');
      expect(text).toContain('npi_lookup_taxonomy mode browse');
      expect(text.includes('grouping "Allopathic & Osteopathic Physicians"')).toBe(physician);
    },
  );

  it.each([
    ['heart doctors', 'Cardiovascular Disease', '207RC0000X'],
    ['family doctors', 'Family Medicine', '207Q00000X'],
  ])(
    'specialty "%s" sends %s upstream and echoes %s on both surfaces',
    async (specialty, description, code) => {
      const fetchSpy = pageStub([]);
      const { structured, text } = await contract({ specialty, city: 'Seattle' });
      expect(sentQuery(fetchSpy).taxonomy_description).toBe(description);
      const echoed = structured as unknown as {
        appliedTaxonomyDescription?: string;
        resolvedTaxonomies?: { code: string }[];
      };
      expect(echoed.appliedTaxonomyDescription).toBe(description);
      expect(echoed.resolvedTaxonomies?.[0]?.code).toBe(code);
      expect(text).toContain(`${description} (${code})`);
    },
  );
});
