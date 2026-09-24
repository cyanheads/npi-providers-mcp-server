/**
 * @fileoverview npi_search_providers — search the NPPES registry for individual
 * practitioners and organizations, with NUCC specialty resolution and honest
 * pagination disclosure.
 * @module mcp-server/tools/definitions/search-providers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNppesService } from '@/services/nppes/nppes-service.js';
import type { NppesSearchParams, ProviderLocation } from '@/services/nppes/types.js';
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

/**
 * Whether one location satisfies every requested field on its own: state and city
 * case-insensitively (rows are upstream-uppercase), postal code by ZIP/ZIP+4 prefix.
 * An empty request matches every location.
 */
function locationMatches(location: ProviderLocation, requested: ProviderLocation): boolean {
  if (requested.state && location.state?.toUpperCase() !== requested.state.toUpperCase()) {
    return false;
  }
  if (requested.city && location.city?.toUpperCase() !== requested.city.toUpperCase()) {
    return false;
  }
  if (requested.postalCode && !postalCodeMatches(location.postalCode, requested.postalCode)) {
    return false;
  }
  return true;
}

/** Render a location as `City, ST 12345`, omitting absent parts. */
function renderLocation(location: {
  city?: string | undefined;
  postalCode?: string | undefined;
  state?: string | undefined;
}): string {
  const cityState = [location.city, location.state].filter(Boolean).join(', ');
  return [cityState, location.postalCode].filter(Boolean).join(' ');
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
    city: z.string().optional().describe('Primary practice-location city when present.'),
    state: z.string().optional().describe('Primary practice-location state when present.'),
    postalCode: z
      .string()
      .optional()
      .describe('Primary practice-location postal/ZIP code when present.'),
    matchedLocation: z
      .object({
        city: z.string().optional().describe('City of the matching practice location.'),
        state: z.string().optional().describe('State of the matching practice location.'),
        postalCode: z
          .string()
          .optional()
          .describe('Postal/ZIP code of the matching practice location.'),
      })
      .optional()
      .describe(
        'The additional practice location that satisfied the requested city/state/postal_code. Present only when the primary practice location is elsewhere.',
      ),
    status: z
      .enum(['active', 'deactivated'])
      .describe('Registry status — never treat a deactivated NPI as current.'),
  })
  .describe('A compact provider row for disambiguation.');

export const searchProvidersTool = tool('npi_search_providers', {
  description:
    'Search the NPPES NPI registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. Plain-language specialty terms (e.g. "cardiologist", "pediatric cardiologist") resolve through the bundled NUCC taxonomy; the top match\'s specialization or classification becomes taxonomy_description, and all resolved candidates are returned in metadata. Location belongs in the dedicated city/state/postal_code inputs, not inside specialty. Each provider row includes the NPI, name, primary specialty, city/state/ZIP, type, and active/deactivated status; the NPI is the input for npi_get_provider when the full record is needed. At least one search criterion is required, and the registry rejects state-only searches. When city/state/postal_code are given, only practice addresses are searched, never mailing addresses: a provider is returned only when its primary practice location or one of its other practice locations matches all of them. A provider kept on another practice location names it in matchedLocation. The registry never reports a true match total and only the first 1200 matches are reachable, so broad queries are capped.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_search_criteria',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No effective search criterion was provided.',
      recovery:
        'Provide at least one of name, organization, specialty, or city — state alone is not accepted by the registry.',
    },
    {
      reason: 'conflicting_specialty',
      code: JsonRpcErrorCode.ValidationError,
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
      code: JsonRpcErrorCode.ValidationError,
      when: 'The registry returned a field error (e.g. wildcard under 2 characters, bad provider type).',
      recovery:
        'Read the field error; wildcards need at least 2 leading characters and state needs a companion filter.',
      // Raised by the NPPES service's Errors[]-on-200 mapping, not by this handler.
      thrownBy: 'service',
    },
  ],

  input: z.object({
    name_search: z
      .string()
      .optional()
      .describe(
        "One person's name. The first token becomes first_name and the last token becomes last_name; use first_name/last_name when middle names or multi-part surnames matter.",
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
        '2-letter state code (e.g. "WA"). The registry rejects state-only searches, so another criterion is required. A blank value is treated as omitted.',
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
              'Search-compatible NUCC specialization or classification for this candidate.',
            ),
        }),
      )
      .optional()
      .describe(
        'Taxonomy candidates ranked for the specialty term. The first candidate supplies appliedTaxonomyDescription; a different candidate can be selected through taxonomy_description.',
      ),
    appliedTaxonomyDescription: z
      .string()
      .optional()
      .describe('The exact NUCC specialization or classification used as the specialty filter.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the NPPES page contained at least cap providers before location constraints were applied; more may match even when shown is below cap.',
      ),
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
      // with their codes so alternate candidates remain selectable through
      // taxonomy_description.
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

    /**
     * The service asks NPPES for practice-address matches only (address_purpose=LOCATION),
     * which covers the primary LOCATION address and every practiceLocations[] entry.
     * This filter is the guarantee on top of it: keep a row only when one professional
     * location satisfies every requested field on its own, so requested fields split
     * across two locations, or any other row the registry returns without a matching
     * practice location, never reach the caller. Such drops are rare. A row kept on a
     * secondary practice location carries it as matchedLocation, so the primary
     * address is never the only location shown for it.
     */
    const requested: ProviderLocation = {
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(postalCode ? { postalCode } : {}),
    };
    const rawCount = providers.length;
    const providersInLocation = providers.flatMap(({ practiceLocations, ...row }) => {
      if (locationMatches(row, requested)) return [row];
      const matchedLocation = practiceLocations.find((l) => locationMatches(l, requested));
      return matchedLocation ? [{ ...row, matchedLocation }] : [];
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
      // Upstream matched, but no provider practices in the requested location. The
      // other criteria DID match, so don't emit the generic broaden notice.
      noticeParts.push(
        `${rawCount} provider(s) matched but none were in the requested location: no provider's practice location matches every requested location field on its own. Broaden or drop the location.`,
      );
    } else {
      if (filteredOut > 0) {
        noticeParts.push(
          `${filteredOut} out-of-location row(s) the registry returned were filtered out: for each, no practice location matches every requested location field on its own.`,
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
      const location = renderLocation(p);
      if (location) lines.push(`**Location:** ${location}`);
      if (p.matchedLocation) {
        lines.push(`**Matched practice location:** ${renderLocation(p.matchedLocation)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
