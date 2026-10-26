/**
 * @fileoverview Tests for the npi_lookup_taxonomy tool — resolve/get/browse
 * modes, error contracts, truncation enrichment, and format() parity.
 * @module tests/mcp-server/tools/lookup-taxonomy.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createLookupTaxonomyTool,
  lookupTaxonomyTool,
} from '@/mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

beforeAll(() => {
  initTaxonomyService();
});

const ctx = () => createMockContext({ errors: lookupTaxonomyTool.errors });

/** The handler is synchronous; capture its (sync or async) throw as a value. */
async function caught(
  input: Parameters<typeof lookupTaxonomyTool.handler>[0],
  c: ReturnType<typeof ctx>,
) {
  return Promise.resolve()
    .then(() => lookupTaxonomyTool.handler(input, c))
    .catch((e) => e);
}

describe('lookupTaxonomyTool', () => {
  it.each(['resolve', 'browse'] as const)(
    'configured %s limits advertise/reject the opt-out bound',
    async (mode) => {
      const strict = createLookupTaxonomyTool(false);
      const input = { mode, ...(mode === 'resolve' ? { query: 'nurse' } : {}), limit: 51 };
      expect(strict.input.toJSONSchema().properties?.limit).toMatchObject({ maximum: 50 });
      expect(strict.input.safeParse(input).success).toBe(false);
      expect((await runToolContract(strict, input)).isError).toBe(true);
    },
  );

  it.each([0, -1, 1.5])('rejects invalid limit %s in both configurations', (limit) => {
    for (const clamp of [false, true]) {
      for (const mode of ['browse', 'resolve']) {
        expect(
          createLookupTaxonomyTool(clamp).input.safeParse({ mode, query: 'nurse', limit }).success,
        ).toBe(false);
      }
    }
  });

  it.each([
    { mode: 'resolve', code: '' },
    { mode: 'resolve', grouping: '' },
    { mode: 'resolve', section: 'Individual' },
    { mode: 'browse', query: '' },
    { mode: 'browse', code: '' },
    { mode: 'get', limit: 20 },
    { mode: 'get', query: '' },
    { mode: 'get', grouping: '' },
    { mode: 'get', section: 'Individual' },
  ] as const)('rejects wrong-mode fields before missing arguments/defaults: %j', async (input) => {
    const result = await runToolContract(lookupTaxonomyTool, input);
    const { error } = result.structuredContent as {
      error: { data: { reason: string; recovery: { hint: string } } };
    };
    expect(error.data.reason).toBe('wrong_mode_argument');
    expect(error.data.recovery.hint).toContain('Use query with resolve');
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('does not accept:'),
        }),
      ]),
    );
  });

  it.each([
    { mode: 'resolve', query: 'nurse', limit: 99 },
    { mode: 'resolve', query: 'cardiologist', limit: 99 },
    { mode: 'resolve', query: 'nurse', limit: 99, skip: 1000 },
    { mode: 'browse', grouping: 'not-a-group', limit: 99 },
    { mode: 'browse', limit: 99, skip: 1000 },
  ] as const)('retains clamp notices on capped, short and empty pages: %j', async (input) => {
    const result = await run(input);
    expect(result.isError).toBe(false);
    expect(result.structured.notice).toMatch(/99.*50/);
    expect(result.text).toContain(result.structured.notice);
  });
  it('advertises a flat enum mode and optional pagination without defaults', () => {
    expect(lookupTaxonomyTool.input.toJSONSchema()).toMatchObject({
      type: 'object',
      required: ['mode'],
      properties: { mode: { enum: ['resolve', 'get', 'browse'] } },
    });
    expect(lookupTaxonomyTool.input.parse({ mode: 'browse' })).toEqual({ mode: 'browse' });
  });

  it('clamps oversize browse limits and reports requested/applied values on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'browse', limit: 99 });
    expect(structured.matches).toHaveLength(50);
    expect(structured.notice).toMatch(/99.*50/);
    expect(text).toMatch(/99.*50/);
  });

  it('renders the NUCC section without an entity-type inference', async () => {
    const { structured, text } = await run({ mode: 'get', code: '207RC0000X' });
    expect(structured.matches?.[0]?.section).toBe('Individual');
    expect(text).toContain('**Section:** Individual |');
    expect(text).not.toMatch(/NPI-[12]/);
  });

  it.each([
    ['225XR0403X', 'notes'],
    ['207RC0000X', 'notes'],
    ['102X00000X', 'definition'],
  ])('converts known markup for %s on both tool surfaces', async (code, field) => {
    const { structured, text } = await run({ mode: 'get', code });
    const value = structured.matches?.[0]?.[field] as string;
    expect(value).toContain('\n');
    expect(value).not.toMatch(/<br\/>|<\/?ul>|<li>/);
    expect(text).toContain(value);
    if (code === '225XR0403X') expect(value.split('\n- ')).toHaveLength(6);
  });
  it('keeps business Group codes in the Individual NUCC section (characterization)', async () => {
    const { structured } = await run({ mode: 'browse', grouping: 'Group', section: 'Individual' });
    expect(structured.matches?.map((entry) => entry.code)).toEqual(['193200000X', '193400000X']);
  });
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

  it('resolve: a term named like an Object.prototype key is a plain no_match on both surfaces', async () => {
    const { isError, structured, text } = await run({ mode: 'resolve', query: 'constructor' });
    expect(isError).toBe(true);
    expect(structured.error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(structured.error?.data?.reason).toBe('no_match');
    expect(structured.error?.message).toBe('No taxonomy matched "constructor".');
    expect(text).toContain('No taxonomy matched "constructor".');
  });

  it('resolve: requires query through the handler contract', async () => {
    const result = await run({ mode: 'resolve' });
    expect(result.structured.error?.data?.reason).toBe('missing_argument');
  });

  it('resolve: throws missing_argument when query is blank', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: '   ' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('missing_argument');
  });

  it('resolve: discloses truncation when more matches than the limit', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'nurse', limit: 2 });
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

  it('get: trims and normalizes code case before exact lookup', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '  207rc0000x  ' });
    const result = await lookupTaxonomyTool.handler(input, ctx());
    expect(result.matches[0]?.code).toBe('207RC0000X');
  });

  it('get: throws no_match for an unknown code', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '000ZZZ000X' });
    expect((await caught(input, ctx()))?.data?.reason).toBe('no_match');
  });

  it('get: requires code through the handler contract', async () => {
    const result = await run({ mode: 'get' });
    expect(result.structured.error?.data?.reason).toBe('missing_argument');
  });

  it('get: throws missing_argument when code is blank', async () => {
    const input = lookupTaxonomyTool.input.parse({ mode: 'get', code: '   ' });
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

  it('browse: returns a complete narrow group without truncation metadata', async () => {
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({
        mode: 'browse',
        grouping: 'Managed Care Organizations',
        limit: 50,
      }),
      c,
    );
    expect(result.matches).toHaveLength(4);
    expect(getEnrichment(c)).not.toHaveProperty('truncated');
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

  it('browse: discloses truncation and the next deterministic skip', async () => {
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'browse', limit: 2, skip: 4 }),
      c,
    );
    expect(result.matches).toHaveLength(2);
    expect(getEnrichment(c)).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(getEnrichment(c).notice).toMatch(/skip=6/);
  });

  it('browse: a page past the end returns empty with terminal-page guidance', async () => {
    const c = ctx();
    const result = await lookupTaxonomyTool.handler(
      lookupTaxonomyTool.input.parse({ mode: 'browse', skip: 1000 }),
      c,
    );
    expect(result.matches).toEqual([]);
    expect(getEnrichment(c).notice).toMatch(/No more entries beyond skip=1000/i);
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
      lookupTaxonomyTool.input.parse({ mode: 'resolve', query: 'nurse', limit: 2 }),
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

  it('get: rejects browse-only arguments instead of silently stripping them (#7)', async () => {
    const result = await run({ mode: 'get', code: '207RC0000X', skip: 9 });
    expect(result.structured.error?.data?.reason).toBe('wrong_mode_argument');
    expect(result.text).toContain('does not accept: skip');
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
          status: 'active',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('207RC0000X');
    expect(text).toContain('Cardiovascular Disease');
  });

  it('format: renders empty and multi-entry results, including definitions', () => {
    expect(lookupTaxonomyTool.format!({ matches: [] })).toEqual([
      { type: 'text', text: 'No taxonomy entries matched.' },
    ]);
    const blocks = lookupTaxonomyTool.format!({
      matches: [
        {
          code: '207R00000X',
          grouping: 'Allopathic & Osteopathic Physicians',
          classification: 'Internal Medicine',
          displayName: 'Internal Medicine Physician',
          definition: 'A physician who provides long-term, comprehensive care.',
          section: 'Individual',
          status: 'active',
        },
        {
          code: '207Q00000X',
          grouping: 'Allopathic & Osteopathic Physicians',
          classification: 'Family Medicine',
          displayName: 'Family Medicine Physician',
          section: 'Individual',
          status: 'active',
        },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain('Taxonomy matches (2)');
    expect(text).toContain('A physician who provides long-term, comprehensive care.');
    expect(text).toContain('207Q00000X');
  });
});

type LookupInput = z.input<typeof lookupTaxonomyTool.input>;
type Entry = Record<string, unknown> & { code: string };

/** Run the tool through its public contract; return both client surfaces. */
async function run(input: LookupInput) {
  const result = await runToolContract(lookupTaxonomyTool, input);
  const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  return {
    isError: result.isError === true,
    structured: result.structuredContent as {
      matches?: Entry[];
      notice?: string;
      truncated?: boolean;
      error?: { code: number; message: string; data?: { reason?: string } };
    },
    text,
  };
}

const PERFUSIONIST_NOTES =
  'Source:  Health Professions Career and Education Directory, American Medical Association [1/1/2007: new]';

describe('lookupTaxonomyTool NUCC Notes (#11)', () => {
  it('retains literal reference markers on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'get', code: '3336C0004X' });
    expect(structured.matches?.[0]?.notes).toContain('<795>');
    expect(structured.matches?.[0]?.notes).toContain('<797>');
    expect(text).toContain('<795>');
    expect(text).toContain('<797>');
  });
  it('get: returns the trimmed Notes cell byte for byte on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'get', code: '242T00000X' });
    expect(structured.matches?.[0]?.notes).toBe(PERFUSIONIST_NOTES);
    expect(text).toContain(PERFUSIONIST_NOTES);
  });

  it('get: omits notes for a code whose Notes cell is empty', async () => {
    const { structured, text } = await run({ mode: 'get', code: '207QA0505X' });
    expect(structured.matches?.[0]?.code).toBe('207QA0505X');
    expect(structured.matches?.[0]).not.toHaveProperty('notes');
    expect(text).not.toMatch(/\*\*Notes:\*\*/);
    const withNotes = await run({ mode: 'get', code: '242T00000X' });
    expect(withNotes.text).toMatch(/\*\*Notes:\*\*/);
  });

  it('resolve and browse: list entries omit the notes get returns for the same code', async () => {
    const got = await run({ mode: 'get', code: '242T00000X' });
    expect(got.structured.matches?.[0]).toHaveProperty('notes');
    const resolved = await run({ mode: 'resolve', query: 'perfusionist' });
    expect(resolved.structured.matches?.map((m) => m.code)).toContain('242T00000X');
    const browsed = await run({ mode: 'browse', limit: 50 });
    for (const surface of [resolved, browsed]) {
      expect(surface.structured.matches?.length).toBeGreaterThan(0);
      for (const match of surface.structured.matches ?? []) {
        expect(match).not.toHaveProperty('notes');
      }
      expect(surface.text).not.toMatch(/\*\*Notes:\*\*/);
    }
  });
});

describe('lookupTaxonomyTool inactive codes (#16)', () => {
  it('get: flags an inactive code and names its replacement on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'get', code: '103GC0700X' });
    expect(structured.matches?.[0]).toMatchObject({
      code: '103GC0700X',
      status: 'inactive',
      replacedBy: '103G00000X',
    });
    expect(text).toMatch(/\*\*Status:\*\* inactive/);
    expect(text).toContain('replaced by 103G00000X');
  });

  it('get: flags an inactive code with no named replacement', async () => {
    const { structured, text } = await run({ mode: 'get', code: '1744G0900X' });
    expect(structured.matches?.[0]).toMatchObject({ code: '1744G0900X', status: 'inactive' });
    expect(structured.matches?.[0]).not.toHaveProperty('replacedBy');
    expect(text).toMatch(/\*\*Status:\*\* inactive/);
    expect(text).not.toMatch(/replaced by/i);
  });

  it('get: reports an active code as active', async () => {
    const { structured, text } = await run({ mode: 'get', code: '207RC0000X' });
    expect(structured.matches?.[0]).toMatchObject({ code: '207RC0000X', status: 'active' });
    expect(structured.matches?.[0]).not.toHaveProperty('replacedBy');
    expect(text).toMatch(/\*\*Status:\*\* active/);
  });

  it('resolve: drops the inactive twin and returns only the active code', async () => {
    const { structured } = await run({ mode: 'resolve', query: 'clinical neuropsychologist' });
    expect(structured.matches?.map((m) => [m.code, m.status])).toEqual([['103G00000X', 'active']]);
  });

  it('resolve: no_match names the inactive code when every match is inactive', async () => {
    const { isError, structured, text } = await run({
      mode: 'resolve',
      query: 'graphics designer',
    });
    expect(isError).toBe(true);
    expect(structured.error?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(structured.error?.data?.reason).toBe('no_match');
    expect(structured.error?.message).toContain('1744G0900X');
    expect(structured.error?.message).toMatch(/inactive/i);
    expect(text).toContain('1744G0900X');
    expect(text).toMatch(/Recovery:/);
  });

  it('resolve: no_match names each inactive code with its replacement', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'christian science' });
    expect(structured.error?.data?.reason).toBe('no_match');
    for (const code of ['287300000X', '317400000X', '282J00000X']) {
      expect(structured.error?.message).toContain(code);
      expect(text).toContain(code);
    }
  });

  it('resolve: the inactive-only no_match message lists each code, name, and replacement (characterization)', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'christian science' });
    const message =
      'No active taxonomy matched "christian science". It matched only codes NUCC marks inactive: 287300000X Christian Science Sanitorium (replaced by 282J00000X); 317400000X Christian Science Facility (replaced by 282J00000X).';
    expect(structured.error?.message).toBe(message);
    expect(text).toContain(message);
    const none = await run({ mode: 'resolve', query: 'graphics designer' });
    expect(none.structured.error?.message).toBe(
      'No active taxonomy matched "graphics designer". It matched only codes NUCC marks inactive: 1744G0900X Graphics Designer (no replacement named).',
    );
  });

  it('resolve: a term with no match at all keeps the plain no_match message (characterization)', async () => {
    const { structured } = await run({ mode: 'resolve', query: 'zzzznotaspecialty' });
    expect(structured.error?.data?.reason).toBe('no_match');
    expect(structured.error?.message).not.toMatch(/inactive/i);
  });

  it('resolve: skip past an inactive-only match set is an empty page, not no_match (characterization)', async () => {
    const { isError, structured } = await run({
      mode: 'resolve',
      query: 'graphics designer',
      skip: 20,
    });
    expect(isError).toBe(false);
    expect(structured.matches).toEqual([]);
    expect(structured.notice).toMatch(/No more matches beyond skip=20/);
  });

  it('resolve: truncation counts only active matches and pages contiguously', async () => {
    const all = await run({ mode: 'resolve', query: 'psychologist', limit: 50 });
    const codes = all.structured.matches?.map((m) => m.code) ?? [];
    expect(codes).not.toContain('103TE1000X');
    expect(all.structured.matches?.every((m) => m.status === 'active')).toBe(true);
    const page1 = await run({ mode: 'resolve', query: 'psychologist', limit: 8 });
    const page2 = await run({ mode: 'resolve', query: 'psychologist', limit: 8, skip: 8 });
    expect(page1.structured.truncated).toBe(true);
    expect(page1.structured.notice).toMatch(/skip=8/);
    expect([...(page1.structured.matches ?? []), ...(page2.structured.matches ?? [])]).toEqual(
      all.structured.matches?.slice(0, 16),
    );
  });

  it('browse: keeps inactive codes on the page, flagged, on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'browse', limit: 20 });
    const byCode = new Map(structured.matches?.map((m) => [m.code, m]));
    expect(byCode.get('103GC0700X')).toMatchObject({
      status: 'inactive',
      replacedBy: '103G00000X',
    });
    expect(byCode.get('103TE1000X')).toMatchObject({ status: 'inactive' });
    expect(byCode.get('103G00000X')).toMatchObject({ status: 'active' });
    expect(text).toMatch(/\*\*Status:\*\* inactive \(replaced by 103G00000X\)/);
  });

  it('browse: a full skip-walk returns every code once, inactive codes included (#7)', async () => {
    const walked: Entry[] = [];
    for (let skip = 0; ; skip += 50) {
      const page = await run({ mode: 'browse', limit: 50, skip });
      if (!page.structured.matches?.length) break;
      walked.push(...page.structured.matches);
    }
    const codes = walked.map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
    expect(walked.filter((m) => m.status === 'inactive').map((m) => m.code)).toContain(
      '1744G0900X',
    );
  });
});

describe('lookupTaxonomyTool resolve ranking and matching (#10, #20, #21, #22)', () => {
  it('resolve: "dentist" leads with Dentist and carries no mid-word "dent" match', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'dentist', limit: 50 });
    expect(structured.matches?.[0]?.code).toBe('122300000X');
    expect(structured.matches?.map((m) => m.code)).not.toContain('202C00000X');
    expect(text).toMatch(/^## Taxonomy matches \(\d+\)\n\n### Dentist\n/);
    expect(text).not.toContain('Independent Medical Examiner');
  });

  it('resolve: "physician assistant" leads with Physician Assistant on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'physician assistant' });
    expect(structured.matches?.[0]?.code).toBe('363A00000X');
    expect(text.indexOf('### Physician Assistant')).toBeLessThan(
      text.indexOf('### Dental Assistant'),
    );
  });

  it('resolve: "oncologist" leads with Medical Oncology on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'oncologist', limit: 1 });
    expect(structured.matches?.map((m) => m.code)).toEqual(['207RX0202X']);
    expect(structured.truncated).toBe(true);
    expect(structured.notice).toMatch(/skip=1/);
    expect(text).toContain('**Code:** 207RX0202X');
  });

  it('resolve: a single-entry alias match renders one entry and no truncation', async () => {
    const { isError, structured, text } = await run({ mode: 'resolve', query: 'neurosurgeon' });
    expect(isError).toBe(false);
    expect(structured.matches?.map((m) => m.code)).toEqual(['207T00000X']);
    expect(structured).not.toHaveProperty('truncated');
    expect(text).toMatch(/^### Neurological Surgery Physician\n/);
  });

  it('resolve: "primary care doctor" caps at limit, then pages on with skip', async () => {
    const page1 = await run({ mode: 'resolve', query: 'primary care doctor', limit: 2 });
    expect(page1.structured.matches?.map((m) => m.code)).toEqual(['207Q00000X', '207R00000X']);
    expect(page1.structured).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(page1.structured.notice).toMatch(/skip=2/);
    expect(page1.text).toContain('### Family Medicine Physician');
    const all = await run({ mode: 'resolve', query: 'primary care doctor', limit: 50 });
    const page2 = await run({ mode: 'resolve', query: 'primary care doctor', limit: 2, skip: 2 });
    expect(page2.structured.matches).toEqual(all.structured.matches?.slice(2, 4));
  });

  it('resolve: a skip past the end of an alias match set is an empty page', async () => {
    const { isError, structured, text } = await run({
      mode: 'resolve',
      query: 'speech therapist',
      skip: 5,
    });
    expect(isError).toBe(false);
    expect(structured.matches).toEqual([]);
    expect(structured.notice).toMatch(/No more matches beyond skip=5/);
    expect(text).toContain('No taxonomy entries matched.');
  });

  it('resolve: "urologist" returns no Neurology entry, and a nonsense term still fails no_match', async () => {
    const { structured } = await run({ mode: 'resolve', query: 'urologist', limit: 50 });
    expect(structured.matches?.[0]?.code).toBe('208800000X');
    expect(structured.matches?.filter((m) => /neurolog/i.test(String(m.classification)))).toEqual(
      [],
    );
    const miss = await run({ mode: 'resolve', query: 'orthopedistzz' });
    expect(miss.structured.error?.data?.reason).toBe('no_match');
  });

  it('resolve: rejects an out-of-range limit before resolving', () => {
    expect(
      lookupTaxonomyTool.input.safeParse({ mode: 'resolve', query: 'oncologist', limit: 0 })
        .success,
    ).toBe(false);
  });
});

describe('lookupTaxonomyTool resolve: therapist and pediatric ranking (#24, #25)', () => {
  it('resolve: "therapist" returns therapist professions only, on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'therapist', limit: 50 });
    const matches = structured.matches ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.filter((m) => m.grouping === 'Allopathic & Osteopathic Physicians')).toEqual([]);
    expect(text).not.toContain('Therapeutic Radiology');
    expect(text).not.toMatch(/^### .*Physician$/m);
    expect(text).toMatch(/^### .*Therapist/m);
  });

  it('resolve: "sports medicine" leads with a non-pediatric code, on both surfaces', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'sports medicine', limit: 1 });
    expect(structured.matches?.map((m) => m.code)).toEqual(['207QS0010X']);
    expect(structured.truncated).toBe(true);
    expect(text).toMatch(/^### Sports Medicine \(Family Medicine\) Physician\n/);
  });

  it('resolve: "pediatric sports medicine" still leads with the pediatric code', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'pediatric sports medicine' });
    expect(structured.matches?.map((m) => m.code)).toEqual(['2080S0010X']);
    expect(structured).not.toHaveProperty('truncated');
    expect(text).toContain('**Code:** 2080S0010X');
  });

  it('resolve: the pediatric sleep medicine code sits on the last page, and skip past it is empty', async () => {
    const page = await run({ mode: 'resolve', query: 'sleep medicine', limit: 2, skip: 4 });
    expect(page.structured.matches?.map((m) => m.code)).toEqual(['2080S0012X']);
    expect(page.structured).not.toHaveProperty('truncated');
    const past = await run({ mode: 'resolve', query: 'sleep medicine', limit: 2, skip: 5 });
    expect(past.structured.matches).toEqual([]);
    expect(past.structured.notice).toMatch(/No more matches beyond skip=5/);
  });
});

describe('lookupTaxonomyTool dotted abbreviations (#29)', () => {
  // https://github.com/cyanheads/npi-providers-mcp-server/issues/29
  it('resolve: "P.A." returns the Physician Assistant codes in both surfaces', async () => {
    const { structured, text } = await run({ mode: 'resolve', query: 'P.A.' });
    expect(structured.matches?.map((m) => m.code)).toEqual([
      '363A00000X',
      '363AM0700X',
      '363AS0400X',
    ]);
    expect(text).toContain('**Code:** 363A00000X');
    expect(text).not.toContain('207ZP0101X');
  });

  it('resolve: "M.D." and a one-letter query end in no_match rather than a single-letter hit', async () => {
    for (const query of ['M.D.', 'p a']) {
      const { isError, structured, text } = await run({ mode: 'resolve', query });
      expect(isError).toBe(true);
      expect(structured.error?.data?.reason).toBe('no_match');
      expect(text).toMatch(/Recovery:/);
    }
  });
});

describe('lookupTaxonomyTool stop-word-only queries (#31)', () => {
  // https://github.com/cyanheads/npi-providers-mcp-server/issues/31
  type ErrorData = { reason?: string; recovery?: { hint?: string } };

  it.each(['do', 'D.O.', 'md', 'M.D.', 'physician', 'doctor'])(
    'resolve: "%s" fails with no_match and points to browse the physician grouping',
    async (query) => {
      const { isError, structured, text } = await run({ mode: 'resolve', query });
      expect(isError).toBe(true);
      const data = structured.error?.data as ErrorData | undefined;
      expect(data?.reason).toBe('no_match');
      expect(structured.error?.message).toBe(`"${query}" names no specialty on its own.`);
      expect(data?.recovery?.hint).toMatch(/mode browse/);
      expect(data?.recovery?.hint).toContain('grouping "Allopathic & Osteopathic Physicians"');
      expect(text).toContain(`"${query}" names no specialty on its own.`);
      expect(text).toContain('Recovery:');
      expect(text).toContain('grouping "Allopathic & Osteopathic Physicians"');
    },
  );

  it.each(['specialist', 'provider'])(
    'resolve: "%s" fails with no_match and points to browse without naming a grouping',
    async (query) => {
      const { isError, structured, text } = await run({ mode: 'resolve', query });
      expect(isError).toBe(true);
      const data = structured.error?.data as ErrorData | undefined;
      expect(data?.reason).toBe('no_match');
      expect(data?.recovery?.hint).toMatch(/mode browse/);
      expect(data?.recovery?.hint).not.toContain('Allopathic');
      expect(text).toMatch(/Recovery:.*mode browse/);
    },
  );

  it.each([
    ['physician assistant', '363A00000X'],
    ['heart doctor', '207RC0000X'],
    ['nurse specialist', '364S00000X'],
    ['sports physician', '207QS0010X'],
    ['family doctor', '207Q00000X'],
  ])('resolve: "%s" still leads with %s (characterization)', async (query, code) => {
    const { isError, structured, text } = await run({ mode: 'resolve', query, limit: 1 });
    expect(isError).toBe(false);
    expect(structured.matches?.[0]?.code).toBe(code);
    expect(text).toContain(`**Code:** ${code}`);
  });
});

describe('lookupTaxonomyTool plural stop words (#32)', () => {
  // https://github.com/cyanheads/npi-providers-mcp-server/issues/32
  type ErrorData = { reason?: string; recovery?: { hint?: string } };

  it.each(['physicians', 'doctors', 'MDs'])(
    'resolve: "%s" fails with no_match and points to browse the physician grouping',
    async (query) => {
      const { isError, structured, text } = await run({ mode: 'resolve', query });
      expect(isError).toBe(true);
      const data = structured.error?.data as ErrorData | undefined;
      expect(structured.error?.code).toBe(JsonRpcErrorCode.NotFound);
      expect(data?.reason).toBe('no_match');
      expect(structured.error?.message).toBe(`"${query}" names no specialty on its own.`);
      expect(data?.recovery?.hint).toContain(
        'mode browse with grouping "Allopathic & Osteopathic Physicians"',
      );
      expect(text).toContain(`"${query}" names no specialty on its own.`);
      expect(text).toContain('Recovery:');
      expect(text).toContain('grouping "Allopathic & Osteopathic Physicians"');
    },
  );

  it.each(['specialists', 'providers'])(
    'resolve: "%s" fails with no_match and points to browse without naming a grouping',
    async (query) => {
      const { isError, structured, text } = await run({ mode: 'resolve', query });
      expect(isError).toBe(true);
      const data = structured.error?.data as ErrorData | undefined;
      expect(data?.reason).toBe('no_match');
      expect(structured.error?.message).toBe(`"${query}" names no specialty on its own.`);
      expect(data?.recovery?.hint).toMatch(/mode browse/);
      expect(data?.recovery?.hint).not.toContain('Allopathic');
      expect(text).toMatch(/Recovery:.*mode browse/);
    },
  );

  it.each([
    ['heart doctors', 'heart doctor'],
    ['eye doctors', 'eye doctor'],
    ['kidney doctors', 'kidney doctor'],
  ])(
    'resolve: "%s" returns the same entries as "%s" on both surfaces',
    async (plural, singular) => {
      const expected = await run({ mode: 'resolve', query: singular, limit: 50 });
      const actual = await run({ mode: 'resolve', query: plural, limit: 50 });
      expect(expected.isError).toBe(false);
      expect(actual.isError).toBe(false);
      expect(actual.structured.matches?.map((m) => m.code)).toEqual(
        expected.structured.matches?.map((m) => m.code),
      );
      expect(actual.text).toBe(expected.text);
    },
  );
});
