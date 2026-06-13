/**
 * @fileoverview npi_lookup_taxonomy — offline NUCC Healthcare Provider Taxonomy
 * resolver and browser. Grounds the `specialty` filter the search tools accept.
 * @module mcp-server/tools/definitions/lookup-taxonomy.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
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
    section: z
      .enum(['Individual', 'Non-Individual'])
      .describe('NPI enumeration scope: Individual (NPI-1) or Non-Individual (NPI-2).'),
  })
  .describe('A single NUCC taxonomy entry.');

/** Map a domain entry to the output shape, omitting absent optional fields. */
function toEntry(e: TaxonomyEntry): z.infer<typeof EntrySchema> {
  return {
    code: e.code,
    grouping: e.grouping,
    classification: e.classification,
    ...(e.specialization ? { specialization: e.specialization } : {}),
    displayName: e.displayName,
    ...(e.definition ? { definition: e.definition } : {}),
    section: e.section,
  };
}

function renderEntry(e: z.infer<typeof EntrySchema>): string {
  const lines = [
    `### ${e.displayName}`,
    `**Code:** ${e.code} | **Section:** ${e.section} (${e.section === 'Individual' ? 'NPI-1' : 'NPI-2'})`,
    `**Hierarchy:** ${e.grouping} › ${e.classification}${e.specialization ? ` › ${e.specialization}` : ''}`,
  ];
  if (e.definition) lines.push(e.definition);
  return lines.join('\n');
}

export const lookupTaxonomyTool = tool('npi_lookup_taxonomy', {
  description:
    'Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses — fully offline (bundled). Mode `resolve` turns a plain-language specialty (e.g. "cardiologist", "heart doctor") into matching taxonomy codes and their canonical descriptions; mode `get` returns the full entry for an exact code; mode `browse` walks the hierarchy (grouping → classification → specialization), optionally filtered by grouping and by NPI section (Individual/NPI-1 vs Non-Individual/NPI-2). Grounding a plain-language specialty here before calling npi_search_providers ensures the correct taxonomy code is sent rather than returning nothing.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    mode: z
      .enum(['resolve', 'get', 'browse'])
      .describe(
        'resolve: plain term → codes. get: exact code → entry. browse: walk the hierarchy.',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'For mode "resolve": the plain-language specialty term to resolve (e.g. "pediatric cardiologist").',
      ),
    code: z
      .string()
      .optional()
      .describe('For mode "get": the exact NUCC taxonomy code (e.g. "207RC0000X").'),
    grouping: z
      .string()
      .optional()
      .describe(
        'For mode "browse": filter to a top-level grouping by case-insensitive substring (e.g. "physicians").',
      ),
    section: z
      .enum(['Individual', 'Non-Individual'])
      .optional()
      .describe(
        'For mode "browse": filter by NPI section — Individual (NPI-1) or Non-Individual (NPI-2).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Maximum entries to return for resolve/browse (1–50). Ignored for get.'),
  }),

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
      .describe('Guidance when nothing matched — suggests broadening or browsing the hierarchy.'),
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'A resolve query or get code matched no taxonomy entry.',
      recovery: 'Try a broader term, or use mode browse to walk groupings then classifications.',
    },
    {
      reason: 'missing_argument',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The required argument for the chosen mode was not provided (query for resolve, code for get).',
      recovery: 'Provide query for mode resolve, or code for mode get; browse needs neither.',
    },
  ],

  handler(input, ctx) {
    const taxonomy = getTaxonomyService();

    if (input.mode === 'get') {
      const code = input.code?.trim();
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
      return { matches: [toEntry(entry)] };
    }

    if (input.mode === 'resolve') {
      const query = input.query?.trim();
      if (!query) {
        throw ctx.fail('missing_argument', 'Mode "resolve" requires a `query`.', {
          ...ctx.recoveryFor('missing_argument'),
        });
      }
      // Fetch one past the cap to detect truncation honestly.
      const hits = taxonomy.resolve(query, input.limit + 1);
      if (hits.length === 0) {
        throw ctx.fail('no_match', `No taxonomy matched "${query}".`, {
          ...ctx.recoveryFor('no_match'),
        });
      }
      const matches = hits.slice(0, input.limit);
      if (hits.length > input.limit) {
        ctx.enrich.truncated({ shown: matches.length, cap: input.limit });
      }
      return { matches: matches.map(toEntry) };
    }

    // mode === 'browse'
    const hits = taxonomy.browse({
      ...(input.grouping ? { grouping: input.grouping } : {}),
      ...(input.section ? { section: input.section } : {}),
      limit: input.limit + 1,
    });
    const matches = hits.slice(0, input.limit);
    if (matches.length === 0) {
      ctx.enrich.notice(
        'No taxonomy entries matched the browse filters. Drop the grouping/section filter, or call mode browse with no filters to see all groupings.',
      );
    } else if (hits.length > input.limit) {
      ctx.enrich.truncated({ shown: matches.length, cap: input.limit });
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
