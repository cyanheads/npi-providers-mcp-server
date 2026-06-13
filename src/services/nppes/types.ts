/**
 * @fileoverview Raw upstream and normalized domain types for the NPPES NPI Registry API v2.1.
 * @module services/nppes/types
 *
 * Raw types mirror the live API response shape (probed against the registry).
 * Upstream is sparse — `license`, `state`, `middle_name`, `credential`,
 * `telephone_number`, and the `identifiers`/`endpoints`/`practiceLocations` arrays
 * are frequently null or empty. Raw fields default to optional unless presence is
 * guaranteed; normalization preserves absence rather than fabricating defaults.
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

/** Raw `taxonomies[]` element. */
export interface RawNppesTaxonomy {
  code?: string;
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

/** Raw `endpoints[]` element (FHIR / Direct messaging endpoints). */
export interface RawNppesEndpoint {
  address_1?: string;
  affiliation?: string;
  city?: string;
  contentType?: string;
  country_code?: string;
  endpoint?: string;
  endpointType?: string;
  endpointTypeDescription?: string;
  postal_code?: string;
  state?: string;
  use?: string;
}

/** Raw `results[]` element. */
export interface RawNppesResult {
  addresses?: RawNppesAddress[];
  basic?: RawNppesBasic;
  created_epoch?: number | string;
  endpoints?: RawNppesEndpoint[];
  enumeration_type?: string;
  identifiers?: RawNppesIdentifier[];
  last_updated_epoch?: number | string;
  number?: number | string;
  other_names?: RawNppesOtherName[];
  practiceLocations?: RawNppesAddress[];
  taxonomies?: RawNppesTaxonomy[];
}

/** Top-level raw API response. Either `results` (and `result_count`) or `Errors`. */
export interface RawNppesResponse {
  Errors?: RawNppesError[];
  result_count?: number;
  results?: RawNppesResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized domain shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Provider enumeration type, normalized from `enumeration_type`. */
export type ProviderType = 'individual' | 'organization';

/** Normalized provider status. `A` (active) maps to `active`; anything else to `deactivated`. */
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
  organizationName?: string;
  type?: string;
}

/** A normalized FHIR / Direct endpoint. */
export interface ProviderEndpoint {
  contentType?: string;
  endpoint: string;
  endpointType?: string;
  endpointTypeDescription?: string;
  use?: string;
}

/** The authorized-official block for organization (NPI-2) records. */
export interface AuthorizedOfficial {
  credential?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  telephoneNumber?: string;
  title?: string;
}

/** A fully decoded NPPES provider record. */
export interface ProviderRecord {
  addresses: ProviderAddress[];
  authorizedOfficial?: AuthorizedOfficial;
  certificationDate?: string;
  credential?: string;
  endpoints: ProviderEndpoint[];
  enumerationDate?: string;
  firstName?: string;
  identifiers: ProviderIdentifier[];
  lastName?: string;
  lastUpdated?: string;
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

/** A compact provider row for search disambiguation. */
export interface ProviderSummary {
  city?: string;
  credential?: string;
  name: string;
  npi: string;
  primaryTaxonomy?: { code: string; description?: string };
  state?: string;
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
