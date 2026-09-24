/**
 * @fileoverview npi_lookup_taxonomy — offline NUCC Healthcare Provider Taxonomy
 * resolver and browser. Grounds the `specialty` filter the search tools accept.
 * @module mcp-server/tools/definitions/lookup-taxonomy.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  describeInactiveEntries,
  getTaxonomyService,
  stopWordOnlyQuery,
} from '@/services/taxonomy/taxonomy-service.js';
import type { TaxonomyEntry } from '@/services/taxonomy/types.js';

const EntrySchema = z
  .object({
    code: z.string().describe('NUCC taxonomy code, e.g. "207RC0000X".'),
    grouping: z
      .string()
      .describe('Top-level grouping, e.g. "Allopathic & Osteopathic Physicians".'),
    classification: z
      .string()
      .describe('Classification within the grouping, e.g. "Internal Medicine".'),
    specialization: z
      .string()
      .optional()
      .describe(
        'Specialization within the classification, e.g. "Cardiovascular Disease". Absent for top-level classification codes.',
      ),
    displayName: z
      .string()
      .describe('Human-readable display name, e.g. "Cardiovascular Disease Physician".'),
    definition: z
      .string()
      .optional()
      .describe('Scope note / definition. Absent for a handful of codes.'),
    notes: z
      .string()
      .optional()
      .describe(
        'NUCC Notes: sources, revision history, and status remarks. Returned by mode "get" only, when NUCC records a note.',
      ),
    section: z
      .enum(['Individual', 'Non-Individual'])
      .describe('NPI enumeration scope: Individual (NPI-1) or Non-Individual (NPI-2).'),
    status: z
      .enum(['active', 'inactive'])
      .describe(
        'NUCC status. Inactive codes are no longer maintained: mode "resolve" excludes them, while "get" and "browse" return them.',
      ),
    replacedBy: z
      .string()
      .optional()
      .describe('For an inactive code, the active replacement code NUCC names, when it names one.'),
  })
  .describe('A single NUCC taxonomy entry.');

/** Map a domain entry to the list-mode output shape (no notes), omitting absent optional fields. */
function toEntry(e: TaxonomyEntry): z.infer<typeof EntrySchema> {
  return {
    code: e.code,
    grouping: e.grouping,
    classification: e.classification,
    ...(e.specialization ? { specialization: e.specialization } : {}),
    displayName: e.displayName,
    ...(e.definition ? { definition: e.definition } : {}),
    section: e.section,
    status: e.status,
    ...(e.replacedBy ? { replacedBy: e.replacedBy } : {}),
  };
}

function renderEntry(e: z.infer<typeof EntrySchema>): string {
  const lines = [
    `### ${e.displayName}`,
    `**Code:** ${e.code} | **Section:** ${e.section} (${e.section === 'Individual' ? 'NPI-1' : 'NPI-2'}) | **Status:** ${e.status}${e.replacedBy ? ` (replaced by ${e.replacedBy})` : ''}`,
    `**Hierarchy:** ${e.grouping} › ${e.classification}${e.specialization ? ` › ${e.specialization}` : ''}`,
  ];
  if (e.definition) lines.push(e.definition);
  if (e.notes) lines.push(`**Notes:** ${e.notes}`);
  return lines.join('\n');
}

export const lookupTaxonomyTool = tool('npi_lookup_taxonomy', {
  description:
    'Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses — fully offline (bundled). Mode `resolve` turns a plain-language specialty (e.g. "cardiologist", "heart doctor") into matching active taxonomy entries, excluding codes NUCC marks inactive; mode `get` returns the full entry for an exact code, including NUCC\'s Notes; mode `browse` walks the hierarchy (grouping → classification → specialization), optionally filtered by grouping and by NPI section (Individual/NPI-1 vs Non-Individual/NPI-2). Every entry carries its status, and an inactive code names its replacement when NUCC gives one; `get` and `browse` still return inactive codes. A resolved entry\'s specialization, or its classification when specialization is absent, maps directly to npi_search_providers.taxonomy_description.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('resolve').describe('Resolve a plain-language specialty to taxonomy codes.'),
      query: z
        .string()
        .min(1)
        .describe('The plain-language specialty term to resolve, e.g. "pediatric cardiologist".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Maximum matching entries to return (1–50).'),
      skip: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          'Entries to skip before the page (0–1000). Keep the same query and limit, then raise skip by limit each call.',
        ),
    }),
    z.object({
      mode: z.literal('get').describe('Fetch one exact taxonomy entry by code.'),
      code: z.string().min(1).describe('The exact NUCC taxonomy code, e.g. "207RC0000X".'),
    }),
    z.object({
      mode: z.literal('browse').describe('Browse the taxonomy hierarchy.'),
      grouping: z
        .string()
        .optional()
        .describe(
          'Filter to a top-level grouping by case-insensitive substring, e.g. "physicians".',
        ),
      section: z
        .enum(['Individual', 'Non-Individual'])
        .optional()
        .describe('Filter by NPI section: Individual (NPI-1) or Non-Individual (NPI-2).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('Maximum entries to return (1–50).'),
      skip: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          'Entries to skip before the page (0–1000). Keep the same filters and limit, then raise skip by limit each call.',
        ),
    }),
  ]),

  output: z.object({
    matches: z
      .array(EntrySchema)
      .describe(
        'Matching taxonomy entries. For mode "get" this is the single requested entry; for "resolve"/"browse" it is the ranked/sorted matches up to limit.',
      ),
  }),

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe('True when the list was capped at `limit` (more entries may match).'),
    shown: z.number().optional().describe('Number of entries returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance — how to page a truncated result with skip, or how to broaden when nothing matched.',
      ),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'A get code matched no taxonomy entry, a resolve query matched no active one (the message names any inactive codes it matched), or a resolve query was made only of generic words ("doctor", "M.D.", "specialist") that name no specialty.',
      recovery: 'Try a broader term, or use mode browse to walk groupings then classifications.',
    },
    {
      reason: 'missing_argument',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The required query or code was present but blank after trimming.',
      recovery: 'Provide a non-blank query for resolve or taxonomy code for get.',
    },
  ],

  handler(input, ctx) {
    const taxonomy = getTaxonomyService();

    if (input.mode === 'get') {
      const code = input.code.trim();
      if (!code) {
        throw ctx.fail('missing_argument', 'Mode "get" requires a `code`.', {
          ...ctx.recoveryFor('missing_argument'),
        });
      }
      const entry = taxonomy.get(code);
      if (!entry) {
        throw ctx.fail('no_match', `No taxonomy entry for code "${code}".`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      return { matches: [{ ...toEntry(entry), ...(entry.notes ? { notes: entry.notes } : {}) }] };
    }

    if (input.mode === 'resolve') {
      const query = input.query.trim();
      if (!query) {
        throw ctx.fail('missing_argument', 'Mode "resolve" requires a `query`.', {
          ...ctx.recoveryFor('missing_argument'),
        });
      }
      // "doctor", "M.D.", "specialist" alone name no specialty; point at browse, not a bare miss.
      const stopWordsOnly = stopWordOnlyQuery(query);
      if (stopWordsOnly) {
        throw ctx.fail('no_match', `"${query}" names no specialty on its own.`, {
          recovery: {
            hint:
              stopWordsOnly === 'physician'
                ? 'Use mode browse with grouping "Allopathic & Osteopathic Physicians" to list physician specialties, or add the specialty to the query (e.g. "heart doctor").'
                : 'Use mode browse to walk groupings then classifications, or add the specialty to the query (e.g. "nurse specialist").',
          },
        });
      }
      // Fetch one past the cap to detect truncation honestly.
      const { matches: hits, inactiveMatches } = taxonomy.resolveWithInactive(
        query,
        input.limit + 1,
        input.skip,
      );
      if (hits.length === 0) {
        // A skip past the end of a real match set is an empty page, not a no-match.
        if (input.skip > 0) {
          ctx.enrich.notice(
            `No more matches beyond skip=${input.skip}. Lower skip, or omit it to page from the start.`,
          );
          return { matches: [] };
        }
        const inactive = describeInactiveEntries(inactiveMatches);
        if (inactive) {
          throw ctx.fail(
            'no_match',
            `No active taxonomy matched "${query}". It matched only codes NUCC marks inactive: ${inactive}.`,
            {
              recovery: {
                hint: 'Resolve excludes inactive codes. Use a named replacement code with mode get, read an inactive entry with mode get, or try a broader term.',
              },
            },
          );
        }
        throw ctx.fail('no_match', `No taxonomy matched "${query}".`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      const matches = hits.slice(0, input.limit);
      if (hits.length > input.limit) {
        ctx.enrich.truncated({
          shown: matches.length,
          cap: input.limit,
          guidance: `More matches beyond this page. Page forward with skip=${input.skip + input.limit} at the same limit, or refine the query.`,
        });
      }
      return { matches: matches.map(toEntry) };
    }

    // mode === 'browse'
    const hits = taxonomy.browse({
      ...(input.grouping ? { grouping: input.grouping } : {}),
      ...(input.section ? { section: input.section } : {}),
      limit: input.limit + 1,
      skip: input.skip,
    });
    const matches = hits.slice(0, input.limit);
    if (matches.length === 0) {
      ctx.enrich.notice(
        input.skip > 0
          ? `No more entries beyond skip=${input.skip}. Lower skip, or omit it to page from the start.`
          : 'No taxonomy entries matched the browse filters. Drop the grouping/section filter, or call mode browse with no filters to see all groupings.',
      );
    } else if (hits.length > input.limit) {
      ctx.enrich.truncated({
        shown: matches.length,
        cap: input.limit,
        guidance: `More entries beyond this page. Page forward with skip=${input.skip + input.limit} at the same limit, or filter by grouping/section.`,
      });
    }
    return { matches: matches.map(toEntry) };
  },

  format: (result) => {
    if (result.matches.length === 0) {
      return [{ type: 'text', text: 'No taxonomy entries matched.' }];
    }
    if (result.matches.length === 1) {
      return [
        { type: 'text', text: renderEntry(result.matches[0] as z.infer<typeof EntrySchema>) },
      ];
    }
    const lines = [`## Taxonomy matches (${result.matches.length})`];
    for (const m of result.matches) lines.push(renderEntry(m));
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
