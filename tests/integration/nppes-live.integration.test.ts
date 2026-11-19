/**
 * @fileoverview Live NPPES checks for the other-name marking (#26), the
 * postal-prefix continuation past the 1200-match window (#12), the NUCC fill for
 * taxonomy descriptions the registry serves blank (#43), the matched-taxonomy
 * marking (#44), and the authorized-official name search (#45). They call the real
 * registry sequentially (~125 requests in all), so
 * they run only with `NPPES_LIVE=1` (`NPPES_LIVE=1 bunx vitest run --project
 * integration nppes-live`); a plain `bun run test` skips them.
 * @module tests/integration/nppes-live.integration.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { postalContinuation } from '@/mcp-server/search-window.js';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import type { ProviderRecord, TaxonomyReference } from '@/services/nppes/types.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

interface Row {
  authorizedOfficial?: { name: string; title?: string };
  city?: string;
  matchedLocation?: { postalCode?: string; city?: string };
  matchedOtherName?: { name: string; type?: string };
  matchedTaxonomy?: TaxonomyReference;
  name: string;
  npi: string;
  postalCode?: string;
  primaryTaxonomy?: TaxonomyReference;
  type: 'individual' | 'organization';
}

interface Surface {
  continuationPostalCodes?: string[];
  nextPage?: { skip: number; limit: number };
  notice?: string;
  providers: Row[];
}

/** One live tool call through the public contract, spaced 150 ms after the last. */
async function search(input: z.input<typeof searchProvidersTool.input>): Promise<Surface> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = await runToolContract(searchProvidersTool, input);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as unknown as Surface;
}

/**
 * Every row of a search whose matches end inside the reachable window, paged at
 * limit 200 until a page returns fewer rows. Fails if the search reaches its
 * terminal window, since then the listing would not be complete, if a page repeats
 * an NPI, or if nextPage does not continue exactly where the page ended.
 */
async function listAll(input: z.input<typeof searchProvidersTool.input>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let skip = 0; ; ) {
    const page = await search({ ...input, skip, limit: 200 });
    expect(new Set(page.providers.map((row) => row.npi)).size).toBe(page.providers.length);
    rows.push(...page.providers);
    if (!page.nextPage) {
      expect(page.continuationPostalCodes, `${JSON.stringify(input)} filled its window`).toBe(
        undefined,
      );
      return rows;
    }
    expect(page.nextPage).toEqual({ skip: skip + 200, limit: 200 });
    skip = page.nextPage.skip;
  }
}

const lastWord = (name: string) => name.split(' ').at(-1);

describe.runIf(process.env.NPPES_LIVE === '1')('live NPPES (#12, #26, #43, #44, #45)', () => {
  beforeAll(() => {
    initTaxonomyService();
    initNppesService();
  });

  it('decodes Vascular Surgery, which the registry serves without a description, from NUCC (#43)', async () => {
    const vascularSurgery = {
      code: '2086S0129X',
      description: 'Surgery, Vascular Surgery',
      descriptionSource: 'nucc',
    };
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await runToolContract(getProviderTool, { npis: '1073637286' });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    const [record] = (result.structuredContent as { found: ProviderRecord[] }).found;
    expect(record?.taxonomies).toContainEqual({
      ...vascularSurgery,
      primary: true,
      license: 'MD61452023',
      state: 'WA',
    });

    const page = await search({
      taxonomy_description: 'Vascular Surgery',
      state: 'WA',
      limit: 200,
    });
    const vascular = page.providers.filter((row) => row.primaryTaxonomy?.code === '2086S0129X');
    expect(vascular.length).toBeGreaterThan(0);
    for (const row of vascular) expect(row.primaryTaxonomy).toEqual(vascularSurgery);
  }, 60_000);

  it('names the non-primary taxonomy a row matched the specialty through, by prefix (#44)', async () => {
    const cardiology = await search({
      specialty: 'cardiologist',
      city: 'SEATTLE',
      state: 'WA',
      limit: 200,
    });
    const marked = cardiology.providers.filter((row) => row.matchedTaxonomy);
    expect(marked.length).toBeGreaterThan(0);
    expect(cardiology.notice).toContain(
      `${marked.length} of ${cardiology.providers.length} row(s) matched the specialty filter through a taxonomy other than their primary specialty`,
    );
    const startsCardiovascularDisease = /(^|, )Cardiovascular Disease/;
    for (const row of cardiology.providers) {
      if (startsCardiovascularDisease.test(row.primaryTaxonomy?.description ?? '')) {
        expect(row.matchedTaxonomy).toBeUndefined();
      }
    }
    for (const row of marked) {
      expect(row.matchedTaxonomy?.description).toMatch(startsCardiovascularDisease);
    }

    // Prefix, not substring: a primary that only contains "Surgery" is marked.
    const surgery = await search({
      taxonomy_description: 'Surgery',
      city: 'SEATTLE',
      state: 'WA',
      limit: 200,
    });
    const surgeryMarked = surgery.providers.filter((row) => row.matchedTaxonomy);
    expect(surgeryMarked.length).toBeGreaterThan(0);
    for (const row of surgeryMarked) {
      expect(row.matchedTaxonomy?.description).toMatch(/(^|, )Surgery/);
    }
    expect(
      surgeryMarked.some((row) => /\bSurgery\b/.test(row.primaryTaxonomy?.description ?? '')),
    ).toBe(true);
  }, 60_000);

  it('marks the other-name Smiths that lead a last_name=Smith search, and only those (#26)', async () => {
    const top = await search({ last_name: 'Smith', limit: 5 });
    expect(top.providers).toHaveLength(5);
    for (const row of top.providers) {
      expect(lastWord(row.name)).not.toBe('SMITH');
      expect(lastWord(row.matchedOtherName?.name ?? '')).toBe('SMITH');
    }
    expect(top.notice).toMatch(/sorts by current name/);

    const wa = await search({ last_name: 'Smith', state: 'WA', limit: 200 });
    const current = wa.providers.filter((row) => lastWord(row.name) === 'SMITH');
    const other = wa.providers.filter((row) => lastWord(row.name) !== 'SMITH');
    expect(current.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    for (const row of current) expect(row.matchedOtherName).toBeUndefined();
    for (const row of other) expect(lastWord(row.matchedOtherName?.name ?? '')).toBe('SMITH');
  }, 60_000);

  it('never marks a current Smith matched through a first-name variant (#26)', async () => {
    const page = await search({ first_name: 'Robert', last_name: 'Smith', limit: 200 });
    const variants = page.providers.filter(
      (row) => lastWord(row.name) === 'SMITH' && !row.name.startsWith('ROBERT '),
    );
    expect(variants.length).toBeGreaterThan(0); // BOBBY, ROB, ROBBIE …
    for (const row of page.providers.filter((r) => lastWord(r.name) === 'SMITH')) {
      expect(row.matchedOtherName).toBeUndefined();
    }
  }, 60_000);

  it('finds organizations by their official, marking DBA matches on organization_name alone (#45)', async () => {
    const page = await search({
      last_name: 'Smith',
      organization_name: 'SMITH*',
      name_role: 'authorized_official',
      limit: 200,
    });
    expect(page.providers.length).toBeGreaterThan(0);
    for (const row of page.providers) {
      expect(row.type).toBe('organization');
      expect(lastWord(row.authorizedOfficial?.name ?? '')).toBe('SMITH');
      // Every row reached SMITH* through its current name or a marked other name.
      if (!row.name.startsWith('SMITH')) {
        expect(row.matchedOtherName?.name.startsWith('SMITH')).toBe(true);
      }
    }
    const marked = page.providers.filter((row) => row.matchedOtherName);
    expect(marked.length).toBeGreaterThan(0);
    for (const row of marked) expect(row.name.startsWith('SMITH')).toBe(false);
  }, 60_000);

  it('marks a wildcard first name matched only through an other name (#26)', async () => {
    const page = await search({ first_name: 'JO*', last_name: 'Smith', limit: 200 });
    const marked = page.providers.filter((row) => row.matchedOtherName);
    expect(marked.length).toBeGreaterThan(0);
    for (const row of page.providers) {
      const currentMatches = row.name.startsWith('JO') && lastWord(row.name) === 'SMITH';
      if (currentMatches) expect(row.matchedOtherName).toBeUndefined();
    }
  }, 60_000);

  it('returns rows for trailing-* postal_code and city prefixes (#12)', async () => {
    for (const postal_code of ['98*', '981*']) {
      const page = await search({ last_name: 'Smith', postal_code, limit: 200 });
      expect(page.providers.length).toBeGreaterThan(0);
      const prefix = postal_code.slice(0, -1);
      for (const row of page.providers) {
        expect(row.matchedLocation?.postalCode ?? row.postalCode).toMatch(new RegExp(`^${prefix}`));
      }
    }
    const city = await search({ last_name: 'Smith', city: 'SE*', state: 'WA', limit: 200 });
    expect(city.providers.length).toBeGreaterThan(0);
    for (const row of city.providers) {
      expect(row.matchedLocation?.city ?? row.city).toMatch(/^SE/);
    }
  }, 60_000);

  it('continues the terminal window by postal prefix, and names a dense ZIP a dead end (#12)', async () => {
    const terminal = await search({ last_name: 'Smith', skip: 1000, limit: 200 });
    expect(terminal.providers.length).toBe(200);
    expect(terminal.nextPage).toBeUndefined();
    expect(terminal.continuationPostalCodes).toHaveLength(100);
    expect(terminal.notice).toMatch(/no further live-API page/i);

    const dense = await search({
      postal_code: '77030',
      provider_type: 'individual',
      skip: 1000,
      limit: 200,
    });
    expect(dense.continuationPostalCodes).toEqual([]);
    expect(dense.notice).toMatch(/no postal split remains/i);
  }, 60_000);

  it('the 2-digit postal partition of last_name=Smith, first_name=KE* equals the search (#12)', async () => {
    const parent = await listAll({ last_name: 'Smith', first_name: 'KE*' });
    const parentNpis = new Set(parent.map((row) => row.npi));
    /**
     * The registry sorts by name alone and returns rows that share a name in a different
     * order on each query, so a tied row at a page boundary can come back on both pages
     * while another tied row comes back on neither. listAll pins the pages to adjoining
     * windows, so every repeat here is the registry's, and each one displaces at most one
     * row, which the partition then finds as extra.
     */
    const repeats = parent.length - parentNpis.size;

    const continuation = postalContinuation(undefined);
    const codes = 'postalCodes' in continuation ? continuation.postalCodes : [];
    expect(codes).toHaveLength(100);
    const union = new Set<string>();
    let leafRows = 0;
    for (const postal_code of codes) {
      const rows = await listAll({ last_name: 'Smith', first_name: 'KE*', postal_code });
      leafRows += rows.length;
      for (const row of rows) union.add(row.npi);
    }
    const missing = [...parentNpis].filter((npi) => !union.has(npi));
    const extra = [...union].filter((npi) => !parentNpis.has(npi));
    console.info(
      `KE* partition: parent ${parentNpis.size} (${repeats} repeated), union ${union.size}, leaf rows ${leafRows}, missing ${missing.length}, extra ${extra.length}`,
    );
    expect(missing).toEqual([]);
    expect(extra.length).toBeLessThanOrEqual(repeats);
  }, 600_000);
});
