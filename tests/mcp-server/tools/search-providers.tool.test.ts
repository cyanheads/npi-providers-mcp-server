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
import {
  createSearchProvidersTool,
  searchProvidersTool,
} from '@/mcp-server/tools/definitions/search-providers.tool.js';
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
  continuationPostalCodes?: string[];
  notice?: string;
  resolvedTaxonomies?: { code: string; description: string }[];
  shown?: number;
  truncated?: boolean;
}

function enrichment(c: ReturnType<typeof ctx>): SearchEnrichment {
  return getEnrichment(c) as SearchEnrichment;
}

function contractEnrichment(result: { structuredContent?: unknown }): SearchEnrichment {
  return result.structuredContent as SearchEnrichment;
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
  it.each([10, 200, 201])(
    'records exactly one notice log only for an actual clamp (%s)',
    async (limit) => {
      stubResults([]);
      const c = ctx();
      const log = vi.spyOn(c.log, 'notice');
      await searchProvidersTool.handler(
        searchProvidersTool.input.parse({ last_name: 'Abate', limit }),
        c,
      );
      if (limit > 200)
        expect(log).toHaveBeenCalledExactlyOnceWith('Tool limit clamped.', {
          tool: 'npi_search_providers',
          requested: 201,
          applied: 200,
        });
      else expect(log).not.toHaveBeenCalled();
    },
  );

  it('rejects non-boolean alias options before requesting upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(searchProvidersTool, {
      first_name: 'Bob',
      use_first_name_alias: 'False' as unknown as boolean,
    });
    expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(result.content)).toContain('use_first_name_alias');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])('rejects invalid limit %s in both deployment modes', async (limit) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const mode of [true, false]) {
      const result = await runToolContract(createSearchProvidersTool(mode), {
        last_name: 'Abate',
        limit,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('restores the advertised maximum and rejects excess before upstream when disabled', async () => {
    const definition = createSearchProvidersTool(false);
    expect(definition.input.shape.limit.toJSONSchema()).toMatchObject({
      maximum: 200,
      default: 10,
    });
    expect(searchProvidersTool.input.shape.limit.toJSONSchema().maximum).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await runToolContract(definition, { city: 'Seattle', limit: 201 })).isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(definition.input.parse({ city: 'Seattle' }).limit).toBe(10);
    expect(searchProvidersTool.input.parse({ city: 'Seattle' }).limit).toBe(10);
  });

  it.each([0, 1])('retains clamp and offset/empty guidance for %s returned rows', async (count) => {
    stubResults(Array.from({ length: count }, () => ROW));
    const result = await runToolContract(searchProvidersTool, {
      last_name: 'Abate',
      limit: 201,
      skip: 400,
    });
    expect(result.isError).not.toBe(true);
    expect(contractEnrichment(result).notice).toMatch(/201.*200/);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('nextPage');
    expect(JSON.stringify(result.content)).toMatch(/201.*200/);
    if (!count) {
      expect(contractEnrichment(result).notice).toContain('matches end before that offset');
      expect(JSON.stringify(result.content)).toContain('matches end before that offset');
    }
  });

  it('uses the applied limit for terminal continuation despite location filtering', async () => {
    stubResults(
      Array.from({ length: 200 }, (_, index) => (index === 0 ? ROW : OUT_OF_LOCATION_ROW)),
    );
    const result = await runToolContract(searchProvidersTool, {
      city: 'Seattle',
      state: 'WA',
      limit: 201,
      skip: 1000,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ cap: 200, shown: 1, truncated: true });
    expect(result.structuredContent).not.toHaveProperty('nextPage');
    expect(contractEnrichment(result).continuationPostalCodes).toHaveLength(100);
    for (const text of [
      String(contractEnrichment(result).notice),
      JSON.stringify(result.content),
    ]) {
      expect(text).toContain('terminal window');
      expect(text).toContain('199 out-of-location');
      expect(text).toMatch(/201.*200/);
    }
  });

  it('computes overlapping next-page guidance from the applied limit', async () => {
    stubResults(Array.from({ length: 200 }, () => ROW));
    const result = await runToolContract(searchProvidersTool, {
      last_name: 'Abate',
      limit: 201,
      skip: 950,
    });
    expect(result.structuredContent).toMatchObject({ nextPage: { skip: 1000, limit: 200 } });
    expect(contractEnrichment(result).notice).toContain('first 150 row(s) repeat');
    expect(JSON.stringify(result.content)).toContain('first 150 row(s) repeat');
  });

  it.each([
    [{ name_search: 'Bob Smith' }, 'Bob', true],
    [
      { name_search: 'Bob Smith', first_name: 'Robert', use_first_name_alias: false },
      'Robert',
      false,
    ],
    [{ first_name: 'Bob', use_first_name_alias: true }, 'Bob', true],
  ] as const)(
    'reports effective aliases after explicit name precedence: %j',
    async (input, first, applied) => {
      stubResults([]);
      const result = await runToolContract(searchProvidersTool, input);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ appliedFirstNameAlias: applied });
      expect(
        new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).searchParams.get('first_name'),
      ).toBe(first);
      expect(JSON.stringify(result.content)).toContain(`First-name aliases:** ${applied}`);
    },
  );

  it.each([
    [{ name_search: 'Bob Smith', first_name: 'Ro*', use_first_name_alias: false }, 'wildcard'],
    [{ organization_name: 'Hospital', use_first_name_alias: false }, 'no first_name'],
    [{ name_search: 'Smith', use_first_name_alias: true }, 'no first_name'],
  ] as const)(
    'reports inapplicable aliases without effective metadata: %j',
    async (input, reason) => {
      stubResults([]);
      const result = await runToolContract(searchProvidersTool, input);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).not.toHaveProperty('appliedFirstNameAlias');
      expect(contractEnrichment(result).notice).toContain(reason);
      expect(JSON.stringify(result.content)).toContain(reason);
      expect(contractEnrichment(result).notice).toContain('broadening');
      expect(
        new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).searchParams.get(
          'use_first_name_alias',
        ),
      ).toBe(input.use_first_name_alias ? 'True' : 'False');
    },
  );

  it('rejects an alias-only request with the no-search recovery on both surfaces', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(searchProvidersTool, { use_first_name_alias: false });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_search_criteria',
          recovery: { hint: expect.stringContaining('Provide at least one') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Provide at least one');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves upstream names and omits the alias parameter by default', async () => {
    stubResults([ROW, { ...ROW, basic: { ...ROW.basic, first_name: 'ROBERT' } }]);
    const result = await runToolContract(searchProvidersTool, { first_name: 'Bob' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      providers: [{ name: 'JOSEPH ABATE' }, { name: 'ROBERT ABATE' }],
    });
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(url.searchParams.has('use_first_name_alias')).toBe(false);
  });

  it('clamps an over-cap page and uses the applied limit for pagination on both surfaces', async () => {
    stubResults(Array.from({ length: 200 }, () => ROW));
    const result = await runToolContract(searchProvidersTool, { last_name: 'Abate', limit: 201 });
    expect(result.isError).not.toBe(true);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).searchParams.get('limit')).toBe(
      '200',
    );
    expect(result.structuredContent).toMatchObject({
      cap: 200,
      truncated: true,
      nextPage: { skip: 200, limit: 200 },
    });
    expect(contractEnrichment(result).notice).toMatch(/201.*200/);
    expect(JSON.stringify(result.content)).toMatch(/201.*200/);
  });

  it('forwards false aliases for the name shortcut and reports the effective setting on both surfaces', async () => {
    stubResults([]);
    const result = await runToolContract(searchProvidersTool, {
      name_search: 'Bob Smith',
      use_first_name_alias: false,
    });
    expect(result.isError).not.toBe(true);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      first_name: 'Bob',
      last_name: 'Smith',
      use_first_name_alias: 'False',
    });
    expect(result.structuredContent).toMatchObject({ appliedFirstNameAlias: false });
    expect(contractEnrichment(result).notice).toMatch(/broadening/);
    expect(JSON.stringify(result.content)).toContain('false');
  });

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
    expect(notice).not.toMatch(/^No providers matched/);
    expect(notice).not.toMatch(/prefix of a taxonomy/i);
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
    // The Pediatrics variant ranks past the five candidates, listed only for sharing the text (#51).
    expect(structured.resolvedTaxonomies?.map((t) => t.code).indexOf('2080S0010X')).toBe(7);
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

/** A failed call's error, as `structuredContent` carries it. */
type ErrorEnvelope = {
  error: { code: number; message: string; data: { reason: string; recovery?: { hint: string } } };
};

/** Answer every registry request with one `Errors[]` field error, as NPPES does (HTTP 200). */
function fieldErrorStub(field: string, number: string, description: string) {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ Errors: [{ description, field, number }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Run the tool through its public contract, expecting a failure; return both client surfaces. */
async function failure(input: z.input<typeof searchProvidersTool.input>) {
  const result = await runToolContract(searchProvidersTool, input);
  expect(result.isError).toBe(true);
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return { error: (result.structuredContent as unknown as ErrorEnvelope).error, text };
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
    const error = (result.structuredContent as { error: { message: string } }).error;
    expect(error.message).toContain('2–9 digits followed by one trailing "*"');
    expect(text).toContain('2–9 digits followed by one trailing "\\*"');
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

  it('an empty first page keeps the broaden notice, describing prefix matching (#44)', async () => {
    pageStub([]);
    const { structured } = await contract({ last_name: 'Smith', limit: 10 });
    expect(structured.notice).toBe(
      "No providers matched. The registry matches a specialty filter as a case-insensitive prefix of a taxonomy's classification or specialization, and rejects state-only searches — try broadening, verifying the specialty resolution, or pairing state with a name/city.",
    );
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
    // Either post-filter can trim a page below limit (#51).
    expect(notice).toContain(
      '(a page the location or resolved-code filter trimmed below limit can still name one)',
    );
    expect(notice).not.toMatch(/until a page returns fewer than limit/i);
    expect(notice).toMatch(/dedupe by NPI/i);
    expect(notice).toMatch(/outside the US/i);
    expect(notice).not.toMatch(/page with skip/i);
    expect(notice).not.toMatch(/total of|\d+ total/i);
    // The registry rejects a 1-digit postal_code, so no exact value joins the root split (#54).
    expect(notice).toContain('(00* … 99*, 100 values)');
    expect(notice).not.toContain('without a wildcard');
    expect(text).toContain('**Continue with postal_code:** 00*, 01*, 02*');
    expect(text).toContain('98*, 99*');
  });

  // https://github.com/cyanheads/npi-providers-mcp-server/issues/54
  it.each([
    ['98*', '98'],
    ['981*', '981'],
    ['9810*', '9810'],
    ['6151*', '6151'],
    ['981011*', '981011'],
    ['9810112*', '9810112'],
    ['98101123*', '98101123'],
  ])(
    'splits postal_code %s into its exact digits, then one more digit (#54)',
    async (postal_code, prefix) => {
      pageStub(pageAt(200, prefix.padEnd(9, '0')));
      const { structured, text } = await contract({
        last_name: 'Smith',
        postal_code,
        skip: 1000,
        limit: 200,
      });
      const codes = [prefix, ...digits.map((d) => `${prefix}${d}*`)];
      expect(structured.continuationPostalCodes).toEqual(codes);
      for (const surface of [structured.notice ?? '', text]) {
        expect(surface).toContain(`(${prefix} … ${prefix}9*, 11 values)`);
        expect(surface).toContain(
          `${prefix}, the one value without a wildcard, matches only a postal code recorded with exactly those digits, which the wildcard values miss, so an empty result for it ends that branch.`,
        );
      }
      expect(text).toContain(`**Continue with postal_code:** ${codes.join(', ')}`);
      for (const code of codes) {
        expect(
          searchProvidersTool.input.safeParse({ last_name: 'Smith', postal_code: code }).success,
        ).toBe(true);
      }
    },
  );

  it.each([
    ['98101', '981011234', /5-digit ZIP/],
    ['98101*', '981011234', /5-digit ZIP/],
    ['981011234', '981011234', /ZIP\+4/],
    ['981011234*', '981011234', /ZIP\+4/],
    ['T2C1N6', 'T2C1N6', /postal_code is not a numeric ZIP prefix/],
    // An exact digit string, such as a split's exact value, splits no further (#54).
    ['6151', '6151', /postal_code 6151 matches only a postal code recorded with exactly those/],
    ['9810112', '9810112', /postal_code 9810112 matches only a postal code recorded with exactly/],
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
    expect(structured.continuationPostalCodes).toEqual(['98', ...digits.map((d) => `98${d}*`)]);
    expect(structured.notice).toMatch(/1 out-of-location row/i);
  });

  it.each([undefined, '6151*'])(
    'at postal_code %s names blank postcodes and a non-digit where a split adds one as unreached (#54)',
    async (postal_code) => {
      pageStub(pageAt(200, '615100000'));
      const { structured, text } = await contract({
        last_name: 'Smith',
        postal_code,
        skip: 1000,
        limit: 200,
      });
      for (const surface of [structured.notice ?? '', text]) {
        expect(surface).toContain(
          'Practice addresses whose postal code is blank, or has a letter, space, or hyphen in a position the split adds, are not reached this way; most are outside the US.',
        );
        // The exact value reaches a postcode as long as the prefix being split.
        expect(surface).not.toMatch(
          /shorter than the prefixes|contains letters|have no numeric ZIP/,
        );
      }
    },
  );
});

// ── #42: postal_code shapes ──────────────────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/42

describe('searchProvidersTool postal_code shapes (#42)', () => {
  /** Live row shape: the one provider at Australian postcode 6151 (2026-11-19). */
  const SOUTH_PERTH = practiceRow(1659663912, {
    city: 'SOUTH PERTH',
    state: 'WESTERN AUSTRALIA',
    postal_code: '6151',
  });
  /** Live row shape: the registry stores this Ontario postal code in lowercase (2026-11-19). */
  const SIMCOE = practiceRow(1427219385, {
    city: 'SIMCOE',
    state: 'ONTARIO',
    postal_code: 'n3y4k5',
  });

  it('sends a hyphenated ZIP+4 as its 9 digits', async () => {
    const fetchSpy = pageStub([]);
    await contract({ last_name: 'Smith', postal_code: '98105-3901' });
    expect(sentQuery(fetchSpy)).toMatchObject({
      postal_code: '981053901',
      address_purpose: 'LOCATION',
    });
  });

  it('filters rows against the 9-digit form of a hyphenated ZIP+4', async () => {
    pageStub([
      practiceRow(1000000011, { city: 'SEATTLE', state: 'WA', postal_code: '981053901' }),
      practiceRow(1000000012, { city: 'SEATTLE', state: 'WA', postal_code: '98105' }),
      practiceRow(1000000013, { city: 'SEATTLE', state: 'WA', postal_code: '981054770' }),
    ]);
    const { structured } = await contract({ last_name: 'Smith', postal_code: '98105-3901' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000011', '1000000012']);
  });

  it('ends the postal split at a hyphenated ZIP+4 as the full ZIP+4 it is', async () => {
    pageStub(pageAt(200, '981053901'));
    const { structured, text } = await contract({
      last_name: 'Smith',
      postal_code: '98105-3901',
      skip: 1000,
      limit: 200,
    });
    expect(structured.providers).toHaveLength(200);
    expect(structured.continuationPostalCodes).toEqual([]);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('postal_code 981053901 is already a full ZIP+4');
    }
  });

  it.each(['98', '981', '9810', '981054', '98105390'])(
    'sends %s unchanged and says an empty result was matched exactly, naming the prefix form',
    async (postal_code) => {
      const fetchSpy = pageStub([]);
      const { structured, text } = await contract({
        taxonomy_description: 'Family Medicine',
        postal_code,
      });
      expect(sentQuery(fetchSpy)).toMatchObject({ postal_code });
      expect(structured.providers).toEqual([]);
      for (const surface of [structured.notice ?? '', text]) {
        expect(surface).toContain(
          `postal_code ${postal_code} was matched exactly, so it matches only a practice address recorded as exactly ${postal_code}`,
        );
        // The specialty may have emptied the search, so no claim that the code is unrecorded.
        expect(surface).not.toContain('no practice address is recorded');
        expect(surface).toContain(`postal_code ${postal_code}*`);
        // A split's exact value lands here too, and its parent search already ran (#54).
        expect(surface).toContain(
          `when ${postal_code} came from continuationPostalCodes, that search already ran and this empty result ends the branch`,
        );
        expect(surface).not.toMatch(/specialty filter/);
      }
    },
  );

  it.each(['98105', '981053901', '981*'])(
    'keeps the broaden notice for an empty result at postal_code %s',
    async (postal_code) => {
      pageStub([]);
      const { structured } = await contract({
        taxonomy_description: 'Family Medicine',
        postal_code,
      });
      expect(structured.notice).toMatch(/^No providers matched\. The registry matches a specialty/);
      expect(structured.notice).not.toMatch(/matched exactly|contains letters/);
    },
  );

  it('answers an empty page past skip 0 at an exactly matched postal_code with the skip notice', async () => {
    pageStub([]);
    const { structured, text } = await contract({
      taxonomy_description: 'Family Medicine',
      postal_code: '981',
      skip: 200,
    });
    expect(structured.providers).toEqual([]);
    expect(structured.notice).toMatch(/^No providers at skip 200/);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('No providers at skip 200');
      expect(surface).not.toContain('was matched exactly');
    }
  });

  it('sends a 4-digit postcode unchanged and keeps the provider recorded with it (characterization)', async () => {
    const fetchSpy = pageStub([SOUTH_PERTH]);
    const { structured } = await contract({ postal_code: '6151' });
    expect(sentQuery(fetchSpy)).toMatchObject({ postal_code: '6151' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1659663912']);
    expect(structured.notice).toBeUndefined();
  });

  it('keeps a row stored in lowercase for an uppercase lettered code, with the lettered-code notice', async () => {
    pageStub([SIMCOE]);
    const { structured, text } = await contract({ postal_code: 'N3Y4K5' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1427219385']);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('postal_code contains letters');
      expect(surface).toContain('search by the practice city without postal_code');
      expect(surface).not.toMatch(/none were in the requested location/);
    }
  });

  it('keeps a lettered code matched on a secondary practice location stored in lowercase', async () => {
    pageStub([
      practiceRow(1427219386, { city: 'SEATTLE', state: 'WA', postal_code: '981010000' }, [
        { city: 'SIMCOE', state: 'ONTARIO', postal_code: 'n3y4k5' },
      ]),
    ]);
    const { structured } = await contract({ last_name: 'Smith', postal_code: 'N3Y4K5' });
    expect(structured.providers[0]?.matchedLocation).toEqual({
      city: 'SIMCOE',
      state: 'ONTARIO',
      postalCode: 'n3y4k5',
    });
  });

  it('keeps a row stored in uppercase for a lowercase lettered code, with the lettered-code notice', async () => {
    pageStub([
      practiceRow(1427219387, { city: 'SIMCOE', state: 'ONTARIO', postal_code: 'N3Y4K5' }),
    ]);
    const { structured, text } = await contract({ postal_code: 'n3y4k5' });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1427219387']);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('postal_code contains letters');
      expect(surface).not.toMatch(/none were in the requested location/);
    }
  });

  it('keeps a lowercase lettered code matched on a secondary practice location stored in uppercase', async () => {
    pageStub([
      practiceRow(1427219388, { city: 'SEATTLE', state: 'WA', postal_code: '981010000' }, [
        { city: 'SIMCOE', state: 'ONTARIO', postal_code: 'N3Y4K5' },
      ]),
    ]);
    const { structured } = await contract({ last_name: 'Smith', postal_code: 'n3y4k5' });
    expect(structured.providers[0]?.matchedLocation).toEqual({
      city: 'SIMCOE',
      state: 'ONTARIO',
      postalCode: 'N3Y4K5',
    });
  });

  it('answers an empty lettered-code search with the lettered-code notice, not the broaden text', async () => {
    pageStub([]);
    const { structured, text } = await contract({ postal_code: 'T2C1N6' });
    expect(structured.providers).toEqual([]);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('No providers matched.');
      expect(surface).toContain('postal_code contains letters');
      expect(surface).not.toMatch(/specialty filter/);
    }
  });

  it.each(['T2C 1N6', '9', '1234567890'])(
    'relays the registry rejection of postal_code "%s" with the postal-code recovery',
    async (postal_code) => {
      const fetchSpy = fieldErrorStub(
        'postal_code',
        '05',
        'Field contains special character(s) or wrong number of characters',
      );
      const { error, text } = await failure({ last_name: 'Smith', postal_code });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(sentQuery(fetchSpy)).toMatchObject({ postal_code });
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_search_field');
      for (const surface of [error.data.recovery?.hint ?? '', text]) {
        expect(surface).toContain('ddddd-dddd');
        expect(surface).toContain('by city without postal_code');
        expect(surface).not.toContain('state needs a companion filter');
      }
    },
  );

  it('keeps the declared recovery for a registry field error on another field', async () => {
    fieldErrorStub('first_name', '03', 'Wildcards require at least two leading characters');
    const { error, text } = await failure({ first_name: 'J*', postal_code: '98105' });
    expect(error.data.reason).toBe('invalid_search_field');
    expect(error.data.recovery?.hint).toBe(
      'Read the field error; wildcards need at least 2 leading characters and state needs a companion filter.',
    );
    expect(text).toContain('state needs a companion filter');
    expect(text).not.toContain('ddddd-dddd');
  });

  it.each([
    [' 98*', '98*'],
    ['98* ', '98*'],
    [' 981011234* ', '981011234*'],
    [' 98105 ', '98105'],
    [' 98105-3901 ', '981053901'],
    ['\t6151\n', '6151'],
    [' N3Y4K5', 'N3Y4K5'],
  ])('trims postal_code %j and sends %s', async (postal_code, sent) => {
    const fetchSpy = pageStub([]);
    await contract({ last_name: 'Smith', postal_code });
    expect(sentQuery(fetchSpy)).toMatchObject({ postal_code: sent });
  });

  it.each(['', '   '])(
    'treats a blank postal_code %j as omitted (characterization)',
    async (postal_code) => {
      const fetchSpy = pageStub([]);
      await contract({ last_name: 'Smith', postal_code });
      const query = sentQuery(fetchSpy);
      expect(query).not.toHaveProperty('postal_code');
      expect(query).not.toHaveProperty('address_purpose');
    },
  );

  it.each([
    '98105-3901',
    '6151',
    'T2C1N6',
    'N3Y4K5',
    'n3y4k5',
    'T2C 1N6',
    '9',
    '1234567890',
    ' 98* ',
    '\t981011234*',
  ])('accepts postal_code %j at the schema', (postal_code) => {
    expect(searchProvidersTool.input.safeParse({ last_name: 'Smith', postal_code }).success).toBe(
      true,
    );
  });
});

// ── An exactly matched partial postal_code on a practice location ────────────

describe('searchProvidersTool exactly matched postal_code on a practice location', () => {
  /** A row practicing first at `primary` and also at the non-US postcode `postal_code`. */
  const twoPractices = (npi: number, primary: string, postal_code: string) =>
    practiceRow(npi, { city: 'PEORIA', state: 'IL', postal_code: primary }, [
      { city: 'SOUTH PERTH', state: 'WESTERN AUSTRALIA', postal_code },
    ]);

  // The registry matches a 2–4 or 6–8 digit postal_code only against that exact code (#54).
  it.each([
    ['98', '981011234'],
    ['6151', '615178022'],
    ['110005', '110005123'],
    ['82900352', '829003521'],
  ])(
    'keeps postal_code %s on the practice recorded with exactly it, not ZIP+4 %s',
    async (postal_code, zipPlus4) => {
      pageStub([
        twoPractices(1000000201, zipPlus4, postal_code),
        practiceRow(1000000202, { city: 'PEORIA', state: 'IL', postal_code: zipPlus4 }),
      ]);
      const { structured, text } = await contract({ last_name: 'Smith', postal_code });
      expect(structured.providers.map((row) => row.npi)).toEqual(['1000000201']);
      expect(structured.providers[0]?.matchedLocation).toEqual({
        city: 'SOUTH PERTH',
        state: 'WESTERN AUSTRALIA',
        postalCode: postal_code,
      });
      expect(text).toMatch(
        new RegExp(`Matched practice location:.*SOUTH PERTH.* ${postal_code}$`, 'm'),
      );
      for (const surface of [structured.notice ?? '', text]) {
        expect(surface).toContain(
          '1 out-of-location row(s) the registry returned were filtered out',
        );
      }
    },
  );

  it.each([
    ['98105', '981053901'],
    ['981053901', '98105'],
  ])(
    'keeps postal_code %s on a primary practice at %s, by the 5- vs 9-digit ZIP tolerance (characterization)',
    async (postal_code, primary) => {
      pageStub([twoPractices(1000000203, primary, postal_code)]);
      const { structured } = await contract({ last_name: 'Smith', postal_code });
      expect(structured.providers.map((row) => row.npi)).toEqual(['1000000203']);
      expect(structured.providers[0]).not.toHaveProperty('matchedLocation');
      expect(structured.notice).toBeUndefined();
    },
  );
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

/** A Seattle individual row holding `taxonomies` (non-primary unless flagged), in order. */
function taxonomyRow(
  npi: number,
  taxonomies: { code: string; desc?: string | null; primary?: boolean }[],
) {
  return {
    number: npi,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'PAT', last_name: 'SURGEON', credential: 'MD', status: 'A' },
    taxonomies: taxonomies.map((taxonomy) => ({ primary: false, ...taxonomy })),
    addresses: [
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
    ],
  };
}

// ── #43: taxonomy descriptions the registry serves blank ─────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/43

describe('searchProvidersTool taxonomy descriptions the registry leaves blank (#43)', () => {
  it('decodes a null-desc primary taxonomy from NUCC on both surfaces, naming the source', async () => {
    pageStub([taxonomyRow(1073637286, [{ code: '2086S0129X', desc: null, primary: true }])]);
    const { structured, text } = await contract({ last_name: 'Surgeon', limit: 5 });
    expect(structured.providers[0]?.primaryTaxonomy).toEqual({
      code: '2086S0129X',
      description: 'Surgery, Vascular Surgery',
      descriptionSource: 'nucc',
    });
    expect(text).toContain(
      '**Primary specialty:** Surgery, Vascular Surgery (2086S0129X; description from NUCC)',
    );
  });

  it('renders a registry-served description unmarked (characterization)', async () => {
    pageStub([
      taxonomyRow(1720034424, [
        { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease', primary: true },
      ]),
    ]);
    const { structured, text } = await contract({ last_name: 'Surgeon', limit: 5 });
    expect(structured.providers[0]?.primaryTaxonomy).toEqual({
      code: '207RC0000X',
      description: 'Internal Medicine, Cardiovascular Disease',
    });
    expect(text).toMatch(
      /^\*\*Primary specialty:\*\* Internal Medicine, Cardiovascular Disease \(207RC0000X\)$/m,
    );
    expect(text).not.toContain('description from NUCC');
  });

  it('reads Unknown for a blank code the bundled set lacks (characterization)', async () => {
    pageStub([taxonomyRow(1720034424, [{ code: '207RX9999X', desc: null, primary: true }])]);
    const { structured, text } = await contract({ last_name: 'Surgeon', limit: 5 });
    expect(structured.providers[0]?.primaryTaxonomy).toEqual({ code: '207RX9999X' });
    expect(text).toMatch(/^\*\*Primary specialty:\*\* Unknown \(207RX9999X\)$/m);
  });
});

// ── #44: the taxonomy a row matched the specialty filter through ─────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/44

describe('searchProvidersTool matched taxonomy (#44)', () => {
  const CARDIOLOGY = { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease' };
  /**
   * Synthetic Seattle NPI-1 rows whose taxonomy desc strings are the registry's wording on the
   * Seattle cardiologist page (2026-11-19); their NPIs, entity types, addresses, and taxonomy
   * lists don't reproduce any live row.
   */
  const HEM_ONC_PRIMARY = taxonomyRow(1053791517, [
    { code: '207RH0003X', desc: 'Internal Medicine, Hematology & Oncology', primary: true },
    CARDIOLOGY,
  ]);
  const CARDIOLOGY_PRIMARY = taxonomyRow(1720034424, [{ ...CARDIOLOGY, primary: true }]);
  const ANESTHESIOLOGY_PRIMARY = taxonomyRow(1093736621, [
    { code: '207L00000X', desc: 'Anesthesiology', primary: true },
    CARDIOLOGY,
  ]);

  it('keeps every row of a specialty search, in upstream order, with the same query (characterization)', async () => {
    const fetchSpy = pageStub([HEM_ONC_PRIMARY, CARDIOLOGY_PRIMARY, ANESTHESIOLOGY_PRIMARY]);
    const { structured } = await contract({
      specialty: 'cardiologist',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(structured.providers.map((row) => row.npi)).toEqual([
      '1053791517',
      '1720034424',
      '1093736621',
    ]);
    expect(structured.providers.map((row) => row.primaryTaxonomy)).toEqual([
      { code: '207RH0003X', description: 'Internal Medicine, Hematology & Oncology' },
      { code: '207RC0000X', description: 'Internal Medicine, Cardiovascular Disease' },
      { code: '207L00000X', description: 'Anesthesiology' },
    ]);
    expect(sentQuery(fetchSpy)).toEqual({
      version: '2.1',
      limit: '10',
      skip: '0',
      taxonomy_description: 'Cardiovascular Disease',
      city: 'SEATTLE',
      state: 'WA',
      address_purpose: 'LOCATION',
    });
    expect(structured.providers.every((row) => !('matchedLocation' in row))).toBe(true);
  });

  it('names the matched taxonomy on both surfaces and counts marked rows in the notice', async () => {
    pageStub([HEM_ONC_PRIMARY, CARDIOLOGY_PRIMARY, ANESTHESIOLOGY_PRIMARY]);
    const { structured, text } = await contract({
      specialty: 'cardiologist',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    const cardiology = {
      code: '207RC0000X',
      description: 'Internal Medicine, Cardiovascular Disease',
    };
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      cardiology,
      undefined,
      cardiology,
    ]);
    expect(structured.providers[1]).not.toHaveProperty('matchedTaxonomy');
    expect(
      text.match(
        /^\*\*Matched specialty:\*\* Internal Medicine, Cardiovascular Disease \(207RC0000X\)$/gm,
      ),
    ).toHaveLength(2);
    expect(structured.notice).toBe(
      '2 of 3 row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).',
    );
    expect(text).toContain(structured.notice);
  });

  it('marks a taxonomy_description passthrough match on a null-desc code, naming the NUCC source', async () => {
    pageStub([
      taxonomyRow(1073637286, [
        {
          code: '208G00000X',
          desc: 'Thoracic Surgery (Cardiothoracic Vascular Surgery)',
          primary: true,
        },
        { code: '2086S0129X', desc: null },
      ]),
    ]);
    const { structured, text } = await contract({
      taxonomy_description: 'Vascular Surgery',
      state: 'WA',
      limit: 10,
    });
    expect(structured.providers[0]?.matchedTaxonomy).toEqual({
      code: '2086S0129X',
      description: 'Surgery, Vascular Surgery',
      descriptionSource: 'nucc',
    });
    expect(text).toContain(
      '**Matched specialty:** Surgery, Vascular Surgery (2086S0129X; description from NUCC)',
    );
    expect(structured.notice).toMatch(/^1 of 1 row\(s\) matched the specialty filter/);
  });

  it('marks nothing, and says nothing, without a specialty filter', async () => {
    pageStub([HEM_ONC_PRIMARY, ANESTHESIOLOGY_PRIMARY]);
    const { structured, text } = await contract({ last_name: 'Surgeon', limit: 10 });
    expect(structured.providers.some((row) => 'matchedTaxonomy' in row)).toBe(false);
    expect(text).not.toContain('Matched specialty');
    expect(structured.notice).toBeUndefined();
  });

  it('adds no matched-taxonomy notice when every row matched through its primary', async () => {
    pageStub([CARDIOLOGY_PRIMARY]);
    const { structured } = await contract({
      specialty: 'cardiologist',
      city: 'SEATTLE',
      limit: 10,
    });
    expect(structured.providers[0]).not.toHaveProperty('matchedTaxonomy');
    expect(structured.notice).toBeUndefined();
  });

  it('counts only the rows the location filter kept in the matched-taxonomy notice', async () => {
    const portland = {
      ...taxonomyRow(1000000044, [
        { code: '207RH0003X', desc: 'Internal Medicine, Hematology & Oncology', primary: true },
        CARDIOLOGY,
      ]),
      addresses: [
        { address_purpose: 'LOCATION', city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
      ],
    };
    pageStub([HEM_ONC_PRIMARY, portland]);
    const { structured, text } = await contract({
      specialty: 'cardiologist',
      city: 'SEATTLE',
      limit: 10,
    });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1053791517']);
    expect(structured.providers[0]).toHaveProperty('matchedTaxonomy');
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('1 out-of-location row(s)');
      expect(surface).toContain(
        '1 of 1 row(s) matched the specialty filter through a taxonomy other than their primary specialty',
      );
    }
  });

  it('assembles the matched-taxonomy and other-name counts into one notice', async () => {
    const formerSmith = {
      ...taxonomyRow(1437702123, [{ ...CARDIOLOGY, primary: true }]),
      basic: { first_name: 'MICALA', last_name: 'ABBIATI', status: 'A' },
      other_names: [{ type: 'Former Name', first_name: 'MICALA', last_name: 'SMITH' }],
    };
    const smith = {
      ...HEM_ONC_PRIMARY,
      basic: { first_name: 'JANE', last_name: 'SMITH', status: 'A' },
    };
    pageStub([formerSmith, smith]);
    const { structured } = await contract({
      last_name: 'Smith',
      taxonomy_description: 'Cardiovascular Disease',
      limit: 5,
    });
    expect(structured.providers[0]).toHaveProperty('matchedOtherName');
    expect(structured.providers[0]).not.toHaveProperty('matchedTaxonomy');
    expect(structured.providers[1]).not.toHaveProperty('matchedOtherName');
    expect(structured.providers[1]).toHaveProperty('matchedTaxonomy');
    expect(structured.notice).toMatch(/1 of 2 row\(s\) matched through an other name/);
    expect(structured.notice).toMatch(
      /1 of 2 row\(s\) matched the specialty filter through a taxonomy other than their primary specialty/,
    );
  });

  it('format: renders a matched specialty, with and without a NUCC-filled description', () => {
    const text = searchProvidersTool.format!({
      providers: [
        {
          npi: '1053791517',
          type: 'individual',
          name: 'PAT SURGEON',
          primaryTaxonomy: {
            code: '207RH0003X',
            description: 'Internal Medicine, Hematology & Oncology',
          },
          matchedTaxonomy: {
            code: '207RC0000X',
            description: 'Internal Medicine, Cardiovascular Disease',
          },
          status: 'active',
        },
        {
          npi: '1073637286',
          type: 'individual',
          name: 'PAT VASCULAR',
          matchedTaxonomy: {
            code: '2086S0129X',
            description: 'Surgery, Vascular Surgery',
            descriptionSource: 'nucc',
          },
          status: 'active',
        },
      ],
    })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      '**Primary specialty:** Internal Medicine, Hematology & Oncology (207RH0003X)\n**Matched specialty:** Internal Medicine, Cardiovascular Disease (207RC0000X)',
    );
    expect(text).toMatch(
      /^\*\*Matched specialty:\*\* Surgery, Vascular Surgery \(2086S0129X; description from NUCC\)$/m,
    );
  });
});

// ── #51: keep only rows holding a resolved specialty code ────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/51

describe('searchProvidersTool resolved-code filter (#51)', () => {
  // Registry desc wording as served on the Seattle pages of 2026-11-25.
  const FAMILY_MEDICINE = { code: '207Q00000X', desc: 'Family Medicine' };
  const FAMILY_NP = { code: '363LF0000X', desc: 'Nurse Practitioner, Family' };
  const CARDIOLOGY = { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease' };
  const FAMILY_PSYCHOLOGIST = { code: '103TF0000X', desc: 'Psychologist, Family' };

  it.each([
    ['pediatrician', ['208000000X', '2088P0231X', '2086S0120X', '207ZP0213X', '2085P0229X']],
    ['family nurse practitioner', ['363LF0000X']],
    ['pediatric nurse practitioner', ['363LP0200X', '363LP0222X']],
    // Five ranked candidates, then every later one that also sends "Sports Medicine".
    [
      'sports medicine',
      [
        '207QS0010X',
        '207RS0010X',
        '207PS0010X',
        '2084S0010X',
        '207XX0005X',
        '2083S0010X',
        '2081S0010X',
        '2080S0010X',
        '213ES0000X',
      ],
    ],
  ])('specialty %j lists %j in resolvedTaxonomies', async (specialty, codes) => {
    const fetchSpy = pageStub([]);
    const { structured, text } = await contract({ specialty, city: 'SEATTLE' });
    const echo = structured as unknown as SearchEnrichment;
    expect(echo.resolvedTaxonomies?.map((t) => t.code)).toEqual(codes);
    expect(sentQuery(fetchSpy).taxonomy_description).toBe(
      echo.resolvedTaxonomies?.[0]?.description,
    );
    expect(text).toContain(`(${codes.at(-1)})`);
  });

  it('free-text taxonomy_description "Family" keeps every row and the #44 text rule (characterization)', async () => {
    const fetchSpy = pageStub([
      taxonomyRow(1000000051, [{ ...FAMILY_MEDICINE, primary: true }]),
      taxonomyRow(1000000052, [{ ...FAMILY_MEDICINE, primary: true }, FAMILY_NP]),
      taxonomyRow(1000000053, [{ ...CARDIOLOGY, primary: true }, FAMILY_NP, FAMILY_MEDICINE]),
      taxonomyRow(1000000054, [{ ...CARDIOLOGY, primary: true }, FAMILY_PSYCHOLOGIST]),
    ]);
    const { structured, text } = await contract({
      taxonomy_description: 'Family',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe('Family');
    expect(structured).not.toHaveProperty('resolvedTaxonomies');
    expect(structured.providers.map((row) => row.npi)).toEqual([
      '1000000051',
      '1000000052',
      '1000000053',
      '1000000054',
    ]);
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      undefined,
      undefined,
      { code: '363LF0000X', description: 'Nurse Practitioner, Family' },
      { code: '103TF0000X', description: 'Psychologist, Family' },
    ]);
    expect(structured.notice).toBe(
      '2 of 4 row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).',
    );
    expect(text).toContain(structured.notice);
  });

  const PEDIATRICS = { code: '208000000X', desc: 'Pediatrics' };
  const PEDIATRIC_EM = { code: '2080P0204X', desc: 'Pediatrics, Pediatric Emergency Medicine' };
  const PEDIATRIC_NP = { code: '363LP0200X', desc: 'Nurse Practitioner, Pediatrics' };
  const PEDIATRIC_CC_NP = {
    code: '363LP0222X',
    desc: 'Nurse Practitioner, Pediatrics, Critical Care',
  };
  const PEDIATRIC_RN = { code: '163WP0200X', desc: 'Registered Nurse, Pediatrics' };
  const PSYCHIATRY = { code: '2084P0800X', desc: 'Psychiatry & Neurology, Psychiatry' };
  const NEUROLOGY = { code: '2084N0400X', desc: 'Psychiatry & Neurology, Neurology' };
  const CHILD_PSYCHIATRY = {
    code: '2084P0804X',
    desc: 'Psychiatry & Neurology, Child & Adolescent Psychiatry',
  };
  const NURSE_PRACTITIONER = { code: '363L00000X', desc: 'Nurse Practitioner' };
  const HEM_ONC = { code: '207RH0003X', desc: 'Internal Medicine, Hematology & Oncology' };
  const HEMATOLOGY = { code: '207RH0000X', desc: 'Internal Medicine, Hematology' };
  const HEMATOPATHOLOGY = { code: '207ZH0000X', desc: 'Pathology, Hematology' };
  const PEDIATRIC_SPORTS = { code: '2080S0010X', desc: 'Pediatrics, Sports Medicine' };
  const PODIATRIC_SPORTS = { code: '213ES0000X', desc: 'Podiatrist, Sports Medicine' };
  const PSYCHOTHERAPY = { code: '103TP2700X', desc: 'Psychologist, Psychotherapy' };
  // Legal Medicine names a physician classification and an unrelated one in Other Service Providers.
  const LEGAL_MEDICINE = { code: '209800000X', desc: 'Legal Medicine' };
  const LEGAL_MEDICINE_OTHER = { code: '173000000X', desc: 'Legal Medicine' };

  const CODE_FILTERED = 'row(s) holding no resolved taxonomy code were filtered out';

  it('the Psychologist fixture is a code NUCC marks inactive', () => {
    expect(getTaxonomyService().get(PSYCHOTHERAPY.code)?.status).toBe('inactive');
  });

  it.each<
    [string, z.input<typeof searchProvidersTool.input>, string, { code: string }[], string[]]
  >([
    [
      'pediatric nurse practitioner drops physician Pediatrics, keeps a listed candidate',
      { specialty: 'pediatric nurse practitioner' },
      'Pediatrics',
      [PEDIATRICS, PEDIATRIC_EM, PEDIATRIC_CC_NP, PEDIATRIC_NP],
      ['363LP0222X', '363LP0200X'],
    ],
    [
      'pediatrician drops nursing Pediatrics, keeps every code of its classification',
      { specialty: 'pediatrician' },
      'Pediatrics',
      [PEDIATRIC_NP, PEDIATRIC_RN, PEDIATRIC_EM, PEDIATRICS],
      ['2080P0204X', '208000000X'],
    ],
    [
      'psychiatrist drops Neurology, keeps a listed candidate',
      { specialty: 'psychiatrist' },
      'Psychiatry',
      [NEUROLOGY, CHILD_PSYCHIATRY, PSYCHIATRY],
      ['2084P0804X', '2084P0800X'],
    ],
    [
      'a classification code keeps its specializations',
      { taxonomy_description: '363L00000X' },
      'Nurse Practitioner',
      [FAMILY_NP, FAMILY_MEDICINE, NURSE_PRACTITIONER],
      ['363LF0000X', '363L00000X'],
    ],
    [
      'Internal Medicine keeps Cardiovascular Disease',
      { taxonomy_description: '207R00000X' },
      'Internal Medicine',
      [CARDIOLOGY, FAMILY_MEDICINE, HEM_ONC],
      ['207RC0000X', '207RH0003X'],
    ],
    [
      'a specialization code is code-exact',
      { taxonomy_description: '207RH0000X' },
      'Hematology',
      [HEM_ONC, HEMATOLOGY, HEMATOPATHOLOGY],
      ['207RH0000X'],
    ],
    [
      'a decoded display name filters like its code',
      { taxonomy_description: 'Family Nurse Practitioner' },
      'Family',
      [FAMILY_MEDICINE, FAMILY_NP],
      ['363LF0000X'],
    ],
    [
      'sports medicine keeps the same-text candidates past the first five',
      { specialty: 'sports medicine' },
      'Sports Medicine',
      [PEDIATRIC_SPORTS, PODIATRIC_SPORTS],
      ['2080S0010X', '213ES0000X'],
    ],
    [
      'a classification code keeps an inactive code of its classification',
      { taxonomy_description: '103T00000X' },
      'Psychologist',
      [PSYCHOTHERAPY],
      ['103TP2700X'],
    ],
    [
      'a classification code drops the same-named classification of another grouping',
      { taxonomy_description: '209800000X' },
      'Legal Medicine',
      [LEGAL_MEDICINE_OTHER, LEGAL_MEDICINE],
      ['209800000X'],
    ],
  ])('%s', async (_label, input, sent, taxonomies, kept) => {
    const fetchSpy = pageStub(
      taxonomies.map((taxonomy, index) =>
        taxonomyRow(1000000100 + index, [{ ...taxonomy, primary: true }]),
      ),
    );
    const { structured, text } = await contract({ ...input, city: 'SEATTLE', limit: 10 });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe(sent);
    expect((structured as unknown as SearchEnrichment).appliedTaxonomyDescription).toBe(sent);
    expect(
      structured.providers.map((row) => (row.primaryTaxonomy as { code: string }).code),
    ).toEqual(kept);
    for (const code of kept) expect(text).toContain(`(${code})`);
    const dropped = taxonomies.length - kept.length;
    for (const surface of [structured.notice ?? '', text]) {
      if (dropped > 0) expect(surface).toContain(`${dropped} ${CODE_FILTERED}`);
      else expect(surface).not.toContain(CODE_FILTERED);
    }
  });

  it('family nurse practitioner drops Family Medicine and names the held 363LF0000X on both surfaces', async () => {
    const fetchSpy = pageStub([
      taxonomyRow(1000000061, [{ ...FAMILY_MEDICINE, primary: true }]),
      taxonomyRow(1000000062, [{ ...FAMILY_MEDICINE, primary: true }, FAMILY_NP]),
      taxonomyRow(1000000063, [{ ...FAMILY_NP, primary: true }]),
    ]);
    const { structured, text } = await contract({
      specialty: 'family nurse practitioner',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(sentQuery(fetchSpy)).toEqual({
      version: '2.1',
      limit: '10',
      skip: '0',
      taxonomy_description: 'Family',
      city: 'SEATTLE',
      state: 'WA',
      address_purpose: 'LOCATION',
    });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000062', '1000000063']);
    // The primary passes "Family" too, but holds no resolved code.
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      { code: '363LF0000X', description: 'Nurse Practitioner, Family' },
      undefined,
    ]);
    for (const row of structured.providers) {
      expect(row).not.toHaveProperty('matchesResolvedTaxonomies');
    }
    expect(text).toMatch(/^\*\*Matched specialty:\*\* Nurse Practitioner, Family \(363LF0000X\)$/m);
    expect(text).not.toContain('1000000061');
    expect(structured.notice).toBe(
      '1 row(s) holding no resolved taxonomy code were filtered out: the registry matched appliedTaxonomyDescription through another code whose taxonomy starts with the same text (see resolvedTaxonomies; a classification-level code counts every code of its classification). 1 of 2 row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).',
    );
    expect(text).toContain(structured.notice);
  });

  it('never drops a row holding a resolved code, keeping upstream order and the query (regression)', async () => {
    const fetchSpy = pageStub([
      // 2084P0805X, Geriatric Psychiatry, is psychiatrist's fourth candidate; served without a desc.
      taxonomyRow(1000000081, [{ code: '2084P0805X', desc: null, primary: true }]),
      taxonomyRow(1000000082, [{ ...NEUROLOGY, primary: true }]),
      taxonomyRow(1000000083, [{ ...NEUROLOGY, primary: true }, CHILD_PSYCHIATRY]),
      taxonomyRow(1000000084, [{ ...PSYCHIATRY, primary: true }]),
    ]);
    const { structured } = await contract({
      specialty: 'psychiatrist',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(sentQuery(fetchSpy)).toMatchObject({ taxonomy_description: 'Psychiatry' });
    expect((structured as unknown as SearchEnrichment).appliedTaxonomyDescription).toBe(
      'Psychiatry',
    );
    expect(structured.providers.map((row) => row.npi)).toEqual([
      '1000000081',
      '1000000083',
      '1000000084',
    ]);
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      undefined,
      { code: '2084P0804X', description: CHILD_PSYCHIATRY.desc },
      undefined,
    ]);

    // surgeon resolves to 208600000X, the Surgery classification: its specializations count.
    pageStub([
      taxonomyRow(1000000091, [{ code: '2086S0129X', desc: null, primary: true }]),
      taxonomyRow(1000000092, [
        { code: '204E00000X', desc: 'Oral & Maxillofacial Surgery', primary: true },
        { code: '2086S0129X', desc: null },
      ]),
    ]);
    const surgery = await contract({ specialty: 'surgeon', city: 'SEATTLE', limit: 10 });
    expect(surgery.structured.providers.map((row) => row.npi)).toEqual([
      '1000000091',
      '1000000092',
    ]);
    expect(surgery.structured.providers[1]?.matchedTaxonomy).toEqual({
      code: '2086S0129X',
      description: 'Surgery, Vascular Surgery',
      descriptionSource: 'nucc',
    });
    expect(surgery.structured.notice ?? '').not.toContain(CODE_FILTERED);
  });

  // Absent from the bundled v26.1 set, as a code NUCC adds in a later release is.
  const NEW_PEDIATRICS = { code: '2080X0001X', desc: 'Pediatrics, Pediatric Hospital Medicine' };
  const NEW_FAMILY_MEDICINE = { code: '207QX0001X', desc: 'Family Medicine, Lifestyle Medicine' };

  it('keeps a code newer than the bundled NUCC set under a classification-level resolution of its classification', async () => {
    expect(getTaxonomyService().get(NEW_PEDIATRICS.code)).toBeUndefined();
    const fetchSpy = pageStub([
      taxonomyRow(1000000111, [{ ...NEW_PEDIATRICS, primary: true }]),
      taxonomyRow(1000000112, [{ ...PEDIATRIC_NP, primary: true }, NEW_PEDIATRICS]),
      taxonomyRow(1000000113, [{ ...PEDIATRIC_NP, primary: true }]),
    ]);
    // pediatrician resolves first to 208000000X, the Pediatrics classification.
    const { structured, text } = await contract({
      specialty: 'pediatrician',
      city: 'SEATTLE',
      limit: 10,
    });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe('Pediatrics');
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000111', '1000000112']);
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      undefined,
      { code: '2080X0001X', description: 'Pediatrics, Pediatric Hospital Medicine' },
    ]);
    expect(text).toMatch(
      /^\*\*Matched specialty:\*\* Pediatrics, Pediatric Hospital Medicine \(2080X0001X\)$/m,
    );
    expect(text).not.toContain('1000000113');
    expect(structured.notice).toBe(
      `1 ${CODE_FILTERED}: the registry matched appliedTaxonomyDescription through another code whose taxonomy starts with the same text (see resolvedTaxonomies; a classification-level code counts every code of its classification). 1 of 2 row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).`,
    );
    expect(text).toContain(structured.notice);
  });

  it('drops a code newer than the bundled NUCC set under a specialization-level resolution', async () => {
    expect(getTaxonomyService().get(NEW_FAMILY_MEDICINE.code)).toBeUndefined();
    const fetchSpy = pageStub([
      taxonomyRow(1000000121, [{ ...NEW_FAMILY_MEDICINE, primary: true }]),
      taxonomyRow(1000000122, [{ ...FAMILY_MEDICINE, primary: true }, NEW_FAMILY_MEDICINE]),
      taxonomyRow(1000000123, [{ ...FAMILY_NP, primary: true }]),
    ]);
    // family nurse practitioner resolves to 363LF0000X alone, a specialization.
    const { structured, text } = await contract({
      specialty: 'family nurse practitioner',
      city: 'SEATTLE',
      limit: 10,
    });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe('Family');
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000123']);
    expect(structured.providers[0]).not.toHaveProperty('matchedTaxonomy');
    expect(text).not.toMatch(/100000012[12]/);
    expect(structured.notice).toBe(
      `2 ${CODE_FILTERED}: the registry matched appliedTaxonomyDescription through another code whose taxonomy starts with the same text (see resolvedTaxonomies; a classification-level code counts every code of its classification).`,
    );
    expect(text).toContain(structured.notice);
  });

  it('runs the location filter first and counts each filter in its own notice fragment', async () => {
    const portland = {
      ...taxonomyRow(1000000071, [{ ...FAMILY_MEDICINE, primary: true }]),
      addresses: [
        { address_purpose: 'LOCATION', city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
      ],
    };
    pageStub([
      portland,
      taxonomyRow(1000000072, [{ ...FAMILY_MEDICINE, primary: true }]),
      taxonomyRow(1000000073, [{ ...FAMILY_NP, primary: true }]),
    ]);
    const { structured, text } = await contract({
      specialty: 'family nurse practitioner',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000073']);
    for (const surface of [structured.notice ?? '', text]) {
      const location = surface.indexOf(
        '1 out-of-location row(s) the registry returned were filtered out',
      );
      const code = surface.indexOf(`1 ${CODE_FILTERED}`);
      expect(location).toBeGreaterThanOrEqual(0);
      expect(code).toBeGreaterThan(location);
    }
  });

  it('counts only the location survivors as code-dropped when none is shown', async () => {
    const portland = {
      ...taxonomyRow(1000000131, [{ ...FAMILY_MEDICINE, primary: true }]),
      addresses: [
        { address_purpose: 'LOCATION', city: 'PORTLAND', state: 'OR', postal_code: '972010000' },
      ],
    };
    pageStub([portland, taxonomyRow(1000000132, [{ ...FAMILY_MEDICINE, primary: true }])]);
    const { structured, text } = await contract({
      specialty: 'family nurse practitioner',
      city: 'SEATTLE',
      state: 'WA',
      limit: 10,
    });
    expect(structured.providers).toEqual([]);
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain('1 out-of-location row(s) the registry returned were filtered out');
      expect(surface).toContain(
        '1 row(s) matched appliedTaxonomyDescription, but none holds a resolved taxonomy code, so none is shown',
      );
    }
  });

  /** Two Seattle rows: JONES, formerly SMITH, holding `formerSmith`; SMITH holding `currentSmith`. */
  const smithRows = (formerSmith: typeof FAMILY_NP, currentSmith: typeof FAMILY_NP) => [
    {
      ...taxonomyRow(1000000141, [{ ...formerSmith, primary: true }]),
      basic: { first_name: 'PAT', last_name: 'JONES', status: 'A' },
      other_names: [{ type: 'Former Name', first_name: 'PAT', last_name: 'SMITH' }],
    },
    {
      ...taxonomyRow(1000000142, [{ ...currentSmith, primary: true }]),
      basic: { first_name: 'PAT', last_name: 'SMITH', status: 'A' },
    },
  ];
  const smithSearch = {
    last_name: 'SMITH',
    specialty: 'family nurse practitioner',
    city: 'SEATTLE',
    limit: 10,
  };

  it('counts other-name rows over the rows the resolved-code filter kept', async () => {
    pageStub(smithRows(FAMILY_NP, FAMILY_MEDICINE));
    const { structured, text } = await contract(smithSearch);
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000141']);
    expect(structured.providers[0]?.matchedOtherName).toEqual({
      name: 'PAT SMITH',
      type: 'Former Name',
    });
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain(`1 ${CODE_FILTERED}`);
      expect(surface).toContain('1 of 1 row(s) matched through an other name');
    }
  });

  it('says nothing of other names when the resolved-code filter dropped the other-name row', async () => {
    pageStub(smithRows(FAMILY_MEDICINE, FAMILY_NP));
    const { structured, text } = await contract(smithSearch);
    expect(structured.providers.map((row) => row.npi)).toEqual(['1000000142']);
    expect(structured.providers[0]).not.toHaveProperty('matchedOtherName');
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain(`1 ${CODE_FILTERED}`);
      expect(surface).not.toContain('matched through an other name');
    }
  });

  /** A full page of 200 Seattle rows, none holding 103TF0000X (Psychologist, Family). */
  const familyPage = () =>
    Array.from({ length: 200 }, (_, index) =>
      taxonomyRow(1100000000 + index, [
        { ...(index % 2 ? FAMILY_NP : FAMILY_MEDICINE), primary: true },
      ]),
    );
  const NONE_HOLDS = '200 row(s) matched appliedTaxonomyDescription, but none holds';

  it('an emptied full page names the next page and the dropped count, not the broaden text', async () => {
    pageStub(familyPage());
    const { structured, text } = await contract({
      taxonomy_description: '103TF0000X',
      city: 'SEATTLE',
      state: 'WA',
      limit: 200,
    });
    expect(structured.providers).toEqual([]);
    expect(structured).toMatchObject({
      truncated: true,
      shown: 0,
      cap: 200,
      nextPage: { skip: 200, limit: 200 },
    });
    for (const surface of [structured.notice ?? '', text]) {
      expect(surface).toContain(
        `${NONE_HOLDS} a resolved taxonomy code, so none is shown: the registry matched the text through other codes whose taxonomies start with it`,
      );
      expect(surface).toContain('the next page is skip 200');
      expect(surface).not.toContain('broadening');
      expect(surface).not.toContain('out-of-location');
    }
  });

  it('walks emptied pages to the terminal window, which returns continuationPostalCodes', async () => {
    const fetchSpy = pageStub(familyPage());
    const skips: number[] = [];
    let page: SearchSurface | undefined;
    // skip 0, 200, … 1000: six pages reach the terminal window.
    for (let skip: number | undefined = 0; skip !== undefined && skips.length < 6; ) {
      skips.push(skip);
      ({ structured: page } = await contract({
        taxonomy_description: '103TF0000X',
        city: 'SEATTLE',
        limit: 200,
        skip,
      }));
      expect(page.providers).toEqual([]);
      expect(page).toMatchObject({ truncated: true, shown: 0 });
      expect(page.notice).toContain(NONE_HOLDS);
      skip = page.nextPage?.skip;
    }
    expect(skips).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(page?.nextPage).toBeUndefined();
    expect(page?.continuationPostalCodes).toHaveLength(100);
    expect(page?.notice).toContain('terminal window');
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});

// ── #45: organizations by authorized-official name ───────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/45

describe('searchProvidersTool authorized-official name search (#45)', () => {
  /** An organization row shaped like a live `name_purpose=AO` row (2026-11-19). */
  function officialRow(
    npi: number,
    organizationName: string,
    official: Record<string, string>,
    otherNames: object[] = [],
  ) {
    return {
      number: npi,
      enumeration_type: 'NPI-2',
      basic: { organization_name: organizationName, status: 'A', ...official },
      other_names: otherNames,
      addresses: [
        { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: '981010000' },
      ],
    };
  }
  // NPI 1376714063: official JUDY L SMITH, Office Manager, prefix Mrs.
  const ARLINGTON = officialRow(1376714063, '.ARLINGTON FAMILY MEDICINE INC', {
    authorized_official_first_name: 'JUDY',
    authorized_official_middle_name: 'L',
    authorized_official_last_name: 'SMITH',
    authorized_official_name_prefix: 'Mrs.',
    authorized_official_name_suffix: '--',
    authorized_official_title_or_position: 'Office Manager',
    authorized_official_telephone_number: '3178902300',
  });
  // An official with no title recorded.
  const UNTITLED = officialRow(1518856988, '1 LANE XPRESS SERVICES LLC', {
    authorized_official_first_name: 'ANTHONY',
    authorized_official_last_name: 'SMITH',
  });
  // NPI 1457636912: current name AFFORDABLE EYECARE, INC; DBA SMITH OPTOMETRY; official ROBERT SMITH.
  const AFFORDABLE = officialRow(
    1457636912,
    'AFFORDABLE EYECARE, INC',
    {
      authorized_official_first_name: 'ROBERT',
      authorized_official_last_name: 'SMITH',
      authorized_official_title_or_position: 'Owner',
    },
    [{ code: '3', organization_name: 'SMITH OPTOMETRY', type: 'Doing Business As' }],
  );

  function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
    return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  }

  it('sends name_purpose=AO with NPI-2 and names each official on both surfaces', async () => {
    const fetchSpy = pageStub([ARLINGTON, UNTITLED]);
    const { structured, text } = await contract({
      last_name: 'Smith',
      name_role: 'authorized_official',
      limit: 5,
    });
    expect(sentQuery(fetchSpy)).toEqual({
      version: '2.1',
      limit: '5',
      skip: '0',
      enumeration_type: 'NPI-2',
      last_name: 'Smith',
      name_purpose: 'AO',
    });
    expect(structured.providers.map((row) => row.authorizedOfficial)).toEqual([
      { name: 'JUDY L SMITH', title: 'Office Manager' },
      { name: 'ANTHONY SMITH' },
    ]);
    expect(text).toContain('**Authorized official:** JUDY L SMITH (Office Manager)');
    expect(text).toMatch(/^\*\*Authorized official:\*\* ANTHONY SMITH$/m);
  });

  it.each([
    [{ name_search: 'Jane Smith' }, { first_name: 'Jane', last_name: 'Smith' }],
    [{ name_search: 'Smith' }, { last_name: 'Smith' }],
    [
      { last_name: 'Smith', organization_name: 'Smith*' },
      { last_name: 'Smith', organization_name: 'Smith*' },
    ],
    [{ last_name: 'Smith', provider_type: 'organization' }, { last_name: 'Smith' }],
    [
      { last_name: 'Smith', specialty: 'cardiologist' },
      { last_name: 'Smith', taxonomy_description: 'Cardiovascular Disease' },
    ],
    [
      { first_name: 'Jo*', last_name: 'Smith', city: 'Seattle', state: 'WA' },
      { first_name: 'Jo*', last_name: 'Smith', city: 'Seattle', state: 'WA' },
    ],
    [
      { last_name: 'Smith', postal_code: '98*' },
      { last_name: 'Smith', postal_code: '98*' },
    ],
  ] as const)(
    'combines %o with an official name, raising no mixed criteria',
    async (input, sent) => {
      const fetchSpy = pageStub([]);
      await contract({ ...input, name_role: 'authorized_official', limit: 5 });
      expect(sentQuery(fetchSpy)).toMatchObject({
        ...sent,
        enumeration_type: 'NPI-2',
        name_purpose: 'AO',
      });
    },
  );

  it.each([
    [{ last_name: 'Smith', provider_type: 'individual' }, ['provider_type', 'name_role']],
    [
      { name_search: 'Jane Smith', organization_name: 'Smith*', provider_type: 'individual' },
      ['provider_type', 'organization_name', 'name_role'],
    ],
  ] as const)(
    'rejects %o with provider_type "individual" before any registry request, naming %o',
    async (input, fields) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(searchProvidersTool, {
        ...input,
        name_role: 'authorized_official',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('mixed_provider_criteria');
      const text = textOf(result);
      for (const field of fields) {
        expect(error.data.recovery?.hint).toContain(field);
        expect(text).toContain(field);
      }
      expect(error.data.recovery?.hint).toContain(
        'drop provider_type "individual" to search organizations',
      );
      // The name fields are the official's here, never the individual side.
      expect(text).not.toMatch(/(last_name|name_search) searches individuals/);
    },
  );

  it('rejects provider_type "individual" with no official name as mixed criteria, before any registry request', async () => {
    const fetchSpy = pageStub([]);
    const { error, text } = await failure({
      name_role: 'authorized_official',
      provider_type: 'individual',
      city: 'SEATTLE',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('mixed_provider_criteria');
    for (const surface of [error.message, text]) {
      expect(surface).toContain('name_role "authorized_official" searches organizations');
    }
  });

  it.each([
    [{}],
    [{ organization_name: 'Smith*' }],
    [{ specialty: 'cardiologist' }],
    [{ taxonomy_description: 'Dentist' }],
    [{ city: 'Seattle', state: 'WA' }],
    [{ postal_code: '98101' }],
    [{ organization_name: 'Smith*', name_search: '   ', first_name: '', last_name: ' ' }],
  ] as const)(
    'fails %o as official_name_required, on both surfaces, before any registry request',
    async (input) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await runToolContract(searchProvidersTool, {
        ...input,
        name_role: 'authorized_official',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as unknown as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('official_name_required');
      expect(error.data.recovery?.hint).toMatch(/first_name or last_name/);
      const text = textOf(result);
      expect(text).toMatch(/Recovery:.*first_name or last_name/);
      expect(text).toContain('name_role');
    },
  );

  it('forwards use_first_name_alias=False for the official and reports it on both surfaces', async () => {
    const fetchSpy = pageStub([]);
    const result = await runToolContract(searchProvidersTool, {
      first_name: 'Bob',
      last_name: 'Smith',
      name_role: 'authorized_official',
      use_first_name_alias: false,
    });
    expect(result.isError).not.toBe(true);
    expect(sentQuery(fetchSpy)).toMatchObject({
      first_name: 'Bob',
      last_name: 'Smith',
      use_first_name_alias: 'False',
      name_purpose: 'AO',
    });
    expect(result.structuredContent).toMatchObject({ appliedFirstNameAlias: false });
    expect(textOf(result)).toContain('**First-name aliases:** false');
  });

  it("marks a DBA match on organization_name, never one through the official's name", async () => {
    // The second row carries a personal other name that satisfies the official's last name.
    const personalSmith = officialRow(
      1000000045,
      'JONES CLINIC LLC',
      { authorized_official_first_name: 'PAT', authorized_official_last_name: 'SMITH' },
      [{ type: 'Other Name', first_name: 'PAT', last_name: 'SMITH' }],
    );
    pageStub([AFFORDABLE, personalSmith]);
    const { structured, text } = await contract({
      last_name: 'Smith',
      organization_name: 'Smith*',
      name_role: 'authorized_official',
      limit: 5,
    });
    expect(structured.providers[0]?.matchedOtherName).toEqual({
      name: 'SMITH OPTOMETRY',
      type: 'Doing Business As',
    });
    expect(text).toContain('**Matched other name:** SMITH OPTOMETRY (Doing Business As)');
    pageStub([personalSmith]);
    const officialOnly = await contract({
      last_name: 'Smith',
      name_role: 'authorized_official',
      limit: 5,
    });
    expect(officialOnly.structured.providers[0]).not.toHaveProperty('matchedOtherName');
    expect(officialOnly.text).not.toContain('Matched other name');
  });

  it.each([
    [{ last_name: 'Smith', name_role: 'provider' }, { last_name: 'Smith' }],
    [{ organization_name: 'Smith*' }, { organization_name: 'Smith*', enumeration_type: 'NPI-2' }],
    [
      { organization_name: 'Smith*', name_role: 'provider' },
      { organization_name: 'Smith*', enumeration_type: 'NPI-2' },
    ],
  ] as const)(
    "%o sends today's query and carries no authorizedOfficial (regression)",
    async (input, sent) => {
      const fetchSpy = pageStub([ARLINGTON]);
      const { structured, text } = await contract({ ...input, limit: 5 });
      expect(sentQuery(fetchSpy)).toEqual({ version: '2.1', limit: '5', skip: '0', ...sent });
      expect(structured.providers[0]).not.toHaveProperty('authorizedOfficial');
      expect(text).not.toContain('Authorized official');
    },
  );

  it('keeps name_role "provider" on the individual side of the mix check (regression)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await runToolContract(searchProvidersTool, {
      last_name: 'Smith',
      provider_type: 'organization',
      name_role: 'provider',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const { error } = result.structuredContent as unknown as ErrorEnvelope;
    expect(error.data.reason).toBe('mixed_provider_criteria');
    expect(error.data.recovery?.hint).toBe(
      'Keep one side: drop last_name to search organizations, or drop provider_type "organization" to search individuals.',
    );
  });

  it('format: renders an official with and without a title, and no line without one', () => {
    const text = searchProvidersTool.format!({
      providers: [
        {
          npi: '1376714063',
          type: 'organization',
          name: '.ARLINGTON FAMILY MEDICINE INC',
          authorizedOfficial: { name: 'JUDY L SMITH', title: 'Office Manager' },
          status: 'active',
        },
        {
          npi: '1518856988',
          type: 'organization',
          name: '1 LANE XPRESS SERVICES LLC',
          authorizedOfficial: { name: 'ANTHONY SMITH' },
          status: 'active',
        },
        { npi: '1234567893', type: 'organization', name: 'EXAMPLE HEALTH', status: 'active' },
      ],
    })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(text).toContain(
      '**NPI:** 1376714063 | **Type:** organization | **Status:** active\n**Authorized official:** JUDY L SMITH (Office Manager)',
    );
    expect(text).toMatch(/^\*\*Authorized official:\*\* ANTHONY SMITH$/m);
    expect(text.split('**Authorized official:**')).toHaveLength(3);
  });
});

// ── #46: plain-language specialty aliases ────────────────────────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/46

describe('searchProvidersTool plain-language specialty aliases (#46)', () => {
  it.each([
    ['foot doctor', '213E00000X', 'Podiatrist'],
    ['nursing home', '314000000X', 'Skilled Nursing Facility'],
  ])('specialty "%s" resolves to %s and sends %s', async (specialty, code, description) => {
    const fetchSpy = pageStub([]);
    const { structured, text } = await contract({ specialty, city: 'SEATTLE' });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe(description);
    const echo = structured as unknown as SearchEnrichment;
    expect(echo.appliedTaxonomyDescription).toBe(description);
    expect(echo.resolvedTaxonomies?.[0]).toEqual({ code, description });
    expect(text).toContain(`**Resolved specialty →** ${description} (${code})`);
  });
});

// ── #48: a NUCC code or display name in taxonomy_description ─────────────────
// https://github.com/cyanheads/npi-providers-mcp-server/issues/48

describe('searchProvidersTool taxonomy_description codes and display names (#48)', () => {
  /** Run a search that succeeds; return the sent query and both surfaces' taxonomy echo. */
  async function search(input: z.input<typeof searchProvidersTool.input>) {
    const fetchSpy = pageStub([]);
    const { structured, text } = await contract({ city: 'SEATTLE', ...input });
    return { query: sentQuery(fetchSpy), echo: structured as unknown as SearchEnrichment, text };
  }

  it.each([
    ['207RC0000X', '207RC0000X', 'Cardiovascular Disease'],
    ['207rc0000x', '207RC0000X', 'Cardiovascular Disease'],
    ['Cardiovascular Disease Physician', '207RC0000X', 'Cardiovascular Disease'],
    // A code whose NUCC text the registry rejects searches with the registry's wording.
    ['1223D0004X', '1223D0004X', 'Dentist Anesthesiologist Speciality'],
  ])(
    'decodes taxonomy_description %j to %s and sends %j',
    async (taxonomy_description, code, description) => {
      const { query, echo, text } = await search({ taxonomy_description });
      expect(query.taxonomy_description).toBe(description);
      expect(echo.appliedTaxonomyDescription).toBe(description);
      expect(echo.resolvedTaxonomies).toEqual([{ code, description }]);
      expect(text).toContain(`**Resolved specialty →** ${description} (${code})`);
      expect(text).toContain(`**appliedTaxonomyDescription:** \`${description}\``);
    },
  );

  it('resolves a specialty the registry words differently to the registry’s wording', async () => {
    const { query, echo, text } = await search({ specialty: 'psychiatric nurse practitioner' });
    expect(query.taxonomy_description).toBe('Psych/Mental Health');
    expect(echo.appliedTaxonomyDescription).toBe('Psych/Mental Health');
    expect(echo.resolvedTaxonomies?.[0]).toEqual({
      code: '363LP0808X',
      description: 'Psych/Mental Health',
    });
    expect(text).toContain('**Resolved specialty →** Psych/Mental Health (363LP0808X)');
    expect(text).toContain('**appliedTaxonomyDescription:** `Psych/Mental Health`');
  });

  it.each([
    // A display name that starts a bundled classification or specialization.
    'Critical Access Hospital',
    // Free text: the registry's own wording, which no bundled name holds.
    'Psych/Mental Health',
  ])(
    'sends taxonomy_description %j as written, with no resolvedTaxonomies (characterization)',
    async (taxonomy_description) => {
      const { query, echo, text } = await search({ taxonomy_description });
      expect(query.taxonomy_description).toBe(taxonomy_description);
      expect(echo.appliedTaxonomyDescription).toBe(taxonomy_description);
      expect(echo).not.toHaveProperty('resolvedTaxonomies');
      expect(text).toContain(`**appliedTaxonomyDescription:** \`${taxonomy_description}\``);
      expect(text).not.toContain('Resolved specialty');
    },
  );

  it('sends padded free-text taxonomy_description trimmed and echoes it trimmed', async () => {
    const { query, echo, text } = await search({ taxonomy_description: '  Family Medicine  ' });
    expect(query.taxonomy_description).toBe('Family Medicine');
    expect(echo.appliedTaxonomyDescription).toBe('Family Medicine');
    expect(echo).not.toHaveProperty('resolvedTaxonomies');
    expect(text).toContain('**appliedTaxonomyDescription:** `Family Medicine`');
  });

  it('rejects a code the bundled NUCC set lacks as unresolved_specialty, before any request', async () => {
    const fetchSpy = pageStub([]);
    const { error, text } = await failure({ taxonomy_description: '207RZ9999X', city: 'SEATTLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data.reason).toBe('unresolved_specialty');
    const message = 'taxonomy_description 207RZ9999X matches no code in the bundled NUCC taxonomy.';
    const hint =
      'Check the code for a typo, or find a valid one with npi_lookup_taxonomy mode resolve or browse.';
    expect(error.message).toBe(message);
    expect(error.data.recovery?.hint).toBe(hint);
    expect(text).toContain(message);
    expect(text).toContain(hint);
  });

  it.each([
    [
      '103GC0700X',
      '103GC0700X Clinical Neuropsychologist (replaced by 103G00000X)',
      'Pass the replacement code 103G00000X as taxonomy_description, or find another active code with npi_lookup_taxonomy mode resolve or browse.',
    ],
    [
      '1744G0900X',
      '1744G0900X Graphics Designer (no replacement named)',
      'Find an active code with npi_lookup_taxonomy mode resolve or browse.',
    ],
  ])(
    'rejects inactive code %s as unresolved_specialty naming its replacement, before any request',
    async (taxonomy_description, named, hint) => {
      const fetchSpy = pageStub([]);
      const { error, text } = await failure({ taxonomy_description, city: 'SEATTLE' });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data.reason).toBe('unresolved_specialty');
      const message = `taxonomy_description names a code NUCC marks inactive: ${named}.`;
      expect(error.message).toBe(message);
      expect(error.data.recovery?.hint).toBe(hint);
      expect(text).toContain(message);
      expect(text).toContain(hint);
    },
  );

  it('surfaces registry error 14 as unmatched_taxonomy_description with its recovery', async () => {
    const fetchSpy = fieldErrorStub(
      'taxonomy_description',
      '14',
      'No taxonomy codes found with entered description',
    );
    const { error, text } = await failure({
      taxonomy_description: 'Internal Medicine, Cardiovascular Disease',
      city: 'SEATTLE',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentQuery(fetchSpy).taxonomy_description).toBe(
      'Internal Medicine, Cardiovascular Disease',
    );
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('unmatched_taxonomy_description');
    const hint =
      'Find the taxonomy with npi_lookup_taxonomy mode resolve and pass its code as taxonomy_description, or describe the specialty in plain language as specialty.';
    expect(error.data.recovery?.hint).toBe(hint);
    expect(text).toContain('No taxonomy codes found with entered description');
    expect(text).toContain(hint);
  });

  it.each([
    [
      { specialty: 'diabetology' },
      'Diabetology',
      'The registry has no taxonomy named "Diabetology" (NUCC 207QB0505X, 207QD0401X), so resolving the specialty or passing the code again sends the same text. Search the code\'s classification instead, which also matches its other specializations: taxonomy_description "Internal Medicine" for 207QB0505X or "Family Medicine" for 207QD0401X.',
    ],
    [
      { taxonomy_description: '146E00000X' },
      'Community Paramedic',
      'The registry has no taxonomy named "Community Paramedic" (NUCC 146E00000X), so resolving the specialty or passing the code again sends the same text. 146E00000X is a classification with no broader text: pick a related classification with npi_lookup_taxonomy mode browse, grouping "Emergency Medical Service Providers", and pass its code as taxonomy_description, or search by name or location without a specialty filter.',
    ],
  ] as const)(
    'error 14 on a text bundled codes send names a route past it on both surfaces: %j',
    async (input, sent, hint) => {
      const fetchSpy = fieldErrorStub(
        'taxonomy_description',
        '14',
        'No taxonomy codes found with entered description',
      );
      const { error, text } = await failure({ ...input, city: 'SEATTLE' });
      expect(sentQuery(fetchSpy).taxonomy_description).toBe(sent);
      expect(error.data.reason).toBe('unmatched_taxonomy_description');
      expect(error.data.recovery?.hint).toBe(hint);
      expect(text).toContain('No taxonomy codes found with entered description');
      expect(text).toContain(hint);
    },
  );

  it('marks matchedTaxonomy against a decoded code’s text, as for a specialty (#44)', async () => {
    const cardiology = { code: '207RC0000X', desc: 'Internal Medicine, Cardiovascular Disease' };
    const fetchSpy = pageStub([
      taxonomyRow(1053791517, [
        { code: '207RH0003X', desc: 'Internal Medicine, Hematology & Oncology', primary: true },
        cardiology,
      ]),
      taxonomyRow(1720034424, [{ ...cardiology, primary: true }]),
    ]);
    const { structured, text } = await contract({
      taxonomy_description: '207RC0000X',
      city: 'SEATTLE',
    });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe('Cardiovascular Disease');
    expect(structured.providers.map((row) => row.matchedTaxonomy)).toEqual([
      { code: '207RC0000X', description: 'Internal Medicine, Cardiovascular Disease' },
      undefined,
    ]);
    expect(text).toMatch(
      /^\*\*Matched specialty:\*\* Internal Medicine, Cardiovascular Disease \(207RC0000X\)$/m,
    );
    expect(structured.notice).toBe(
      '1 of 2 row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).',
    );
  });
});

// ── #49 / #50 / #53: specialty resolution wiring ─────────────────────────────

describe('searchProvidersTool specialty: short tokens, qualified therapy, dotted credentials (#49, #50, #53)', () => {
  it('specialty "im" fails with unresolved_specialty before any registry request (#49)', async () => {
    const fetchSpy = pageStub([]);
    const { error, text } = await failure({ specialty: 'im', city: 'Seattle' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error.data.reason).toBe('unresolved_specialty');
    expect(error.message).toBe('Specialty "im" matched no NUCC taxonomy.');
    expect(text).toContain('Specialty "im" matched no NUCC taxonomy.');
  });

  it.each([
    ['physical therapy', '225100000X', 'Physical Therapist'], // #50
    ['Clinical Genetics (M.D.)', '207SG0201X', 'Clinical Genetics (M.D.)'], // #53
  ])('specialty "%s" resolves to %s and sends %s', async (specialty, code, description) => {
    const fetchSpy = pageStub([]);
    const { structured, text } = await contract({ specialty, city: 'SEATTLE' });
    expect(sentQuery(fetchSpy).taxonomy_description).toBe(description);
    const echo = structured as unknown as SearchEnrichment;
    expect(echo.appliedTaxonomyDescription).toBe(description);
    expect(echo.resolvedTaxonomies?.[0]).toEqual({ code, description });
    expect(text).toContain(`**Resolved specialty →** ${description} (${code})`);
  });
});
