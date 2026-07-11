/**
 * @fileoverview npi_search_providers — search the NPPES registry for individual
 * practitioners and organizations, with NUCC specialty resolution and honest
 * pagination disclosure.
 * @module mcp-server/tools/definitions/search-providers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNppesService } from '@/services/nppes/nppes-service.js';
import type { NppesSearchParams } from '@/services/nppes/types.js';
import { getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

/** Heuristically split a single name string into first/last parts. */
function splitName(nameSearch: string): { firstName?: string; lastName?: string } {
  const parts = nameSearch.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

/**
 * Match a normalized row's postal code against the requested one, tolerating the
 * 5-digit vs 9-digit ZIP+4 split: the shorter value must be a prefix of the longer.
 */
function postalCodeMatches(rowPostal: string | undefined, requested: string): boolean {
  const row = rowPostal?.trim() ?? '';
  const req = requested.trim();
  if (!row || !req) return false;
  return row.length <= req.length ? req.startsWith(row) : row.startsWith(req);
}

const ProviderRowSchema = z
  .object({
    npi: z
      .string()
      .describe('10-digit National Provider Identifier — the chaining key for npi_get_provider.'),
    type: z
      .enum(['individual', 'organization'])
      .describe('Provider enumeration type (NPI-1 vs NPI-2).'),
    name: z.string().describe('Assembled "First Last" (individual) or organization name.'),
    credential: z.string().optional().describe('Credential (e.g. "MD", "DO", "RN") when present.'),
    primaryTaxonomy: z
      .object({
        code: z.string().describe('Primary taxonomy code.'),
        description: z.string().optional().describe('Primary taxonomy description.'),
      })
      .optional()
      .describe(
        "The provider's primary taxonomy (the entry flagged primary, else the first listed).",
      ),
    city: z.string().optional().describe('Practice-location city when present.'),
    state: z.string().optional().describe('Practice-location state when present.'),
    postalCode: z.string().optional().describe('Practice-location postal/ZIP code when present.'),
    status: z
      .enum(['active', 'deactivated'])
      .describe('Registry status — never treat a deactivated NPI as current.'),
  })
  .describe('A compact provider row for disambiguation.');

export const searchProvidersTool = tool('npi_search_providers', {
  description:
    'Search the NPPES NPI registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. The specialty filter accepts plain-language terms (e.g. "cardiologist", "pediatric cardiologist") and resolves them through the bundled NUCC taxonomy to the registry\'s exact taxonomy descriptions before searching; the resolved taxonomy is echoed back so you can see what was actually searched. Pass location as the dedicated city/state/postal_code inputs, not inside specialty. Returns a compact row per provider — NPI, name, primary specialty, city/state/ZIP, type, and active/deactivated status — suitable for disambiguation; call npi_get_provider with an NPI for the full record. At least one search criterion is required, and the registry rejects state-only searches (pair state with another filter). The registry does not treat location as a hard filter for specialty searches, so location-constrained results are post-filtered server-side to the requested city/state/postal_code. The registry never reports a true match total and only the first 1200 matches are reachable, so broad queries are capped — narrow with more filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_search_criteria',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No effective search criterion was provided.',
      recovery:
        'Provide at least one of name, organization, specialty, or city — state alone is not accepted by the registry.',
    },
    {
      reason: 'conflicting_specialty',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both specialty and taxonomy_description were supplied.',
      recovery:
        'Pass either specialty (plain-language, resolved) or taxonomy_description (exact), not both.',
    },
    {
      reason: 'unresolved_specialty',
      code: JsonRpcErrorCode.NotFound,
      when: 'The specialty term matched no NUCC taxonomy.',
      recovery:
        'Call npi_lookup_taxonomy mode resolve to find a valid specialty, or pass taxonomy_description directly.',
    },
    {
      reason: 'invalid_search_field',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The registry returned a field error (e.g. wildcard under 2 characters, bad provider type).',
      recovery:
        'Read the field error; wildcards need at least 2 leading characters and state needs a companion filter.',
    },
  ],

  input: z.object({
    name_search: z
      .string()
      .optional()
      .describe(
        "Convenience shortcut: a single person's name, split into first/last heuristically. For precise control use first_name/last_name.",
      ),
    first_name: z
      .string()
      .optional()
      .describe(
        'Individual first name. Trailing wildcard "*" allowed with at least 2 leading characters.',
      ),
    last_name: z
      .string()
      .optional()
      .describe(
        'Individual last name. Trailing wildcard "*" allowed with at least 2 leading characters.',
      ),
    organization_name: z
      .string()
      .optional()
      .describe(
        'Organization name (implies provider_type organization). Trailing wildcard "*" allowed with at least 2 leading characters.',
      ),
    provider_type: z
      .enum(['individual', 'organization'])
      .optional()
      .describe('Restrict to individuals (NPI-1) or organizations (NPI-2). Omit to search both.'),
    specialty: z
      .string()
      .optional()
      .describe(
        'Plain-language specialty (e.g. "pediatric cardiologist"), resolved through the bundled NUCC taxonomy to exact descriptions before searching. The matched taxonomy is echoed in the result. Mutually exclusive with taxonomy_description.',
      ),
    taxonomy_description: z
      .string()
      .optional()
      .describe(
        'Exact NUCC taxonomy description for direct passthrough — use when the taxonomy description is already known. Mutually exclusive with specialty.',
      ),
    city: z.string().optional().describe('Practice-location city.'),
    state: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^[A-Z]{2}$/, 'State must be a 2-letter uppercase code (e.g. "WA").')
          .describe('2-letter state code (e.g. "WA").'),
      ])
      .optional()
      .describe(
        '2-letter state code (e.g. "WA"). The registry rejects state-only searches — pair it with another criterion. Blank values from form-based clients are treated as omitted.',
      ),
    postal_code: z
      .string()
      .optional()
      .describe('Practice-location postal/ZIP code (5 or 9 digits).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(10)
      .describe('Maximum providers to return (1–200; the registry caps at 200).'),
    skip: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(0)
      .describe(
        'Results to skip for pagination (0–1000). Only the first 1200 matches are reachable; skip beyond 1000 silently returns the same window — narrow the query instead of paging further.',
      ),
  }),

  output: z.object({
    providers: z.array(ProviderRowSchema).describe('Matching provider rows (up to limit).'),
  }),

  enrichment: {
    resolvedTaxonomies: z
      .array(
        z.object({
          code: z.string().describe('Resolved NUCC taxonomy code.'),
          description: z
            .string()
            .describe(
              'The taxonomy description (specialization or classification) the registry matched on — the value sent as taxonomy_description.',
            ),
        }),
      )
      .optional()
      .describe(
        'The taxonomy candidates the specialty term resolved to; the first was sent to the registry. Re-run with taxonomy_description to pick a different one.',
      ),
    appliedTaxonomyDescription: z
      .string()
      .optional()
      .describe(
        'The single taxonomy_description sent to the registry (from specialty resolution or the raw escape hatch).',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the returned page hit the limit — more may match.'),
    shown: z.number().optional().describe('Number of providers returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance — pagination ceiling, page-size-not-total caveat, or how to broaden an empty result.',
      ),
  },

  enrichmentTrailer: {
    resolvedTaxonomies: {
      render: (taxes) =>
        taxes && taxes.length > 0
          ? `**Resolved specialty →** ${taxes.map((t) => `${t.description} (${t.code})`).join(', ')}`
          : '',
    },
  },

  async handler(input, ctx) {
    // Validate the specialty/taxonomy_description XOR before any work.
    if (input.specialty?.trim() && input.taxonomy_description?.trim()) {
      throw ctx.fail('conflicting_specialty', undefined, {
        ...ctx.recoveryFor('conflicting_specialty'),
      });
    }

    // Resolve specialty → taxonomy_description, or take the raw escape hatch.
    let taxonomyDescription: string | undefined;
    let resolvedTaxonomies: { code: string; description: string }[] | undefined;
    if (input.specialty?.trim()) {
      const taxonomy = getTaxonomyService();
      const hits = taxonomy.resolve(input.specialty, 5);
      if (hits.length === 0) {
        throw ctx.fail(
          'unresolved_specialty',
          `Specialty "${input.specialty}" matched no NUCC taxonomy.`,
          { ...ctx.recoveryFor('unresolved_specialty') },
        );
      }
      // The NPPES API matches `taxonomy_description` against the taxonomy's
      // description (specialization, else classification) — NOT the NUCC display
      // name (which carries a "... Physician" suffix the API rejects). Resolve to
      // the API-accepted description and send the top match; echo all candidates
      // with their codes so the agent can re-run with a different taxonomy_description.
      resolvedTaxonomies = hits.map((h) => ({
        code: h.code,
        description: h.specialization ?? h.classification,
      }));
      taxonomyDescription = resolvedTaxonomies[0]?.description;
    } else if (input.taxonomy_description?.trim()) {
      taxonomyDescription = input.taxonomy_description.trim();
    }

    // Derive name parts (explicit fields win over the convenience shortcut).
    const fromShortcut = input.name_search?.trim() ? splitName(input.name_search) : {};
    const firstName = input.first_name?.trim() || fromShortcut.firstName;
    const lastName = input.last_name?.trim() || fromShortcut.lastName;
    const organizationName = input.organization_name?.trim();

    // Provider type: explicit input, or implied by organization_name.
    let enumerationType: 'NPI-1' | 'NPI-2' | undefined;
    if (input.provider_type === 'individual') enumerationType = 'NPI-1';
    else if (input.provider_type === 'organization') enumerationType = 'NPI-2';
    else if (organizationName) enumerationType = 'NPI-2';

    const city = input.city?.trim();
    const state = input.state?.trim();
    const postalCode = input.postal_code?.trim();

    // Mirror the API's "no valid search criteria" rule, and its state-only rejection,
    // before spending an upstream call.
    const hasCriterion = Boolean(
      firstName || lastName || organizationName || taxonomyDescription || city || postalCode,
    );
    if (!hasCriterion) {
      throw ctx.fail('no_search_criteria', undefined, { ...ctx.recoveryFor('no_search_criteria') });
    }

    const params: NppesSearchParams = {
      limit: input.limit,
      skip: input.skip,
      ...(enumerationType ? { enumerationType } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(organizationName ? { organizationName } : {}),
      ...(taxonomyDescription ? { taxonomyDescription } : {}),
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(postalCode ? { postalCode } : {}),
    };

    const providers = await getNppesService().search(params, ctx);

    // Surface what was actually searched.
    if (resolvedTaxonomies) ctx.enrich({ resolvedTaxonomies });
    if (taxonomyDescription) ctx.enrich({ appliedTaxonomyDescription: taxonomyDescription });

    // NPPES does not treat the requested city/state/postal_code as a hard filter
    // when taxonomy_description is present — it returns providers outside the
    // requested location. Post-filter the normalized rows by whichever location
    // fields the caller actually provided so out-of-location rows aren't presented
    // as matches. City compares case-insensitively (rows are upstream-uppercase);
    // postal_code prefix-matches to tolerate the 5-vs-9-digit ZIP+4 split.
    const rawCount = providers.length;
    const providersInLocation = providers.filter((p) => {
      if (state && p.state?.trim().toUpperCase() !== state.toUpperCase()) return false;
      if (city && p.city?.trim().toUpperCase() !== city.toUpperCase()) return false;
      if (postalCode && !postalCodeMatches(p.postalCode, postalCode)) return false;
      return true;
    });
    const filteredOut = rawCount - providersInLocation.length;

    // A full upstream page means more may match upstream regardless of how many
    // survived the location post-filter — key truncation on the raw page size so
    // post-filtering never hides a full page. `shown` reflects the kept rows.
    const fullPage = rawCount >= input.limit;
    if (fullPage) {
      ctx.enrich.truncated({ shown: providersInLocation.length, cap: input.limit });
    }

    // ctx.enrich.notice is last-wins, so assemble one notice from fragments.
    const noticeParts: string[] = [];
    if (rawCount === 0) {
      noticeParts.push(
        'No providers matched. The registry uses substring matching on specialty and rejects state-only searches — try broadening, verifying the specialty resolution, or pairing state with a name/city.',
      );
    } else if (providersInLocation.length === 0) {
      // Upstream matched the specialty but nothing in the requested location. The
      // specialty DID resolve and match, so don't emit the generic broaden notice.
      noticeParts.push(
        `${rawCount} provider(s) matched but none were in the requested location; the registry does not treat location as a hard filter for specialty searches. Broaden or drop the location, or pass taxonomy_description.`,
      );
    } else {
      if (filteredOut > 0) {
        noticeParts.push(
          `${filteredOut} out-of-location row(s) the registry returned were filtered out.`,
        );
      }
      if (fullPage) {
        noticeParts.push(
          'result_count is the returned page size, not a grand total — the registry never reports the true match count, so at least this many match. More may exist: page with skip (max 1000) or narrow with more filters. Only the first 1200 matches are reachable.',
        );
      }
    }
    if (noticeParts.length > 0) {
      ctx.enrich.notice(noticeParts.join(' '));
    }

    return { providers: providersInLocation };
  },

  format: (result) => {
    if (result.providers.length === 0) {
      return [{ type: 'text', text: 'No providers matched.' }];
    }
    const lines = [`## Providers (${result.providers.length})`];
    for (const p of result.providers) {
      lines.push(`\n### ${p.name}${p.credential ? `, ${p.credential}` : ''}`);
      lines.push(`**NPI:** ${p.npi} | **Type:** ${p.type} | **Status:** ${p.status}`);
      if (p.primaryTaxonomy) {
        lines.push(
          `**Primary specialty:** ${p.primaryTaxonomy.description ?? 'Unknown'} (${p.primaryTaxonomy.code})`,
        );
      }
      const loc = [p.city, p.state].filter(Boolean).join(', ');
      const locWithZip = [loc, p.postalCode].filter(Boolean).join(' ');
      if (locWithZip) lines.push(`**Location:** ${locWithZip}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
