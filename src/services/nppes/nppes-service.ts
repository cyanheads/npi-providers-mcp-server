/**
 * @fileoverview NPPES NPI Registry API v2.1 service — live provider directory
 * search and decode over the keyless CMS endpoint.
 * @module services/nppes/nppes-service
 *
 * The single biggest correctness trap of this API: validation failures come back
 * as **HTTP 200 with an `{"Errors":[…]}` body**, never a 4xx. This service inspects
 * every 200 for `Errors[]` and throws a typed, contract-mapped error (carrying
 * `data.reason` + `data.retryable: false` so `withRetry` fails fast). Genuine
 * transport failures (5xx, timeout) bubble from `fetchWithTimeout` as transient
 * codes and are retried. Normalization preserves upstream sparsity — never
 * fabricates a field the registry omitted.
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type {
  NppesSearchParams,
  ProviderRecord,
  ProviderStatus,
  ProviderSummary,
  ProviderType,
  RawNppesError,
  RawNppesResponse,
  RawNppesResult,
} from './types.js';

/** Maps an NPPES `Errors[]` field code to a tool contract reason. See API Reference in docs/design.md. */
function reasonForErrorNumber(number: string | undefined): string {
  switch (number) {
    case '04': // No valid search criteria
      return 'no_search_criteria';
    case '06': // NPI not 10 digits
      return 'invalid_npi_format';
    default:
      // 03 (wildcard too short), 05 (bad field), 07 (field needs companion), and anything else.
      return 'invalid_search_field';
  }
}

/** Build a human-readable message from the API's `Errors[]` array. */
function describeErrors(errors: RawNppesError[]): string {
  return errors
    .map((e) => {
      const field = e.field ? ` (field: ${e.field})` : '';
      return `${e.description ?? 'Validation error'}${field}`;
    })
    .join('; ');
}

function trimmed(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Build a single-key partial that's present only when `value` is defined — the
 * `exactOptionalPropertyTypes`-honest way to assemble normalized records from
 * sparse upstream fields (omit absent keys, never set them to `undefined`).
 */
function field<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function normalizeStatus(status: string | undefined): ProviderStatus {
  return trimmed(status)?.toUpperCase() === 'A' ? 'active' : 'deactivated';
}

function normalizeType(enumerationType: string | undefined): ProviderType {
  return trimmed(enumerationType) === 'NPI-2' ? 'organization' : 'individual';
}

/** Assemble a display name from a raw result, preferring the `basic.name` org field. */
function assembleName(raw: RawNppesResult, type: ProviderType): string {
  const basic = raw.basic ?? {};
  if (type === 'organization') {
    return (
      trimmed(basic.organization_name) ?? trimmed(basic.name) ?? `NPI ${String(raw.number ?? '')}`
    );
  }
  const parts = [trimmed(basic.first_name), trimmed(basic.middle_name), trimmed(basic.last_name)];
  const assembled = parts.filter(Boolean).join(' ');
  return assembled || trimmed(basic.name) || `NPI ${String(raw.number ?? '')}`;
}

/** The `primary: true` taxonomy, falling back to the first taxonomy when none is flagged. */
function pickPrimaryTaxonomy(
  raw: RawNppesResult,
): { code: string; description?: string } | undefined {
  const taxes = raw.taxonomies ?? [];
  const primary = taxes.find((t) => t.primary) ?? taxes[0];
  const code = trimmed(primary?.code);
  if (!code) return;
  return { code, ...field('description', trimmed(primary?.desc)) };
}

export class NppesService {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Execute one NPPES search call. Inspects the 200 body for `Errors[]` and throws
   * a contract-mapped error on presence; otherwise returns the raw response.
   * Retry wraps the full fetch + parse + error-detect pipeline.
   */
  private call(
    query: Record<string, string | number>,
    ctx: Context,
    operation: string,
  ): Promise<RawNppesResponse> {
    const reqCtx = requestContextService.createRequestContext({
      operation,
      parentContext: { requestId: ctx.requestId, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) },
    });
    return withRetry(
      async () => {
        const url = new URL(`${this.baseUrl}/`);
        url.searchParams.set('version', '2.1');
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, String(value));
        }

        const response = await fetchWithTimeout(url, this.timeoutMs, reqCtx, {
          signal: ctx.signal,
        });
        const text = await response.text();

        // Guard against an HTML error page masquerading as a 200 (rare; classify as transient).
        if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'NPPES returned HTML instead of JSON — the registry may be degraded.',
          );
        }

        let parsed: RawNppesResponse;
        try {
          parsed = JSON.parse(text) as RawNppesResponse;
        } catch (cause) {
          // Inside withRetry: a parse failure on a 200 may be a transient blip.
          throw serviceUnavailable('Failed to parse NPPES response as JSON.', undefined, {
            cause,
          });
        }

        if (parsed.Errors && parsed.Errors.length > 0) {
          this.throwForErrors(parsed.Errors, ctx);
        }
        return parsed;
      },
      {
        operation,
        context: reqCtx,
        baseDelayMs: 500, // CMS API is fast and generous; ephemeral failures dominate.
        signal: ctx.signal,
      },
    );
  }

  /**
   * Map an `Errors[]` body to a typed throw. All three field-error reasons
   * (`no_search_criteria`, `invalid_npi_format`, `invalid_search_field`) are
   * `InvalidParams`; the distinction is carried in `data.reason` for the contract.
   * Deterministic — `retryable: false` so `withRetry` fails fast.
   */
  private throwForErrors(errors: RawNppesError[], ctx: Context): never {
    const reason = reasonForErrorNumber(errors[0]?.number);
    throw invalidParams(describeErrors(errors), {
      reason,
      retryable: false,
      ...ctx.recoveryFor(reason),
    });
  }

  /**
   * Search the registry. Returns compact summary rows for disambiguation.
   * The caller has already validated criteria and resolved any specialty term.
   */
  async search(params: NppesSearchParams, ctx: Context): Promise<ProviderSummary[]> {
    const query: Record<string, string | number> = {
      limit: params.limit,
      skip: params.skip,
    };
    if (params.enumerationType) query.enumeration_type = params.enumerationType;
    if (params.firstName) query.first_name = params.firstName;
    if (params.lastName) query.last_name = params.lastName;
    if (params.organizationName) query.organization_name = params.organizationName;
    if (params.taxonomyDescription) query.taxonomy_description = params.taxonomyDescription;
    if (params.city) query.city = params.city;
    if (params.state) query.state = params.state;
    if (params.postalCode) query.postal_code = params.postalCode;

    const response = await this.call(query, ctx, 'nppes.search');
    return (response.results ?? []).map((raw) => this.normalizeSummary(raw));
  }

  /**
   * Fetch a single provider by NPI. Returns the decoded record, or `null` when the
   * NPI is well-formed but has no registry record (`result_count: 0`).
   */
  async getByNumber(npi: string, ctx: Context): Promise<ProviderRecord | null> {
    const response = await this.call({ number: npi }, ctx, 'nppes.getByNumber');
    const raw = (response.results ?? [])[0];
    return raw ? this.normalizeRecord(raw) : null;
  }

  /** Normalize a raw result into a compact summary row. */
  private normalizeSummary(raw: RawNppesResult): ProviderSummary {
    const type = normalizeType(raw.enumeration_type);
    const primaryAddress =
      (raw.addresses ?? []).find((a) => trimmed(a.address_purpose)?.toUpperCase() === 'LOCATION') ??
      (raw.addresses ?? [])[0];
    return {
      npi: String(raw.number ?? ''),
      type,
      status: normalizeStatus(raw.basic?.status),
      name: assembleName(raw, type),
      ...field('credential', trimmed(raw.basic?.credential)),
      ...field('primaryTaxonomy', pickPrimaryTaxonomy(raw)),
      ...field('city', trimmed(primaryAddress?.city)),
      ...field('state', trimmed(primaryAddress?.state)),
    };
  }

  /** Normalize a raw result into a fully decoded provider record (curate-nothing fidelity). */
  private normalizeRecord(raw: RawNppesResult): ProviderRecord {
    const type = normalizeType(raw.enumeration_type);
    const basic = raw.basic ?? {};

    const authorizedOfficial =
      type === 'organization' ? this.normalizeAuthorizedOfficial(basic) : undefined;

    const record: ProviderRecord = {
      npi: String(raw.number ?? ''),
      type,
      status: normalizeStatus(basic.status),
      name: assembleName(raw, type),
      taxonomies: (raw.taxonomies ?? []).map((t) => ({
        code: trimmed(t.code) ?? '',
        ...field('description', trimmed(t.desc)),
        primary: t.primary === true,
        ...field('license', trimmed(t.license)),
        ...field('state', trimmed(t.state)),
        ...field('taxonomyGroup', trimmed(t.taxonomy_group)),
      })),
      addresses: (raw.addresses ?? []).map((a) => this.normalizeAddress(a)),
      practiceLocations: (raw.practiceLocations ?? []).map((a) => this.normalizeAddress(a)),
      identifiers: (raw.identifiers ?? [])
        .map((i) => ({ identifier: trimmed(i.identifier), raw: i }))
        .filter((x): x is { identifier: string; raw: typeof x.raw } => x.identifier !== undefined)
        .map(({ identifier, raw: i }) => ({
          identifier,
          ...field('code', trimmed(i.code)),
          ...field('description', trimmed(i.desc)),
          ...field('issuer', trimmed(i.issuer)),
          ...field('state', trimmed(i.state)),
        })),
      otherNames: (raw.other_names ?? []).map((n) => ({
        ...field('type', trimmed(n.type)),
        ...field('firstName', trimmed(n.first_name)),
        ...field('lastName', trimmed(n.last_name)),
        ...field('organizationName', trimmed(n.organization_name)),
        ...field('credential', trimmed(n.credential)),
      })),
      endpoints: (raw.endpoints ?? [])
        .map((e) => ({ endpoint: trimmed(e.endpoint), raw: e }))
        .filter((x): x is { endpoint: string; raw: typeof x.raw } => x.endpoint !== undefined)
        .map(({ endpoint, raw: e }) => ({
          endpoint,
          ...field('endpointType', trimmed(e.endpointType)),
          ...field('endpointTypeDescription', trimmed(e.endpointTypeDescription)),
          ...field('use', trimmed(e.use)),
          ...field('contentType', trimmed(e.contentType)),
        })),
    };

    // Individual name parts
    const firstName = trimmed(basic.first_name);
    const lastName = trimmed(basic.last_name);
    const middleName = trimmed(basic.middle_name);
    const namePrefix = trimmed(basic.name_prefix);
    const nameSuffix = trimmed(basic.name_suffix);
    const organizationName = trimmed(basic.organization_name);
    const credential = trimmed(basic.credential);
    const sex = trimmed(basic.sex);
    const soleProprietor = trimmed(basic.sole_proprietor);
    const organizationalSubpart = trimmed(basic.organizational_subpart);
    const enumerationDate = trimmed(basic.enumeration_date);
    const lastUpdated = trimmed(basic.last_updated);
    const certificationDate = trimmed(basic.certification_date);

    if (firstName) record.firstName = firstName;
    if (lastName) record.lastName = lastName;
    if (middleName) record.middleName = middleName;
    if (namePrefix) record.namePrefix = namePrefix;
    if (nameSuffix) record.nameSuffix = nameSuffix;
    if (organizationName) record.organizationName = organizationName;
    if (credential) record.credential = credential;
    if (sex) record.sex = sex;
    if (soleProprietor) record.soleProprietor = soleProprietor;
    if (organizationalSubpart) record.organizationalSubpart = organizationalSubpart;
    if (authorizedOfficial) record.authorizedOfficial = authorizedOfficial;
    if (enumerationDate) record.enumerationDate = enumerationDate;
    if (lastUpdated) record.lastUpdated = lastUpdated;
    if (certificationDate) record.certificationDate = certificationDate;

    return record;
  }

  private normalizeAuthorizedOfficial(basic: NonNullable<RawNppesResult['basic']>) {
    const firstName = trimmed(basic.authorized_official_first_name);
    const lastName = trimmed(basic.authorized_official_last_name);
    const middleName = trimmed(basic.authorized_official_middle_name);
    const credential = trimmed(basic.authorized_official_credential);
    const title = trimmed(basic.authorized_official_title_or_position);
    const telephoneNumber = trimmed(basic.authorized_official_telephone_number);
    if (!firstName && !lastName && !title && !telephoneNumber) return;
    return {
      ...field('firstName', firstName),
      ...field('lastName', lastName),
      ...field('middleName', middleName),
      ...field('credential', credential),
      ...field('title', title),
      ...field('telephoneNumber', telephoneNumber),
    };
  }

  private normalizeAddress(a: NonNullable<RawNppesResult['addresses']>[number]) {
    return {
      ...field('purpose', trimmed(a.address_purpose)),
      ...field('addressType', trimmed(a.address_type)),
      ...field('line1', trimmed(a.address_1)),
      ...field('line2', trimmed(a.address_2)),
      ...field('city', trimmed(a.city)),
      ...field('state', trimmed(a.state)),
      ...field('postalCode', trimmed(a.postal_code)),
      ...field('countryCode', trimmed(a.country_code)),
      ...field('countryName', trimmed(a.country_name)),
      ...field('telephoneNumber', trimmed(a.telephone_number)),
      ...field('faxNumber', trimmed(a.fax_number)),
    };
  }
}

// --- Init / accessor pattern ---

let _service: NppesService | undefined;

/** Initialize the NPPES service. Call from `setup()` in createApp. */
export function initNppesService(): void {
  const config = getServerConfig();
  _service = new NppesService(config.apiBaseUrl, config.timeoutMs);
}

/** Get the initialized NPPES service. Throws if not initialized. */
export function getNppesService(): NppesService {
  if (!_service) {
    throw new Error('NppesService not initialized — call initNppesService() in setup()');
  }
  return _service;
}
