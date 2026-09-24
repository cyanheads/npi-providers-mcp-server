/**
 * @fileoverview Raw upstream and normalized domain types for the NPPES NPI Registry API v2.1.
 * @module services/nppes/types
 *
 * Raw types mirror the live API response shape (probed against the registry).
 * Upstream is sparse — `license`, `state`, `middle_name`, `credential`,
 * `telephone_number`, and the `identifiers`/`endpoints`/`practiceLocations` arrays
 * are frequently null or empty. Raw fields default to optional unless the service
 * validates their presence (the identity fields on `RawNppesResult`, a taxonomy's
 * `code`); normalization preserves absence rather than fabricating defaults.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Raw upstream shapes (https://npiregistry.cms.hhs.gov/api/?version=2.1)
// ─────────────────────────────────────────────────────────────────────────────

/** An element of the `Errors[]` array the API returns inside an HTTP 200 body on validation failure. */
export interface RawNppesError {
  description?: string;
  field?: string;
  number?: string;
}

/** Raw `basic` block — union of individual (NPI-1) and organization (NPI-2) fields. */
export interface RawNppesBasic {
  authorized_official_credential?: string;
  authorized_official_first_name?: string;
  authorized_official_last_name?: string;
  authorized_official_middle_name?: string;
  authorized_official_name_prefix?: string;
  authorized_official_name_suffix?: string;
  authorized_official_telephone_number?: string;
  authorized_official_title_or_position?: string;
  certification_date?: string;
  credential?: string;
  enumeration_date?: string;
  // Individual
  first_name?: string;
  last_name?: string;
  last_updated?: string;
  middle_name?: string;
  name?: string;
  name_prefix?: string;
  name_suffix?: string;
  // Organization
  organization_name?: string;
  organizational_subpart?: string;
  sex?: string;
  sole_proprietor?: string;
  // Common
  status?: string;
}

/** Raw `taxonomies[]` element. The service validates `code` as a non-blank string. */
export interface RawNppesTaxonomy {
  code: string;
  desc?: string;
  license?: string | null;
  primary?: boolean;
  state?: string | null;
  taxonomy_group?: string;
}

/** Raw `addresses[]` / `practiceLocations[]` element. */
export interface RawNppesAddress {
  address_1?: string;
  address_2?: string;
  address_purpose?: string;
  address_type?: string;
  city?: string;
  country_code?: string;
  country_name?: string;
  fax_number?: string;
  postal_code?: string;
  state?: string;
  telephone_number?: string;
}

/** Raw `identifiers[]` element. */
export interface RawNppesIdentifier {
  code?: string;
  desc?: string;
  identifier?: string;
  issuer?: string;
  state?: string;
}

/** Raw `other_names[]` element. */
export interface RawNppesOtherName {
  code?: string;
  credential?: string;
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  organization_name?: string;
  prefix?: string;
  suffix?: string;
  type?: string;
}

/**
 * Raw `endpoints[]` element (FHIR / Direct messaging endpoints). Live responses
 * carry an endpoint-specific address block plus routing/context fields
 * (`address_type`, `affiliationName`, `contentTypeDescription`, `country_name`,
 * `useDescription`) and free-text descriptions (`endpointDescription`, and
 * `useOtherDescription` / `contentOtherDescription` explaining a `use` or
 * `contentType` of `OTHER`) not present on the older probed shape.
 */
export interface RawNppesEndpoint {
  address_1?: string;
  address_2?: string;
  address_type?: string;
  affiliation?: string;
  affiliationName?: string;
  city?: string;
  contentOtherDescription?: string;
  contentType?: string;
  contentTypeDescription?: string;
  country_code?: string;
  country_name?: string;
  endpoint?: string;
  endpointDescription?: string;
  endpointType?: string;
  endpointTypeDescription?: string;
  postal_code?: string;
  state?: string;
  use?: string;
  useDescription?: string;
  useOtherDescription?: string;
}

/** Raw `enumeration_type` values the registry serves: individual vs organization. */
export type RawEnumerationType = 'NPI-1' | 'NPI-2';

/** Raw `basic.status` values: `A` active, `D` deactivated. */
export type RawStatusCode = 'A' | 'D';

/**
 * Raw `results[]` element whose identity fields the service has validated: a
 * 10-digit `number`, a known `enumeration_type`, and a `basic` block with a known
 * `status`. The six array fields are arrays of objects, `null`, or absent.
 */
export interface RawNppesResult {
  addresses?: RawNppesAddress[] | null;
  basic: RawNppesBasic & { status: RawStatusCode };
  created_epoch?: number | string;
  endpoints?: RawNppesEndpoint[] | null;
  enumeration_type: RawEnumerationType;
  identifiers?: RawNppesIdentifier[] | null;
  last_updated_epoch?: number | string;
  number: number | string;
  other_names?: RawNppesOtherName[] | null;
  practiceLocations?: RawNppesAddress[] | null;
  taxonomies?: RawNppesTaxonomy[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized domain shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Provider enumeration type, normalized from `enumeration_type`. */
export type ProviderType = 'individual' | 'organization';

/** Normalized provider status: `A` maps to `active`, `D` to `deactivated`. */
export type ProviderStatus = 'active' | 'deactivated';

/** A normalized taxonomy on a provider record. */
export interface ProviderTaxonomy {
  code: string;
  description?: string;
  license?: string;
  primary: boolean;
  state?: string;
  taxonomyGroup?: string;
}

/** A normalized address on a provider record. */
export interface ProviderAddress {
  addressType?: string;
  city?: string;
  countryCode?: string;
  countryName?: string;
  faxNumber?: string;
  line1?: string;
  line2?: string;
  postalCode?: string;
  purpose?: string;
  state?: string;
  telephoneNumber?: string;
}

/** A normalized secondary identifier (Medicaid, etc.). */
export interface ProviderIdentifier {
  code?: string;
  description?: string;
  identifier: string;
  issuer?: string;
  state?: string;
}

/** A normalized former / DBA name. */
export interface ProviderOtherName {
  credential?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  organizationName?: string;
  prefix?: string;
  suffix?: string;
  type?: string;
}

/** A normalized FHIR / Direct endpoint, including its routing address and context. */
export interface ProviderEndpoint {
  addressType?: string;
  affiliation?: string;
  affiliationName?: string;
  city?: string;
  contentOtherDescription?: string;
  contentType?: string;
  contentTypeDescription?: string;
  countryCode?: string;
  countryName?: string;
  endpoint: string;
  endpointDescription?: string;
  endpointType?: string;
  endpointTypeDescription?: string;
  line1?: string;
  line2?: string;
  postalCode?: string;
  state?: string;
  use?: string;
  useDescription?: string;
  useOtherDescription?: string;
}

/** The authorized-official block for organization (NPI-2) records. */
export interface AuthorizedOfficial {
  credential?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  telephoneNumber?: string;
  title?: string;
}

/**
 * A decoded NPPES provider record: the registry's professional-practice data,
 * with an individual's (NPI-1) non-practice address rows withheld from `addresses`.
 */
export interface ProviderRecord {
  /** Organizations: every row. Individuals: `LOCATION` (practice) rows only. */
  addresses: ProviderAddress[];
  authorizedOfficial?: AuthorizedOfficial;
  certificationDate?: string;
  /** Record creation timestamp, epoch milliseconds (from raw `created_epoch`). */
  createdEpoch?: number;
  credential?: string;
  endpoints: ProviderEndpoint[];
  enumerationDate?: string;
  firstName?: string;
  identifiers: ProviderIdentifier[];
  lastName?: string;
  lastUpdated?: string;
  /** Record last-update timestamp, epoch milliseconds (from raw `last_updated_epoch`). */
  lastUpdatedEpoch?: number;
  middleName?: string;
  /** Assembled "First Last" (individual) or organization name. */
  name: string;
  namePrefix?: string;
  nameSuffix?: string;
  npi: string;
  organizationalSubpart?: string;
  organizationName?: string;
  otherNames: ProviderOtherName[];
  practiceLocations: ProviderAddress[];
  sex?: string;
  soleProprietor?: string;
  status: ProviderStatus;
  taxonomies: ProviderTaxonomy[];
  type: ProviderType;
}

/** The city/state/ZIP of one professional location. */
export interface ProviderLocation {
  city?: string;
  postalCode?: string;
  state?: string;
}

/**
 * A compact provider row for search disambiguation. `city`/`state`/`postalCode`
 * come from the primary `LOCATION` address; `practiceLocations` carries each
 * secondary practice location, so a location search can match either.
 */
export interface ProviderSummary extends ProviderLocation {
  credential?: string;
  name: string;
  npi: string;
  practiceLocations: ProviderLocation[];
  primaryTaxonomy?: { code: string; description?: string };
  status: ProviderStatus;
  type: ProviderType;
}

/** Parameters accepted by the NPPES search call (already validated/resolved by the tool). */
export interface NppesSearchParams {
  city?: string;
  enumerationType?: 'NPI-1' | 'NPI-2';
  firstName?: string;
  lastName?: string;
  limit: number;
  organizationName?: string;
  postalCode?: string;
  skip: number;
  state?: string;
  taxonomyDescription?: string;
}
