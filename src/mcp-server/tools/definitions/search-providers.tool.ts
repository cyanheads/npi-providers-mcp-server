/**
 * @fileoverview npi_search_providers — search the NPPES registry for individual
 * practitioners and organizations, with NUCC specialty resolution and honest
 * pagination disclosure.
 * @module mcp-server/tools/definitions/search-providers.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { MAX_LIMIT, MAX_SKIP, nextPage, postalContinuation } from '@/mcp-server/search-window.js';
import { getNppesService } from '@/services/nppes/nppes-service.js';
import type { NppesSearchParams, ProviderLocation } from '@/services/nppes/types.js';
import {
  describeInactiveEntries,
  getTaxonomyService,
  stopWordOnlyQuery,
  taxonomyDescriptionOf,
} from '@/services/taxonomy/taxonomy-service.js';
import { recordLimitClamp } from '@/utils/limit-clamp.js';

/** Heuristically split a single name string into first/last parts. */
function splitName(nameSearch: string): { firstName?: string; lastName?: string } {
  const parts = nameSearch.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { lastName: parts[0] as string };
  return { firstName: parts[0] as string, lastName: parts[parts.length - 1] as string };
}

/**
 * The postal_code to search, filter, and continue by: trimmed, blank as omitted, and
 * a hyphenated ZIP+4 (`98105-3901`) as its 9 digits — the registry rejects the hyphen.
 */
function normalizePostalCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  return /^\d{5}-\d{4}$/.test(trimmed) ? trimmed.replace('-', '') : trimmed;
}

/**
 * A digit-only postal_code the registry matches exactly: neither a 5-digit ZIP (which
 * it extends to its ZIP+4 codes) nor a 9-digit ZIP+4. It finds a non-US postcode
 * recorded with exactly those digits, never the US ZIPs that start with them.
 */
const EXACT_PARTIAL_ZIP = /^(?:\d{2,4}|\d{6,8})$/;

/** A postal_code with letters, which the registry matches for only some addresses recorded with it. */
const LETTERED_POSTAL_CODE = /[A-Za-z]/;

/**
 * Match a normalized row's postal code against the requested one, case-insensitively
 * (the registry stores some lettered codes in lowercase and returns them for an
 * uppercase request). A trailing-`*` request is a prefix the row's ZIP must start
 * with — as upstream, so a row recorded with only a 5-digit ZIP never matches a ZIP+4
 * prefix. An exact request tolerates the 5-digit vs 9-digit ZIP+4 split: the shorter
 * value must be a prefix of the longer.
 */
function postalCodeMatches(rowPostal: string | undefined, requested: string): boolean {
  const row = rowPostal?.trim().toUpperCase() ?? '';
  const req = requested.trim().toUpperCase();
  if (!row || !req) return false;
  if (req.endsWith('*')) return row.startsWith(req.slice(0, -1));
  return row.length <= req.length ? req.startsWith(row) : row.startsWith(req);
}

/** Match a row's city case-insensitively: equal, or starting with a trailing-`*` request. */
function cityMatches(rowCity: string | undefined, requested: string): boolean {
  const row = rowCity?.toUpperCase();
  const req = requested.toUpperCase();
  if (!row) return false;
  return req.endsWith('*') ? row.startsWith(req.slice(0, -1)) : row === req;
}

/**
 * Whether one location satisfies every requested field on its own, case-insensitively:
 * state and city by equality, postal code by ZIP/ZIP+4 prefix, and a trailing `*` on
 * city or postal code as a prefix. An empty request matches every location.
 */
function locationMatches(location: ProviderLocation, requested: ProviderLocation): boolean {
  if (requested.state && location.state?.toUpperCase() !== requested.state.toUpperCase()) {
    return false;
  }
  if (requested.city && !cityMatches(location.city, requested.city)) {
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

/** Render a taxonomy as `Description (code)`, naming a description filled from NUCC. */
function renderTaxonomy(taxonomy: {
  code: string;
  description?: string | undefined;
  descriptionSource?: 'nucc' | undefined;
}): string {
  const source = taxonomy.descriptionSource === 'nucc' ? '; description from NUCC' : '';
  return `${taxonomy.description ?? 'Unknown'} (${taxonomy.code}${source})`;
}

const TaxonomyReferenceSchema = z.object({
  code: z.string().describe('NUCC taxonomy code.'),
  description: z
    .string()
    .optional()
    .describe(
      'Description as the registry serves it ("Classification" or "Classification, Specialization"). When the registry serves none, the bundled NUCC text in the same form, marked by descriptionSource. Absent when neither has one.',
    ),
  descriptionSource: z
    .enum(['nucc'])
    .optional()
    .describe(
      '"nucc" when the registry served no description for this code and description comes from the bundled NUCC code set. Absent when the registry supplied it.',
    ),
});

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
    authorizedOfficial: z
      .object({
        name: z
          .string()
          .describe(
            'The official\'s name as "First Middle Last", leaving out parts the registry does not record. Prefix, suffix, credential, and telephone are on the npi_get_provider record.',
          ),
        title: z.string().optional().describe("The official's title or position, when recorded."),
      })
      .optional()
      .describe(
        'The organization\'s authorized official, whose name a name_role "authorized_official" search matched. Present only on the rows of such a search, when the registry records a first or last name for the official.',
      ),
    primaryTaxonomy: TaxonomyReferenceSchema.optional().describe(
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
    matchedOtherName: z
      .object({
        name: z
          .string()
          .describe('The other name as "First Middle Last", or its organization name.'),
        type: z
          .string()
          .optional()
          .describe('Registry name type, e.g. "Former Name", "Professional Name".'),
      })
      .optional()
      .describe(
        'The other (former, professional, DBA, or alternate) name this row matched the name search through. Present only when the current name fails a requested last_name, organization_name, or wildcard first_name and this other name satisfies it (case-insensitive, ignoring punctuation and spaces, trailing "*" as a prefix). An exact first_name alone never marks a row: the registry also matches first-name variants (Bob for Robert). Under name_role "authorized_official" only organization_name can mark a row, since the official\'s name is matched against the official alone.',
      ),
    matchedTaxonomy: TaxonomyReferenceSchema.optional().describe(
      "The taxonomy this row matched the specialty filter through: the first of its taxonomies whose classification or specialization starts with appliedTaxonomyDescription (case-insensitive, in the registry's wording), as the registry matches. Present only when primaryTaxonomy does not match and another taxonomy does. It names the taxonomy whose text matched, which need not be the code the specialty resolved to.",
    ),
    status: z
      .enum(['active', 'deactivated'])
      .describe('Registry status — never treat a deactivated NPI as current.'),
  })
  .describe('A compact provider row for disambiguation.');

/** Build the search definition with deployment-selected over-cap handling. */
export function createSearchProvidersTool(clampLimits: boolean) {
  return tool('npi_search_providers', {
    description:
      'Search the NPPES NPI registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. Plain-language specialty terms (e.g. "cardiologist", "pediatric cardiologist") resolve through the bundled NUCC taxonomy; the top match\'s search text becomes taxonomy_description, and all resolved candidates are returned in metadata. taxonomy_description also takes a NUCC code, such as one npi_get_provider returns, and searches with that code\'s text. Location belongs in the dedicated city/state/postal_code inputs, not inside specialty. Each provider row includes the NPI, name, primary specialty, city/state/ZIP, type, and active/deactivated status; the NPI is the input for npi_get_provider when the full record is needed. With name_role "authorized_official", first_name, last_name, and name_search match each organization\'s authorized official instead of the provider, the search covers organizations only, and each row names the official in authorizedOfficial. At least one search criterion is required, and the registry rejects state-only searches. When city/state/postal_code are given, only practice addresses are searched, never mailing addresses: a provider is returned only when its primary practice location or one of its other practice locations matches all of them. A provider kept on another practice location names it in matchedLocation. A specialty filter matches any of a provider\'s taxonomies, as a case-insensitive prefix of the taxonomy\'s classification or specialization; a row matched through a taxonomy other than its primary names it in matchedTaxonomy. Name searches also match former and other names, sorted by current name; such a row names the matching name in matchedOtherName. The registry never reports a true match total, and one search reaches only its first 1200 matches: a full page names the next in nextPage, and the terminal window (skip 1000, limit 200) returns continuationPostalCodes, postal_code prefixes that continue the search.',
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
          "Pass either specialty (plain-language, resolved) or taxonomy_description (a NUCC code or the registry's text), not both.",
      },
      {
        reason: 'mixed_provider_criteria',
        code: JsonRpcErrorCode.ValidationError,
        when: 'Individual criteria (first_name, last_name, name_search) were combined with organization criteria (organization_name), directly or through provider_type. Under name_role "authorized_official" the name fields and name_role are organization criteria.',
        recovery:
          'Keep one side: first_name, last_name, and name_search search individuals (organizations, under name_role "authorized_official"); organization_name searches organizations. Drop the other side, or set provider_type to match.',
      },
      {
        reason: 'official_name_required',
        code: JsonRpcErrorCode.ValidationError,
        when: 'name_role "authorized_official" was given without a first_name, last_name, or name_search to match the official by.',
        recovery:
          "Add the official's first_name or last_name (or name_search), or drop name_role to search by organization_name, specialty, or location alone.",
      },
      {
        reason: 'unresolved_specialty',
        code: JsonRpcErrorCode.NotFound,
        when: 'The specialty term matched no active NUCC taxonomy (the message names any inactive codes it matched), or was made only of generic words ("doctor", "M.D.", "specialist") that name no specialty; or taxonomy_description was a NUCC code the bundled set lacks or NUCC marks inactive (the message names an inactive code\'s replacement). No search is sent.',
        recovery:
          'Call npi_lookup_taxonomy mode resolve to find a valid specialty, or pass taxonomy_description directly.',
      },
      {
        reason: 'invalid_search_field',
        code: JsonRpcErrorCode.ValidationError,
        when: 'The registry returned a field error (e.g. wildcard under 2 characters, a postal_code with a space or the wrong number of digits, bad provider type). A postal_code error carries its own recovery naming the accepted forms.',
        recovery:
          'Read the field error; wildcards need at least 2 leading characters and state needs a companion filter.',
        // Raised by the NPPES service's Errors[]-on-200 mapping, not by this handler.
        thrownBy: 'service',
      },
      {
        reason: 'unmatched_taxonomy_description',
        code: JsonRpcErrorCode.ValidationError,
        when: 'The registry found no taxonomy for the description sent (its error 14): taxonomy_description, or the text a specialty resolved to, starts no classification or specialization in the registry\'s wording. The combined "Classification, Specialization" text never matches. When the text sent is the search text of a bundled NUCC code, the error carries its own recovery naming the broader classification to search, or a related one to browse for.',
        recovery:
          'Find the taxonomy with npi_lookup_taxonomy mode resolve and pass its code as taxonomy_description, or describe the specialty in plain language as specialty.',
        // Raised by the NPPES service's Errors[]-on-200 mapping (error 14), not by this handler.
        thrownBy: 'service',
      },
    ],

    input: z.object({
      name_search: z
        .string()
        .optional()
        .describe(
          "One person's name: the provider's, or the authorized official's under name_role \"authorized_official\". The first token becomes first_name and the last token becomes last_name; use first_name/last_name when middle names or multi-part surnames matter.",
        ),
      first_name: z
        .string()
        .optional()
        .describe(
          'Individual first name, or the authorized official\'s under name_role "authorized_official". Trailing wildcard "*" allowed with at least 2 leading characters.',
        ),
      last_name: z
        .string()
        .optional()
        .describe(
          'Individual last name, or the authorized official\'s under name_role "authorized_official". Trailing wildcard "*" allowed with at least 2 leading characters.',
        ),
      name_role: z
        .enum(['provider', 'authorized_official'])
        .optional()
        .describe(
          "Whose name first_name, last_name and name_search match: the provider's own (default) or an organization's authorized official. authorized_official searches organizations only and needs a first or last name.",
        ),
      use_first_name_alias: z
        .boolean()
        .optional()
        .describe(
          "Include first-name variants (default true upstream). False requests exact first-name matching. Applies to the resolved first_name, including name_search and an authorized official's first name, only without a wildcard; other-name matching remains enabled.",
        ),
      organization_name: z
        .string()
        .optional()
        .describe(
          'Organization name (implies provider_type organization; combines with first_name, last_name, or name_search only under name_role "authorized_official"). Trailing wildcard "*" allowed with at least 2 leading characters.',
        ),
      provider_type: z
        .enum(['individual', 'organization'])
        .optional()
        .describe(
          'Restrict to individuals (NPI-1) or organizations (NPI-2). Omit to search both; when set, it must match the name fields ("individual" for first_name/last_name/name_search, "organization" for organization_name or name_role "authorized_official").',
        ),
      specialty: z
        .string()
        .optional()
        .describe(
          'Plain-language specialty (e.g. "pediatric cardiologist"), resolved through the bundled NUCC taxonomy to exact descriptions before searching. Codes NUCC marks inactive are never resolved. The resolved taxonomy is echoed in the result. Mutually exclusive with taxonomy_description.',
        ),
      taxonomy_description: z
        .string()
        .optional()
        .describe(
          'A NUCC taxonomy code in any case (e.g. "207RC0000X", as npi_get_provider returns it) or taxonomy text. A code searches with that code\'s text, named in resolvedTaxonomies, and so does a NUCC display name such as "Cardiovascular Disease Physician" unless it is itself the start of a NUCC classification or specialization (e.g. "Critical Access Hospital"); a code the bundled NUCC set lacks or marks inactive is rejected before searching. Other text goes to the registry as written. The registry matches the text sent as a case-insensitive prefix of each taxonomy\'s classification or specialization, so a classification code (e.g. "207R00000X", Internal Medicine) also reaches its specializations. Mutually exclusive with specialty.',
        ),
      city: z
        .string()
        .regex(
          /^[^*]*$|^[^*]{2,}\*$/,
          'A city wildcard is at least 2 characters followed by one trailing "*" (e.g. "SAN F*").',
        )
        .optional()
        .describe(
          'Practice-location city, case-insensitive. A trailing "*" after at least 2 characters matches every city starting with them (e.g. "SAN F*").',
        ),
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
        .regex(
          /^[^*]*$|^\s*\d{2,9}\*\s*$/,
          'A postal_code wildcard is 2–9 digits followed by one trailing "*" (e.g. "98*", "981*").',
        )
        .optional()
        .describe(
          'Practice-location postal code: a 5-digit ZIP (also matching the ZIP+4 codes that extend it), a 9-digit ZIP+4 (ddddd-dddd accepted), or a 2–9 digit prefix with one trailing "*" (e.g. "98*", "981*"). Any other 2–4 or 6–8 digit string is matched exactly, as a non-US postcode is: "981" finds only an address recorded as exactly 981, and "981*" is the ZIP prefix. A ZIP+4 prefix (6+ digits) never matches a practice address recorded with only a 5-digit ZIP. A lettered postal code (Canadian, UK) matches only some providers recorded with it; search those by city. A blank value is treated as omitted.',
        ),
      limit: (clampLimits ? z.number().int().min(1) : z.number().int().min(1).max(200))
        .default(10)
        .describe(
          clampLimits
            ? 'Maximum providers to return (default 10). Values above 200 are clamped to the registry cap of 200 with a notice.'
            : 'Maximum providers to return (1–200; default 10).',
        ),
      skip: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(0)
        .describe(
          'Results to skip for pagination (0–1000). A full page names the next in nextPage.',
        ),
    }),

    output: z.object({
      providers: z.array(ProviderRowSchema).describe('Matching provider rows (up to limit).'),
    }),

    enrichment: {
      appliedFirstNameAlias: z
        .boolean()
        .optional()
        .describe(
          'Effective first-name alias expansion for a resolved non-wildcard first name, including the upstream default true. Absent when no first name exists or it contains a wildcard.',
        ),
      resolvedTaxonomies: z
        .array(
          z.object({
            code: z.string().describe('Resolved NUCC taxonomy code.'),
            description: z
              .string()
              .describe(
                "The text that searches the registry for this code: its specialization, else its classification, in the registry's wording where that differs from NUCC's.",
              ),
          }),
        )
        .optional()
        .describe(
          "The taxonomies the search resolved: candidates ranked for a specialty term, or the one code a taxonomy_description code or display name decoded to. The first supplies appliedTaxonomyDescription; pass another candidate's code as taxonomy_description to search it instead. Absent when taxonomy_description was sent as written.",
        ),
      appliedTaxonomyDescription: z
        .string()
        .optional()
        .describe(
          "The taxonomy_description text sent to the registry as the specialty filter: the first resolvedTaxonomies description, else the caller's taxonomy_description, trimmed.",
        ),
      truncated: z
        .boolean()
        .optional()
        .describe(
          'True when the NPPES page contained at least cap providers before location constraints were applied; more may match even when shown is below cap.',
        ),
      shown: z.number().optional().describe('Number of providers returned.'),
      cap: z.number().optional().describe('The limit that was applied.'),
      nextPage: z
        .object({
          skip: z.number().describe('The skip to send for the next page.'),
          limit: z.number().describe('The limit to send for the next page.'),
        })
        .optional()
        .describe(
          'The next page: re-run the same arguments with this skip and limit. Present after a full page while rows remain reachable. When skip + limit passes 1000 it is skip 1000, limit 200, whose leading rows repeat rows already returned (the notice says how many) — dedupe by NPI.',
        ),
      continuationPostalCodes: z
        .array(z.string().describe('A trailing-"*" postal_code prefix.'))
        .optional()
        .describe(
          'Present only at the terminal window (a full page at skip 1000, limit 200): postal_code prefixes that continue the same search, each re-run from skip 0 with the same arguments — the notice gives the full procedure. Empty when no postal split remains (postal_code is already a 5-digit ZIP, a full ZIP+4, or not a numeric ZIP prefix).',
        ),
      notice: z
        .string()
        .optional()
        .describe(
          'Guidance — the page-size-not-total caveat, the next page or terminal-window continuation procedure, other-name, matched-taxonomy, and location-filter counts, a lettered postal_code\'s partial matching, or how to broaden an empty result (for an exactly matched partial ZIP, its trailing-"*" form).',
        ),
    },

    enrichmentTrailer: {
      appliedFirstNameAlias: {
        render: (enabled) => (enabled === undefined ? '' : `**First-name aliases:** ${enabled}`),
      },
      resolvedTaxonomies: {
        render: (taxes) =>
          taxes && taxes.length > 0
            ? `**Resolved specialty →** ${taxes.map((t) => `${t.description} (${t.code})`).join(', ')}`
            : '',
      },
      nextPage: {
        render: (page) => (page ? `**Next page:** skip ${page.skip}, limit ${page.limit}` : ''),
      },
      continuationPostalCodes: {
        render: (codes) =>
          codes
            ? `**Continue with postal_code:** ${codes.length > 0 ? codes.join(', ') : 'none — no postal split remains'}`
            : '',
      },
    },

    async handler(input, ctx) {
      // Validate the specialty/taxonomy_description XOR before any work.
      if (input.specialty?.trim() && input.taxonomy_description?.trim()) {
        throw ctx.fail('conflicting_specialty');
      }

      /**
       * The registry rejects any mix of individual (NPI-1) and organization (NPI-2)
       * criteria with its error 13; name the conflicting fields before a request. Under
       * name_role "authorized_official" the name fields match organizations' officials,
       * so they leave the individual side and name_role stands for them on the other.
       */
      const officialSearch = input.name_role === 'authorized_official';
      const individualSide = [
        ...(officialSearch
          ? []
          : (['first_name', 'last_name', 'name_search'] as const).filter((f) => input[f]?.trim())),
        ...(input.provider_type === 'individual' ? ['provider_type "individual"'] : []),
      ];
      const organizationSide = [
        ...(input.organization_name?.trim() ? ['organization_name'] : []),
        ...(input.provider_type === 'organization' ? ['provider_type "organization"'] : []),
        ...(officialSearch ? ['name_role "authorized_official"'] : []),
      ];
      if (individualSide.length > 0 && organizationSide.length > 0) {
        const individual = individualSide.join(' and ');
        const organization = organizationSide.join(' and ');
        throw ctx.fail(
          'mixed_provider_criteria',
          `Individual and organization criteria can't be combined: ${individual} searches individuals (NPI-1), while ${organization} searches organizations (NPI-2).`,
          {
            recovery: {
              hint: `Keep one side: drop ${individual} to search organizations, or drop ${organization} to search individuals.`,
            },
          },
        );
      }

      // Derive name parts (explicit fields win over the convenience shortcut).
      const fromShortcut = input.name_search?.trim() ? splitName(input.name_search) : {};
      const firstName = input.first_name?.trim() || fromShortcut.firstName;
      const lastName = input.last_name?.trim() || fromShortcut.lastName;
      const organizationName = input.organization_name?.trim();

      // The registry refuses name_purpose=AO without a first or last name (its error 17).
      if (officialSearch && !firstName && !lastName) {
        throw ctx.fail(
          'official_name_required',
          'name_role "authorized_official" matches first_name, last_name, or name_search against each organization\'s authorized official, and none was given.',
        );
      }

      // Resolve specialty → taxonomy_description, or decode / pass through taxonomy_description.
      let taxonomyDescription: string | undefined;
      let resolvedTaxonomies: { code: string; description: string }[] | undefined;
      if (input.specialty?.trim()) {
        // "doctor", "M.D.", "specialist" alone name no specialty; point at browse.
        const stopWordsOnly = stopWordOnlyQuery(input.specialty);
        if (stopWordsOnly) {
          throw ctx.fail(
            'unresolved_specialty',
            `Specialty "${input.specialty}" names no specialty on its own.`,
            {
              recovery: {
                hint:
                  stopWordsOnly === 'physician'
                    ? 'Call npi_lookup_taxonomy mode browse with grouping "Allopathic & Osteopathic Physicians" to pick a physician specialty, or name one in specialty (e.g. "heart doctor").'
                    : 'Call npi_lookup_taxonomy mode browse to walk groupings then classifications, or name the specialty in specialty (e.g. "nurse specialist").',
              },
            },
          );
        }
        const taxonomy = getTaxonomyService();
        const { matches: hits, inactiveMatches } = taxonomy.resolveWithInactive(input.specialty, 5);
        if (hits.length === 0) {
          const inactive = describeInactiveEntries(inactiveMatches);
          throw ctx.fail(
            'unresolved_specialty',
            inactive
              ? `Specialty "${input.specialty}" matched no active NUCC taxonomy. It matched only codes NUCC marks inactive: ${inactive}.`
              : `Specialty "${input.specialty}" matched no NUCC taxonomy.`,
          );
        }
        /**
         * The NPPES API matches `taxonomy_description` as a case-insensitive prefix of a
         * taxonomy's classification or specialization, in its own wording — NOT the combined
         * description or the NUCC display name (which carries a "... Physician" suffix the
         * API rejects). Send the top match's search text (`taxonomyDescriptionOf`); echo all
         * candidates with their codes so alternate candidates remain selectable through
         * taxonomy_description.
         */
        resolvedTaxonomies = hits.map((h) => ({
          code: h.code,
          description: taxonomyDescriptionOf(h),
        }));
        taxonomyDescription = resolvedTaxonomies[0]?.description;
      } else if (input.taxonomy_description?.trim()) {
        /**
         * A NUCC code, or a display name that starts no bundled classification or
         * specialization, searches with the code's text exactly as a resolved specialty
         * does. An unknown or inactive code never becomes a search. Anything else goes to
         * the registry as written.
         */
        const decoded = getTaxonomyService().decodeTaxonomyDescription(input.taxonomy_description);
        if (decoded.kind === 'unknown_code') {
          throw ctx.fail(
            'unresolved_specialty',
            `taxonomy_description ${decoded.code} matches no code in the bundled NUCC taxonomy.`,
            {
              recovery: {
                hint: 'Check the code for a typo, or find a valid one with npi_lookup_taxonomy mode resolve or browse.',
              },
            },
          );
        }
        if (decoded.kind === 'inactive_code') {
          const { replacedBy } = decoded.entry;
          throw ctx.fail(
            'unresolved_specialty',
            `taxonomy_description names a code NUCC marks inactive: ${describeInactiveEntries([decoded.entry])}.`,
            {
              recovery: {
                hint: replacedBy
                  ? `Pass the replacement code ${replacedBy} as taxonomy_description, or find another active code with npi_lookup_taxonomy mode resolve or browse.`
                  : 'Find an active code with npi_lookup_taxonomy mode resolve or browse.',
              },
            },
          );
        }
        if (decoded.kind === 'decoded') {
          taxonomyDescription = decoded.taxonomyDescription;
          resolvedTaxonomies = [
            { code: decoded.entry.code, description: decoded.taxonomyDescription },
          ];
        } else {
          taxonomyDescription = decoded.text;
        }
      }

      // Provider type: explicit input, or implied by organization_name or an official search.
      let enumerationType: 'NPI-1' | 'NPI-2' | undefined;
      if (input.provider_type === 'individual') enumerationType = 'NPI-1';
      else if (input.provider_type === 'organization') enumerationType = 'NPI-2';
      else if (organizationName || officialSearch) enumerationType = 'NPI-2';

      const city = input.city?.trim();
      const state = input.state?.trim();
      const postalCode = normalizePostalCode(input.postal_code);

      // Mirror the API's "no valid search criteria" rule, and its state-only rejection,
      // before spending an upstream call.
      const hasCriterion = Boolean(
        firstName || lastName || organizationName || taxonomyDescription || city || postalCode,
      );
      if (!hasCriterion) {
        throw ctx.fail('no_search_criteria');
      }

      const limit = Math.min(input.limit, MAX_LIMIT);
      const clamped = limit !== input.limit;
      if (clamped)
        recordLimitClamp(ctx, {
          tool: 'npi_search_providers',
          requested: input.limit,
          applied: limit,
        });
      const params: NppesSearchParams = {
        limit,
        skip: input.skip,
        ...(enumerationType ? { enumerationType } : {}),
        ...(firstName ? { firstName } : {}),
        ...(input.use_first_name_alias !== undefined
          ? { useFirstNameAlias: input.use_first_name_alias }
          : {}),
        ...(lastName ? { lastName } : {}),
        ...(officialSearch ? { namePurpose: 'AO' as const } : {}),
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
      const aliasApplicable = Boolean(firstName && !firstName.includes('*'));
      if (aliasApplicable)
        ctx.enrich({ appliedFirstNameAlias: input.use_first_name_alias ?? true });

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
      const fullPage = rawCount >= limit;
      if (fullPage) {
        ctx.enrich.truncated({ shown: providersInLocation.length, cap: limit });
      }

      // ctx.enrich.notice is last-wins, so assemble one notice from fragments.
      const noticeParts: string[] = [];
      if (clamped)
        noticeParts.push(
          `Requested limit ${input.limit} was clamped to ${limit}, the registry's maximum page size.`,
        );
      if (input.use_first_name_alias !== undefined && !aliasApplicable)
        noticeParts.push(
          firstName
            ? 'use_first_name_alias is inapplicable because the resolved first_name contains a wildcard.'
            : 'use_first_name_alias is inapplicable because no first_name was resolved.',
        );
      const letteredPostalCode = Boolean(postalCode && LETTERED_POSTAL_CODE.test(postalCode));
      if (rawCount === 0) {
        if (input.skip > 0) {
          noticeParts.push(
            `No providers at skip ${input.skip}: this search's matches end before that offset — page back with a lower skip.`,
          );
        } else if (letteredPostalCode) {
          // The lettered-code notice below says why.
          noticeParts.push('No providers matched.');
        } else if (postalCode && EXACT_PARTIAL_ZIP.test(postalCode)) {
          noticeParts.push(
            `No providers matched. postal_code ${postalCode} was matched exactly, and no practice address is recorded with exactly that code — the registry extends only a 5-digit ZIP to the ZIP+4 codes that start with it. To match every ZIP starting with ${postalCode}, send postal_code ${postalCode}*.`,
          );
        } else {
          noticeParts.push(
            "No providers matched. The registry matches a specialty filter as a case-insensitive prefix of a taxonomy's classification or specialization, and rejects state-only searches — try broadening, verifying the specialty resolution, or pairing state with a name/city.",
          );
        }
      } else if (providersInLocation.length === 0) {
        // Upstream matched, but no provider practices in the requested location. The
        // other criteria DID match, so don't emit the generic broaden notice.
        noticeParts.push(
          `${rawCount} provider(s) matched but none were in the requested location: no provider's practice location matches every requested location field on its own. Broaden or drop the location.`,
        );
      } else if (filteredOut > 0) {
        noticeParts.push(
          `${filteredOut} out-of-location row(s) the registry returned were filtered out: for each, no practice location matches every requested location field on its own.`,
        );
      }
      if (letteredPostalCode) {
        noticeParts.push(
          'The postal_code contains letters, and the registry matches a lettered postal code for only some of the practice addresses recorded with it, so providers at this code can be missing. To reach them all, search by the practice city without postal_code; a non-US state is recorded inconsistently (e.g. "AB" or "ALBERTA"), so adding state can drop some.',
        );
      }

      const otherNameRows = providersInLocation.filter((p) => p.matchedOtherName).length;
      if (otherNameRows > 0) {
        noticeParts.push(
          `${otherNameRows} of ${providersInLocation.length} row(s) matched through an other name rather than the current name (see matchedOtherName). The registry sorts by current name, so other-name matches can fill pages ahead of current-name matches.`,
        );
      }

      const otherTaxonomyRows = providersInLocation.filter((p) => p.matchedTaxonomy).length;
      if (otherTaxonomyRows > 0) {
        noticeParts.push(
          `${otherTaxonomyRows} of ${providersInLocation.length} row(s) matched the specialty filter through a taxonomy other than their primary specialty (see matchedTaxonomy).`,
        );
      }

      if (fullPage) {
        noticeParts.push(
          'This page is full, and its size is not a grand total — the registry never reports the true match count, so at least this many match.',
        );
        const next = nextPage(input.skip, limit);
        if (next) {
          ctx.enrich({ nextPage: next });
          const repeated = input.skip + limit - MAX_SKIP;
          noticeParts.push(
            repeated > 0
              ? `More may match: the next reachable page is skip ${next.skip} with limit ${next.limit}, and its first ${repeated} row(s) repeat rows already returned — dedupe by NPI. Only the first 1200 matches of a search are reachable by skip.`
              : `More may match: the next page is skip ${next.skip} (limit ${next.limit}). Only the first 1200 matches of a search are reachable by skip.`,
          );
        } else {
          const continuation = postalContinuation(postalCode);
          const postalCodes = 'postalCodes' in continuation ? continuation.postalCodes : [];
          ctx.enrich({ continuationPostalCodes: postalCodes });
          noticeParts.push(
            'This is the terminal window: no further live-API page exists for this search, because only the first 1200 matches are reachable (skip max 1000, limit max 200).',
            'postalCodes' in continuation
              ? `To continue, re-run the same arguments once per postal_code in continuationPostalCodes (${postalCodes[0]} … ${postalCodes.at(-1)}, ${postalCodes.length} values), each starting at skip 0, and follow each one's nextPage until a response names none (a page the location filter trimmed below limit can still name one); split a value that returns its own continuationPostalCodes the same way. A provider with several practice locations can appear under more than one value — dedupe by NPI. Practice addresses whose postal code is blank or contains letters (most outside the US) are not reached this way, nor is a numeric postcode shorter than the prefixes being split (a 4-digit postcode once they reach 5 digits).`
              : `No postal split remains: ${continuation.deadEnd}. Narrowing by name, specialty, or provider_type reaches other subsets of this search but is not guaranteed to cover every match.`,
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
        if (p.authorizedOfficial) {
          const { name, title } = p.authorizedOfficial;
          lines.push(`**Authorized official:** ${name}${title ? ` (${title})` : ''}`);
        }
        if (p.primaryTaxonomy) {
          lines.push(`**Primary specialty:** ${renderTaxonomy(p.primaryTaxonomy)}`);
        }
        if (p.matchedTaxonomy) {
          lines.push(`**Matched specialty:** ${renderTaxonomy(p.matchedTaxonomy)}`);
        }
        const location = renderLocation(p);
        if (location) lines.push(`**Location:** ${location}`);
        if (p.matchedLocation) {
          lines.push(`**Matched practice location:** ${renderLocation(p.matchedLocation)}`);
        }
        if (p.matchedOtherName) {
          const { name, type } = p.matchedOtherName;
          lines.push(`**Matched other name:** ${name}${type ? ` (${type})` : ''}`);
        }
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  });
}

/** Canonical search definition with default limit clamping. */
export const searchProvidersTool = createSearchProvidersTool(true);
