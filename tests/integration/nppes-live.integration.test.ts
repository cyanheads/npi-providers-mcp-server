/**
 * @fileoverview Live NPPES checks for the other-name marking (#26) and the
 * postal-prefix continuation past the 1200-match window (#12). They call the real
 * registry sequentially (~120 requests in all), so they run only with
 * `NPPES_LIVE=1` (`NPPES_LIVE=1 bunx vitest run --project integration nppes-live`);
 * a plain `bun run test` skips them.
 * @module tests/integration/nppes-live.integration.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { postalContinuation } from '@/mcp-server/search-window.js';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

interface Row {
  city?: string;
  matchedLocation?: { postalCode?: string; city?: string };
  matchedOtherName?: { name: string; type?: string };
  name: string;
  npi: string;
  postalCode?: string;
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
 * terminal window, since then the listing would not be complete.
 */
async function listAll(input: z.input<typeof searchProvidersTool.input>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let skip = 0; ; ) {
    const page = await search({ ...input, skip, limit: 200 });
    rows.push(...page.providers);
    if (!page.nextPage) {
      expect(page.continuationPostalCodes, `${JSON.stringify(input)} filled its window`).toBe(
        undefined,
      );
      return rows;
    }
    skip = page.nextPage.skip;
  }
}

const lastWord = (name: string) => name.split(' ').at(-1);

describe.runIf(process.env.NPPES_LIVE === '1')('live NPPES (#12, #26)', () => {
  beforeAll(() => {
    initNppesService();
    initTaxonomyService();
  });

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
    expect(parentNpis.size).toBe(parent.length);

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
      `KE* partition: parent ${parentNpis.size}, union ${union.size}, leaf rows ${leafRows}, missing ${missing.length}, extra ${extra.length}`,
    );
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  }, 600_000);
});
