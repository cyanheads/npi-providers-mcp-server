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
 * codes and are retried, and so does a structurally malformed 200 body (see
 * {@link validateResults}): it surfaces as `ServiceUnavailable`, never as a miss
 * or a defaulted identity. Normalization preserves upstream sparsity — never
 * fabricates a field the registry omitted.
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type {
  NppesSearchParams,
  ProviderLocation,
  ProviderRecord,
  ProviderStatus,
  ProviderSummary,
  ProviderType,
  RawEnumerationType,
  RawNppesAddress,
  RawNppesBasic,
  RawNppesError,
  RawNppesResult,
  RawStatusCode,
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
 * Trim like {@link trimmed}, then treat NPPES's `"--"` placeholder as absence.
 *
 * The registry uses the literal string `"--"` as a sentinel for an unset name
 * prefix/suffix. It is pervasive on individual `name_prefix`/`name_suffix`,
 * organization `authorized_official_name_prefix`/`_suffix`, and `other_names[]`
 * `prefix`/`suffix`. The match is exact — real values (`"Jr."`, `"Dr."`, `"Mr."`)
 * coexist in the same fields, so a broader heuristic would eat legitimate data.
 * Apply only to prefix/suffix-shaped fields; free-text fields (`credential`) never
 * carry the sentinel.
 */
function trimmedNonPlaceholder(v: string | null | undefined): string | undefined {
  const t = trimmed(v);
  return t === '--' ? undefined : t;
}

/** Coerce a raw epoch (`number | string`, milliseconds) to a finite number, or `undefined`. */
function epochNumber(v: number | string | undefined): number | undefined {
  const n = typeof v === 'number' ? v : Number(trimmed(v));
  return Number.isFinite(n) ? n : undefined;
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

/**
 * The many-field form of {@link field}: keep only the entries whose value is
 * defined. Chained `field()` spreads multiply into a union TypeScript cannot
 * represent past ~16 keys; this stays one mapped type.
 */
function presentFields<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

const STATUS_BY_CODE: Record<RawStatusCode, ProviderStatus> = { A: 'active', D: 'deactivated' };
const TYPE_BY_ENUMERATION: Record<RawEnumerationType, ProviderType> = {
  'NPI-1': 'individual',
  'NPI-2': 'organization',
};

/** The six `results[]` fields that must be arrays of objects when present and non-null. */
const ARRAY_FIELDS = [
  'taxonomies',
  'addresses',
  'practiceLocations',
  'identifiers',
  'other_names',
  'endpoints',
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A structurally malformed 200 body — transient, so `withRetry` retries it like unparseable JSON. */
function malformed(detail: string): never {
  throw serviceUnavailable(`NPPES returned a malformed response: ${detail}.`);
}

/**
 * Validate one `results[]` element: its identity fields, that each array field
 * holds only objects, and that every taxonomy carries a non-blank string `code` —
 * a taxonomy's identity, which normalization would otherwise fabricate as `""`.
 * That is all normalization needs to run without a native throw or an invented
 * value — every other scalar it reads goes through `trimmed()`/`epochNumber()`,
 * which turn a wrong-typed value into absence. Unrecognized keys pass through
 * untouched; the name is not required (the `NPI <number>` label covers it).
 */
function validateResult(raw: unknown, index: number): RawNppesResult {
  const at = `results[${index}]`;
  if (!isObject(raw)) malformed(`${at} is not an object`);
  const { number, enumeration_type, basic } = raw;
  if (
    (typeof number !== 'string' && typeof number !== 'number') ||
    !/^\d{10}$/.test(String(number))
  ) {
    malformed(`${at}.number is not a 10-digit NPI`);
  }
  if (enumeration_type !== 'NPI-1' && enumeration_type !== 'NPI-2') {
    malformed(`${at}.enumeration_type is not NPI-1 or NPI-2`);
  }
  if (!isObject(basic)) malformed(`${at}.basic is not an object`);
  if (basic.status !== 'A' && basic.status !== 'D') malformed(`${at}.basic.status is not A or D`);
  for (const key of ARRAY_FIELDS) {
    const value = raw[key];
    if (value == null) continue;
    if (!Array.isArray(value)) malformed(`${at}.${key} is not an array`);
    const bad = value.findIndex((element) => !isObject(element));
    if (bad !== -1) malformed(`${at}.${key}[${bad}] is not an object`);
  }
  const codeless = ((raw.taxonomies ?? []) as Record<string, unknown>[]).findIndex(
    (taxonomy) => typeof taxonomy.code !== 'string' || !trimmed(taxonomy.code),
  );
  if (codeless !== -1) malformed(`${at}.taxonomies[${codeless}].code is not a non-empty string`);
  return raw as unknown as RawNppesResult;
}

/**
 * Validate a parsed 200 body and return its results. A non-empty `Errors` array
 * is the registry's validation envelope, handed back for the typed mapping; any
 * other shape that isn't `{ results: [...] }` is malformed. Live success bodies
 * always carry a `results` array, zero hits included.
 */
function validateResults(
  parsed: unknown,
): { errors: RawNppesError[] } | { results: RawNppesResult[] } {
  if (!isObject(parsed)) malformed('the body is not a JSON object');
  if (parsed.Errors !== undefined) {
    const errors = parsed.Errors;
    if (!Array.isArray(errors) || errors.length === 0 || !errors.every(isObject)) {
      malformed('Errors is not a non-empty array of objects');
    }
    return { errors: errors as RawNppesError[] };
  }
  if (!Array.isArray(parsed.results)) malformed('results is missing or not an array');
  return { results: parsed.results.map(validateResult) };
}

function isPracticeLocation(address: RawNppesAddress): boolean {
  return trimmed(address.address_purpose)?.toUpperCase() === 'LOCATION';
}

/** The city/state/ZIP of an address, each present only when upstream supplied it. */
function cityStateZip(address: RawNppesAddress | undefined): ProviderLocation {
  return presentFields({
    city: trimmed(address?.city),
    state: trimmed(address?.state),
    postalCode: trimmed(address?.postal_code),
  });
}

/** Assemble a display name from a raw result, preferring the `basic.name` org field. */
function assembleName(raw: RawNppesResult, type: ProviderType): string {
  const basic = raw.basic;
  if (type === 'organization') {
    return trimmed(basic.organization_name) ?? trimmed(basic.name) ?? `NPI ${raw.number}`;
  }
  const parts = [trimmed(basic.first_name), trimmed(basic.middle_name), trimmed(basic.last_name)];
  const assembled = parts.filter(Boolean).join(' ');
  return assembled || trimmed(basic.name) || `NPI ${raw.number}`;
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
   * Execute one NPPES search call and return its validated results. A 200 body
   * carrying `Errors[]` throws a contract-mapped error; a structurally malformed
   * body throws `ServiceUnavailable`. Retry wraps the full fetch + parse + validate
   * pipeline, so a malformed body is retried before it surfaces.
   */
  private call(
    query: Record<string, string | number>,
    ctx: Context,
    operation: string,
  ): Promise<RawNppesResult[]> {
    return withRetry(
      async () => {
        const url = new URL(`${this.baseUrl}/`);
        url.searchParams.set('version', '2.1');
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, String(value));
        }

        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
          signal: ctx.signal,
        });
        const text = await response.text();

        // Guard against an HTML error page masquerading as a 200 (rare; classify as transient).
        if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(text)) {
          throw serviceUnavailable(
            'NPPES returned HTML instead of JSON — the registry may be degraded.',
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (cause) {
          // Inside withRetry: a parse failure on a 200 may be a transient blip.
          throw serviceUnavailable('Failed to parse NPPES response as JSON.', undefined, {
            cause,
          });
        }

        const validated = validateResults(parsed);
        if ('errors' in validated) this.throwForErrors(validated.errors, ctx);
        return validated.results;
      },
      {
        operation,
        context: ctx,
        baseDelayMs: 500, // CMS API is fast and generous; ephemeral failures dominate.
        signal: ctx.signal,
      },
    );
  }

  /**
   * Map an `Errors[]` body to a typed throw. All three field-error reasons
   * (`no_search_criteria`, `invalid_npi_format`, `invalid_search_field`) are
   * semantic `ValidationError`s; the distinction is carried in `data.reason` for the contract.
   * Deterministic — `retryable: false` so `withRetry` fails fast.
   */
  private throwForErrors(errors: RawNppesError[], ctx: Context): never {
    const reason = reasonForErrorNumber(errors[0]?.number);
    throw validationError(describeErrors(errors), {
      reason,
      retryable: false,
      ...ctx.recoveryFor(reason),
    });
  }

  /**
   * Search the registry. Returns compact summary rows for disambiguation.
   * The caller has already validated criteria and resolved any specialty term.
   * A search with any location field also sends `address_purpose=LOCATION`:
   * without it NPPES matches the location against mailing addresses too, and
   * with it the match covers the primary practice address and every
   * `practiceLocations[]` entry but never the mailing address.
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
    if (params.city || params.state || params.postalCode) query.address_purpose = 'LOCATION';

    const results = await this.call(query, ctx, 'nppes.search');
    return results.map((raw) => this.normalizeSummary(raw));
  }

  /**
   * Fetch a single provider by NPI. Returns the decoded record, or `null` when the
   * NPI is well-formed but has no registry record (`result_count: 0`).
   */
  async getByNumber(npi: string, ctx: Context): Promise<ProviderRecord | null> {
    const [raw] = await this.call({ number: npi }, ctx, 'nppes.getByNumber');
    return raw ? this.normalizeRecord(raw) : null;
  }

  /**
   * Normalize a raw result into a compact summary row. City/state/ZIP come from
   * the `LOCATION` (practice) address only — selected by purpose, since the
   * registry's address order varies — and are absent when there is none. Each
   * `practiceLocations[]` row contributes its city/state/ZIP in upstream order;
   * no `MAILING` row ever reaches the summary.
   */
  private normalizeSummary(raw: RawNppesResult): ProviderSummary {
    const type = TYPE_BY_ENUMERATION[raw.enumeration_type];
    return {
      npi: String(raw.number),
      type,
      status: STATUS_BY_CODE[raw.basic.status],
      name: assembleName(raw, type),
      ...field('credential', trimmed(raw.basic.credential)),
      ...field('primaryTaxonomy', pickPrimaryTaxonomy(raw)),
      ...cityStateZip((raw.addresses ?? []).find(isPracticeLocation)),
      practiceLocations: (raw.practiceLocations ?? []).map(cityStateZip),
    };
  }

  /**
   * Normalize a raw result into a decoded provider record — every professional
   * field the registry serves, renamed and normalized, never fabricated. The one
   * deliberate omission: for anything not an organization (NPI-2), `addresses`
   * keeps only `LOCATION` rows, so an individual's mailing address and phone (often
   * a home) never leave the server. `practiceLocations` rows are practice data and
   * pass through for both types.
   */
  private normalizeRecord(raw: RawNppesResult): ProviderRecord {
    const type = TYPE_BY_ENUMERATION[raw.enumeration_type];
    const basic = raw.basic;

    const authorizedOfficial =
      type === 'organization' ? this.normalizeAuthorizedOfficial(basic) : undefined;
    const addresses =
      type === 'organization'
        ? (raw.addresses ?? [])
        : (raw.addresses ?? []).filter(isPracticeLocation);

    const record: ProviderRecord = {
      npi: String(raw.number),
      type,
      status: STATUS_BY_CODE[basic.status],
      name: assembleName(raw, type),
      taxonomies: (raw.taxonomies ?? []).map((t) => ({
        code: t.code.trim(),
        ...field('description', trimmed(t.desc)),
        primary: t.primary === true,
        ...field('license', trimmed(t.license)),
        ...field('state', trimmed(t.state)),
        ...field('taxonomyGroup', trimmed(t.taxonomy_group)),
      })),
      addresses: addresses.map((a) => this.normalizeAddress(a)),
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
        ...field('middleName', trimmed(n.middle_name)),
        ...field('lastName', trimmed(n.last_name)),
        ...field('prefix', trimmedNonPlaceholder(n.prefix)),
        ...field('suffix', trimmedNonPlaceholder(n.suffix)),
        ...field('organizationName', trimmed(n.organization_name)),
        ...field('credential', trimmed(n.credential)),
      })),
      endpoints: (raw.endpoints ?? [])
        .map((e) => ({ endpoint: trimmed(e.endpoint), raw: e }))
        .filter((x): x is { endpoint: string; raw: typeof x.raw } => x.endpoint !== undefined)
        .map(({ endpoint, raw: e }) => ({
          endpoint,
          ...presentFields({
            endpointType: trimmed(e.endpointType),
            endpointTypeDescription: trimmed(e.endpointTypeDescription),
            endpointDescription: trimmed(e.endpointDescription),
            use: trimmed(e.use),
            useDescription: trimmed(e.useDescription),
            useOtherDescription: trimmed(e.useOtherDescription),
            contentType: trimmed(e.contentType),
            contentTypeDescription: trimmed(e.contentTypeDescription),
            contentOtherDescription: trimmed(e.contentOtherDescription),
            affiliation: trimmed(e.affiliation),
            affiliationName: trimmed(e.affiliationName),
            addressType: trimmed(e.address_type),
            line1: trimmed(e.address_1),
            line2: trimmed(e.address_2),
            city: trimmed(e.city),
            state: trimmed(e.state),
            postalCode: trimmed(e.postal_code),
            countryCode: trimmed(e.country_code),
            countryName: trimmed(e.country_name),
          }),
        })),
    };

    // Individual name parts. Prefix/suffix carry the `"--"` placeholder sentinel.
    const firstName = trimmed(basic.first_name);
    const lastName = trimmed(basic.last_name);
    const middleName = trimmed(basic.middle_name);
    const namePrefix = trimmedNonPlaceholder(basic.name_prefix);
    const nameSuffix = trimmedNonPlaceholder(basic.name_suffix);
    const organizationName = trimmed(basic.organization_name);
    const credential = trimmed(basic.credential);
    const sex = trimmed(basic.sex);
    const soleProprietor = trimmed(basic.sole_proprietor);
    const organizationalSubpart = trimmed(basic.organizational_subpart);
    const enumerationDate = trimmed(basic.enumeration_date);
    const lastUpdated = trimmed(basic.last_updated);
    const certificationDate = trimmed(basic.certification_date);
    const createdEpoch = epochNumber(raw.created_epoch);
    const lastUpdatedEpoch = epochNumber(raw.last_updated_epoch);

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
    if (createdEpoch !== undefined) record.createdEpoch = createdEpoch;
    if (lastUpdatedEpoch !== undefined) record.lastUpdatedEpoch = lastUpdatedEpoch;

    return record;
  }

  private normalizeAuthorizedOfficial(basic: RawNppesBasic) {
    const firstName = trimmed(basic.authorized_official_first_name);
    const lastName = trimmed(basic.authorized_official_last_name);
    const middleName = trimmed(basic.authorized_official_middle_name);
    // Prefix/suffix carry the same `"--"` placeholder sentinel as individual name parts.
    const namePrefix = trimmedNonPlaceholder(basic.authorized_official_name_prefix);
    const nameSuffix = trimmedNonPlaceholder(basic.authorized_official_name_suffix);
    const credential = trimmed(basic.authorized_official_credential);
    const title = trimmed(basic.authorized_official_title_or_position);
    const telephoneNumber = trimmed(basic.authorized_official_telephone_number);
    if (!firstName && !lastName && !title && !telephoneNumber) return;
    return {
      ...field('firstName', firstName),
      ...field('lastName', lastName),
      ...field('middleName', middleName),
      ...field('namePrefix', namePrefix),
      ...field('nameSuffix', nameSuffix),
      ...field('credential', credential),
      ...field('title', title),
      ...field('telephoneNumber', telephoneNumber),
    };
  }

  private normalizeAddress(a: RawNppesAddress) {
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
