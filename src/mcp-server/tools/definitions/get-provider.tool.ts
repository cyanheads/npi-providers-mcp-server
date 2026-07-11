/**
 * @fileoverview npi_get_provider — fetch the complete NPPES record for one or more
 * NPIs (up to 10), fanning out one call per NPI with partial-success reporting.
 * @module mcp-server/tools/definitions/get-provider.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNppesService } from '@/services/nppes/nppes-service.js';
import type { ProviderRecord } from '@/services/nppes/types.js';

const NpiString = z
  .string()
  .regex(/^\d{10}$/, 'An NPI is exactly 10 digits.')
  .describe('A 10-digit National Provider Identifier.');

const TaxonomySchema = z
  .object({
    code: z.string().describe('Taxonomy code.'),
    description: z.string().optional().describe('Taxonomy description.'),
    primary: z.boolean().describe("Whether this is the provider's primary taxonomy."),
    license: z.string().optional().describe('License number for this taxonomy, when present.'),
    state: z.string().optional().describe('License state for this taxonomy, when present.'),
    taxonomyGroup: z.string().optional().describe('Taxonomy group, when present.'),
  })
  .describe('A taxonomy (specialty) on the record.');

const AddressSchema = z
  .object({
    purpose: z.string().optional().describe('Address purpose (LOCATION or MAILING).'),
    addressType: z.string().optional().describe('Address type (DOM domestic or FOR foreign).'),
    line1: z.string().optional().describe('Address line 1.'),
    line2: z.string().optional().describe('Address line 2.'),
    city: z.string().optional().describe('City.'),
    state: z.string().optional().describe('State.'),
    postalCode: z.string().optional().describe('Postal/ZIP code.'),
    countryCode: z.string().optional().describe('ISO country code.'),
    countryName: z.string().optional().describe('Country name.'),
    telephoneNumber: z.string().optional().describe('Telephone number, when present.'),
    faxNumber: z.string().optional().describe('Fax number, when present.'),
  })
  .describe('A practice or mailing address.');

const IdentifierSchema = z
  .object({
    code: z.string().optional().describe('Identifier type code.'),
    description: z.string().optional().describe('Identifier type description (e.g. "MEDICAID").'),
    identifier: z.string().describe('The secondary identifier value.'),
    issuer: z.string().optional().describe('Issuing organization, when present.'),
    state: z.string().optional().describe('Associated state, when present.'),
  })
  .describe('A secondary identifier (Medicaid, etc.).');

const OtherNameSchema = z
  .object({
    type: z.string().optional().describe('Other-name type (former name, DBA, etc.).'),
    firstName: z.string().optional().describe('First name, for individuals.'),
    middleName: z.string().optional().describe('Middle name, for individuals, when present.'),
    lastName: z.string().optional().describe('Last name, for individuals.'),
    prefix: z.string().optional().describe('Name prefix, when present.'),
    suffix: z.string().optional().describe('Name suffix, when present.'),
    organizationName: z.string().optional().describe('Organization name, for organizations.'),
    credential: z.string().optional().describe('Credential, when present.'),
  })
  .describe('A former or alternate name.');

const EndpointSchema = z
  .object({
    endpointType: z.string().optional().describe('Endpoint type code (e.g. "DIRECT", "FHIR").'),
    endpointTypeDescription: z.string().optional().describe('Endpoint type description.'),
    endpoint: z.string().describe('The endpoint URI/address.'),
    use: z.string().optional().describe('Endpoint use code (e.g. "HIE"), when present.'),
    useDescription: z.string().optional().describe('Endpoint use description, when present.'),
    contentType: z.string().optional().describe('Endpoint content type code, when present.'),
    contentTypeDescription: z
      .string()
      .optional()
      .describe('Endpoint content type description, when present.'),
    affiliation: z
      .string()
      .optional()
      .describe('Whether the endpoint is affiliated with an organization (Y/N), when present.'),
    affiliationName: z
      .string()
      .optional()
      .describe('Name of the affiliated organization, when present.'),
    addressType: z.string().optional().describe('Endpoint address type (DOM/FOR), when present.'),
    line1: z.string().optional().describe('Endpoint address line 1, when present.'),
    city: z.string().optional().describe('Endpoint city, when present.'),
    state: z.string().optional().describe('Endpoint state, when present.'),
    postalCode: z.string().optional().describe('Endpoint postal/ZIP code, when present.'),
    countryCode: z.string().optional().describe('Endpoint ISO country code, when present.'),
    countryName: z.string().optional().describe('Endpoint country name, when present.'),
  })
  .describe('A FHIR or Direct messaging endpoint with its routing address and context.');

const AuthorizedOfficialSchema = z
  .object({
    firstName: z.string().optional().describe('Authorized official first name.'),
    lastName: z.string().optional().describe('Authorized official last name.'),
    middleName: z.string().optional().describe('Authorized official middle name.'),
    namePrefix: z.string().optional().describe('Authorized official name prefix, when present.'),
    nameSuffix: z.string().optional().describe('Authorized official name suffix, when present.'),
    credential: z.string().optional().describe('Authorized official credential.'),
    title: z.string().optional().describe('Authorized official title or position.'),
    telephoneNumber: z.string().optional().describe('Authorized official telephone number.'),
  })
  .describe('The authorized official (organization records).');

const FullProviderRecordSchema = z
  .object({
    npi: z.string().describe('10-digit National Provider Identifier.'),
    type: z.enum(['individual', 'organization']).describe('Enumeration type (NPI-1 vs NPI-2).'),
    status: z
      .enum(['active', 'deactivated'])
      .describe('Registry status — never treat a deactivated NPI as current.'),
    name: z.string().describe('Assembled "First Last" or organization name.'),
    firstName: z.string().optional().describe('First name, for individuals.'),
    lastName: z.string().optional().describe('Last name, for individuals.'),
    middleName: z.string().optional().describe('Middle name, when present.'),
    namePrefix: z.string().optional().describe('Name prefix (e.g. "Dr."), when present.'),
    nameSuffix: z.string().optional().describe('Name suffix (e.g. "Jr."), when present.'),
    organizationName: z.string().optional().describe('Organization legal name, for organizations.'),
    credential: z.string().optional().describe('Credential (e.g. "MD"), when present.'),
    sex: z.string().optional().describe('Sex code, for individuals, when present.'),
    soleProprietor: z.string().optional().describe('Sole-proprietor flag (YES/NO), when present.'),
    organizationalSubpart: z
      .string()
      .optional()
      .describe('Organizational subpart flag, for organizations.'),
    authorizedOfficial: AuthorizedOfficialSchema.optional().describe(
      'Authorized official block, for organizations.',
    ),
    enumerationDate: z.string().optional().describe('Date the NPI was enumerated.'),
    lastUpdated: z.string().optional().describe('Date the record was last updated.'),
    certificationDate: z.string().optional().describe('Certification date, when present.'),
    createdEpoch: z
      .number()
      .optional()
      .describe('Record creation timestamp, epoch milliseconds, when present.'),
    lastUpdatedEpoch: z
      .number()
      .optional()
      .describe('Record last-update timestamp, epoch milliseconds, when present.'),
    taxonomies: z.array(TaxonomySchema).describe('All taxonomies (specialties) on the record.'),
    addresses: z.array(AddressSchema).describe('All practice and mailing addresses.'),
    practiceLocations: z
      .array(AddressSchema)
      .describe('Additional practice locations, when present.'),
    identifiers: z
      .array(IdentifierSchema)
      .describe('Secondary identifiers (Medicaid, etc.), when present.'),
    otherNames: z.array(OtherNameSchema).describe('Former / alternate names, when present.'),
    endpoints: z.array(EndpointSchema).describe('FHIR / Direct endpoints, when present.'),
  })
  .describe('A fully decoded NPPES provider record.');

/** Map a domain record to the output shape (domain already omits absent fields). */
function toFullRecord(r: ProviderRecord): z.infer<typeof FullProviderRecordSchema> {
  return r as z.infer<typeof FullProviderRecordSchema>;
}

function renderRecord(r: z.infer<typeof FullProviderRecordSchema>): string {
  const lines = [`## ${r.name}${r.credential ? `, ${r.credential}` : ''}`];
  lines.push(`**NPI:** ${r.npi} | **Type:** ${r.type} | **Status:** ${r.status}`);
  if (r.namePrefix || r.firstName || r.middleName || r.lastName || r.nameSuffix) {
    const full = [r.namePrefix, r.firstName, r.middleName, r.lastName, r.nameSuffix]
      .filter(Boolean)
      .join(' ');
    if (full) lines.push(`**Name:** ${full}`);
  }
  if (r.organizationName) lines.push(`**Organization:** ${r.organizationName}`);
  if (r.sex) lines.push(`**Sex:** ${r.sex}`);
  if (r.soleProprietor) lines.push(`**Sole proprietor:** ${r.soleProprietor}`);
  if (r.organizationalSubpart) lines.push(`**Organizational subpart:** ${r.organizationalSubpart}`);
  if (r.enumerationDate) lines.push(`**Enumerated:** ${r.enumerationDate}`);
  if (r.lastUpdated) lines.push(`**Last updated:** ${r.lastUpdated}`);
  if (r.certificationDate) lines.push(`**Certified:** ${r.certificationDate}`);
  if (r.createdEpoch !== undefined) lines.push(`**Created (epoch ms):** ${r.createdEpoch}`);
  if (r.lastUpdatedEpoch !== undefined)
    lines.push(`**Last updated (epoch ms):** ${r.lastUpdatedEpoch}`);

  if (r.authorizedOfficial) {
    const ao = r.authorizedOfficial;
    const name = [ao.namePrefix, ao.firstName, ao.middleName, ao.lastName, ao.nameSuffix]
      .filter(Boolean)
      .join(' ');
    const bits = [
      name && `**Name:** ${name}`,
      ao.credential && `**Credential:** ${ao.credential}`,
      ao.title && `**Title:** ${ao.title}`,
      ao.telephoneNumber && `**Phone:** ${ao.telephoneNumber}`,
    ].filter(Boolean);
    if (bits.length) lines.push(`\n**Authorized Official** — ${bits.join(' | ')}`);
  }

  if (r.taxonomies.length) {
    lines.push('\n**Taxonomies:**');
    for (const t of r.taxonomies) {
      const extra = [
        t.primary ? 'primary' : undefined,
        t.license && `license ${t.license}`,
        t.state && `state ${t.state}`,
        t.taxonomyGroup && `group ${t.taxonomyGroup}`,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- ${t.description ?? 'Unknown'} (${t.code})${extra ? ` — ${extra}` : ''}`);
    }
  }

  const renderAddrs = (label: string, addrs: typeof r.addresses) => {
    if (!addrs.length) return;
    lines.push(`\n**${label}:**`);
    for (const a of addrs) {
      const street = [a.line1, a.line2].filter(Boolean).join(', ');
      const cityLine = [a.city, a.state, a.postalCode].filter(Boolean).join(' ');
      const country = [a.countryName, a.countryCode ? `(${a.countryCode})` : undefined]
        .filter(Boolean)
        .join(' ');
      const meta = [
        a.addressType && `type ${a.addressType}`,
        a.telephoneNumber && `tel ${a.telephoneNumber}`,
        a.faxNumber && `fax ${a.faxNumber}`,
      ]
        .filter(Boolean)
        .join(', ');
      const head = a.purpose ?? 'ADDRESS';
      const body = [street, cityLine, country].filter(Boolean).join(', ');
      lines.push(`- ${head}: ${body}${meta ? ` — ${meta}` : ''}`);
    }
  };
  renderAddrs('Addresses', r.addresses);
  renderAddrs('Practice locations', r.practiceLocations);

  if (r.identifiers.length) {
    lines.push('\n**Identifiers:**');
    for (const i of r.identifiers) {
      const label = [i.description, i.code ? `[${i.code}]` : undefined].filter(Boolean).join(' ');
      const issuer = i.issuer ? ` — ${i.issuer}` : '';
      const state = i.state ? ` (${i.state})` : '';
      lines.push(`- ${label || 'ID'}: ${i.identifier}${issuer}${state}`);
    }
  }
  if (r.otherNames.length) {
    lines.push('\n**Other names:**');
    for (const n of r.otherNames) {
      const nm = [
        n.prefix,
        n.organizationName,
        n.firstName,
        n.middleName,
        n.lastName,
        n.suffix,
        n.credential,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`- ${nm || 'Unknown'}${n.type ? ` (${n.type})` : ''}`);
    }
  }
  if (r.endpoints.length) {
    lines.push('\n**Endpoints:**');
    for (const e of r.endpoints) {
      const meta = [
        e.endpointTypeDescription,
        e.endpointType,
        e.use && `use ${e.use}`,
        e.useDescription,
        e.contentType && `content ${e.contentType}`,
        e.contentTypeDescription,
        e.affiliation && `affiliation ${e.affiliation}`,
        e.affiliationName,
      ]
        .filter(Boolean)
        .join(' · ');
      const addr = [e.line1, e.city, e.state, e.postalCode].filter(Boolean).join(', ');
      const country = [e.countryName, e.countryCode ? `(${e.countryCode})` : undefined]
        .filter(Boolean)
        .join(' ');
      const loc = [addr, country].filter(Boolean).join(', ');
      const addrType = e.addressType ? ` [${e.addressType}]` : '';
      lines.push(`- ${e.endpoint}${meta ? ` — ${meta}` : ''}`);
      if (loc || addrType) lines.push(`  ${loc}${addrType}`);
    }
  }
  return lines.join('\n');
}

export const getProviderTool = tool('npi_get_provider', {
  description:
    'Fetch the complete NPPES record for one or more NPI numbers (up to 10 per call). Decodes an NPI from a claim, prescription, or another health data source into a fully populated provider profile: every taxonomy with its primary flag, license number and state; all practice and mailing addresses; credential, sex, sole-proprietor flag; enumeration and last-updated dates; active/deactivated status; secondary identifiers (Medicaid, etc.); and FHIR/Direct endpoints. The 10-digit NPI format is validated before any API call. Reports partial success: well-formed NPIs with no registry record (deactivated or never enumerated) land in notFound, while NPIs whose lookup hit an upstream error (registry unavailable, timeout) land in errored — kept distinct from confirmed misses — rather than failing the whole call.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_npi_format',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'An NPI is not exactly 10 digits (caught by the input schema before any API call).',
      recovery:
        'NPIs are exactly 10 digits — check the value; use npi_search_providers to find one by name.',
    },
    {
      reason: 'none_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Every requested NPI returned a confirmed no-record response — none failed with an upstream error (those surface as the underlying service/timeout error instead).',
      recovery:
        'Verify the NPI(s); deactivated or never-enumerated numbers return nothing. Search by name to confirm.',
    },
  ],

  input: z.object({
    npis: z
      .union([
        NpiString,
        z.array(NpiString).min(1).max(10).describe('An array of up to 10 ten-digit NPIs.'),
      ])
      .describe(
        'A single 10-digit NPI, or an array of up to 10. Each is validated as exactly 10 digits before any API call.',
      ),
  }),

  output: z.object({
    found: z
      .array(FullProviderRecordSchema)
      .describe('Fully decoded records for NPIs that resolved.'),
    notFound: z
      .array(
        z
          .object({
            npi: z.string().describe('The requested NPI with no record.'),
            reason: z.string().describe('Why it returned nothing (e.g. no registry record).'),
          })
          .describe('A requested NPI that returned no record.'),
      )
      .describe(
        'NPIs that were well-formed but returned no record (deactivated or never enumerated). A confirmed absence, not a failure.',
      ),
    errored: z
      .array(
        z
          .object({
            npi: z.string().describe('The requested NPI whose lookup failed operationally.'),
            reason: z
              .string()
              .describe('The upstream failure reason (service unavailable, timeout, etc.).'),
          })
          .describe('A requested NPI whose lookup failed with an upstream error.'),
      )
      .describe(
        'NPIs whose lookups failed with an upstream/transport error (service unavailable, timeout) — distinct from a confirmed miss in notFound. These are unresolved, not absent; retry them.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Number of provider records that resolved from the requested NPIs.'),
    notice: z.string().optional().describe('Guidance when some or all NPIs returned nothing.'),
  },

  async handler(input, ctx) {
    const npis = Array.isArray(input.npis) ? input.npis : [input.npis];
    // De-dupe while preserving order.
    const unique = [...new Set(npis)];
    const nppes = getNppesService();

    const settled = await Promise.allSettled(unique.map((npi) => nppes.getByNumber(npi, ctx)));

    const found: z.infer<typeof FullProviderRecordSchema>[] = [];
    const notFound: { npi: string; reason: string }[] = [];
    const errored: { npi: string; reason: string }[] = [];
    const failures: unknown[] = [];

    // Three-way partition. A fulfilled-null leg is a CONFIRMED absence (result_count 0);
    // a rejected leg is an OPERATIONAL failure (service unavailable / timeout / non-OK
    // status, already retried by the service). Never conflate the two: a failure reported
    // as "not found" would tell the caller to fix a valid NPI during an outage.
    for (const [idx, res] of settled.entries()) {
      const npi = unique[idx] as string;
      if (res.status === 'fulfilled') {
        if (res.value) found.push(toFullRecord(res.value));
        else notFound.push({ npi, reason: 'No record in the NPPES registry for this NPI.' });
      } else {
        errored.push({
          npi,
          reason: res.reason instanceof Error ? res.reason.message : String(res.reason),
        });
        failures.push(res.reason);
      }
    }

    if (found.length === 0) {
      // Any operational failure means we can't honestly claim the batch was absent —
      // surface the real upstream error (its code, reason, and recovery) instead of
      // none_found. Only when every miss is a confirmed absence do we throw none_found.
      if (failures.length > 0) throw failures[0];
      throw ctx.fail(
        'none_found',
        `None of the ${unique.length} requested NPI(s) returned a record.`,
        {
          ...ctx.recoveryFor('none_found'),
        },
      );
    }

    ctx.enrich.total(found.length);
    const notices: string[] = [];
    if (notFound.length > 0) {
      notices.push(
        `${notFound.length} of ${unique.length} NPI(s) returned no record — deactivated or never enumerated.`,
      );
    }
    if (errored.length > 0) {
      notices.push(
        `${errored.length} of ${unique.length} NPI(s) could not be reached due to an upstream error — unresolved, not absent; retry them.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(`${notices.join(' ')} Found ${found.length}.`);

    return { found, notFound, errored };
  },

  format: (result) => {
    const lines: string[] = [];
    if (result.found.length > 0) {
      for (const r of result.found) lines.push(renderRecord(r));
    }
    if (result.notFound.length > 0) {
      lines.push('\n## Not found');
      for (const nf of result.notFound) lines.push(`- **${nf.npi}**: ${nf.reason}`);
    }
    if (result.errored.length > 0) {
      lines.push('\n## Errored (upstream failure — unresolved, not absent; retry)');
      for (const e of result.errored) lines.push(`- **${e.npi}**: ${e.reason}`);
    }
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});
