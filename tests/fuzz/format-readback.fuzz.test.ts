/**
 * @fileoverview Read-back tests for the `content[]` Markdown of all three tools (#55):
 * every registry, NUCC, or caller string a `format()` or the `resolvedTaxonomies`
 * trailer interpolates reads back through markdown-it as the value `structuredContent`
 * carries, and no value changes the document's blocks or authored markup. Properties
 * fill every string slot of each `format()` with Markdown-dense text; the bundled NUCC
 * set is checked exhaustively; the contract runs prove the wiring and that no notice
 * echoes caller text. Global fetch is the only fake.
 * @module tests/fuzz/format-readback.fuzz.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getProviderTool } from '@/mcp-server/tools/definitions/get-provider.tool.js';
import { lookupTaxonomyTool } from '@/mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { searchProvidersTool } from '@/mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from '@/services/nppes/nppes-service.js';
import { TAXONOMY_ENTRIES } from '@/services/taxonomy/taxonomy-data.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import {
  mapStringSlots,
  readBackMismatch,
  readLines,
  readMarkdown,
  slotCount,
} from '../helpers/markdown-readback.js';

beforeAll(() => {
  initTaxonomyService();
  initNppesService();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type GetOutput = z.infer<typeof getProviderTool.output>;
type SearchOutput = z.infer<typeof searchProvidersTool.output>;
type LookupOutput = z.infer<typeof lookupTaxonomyTool.output>;
type Resolved = { code: string; description: string }[] | undefined;

/** Joins a tool's content blocks the way the tests read them. */
function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

const renderGet = (output: GetOutput) => textOf(getProviderTool.format!(output));
const renderSearch = (output: SearchOutput) => textOf(searchProvidersTool.format!(output));
const renderLookup = (output: LookupOutput) => textOf(lookupTaxonomyTool.format!(output));
const renderResolved = (taxes: Resolved) =>
  searchProvidersTool.enrichmentTrailer!.resolvedTaxonomies!.render!(taxes);
const resolvedSchema = searchProvidersTool.enrichment!.resolvedTaxonomies as z.ZodType;

/**
 * Text pieces that parse as Markdown alone or beside authored text. Entities come whole
 * and missing the `;` a template could supply; `b>` and `/b>` finish a `<` another piece
 * or the template left. NUL and U+000B are outside the escaper's guarantee, so they are
 * left out: CommonMark replaces NUL, and the escaper keeps a vertical tab literal at a
 * value's edge, where markdown-it counts it as whitespace (`**\v1**` opens no strong).
 */
const INLINE = ['*', '**', '_', '__', '`', '```', '~', '~~', '~~~', '!', '\\', '\\*', '*x*', '_x_'];
const LINKS = ['[', ']', '(', ')', '[x](y)', '![a](b)', '[x]: <y>', '<a@b.c>', '<http://x.io>'];
const HTML = ['<', '>', '<b>', '</b>', 'b>', '/b>', '<!--', '<?', '<div>'];
const ENTITIES = ['&', ';', '&amp;', '&amp', '&#32;', '&#x41;'];
const BLOCK_MARKERS = ['#', '##', ' #', '-', '--', '---', '+', '=', '===', '|', ':', ':-', '-:'];
const BREAKS_AND_SPACE = ['\n', '\r\n', '\r', '\n\n', ' ', '  ', '    ', '\t', '\f', '\xa0'];
const DIGITS_AND_TEXT = ['0', '1', '12', '1.', '1)', '.', 'x', 'é', '𝐀', 'a_b', 'snake_case'];
const IDENTIFIERS = ['jane_doe@direct.example.org', 'http://x.io/a_b', '207R00000X'];
const PIECES = [
  ...INLINE,
  ...LINKS,
  ...HTML,
  ...ENTITIES,
  ...BLOCK_MARKERS,
  ...BREAKS_AND_SPACE,
  ...DIGITS_AND_TEXT,
  ...IDENTIFIERS,
];

/** A non-empty slot value: mostly Markdown-dense piece runs, sometimes arbitrary text. */
const slotValue = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 8 })
      .map((pieces) => pieces.join('')),
  },
  {
    weight: 1,
    arbitrary: fc
      .string({ unit: 'grapheme', minLength: 1, maxLength: 6 })
      .filter((text) => !/[\0\v]/.test(text)),
  },
);

/**
 * Values every slot takes at once, ahead of the generated runs: the #55 repro, a last
 * line of digits before an authored `)`, an entity whole and one an authored `;`
 * completes, an authored-bracket shape, list and quote lines, edge whitespace on every
 * line, and a plain identifier the escaper must leave alone.
 */
const EVERY_SLOT = [
  'A*B*C [X](y) _Z_',
  'x\n1',
  'x\r\n12',
  '&amp;',
  '&amp',
  '[05]',
  'LINE ONE\n- LINE TWO\n> THREE',
  '<b>x</b>\n# h\n---',
  ' a \n b ',
  'snake_case',
];

/** Runs per property; fast-check counts the EVERY_SLOT examples among them. */
const RUNS = 1000;

/** `template` with its string slots, in walk order, replaced by `values`. */
function fill<T>(schema: z.ZodType, template: T, values: readonly string[]): T {
  let i = 0;
  return mapStringSlots(schema, template, () => values[i++] as string);
}

/**
 * Fills every string slot of `template` with generated text and asserts the render
 * reads back. Returns the number of runs, so the caller can assert the property ran.
 */
function assertReadBack<T>(
  schema: z.ZodType,
  template: T,
  render: (value: T) => string,
  seed: number,
): number {
  const slots = slotCount(schema, template);
  let runs = 0;
  fc.assert(
    fc.property(fc.array(slotValue, { minLength: slots, maxLength: slots }), (values) => {
      runs++;
      expect(readBackMismatch(schema, fill(schema, template, values), render)).toBeUndefined();
    }),
    {
      numRuns: RUNS,
      seed,
      examples: EVERY_SLOT.map((value) => [Array.from({ length: slots }, () => value)]),
    },
  );
  return runs;
}

/** Every slot of a template starts as this; the property replaces each one. */
const S = 's';

const ADDRESS = {
  purpose: S,
  addressType: S,
  line1: S,
  line2: S,
  city: S,
  state: S,
  postalCode: S,
  countryCode: S,
  countryName: S,
  telephoneNumber: S,
  faxNumber: S,
};

/** Every field of the record present, plus sparse rows that reach each other branch. */
const GET_OUTPUT: GetOutput = {
  found: [
    {
      npi: S,
      type: 'organization',
      status: 'active',
      name: S,
      firstName: S,
      lastName: S,
      middleName: S,
      namePrefix: S,
      nameSuffix: S,
      organizationName: S,
      credential: S,
      sex: S,
      soleProprietor: S,
      organizationalSubpart: S,
      authorizedOfficial: {
        firstName: S,
        lastName: S,
        middleName: S,
        namePrefix: S,
        nameSuffix: S,
        credential: S,
        title: S,
        telephoneNumber: S,
      },
      enumerationDate: S,
      lastUpdated: S,
      certificationDate: S,
      createdEpoch: 1373654494000,
      lastUpdatedEpoch: 1767735851000,
      taxonomies: [
        { code: S, description: S, primary: true, license: S, state: S, taxonomyGroup: S },
        { code: S, description: S, descriptionSource: 'nucc', primary: false },
        { code: S, primary: false },
      ],
      addresses: [ADDRESS, { purpose: S, line1: S }],
      practiceLocations: [ADDRESS],
      identifiers: [
        { code: S, description: S, identifier: S, issuer: S, state: S },
        { code: S, identifier: S },
        { identifier: S },
      ],
      otherNames: [
        {
          type: S,
          firstName: S,
          middleName: S,
          lastName: S,
          prefix: S,
          suffix: S,
          organizationName: S,
          credential: S,
        },
        { lastName: S },
      ],
      endpoints: [
        {
          endpoint: S,
          endpointType: S,
          endpointTypeDescription: S,
          endpointDescription: S,
          use: S,
          useDescription: S,
          useOtherDescription: S,
          contentType: S,
          contentTypeDescription: S,
          contentOtherDescription: S,
          affiliation: S,
          affiliationName: S,
          addressType: S,
          line1: S,
          line2: S,
          city: S,
          state: S,
          postalCode: S,
          countryCode: S,
          countryName: S,
        },
        { endpoint: S, addressType: S },
        { endpoint: S },
      ],
    },
    {
      npi: S,
      type: 'individual',
      status: 'deactivated',
      name: S,
      taxonomies: [],
      addresses: [],
      practiceLocations: [],
      identifiers: [],
      otherNames: [],
      endpoints: [],
    },
  ],
  notFound: [{ npi: S, reason: S }],
  errored: [{ npi: S, reason: S }],
  invalid: [{ npi: S, reason: S }],
  unprocessed: [S, S],
};

const SEARCH_OUTPUT: SearchOutput = {
  providers: [
    {
      npi: S,
      type: 'organization',
      name: S,
      credential: S,
      authorizedOfficial: { name: S, title: S },
      primaryTaxonomy: { code: S, description: S, descriptionSource: 'nucc' },
      city: S,
      state: S,
      postalCode: S,
      matchedLocation: { city: S, state: S, postalCode: S },
      matchedOtherName: { name: S, type: S },
      matchedTaxonomy: { code: S, description: S },
      status: 'active',
    },
    {
      npi: S,
      type: 'individual',
      name: S,
      authorizedOfficial: { name: S },
      primaryTaxonomy: { code: S },
      state: S,
      matchedLocation: { postalCode: S },
      matchedOtherName: { name: S },
      status: 'deactivated',
    },
  ],
};

const ENTRY = {
  code: S,
  grouping: S,
  classification: S,
  specialization: S,
  displayName: S,
  definition: S,
  section: 'Individual',
  status: 'inactive',
  replacedBy: S,
} as const;

/** The three `npi_lookup_taxonomy` layouts: one get entry, a browse first page, and an empty page. */
const LOOKUP_OUTPUTS: Record<string, LookupOutput> = {
  get: { matches: [{ ...ENTRY, notes: S }] },
  browse: {
    groupings: [
      { name: S, count: 1 },
      { name: S, count: 2 },
    ],
    classifications: [{ name: S, count: 1 }],
    matches: [
      ENTRY,
      {
        code: S,
        grouping: S,
        classification: S,
        displayName: S,
        section: 'Non-Individual',
        status: 'active',
      },
    ],
  },
  empty: { groupings: [{ name: S, count: 3 }], matches: [] },
};

describe('format() Markdown read-back properties (#55)', () => {
  it('npi_get_provider reads back every string slot of a full record and each partition', () => {
    expect(slotCount(getProviderTool.output, GET_OUTPUT)).toBeGreaterThan(100);
    expect(assertReadBack(getProviderTool.output, GET_OUTPUT, renderGet, 0x4e504947)).toBe(RUNS);
  });

  it('npi_search_providers reads back every string slot of its provider rows', () => {
    expect(
      assertReadBack(searchProvidersTool.output, SEARCH_OUTPUT, renderSearch, 0x4e505352),
    ).toBe(RUNS);
  });

  it.each(Object.entries(LOOKUP_OUTPUTS))(
    'npi_lookup_taxonomy reads back every string slot of a %s layout',
    (_, template) => {
      expect(assertReadBack(lookupTaxonomyTool.output, template, renderLookup, 0x4e50544c)).toBe(
        RUNS,
      );
    },
  );

  it('the resolvedTaxonomies trailer reads back every resolved description and code', () => {
    const template: Resolved = [
      { code: S, description: S },
      { code: S, description: S },
      { code: S, description: S },
    ];
    expect(assertReadBack(resolvedSchema, template, renderResolved, 0x4e505254)).toBe(RUNS);
  });
});

describe('bundled NUCC read-back (#55)', () => {
  it('reads back every field of every bundled entry from npi_lookup_taxonomy mode get', async () => {
    const failing: string[] = [];
    let entries = 0;
    for (const { code } of TAXONOMY_ENTRIES) {
      const result = await runToolContract(lookupTaxonomyTool, { mode: 'get', code });
      const output = result.structuredContent as LookupOutput;
      expect(result.content).toEqual(lookupTaxonomyTool.format!(output));
      if (readBackMismatch(lookupTaxonomyTool.output, output, renderLookup)) failing.push(code);
      entries++;
    }
    expect(entries).toBe(TAXONOMY_ENTRIES.length);
    expect(entries).toBeGreaterThan(800);
    expect(failing).toEqual([]);
  });
});

/** A registry row for a search stub; `overrides` replaces its `basic` and adds fields. */
function searchRow(npi: number, postalCode: string, overrides: Record<string, unknown> = {}) {
  return {
    number: npi,
    enumeration_type: 'NPI-1',
    basic: { first_name: 'ALEX', last_name: 'SMITH', status: 'A' },
    taxonomies: [{ code: '207RC0000X', desc: 'Cardiovascular Disease', primary: true }],
    addresses: [
      { address_purpose: 'LOCATION', city: 'SEATTLE', state: 'WA', postal_code: postalCode },
    ],
    ...overrides,
  };
}

function stubSearch(results: unknown[]): void {
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

describe('npi_search_providers content[] through the tool contract (#55)', () => {
  it('reads back registry text in the rows and the resolved specialty trailer', async () => {
    stubSearch([
      searchRow(1720034424, '98101', {
        basic: {
          first_name: 'A*B*C',
          last_name: '[X](y) _Z_',
          credential: '<b>MD</b>',
          status: 'A',
        },
        taxonomies: [{ code: '207RC0000X', desc: 'Cardio &amp; x\n1', primary: true }],
      }),
    ]);
    const result = await runToolContract(searchProvidersTool, {
      taxonomy_description: '207RC0000X',
      state: 'WA',
    });
    expect(result.isError).not.toBe(true);
    const { providers, resolvedTaxonomies } = result.structuredContent as SearchOutput & {
      resolvedTaxonomies: Resolved;
    };
    expect(providers[0]?.name).toBe('A*B*C [X](y) _Z_');
    const [rows, trailer] = result.content.map((block) =>
      block.type === 'text' ? block.text : '',
    );
    expect(rows).toBe(renderSearch({ providers }));
    expect(readBackMismatch(searchProvidersTool.output, { providers }, renderSearch)).toBe(
      undefined,
    );
    expect(resolvedTaxonomies).toEqual([
      { code: '207RC0000X', description: 'Cardiovascular Disease' },
    ]);
    expect(trailer).toContain(renderResolved(resolvedTaxonomies));
    expect(readLines(rows ?? '')).toContain('A*B*C [X](y) _Z_, <b>MD</b>');
  });

  it('a non-numeric postal_code at the terminal window is not echoed into the notice', async () => {
    const postal = '<b>Z</b>';
    stubSearch(Array.from({ length: 200 }, (_, i) => searchRow(1000000000 + i, postal)));
    const result = await runToolContract(searchProvidersTool, {
      last_name: 'Smith',
      postal_code: postal,
      skip: 1000,
      limit: 200,
    });
    const structured = result.structuredContent as { notice?: string };
    const notice = structured.notice ?? '';
    expect(notice).toContain('No postal split remains: postal_code is not a numeric ZIP prefix.');
    expect(notice).not.toContain(postal);
    const text = textOf(result.content);
    // The notice blockquote reads back as the notice, with no raw HTML.
    expect(readLines(text)).toContain(notice);
    for (const preset of ['commonmark', 'gfm'] as const) {
      expect(
        readMarkdown(text, preset).filter((n) => n.kind === 'markup' && n.token.startsWith('html')),
      ).toEqual([]);
    }
  });
});
