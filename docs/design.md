# npi-providers-mcp-server — Design

US healthcare provider directory over the live, keyless **NPPES NPI Registry API v2.1** (`https://npiregistry.cms.hhs.gov/api/?version=2.1`), plus a bundled **NUCC Healthcare Provider Taxonomy** code set (883 codes, v26.1) for offline specialty resolution. Look up any physician, practitioner, or organization by NPI, name, specialty, or location; decode its professional-practice record (taxonomies, practice addresses, credentials, identifiers, endpoints, status — only LOCATION address rows are kept for individual providers).

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `npi_search_providers` | Search the NPPES registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. The specialty filter accepts plain-language terms (e.g. "cardiologist") and resolves them to the registry's taxonomy descriptions before searching. Returns a compact result row per provider — NPI, name, primary specialty, city/state/ZIP (plus the matching practice location when a location search matched a secondary one), enumeration type, and active/deactivated status — suitable for disambiguation; call `npi_get_provider` with an NPI for the full record. | `name_search?`, `first_name?`, `last_name?`, `organization_name?`, `specialty?`, `taxonomy_description?`, `provider_type?` (`individual`/`organization`), `city?`, `state?`, `postal_code?`, `limit?` (1–200, default 10), `skip?` (0–1000) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_get_provider` | Fetch the NPPES professional-practice record for one or more NPI numbers (up to 10 per call). Returns every taxonomy with its primary flag, license number and state; practice addresses with phone/fax (only LOCATION rows are kept for individual providers, so their mailing address is withheld; organizations also carry their mailing address); credential, sex, sole-proprietor flag; enumeration and last-updated dates; active/deactivated status; secondary identifiers (Medicaid, etc.); and FHIR/Direct endpoints. This is the decode tool — turn an NPI from a claim, prescription, or another health server into a known provider. | `npis` (string or array of up to 10, each 10 digits with a valid check digit) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_lookup_taxonomy` | Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses. Fully offline (bundled). Modes: `resolve` turns a plain-language specialty into matching active taxonomy codes and their canonical descriptions (the value the search tools filter on), excluding codes NUCC marks inactive; `get` returns the full entry for an exact code, including NUCC's Notes; `browse` walks the hierarchy (grouping → classification → specialization). Every entry carries its active/inactive status. Grounds the `specialty` filter the search tools accept, so a weak query like "heart doctor" maps to the correct code instead of returning nothing. | `mode` (`resolve`/`get`/`browse`), `query?` (resolve), `code?` (get), `grouping?` (browse), `section?` (`Individual`\|`Non-Individual` — browse filter by NPI type), `limit?` (1–50, default 20), `skip?` (0–1000, default 0; resolve/browse) | `readOnlyHint: true`, `openWorldHint: false` |

Three tools. `npi_find_by_specialty_location` from the sketch is **folded into `npi_search_providers`** — the search tool already takes `specialty` + `city`/`state`/`postal_code`, so a separate workflow tool would duplicate the surface without earning its keep (see Design Decisions).

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `npi://provider/{npi}` | A single provider's decoded record by NPI number — the resource twin of `npi_get_provider` for one NPI, keeping the same LOCATION-only address rows for individual providers. Read-only, stable URI, useful as injectable context when an NPI is already known. | None (single record) |
| `npi://taxonomy/{code}` | A single NUCC taxonomy entry by code (grouping, classification, specialization, definition, Notes, display name, status and replacement). The resource twin of `npi_lookup_taxonomy` `mode: get`; inactive codes stay readable here. | None (single record) |

Both resources are fully covered by the tool surface — they exist only as convenience for resource-capable clients. Tool-only clients lose nothing.

### Prompts

None. This is a data/lookup server with no recurring multi-step interaction pattern worth templating.

---

## Overview

**What it wraps.** NPPES (National Plan and Provider Enumeration System) is CMS's public directory of every US healthcare provider that holds an NPI (National Provider Identifier) — the identifier on every US claim, prescription, and EHR record. The registry exposes essentially **one parameterized search endpoint**; this server turns it into goal-shaped tools and adds the taxonomy-resolution layer the raw API lacks.

**Who it's for.** Health-IT, claims, and provider-data engineers; care-navigation and referral assistants; clinical-research ops resolving an investigator or site. Agents resolving an NPI → name + specialty, or finding providers by specialty and place.

**Where it sits.** The health cluster has drugs/devices (`openfda`), trials (`clinicaltrials`), literature (`pubmed`), surveillance (`cdc-health`, `who-gho`) — but no provider directory. This is the *who* layer the rest of the cluster references via the NPI.

**Data scope.** Public professional practice data only — name, practice address, specialty, credential, NPI. NPPES publishes every provider's mailing address and phone, and for an individual (NPI-1) — a sole practitioner especially — that row can be a home address. The server therefore withholds an individual's non-`LOCATION` `addresses[]` rows at the raw-to-domain boundary, so the tool and the resource share one rule; organization (NPI-2) mailing addresses, `LOCATION` phone/fax, and `practiceLocations[]` are business contact data and pass through. The scope note in the server `instructions` names the withholding. (Supersedes the original stance that this was a scope note, "not a redaction concern" — see Design Decision 10.)

---

## Requirements

- **Keyless.** No API key, no auth on the upstream. Server runs `MCP_AUTH_MODE=none`; no `auth` scopes on tools (read-only, public data).
- **Read-only.** No write path to NPPES exists; every tool is `readOnlyHint: true`.
- **Specialty resolution is the core DX win.** The API filters by `taxonomy_description` with **substring matching** — `taxonomy_description=cardiology` matches *"Pharmacist, Cardiology"* as readily as *"Cardiovascular Disease Physician"*. Plain specialty words must resolve through the bundled NUCC set to the precise description/code, and the **matched taxonomy must be surfaced in output** so the agent sees what it actually searched.
- **Status fidelity.** Surface `status` (`A` active / `D` deactivated) and `last_updated` so an agent never treats a deactivated NPI as current. The live v2.1 API returns no record for a deactivated NPI (`result_count: 0`), so a deactivation reads as a miss, and a reactivated NPI comes back `A` with no lifecycle fields; the deactivation/reactivation fields in the NPPES field map describe the bulk file, not API responses.
- **Honest pagination.** `result_count` is the **returned page size, not the grand total** (confirmed: `limit=5` → `result_count: 5`). The API never reports a true match count. Output must say "showing N (at least N match)" — never imply a total it doesn't have.
- **Hard pagination ceiling.** `skip` max is **1000**, `limit` max **200** → only the first **1200 matches** of one search are reachable, and `skip` beyond 1000 **silently clamps** (returns the same window, no error — confirmed `skip=1000…2000` all return the identical record). For broad queries this is a real footgun: the tool must name the exact next page while one exists, and at the terminal window give a lossless way on — the practice-ZIP-prefix continuation (Design Decision 16) — rather than letting an agent page into a wall.
- **Other-name matching.** NPPES matches `first_name`, `last_name`, and `organization_name` against every `other_names[]` entry as well as the current name, field by field, and sorts by current name — for `last_name=Smith`, all 1,200 reachable rows are former-name Smiths (ABBIATI … HUGGINS, confirmed 2026-09-24). A row matched that way must say so (Design Decision 15).
- **Quirky error envelope.** The API returns **HTTP 200 with an `{"Errors":[{description, field, number}]}` body** for validation failures — never a 4xx (confirmed across bad-NPI, no-criteria, bad-enum, wildcard-too-short, state-only cases). The service layer must detect `Errors[]` on a 200 and throw, mapping to the right MCP error code. Genuine HTTP 5xx/timeouts still bubble as `ServiceUnavailable`.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nppes-service` | NPPES NPI Registry API v2.1 (live HTTP). Builds the query, calls `fetchWithTimeout`, **inspects the 200 body for `Errors[]`** and throws on presence, normalizes the raw record into the domain shape. | `npi_search_providers`, `npi_get_provider`, `npi://provider/{npi}` |
| `taxonomy-service` | Bundled NUCC Healthcare Provider Taxonomy CSV (883 codes), loaded into an in-memory index at `setup()`. Strict-token resolve (plain term → code + description), exact get-by-code, hierarchy browse. No external dependency. | `npi_lookup_taxonomy`, `npi://taxonomy/{code}`, and the `specialty` resolution step inside `npi_search_providers` |

**Resilience (`nppes-service`).** `withRetry` around the full fetch+parse+validate pipeline; base delay ~500ms (the CMS API is generally fast and generous, ephemeral failures dominate). `fetchWithTimeout` handles non-OK → `ServiceUnavailable`. The `Errors[]`-on-200 check sits **inside** the retried method so a transient HTML error page (rare) classifies as transient, not `SerializationError`. So does shape validation: the body must be an object carrying either a non-empty `Errors` array or a `results` array, and every result must carry a 10-digit `number`, `enumeration_type` `NPI-1`/`NPI-2`, and a `basic` object with `status` `A`/`D`, with the six array fields (`taxonomies`, `addresses`, `practiceLocations`, `identifiers`, `other_names`, `endpoints`) arrays of objects when present and non-null, and every taxonomy carrying a non-blank string `code` (its identity — live pages carry one on every row). That is exactly what normalization needs to run without a native throw or an invented value: every other scalar it reads passes through `trimmed()` (or `epochNumber()` for the two epochs), so a wrong-typed scalar reads as absent. Anything else throws `ServiceUnavailable` from inside the retried closure — retried like unparseable JSON, then surfaced as an upstream failure, never a miss or a defaulted identity. One malformed row fails a whole search rather than being dropped (a dropped row would silently shrink a full page). Name is not required; an identity-only record is labelled `NPI <number>`.

**Taxonomy backend choice.** 883 rows → a plain in-memory `Map`/array index built once at startup (server-level, no framework primitive). Not `MirrorService` (overkill for <1k static rows), not `ctx.state` (global reference data, not tenant-scoped), not DataCanvas (categorical reference data, not analytical rows). Refreshed by re-bundling the CSV on NUCC's twice-yearly release cadence (a maintenance task, not a runtime fetch).

**No DataCanvas.** Directory lookups return small inline result sets an agent reads and chains, not row collections it runs SQL over. No `canvas_id`, no `dataframe_query` tool.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `NPPES_API_BASE_URL` | No | NPPES API base URL. Default `https://npiregistry.cms.hhs.gov/api`. Override for a private mirror or testing. |
| `NPPES_TIMEOUT_MS` | No | Per-request timeout in milliseconds. Default `15000`. |

No API key — the upstream is keyless. The NUCC CSV is bundled in the image (no env var, no runtime fetch). Goes in `src/config/server-config.ts` as a separate Zod schema (`parseEnvConfig`).

---

## Domain Mapping

NPPES is effectively a single endpoint, so the noun×operation grid is shallow — most "operations" are query-parameter shapes on the one search call, not distinct endpoints.

| Noun | Operations | Endpoint / source |
|:-----|:-----------|:------------------|
| Provider (individual NPI-1) | search by name/location/specialty; get by NPI | `GET /api/?version=2.1&...` (one endpoint, parameterized) |
| Organization (NPI-2) | search by org name/location/specialty; get by NPI | same endpoint, `enumeration_type=NPI-2` |
| Taxonomy (NUCC) | resolve term→code; get by code; browse hierarchy | bundled CSV, in-memory index |

**Confirmed upstream search parameters** (probed live): `number` (NPI), `enumeration_type` (`NPI-1`/`NPI-2`), `first_name`, `last_name`, `organization_name`, `taxonomy_description`, `city`, `state`, `postal_code`, `address_purpose` (`LOCATION`/`MAILING`/`PRIMARY`/`SECONDARY`), `limit` (≤200), `skip` (≤1000), `use_first_name_alias`. Wildcards (`*`) are allowed on `first_name`, `last_name`, `organization_name`, `city`, and `postal_code`, and **require ≥2 leading characters** (`9*`, `S*`, a bare `*` → `Errors` `03`); `state` rejects `*` (`05`). A wildcard is a prefix match: `postal_code=98*`, `981*`, down to ZIP+4 prefixes such as `981011*` return only rows with a matching practice ZIP, and `city=SE*` / `SAN F*` only cities starting with the prefix, case-insensitively. The registry strips every `*` and prefix-matches the rest (`9*8` behaves as `98*`, `SE*TTLE` as `SETTLE*`), so the tool accepts only one trailing `*`. An exact `postal_code` is a 5-digit ZIP (also matching the ZIP+4 codes extending it) or a full ZIP+4 — `98`/`981` exact return nothing — and a ZIP+4 prefix never matches a practice address recorded with only its 5-digit ZIP. Name fields also match `other_names[]` (a `first_name` and a `last_name` can each match a different name of the same provider), ignore apostrophes and spaces (`OBrien` finds O'BRIEN, `DeLaCruz` DE LA CRUZ), and an exact `first_name` also matches first-name variants (`Robert` → BOBBY, ROB, ROBBIE) unless `use_first_name_alias=False`; results sort by current last name, then first name. `state` alone is rejected ("requires additional search criteria"); `city`-only and `taxonomy_description`-only are accepted.

**Confirmed record shape** (`results[]` element):

- `number` (NPI string), `enumeration_type` (`NPI-1`/`NPI-2`), `created_epoch`, `last_updated_epoch`
- `basic` — individuals: `first_name`, `last_name`, `middle_name?`, `name_prefix?`, `credential?`, `sex?`, `sole_proprietor`, `status` (`A`/`D`), `enumeration_date`, `last_updated`, `certification_date?`. Organizations: `organization_name`, `organizational_subpart`, `authorized_official_{first_name,last_name,credential,name_prefix,name_suffix,telephone_number,title_or_position}` fields, `status`, `enumeration_date`, `last_updated`, `certification_date?` (present on some org records, absent on others — treat as optional for both types).
- `taxonomies[]` — `code`, `desc`, `primary` (bool), `license?` (nullable), `state?` (nullable), `taxonomy_group`
- `addresses[]` — `address_purpose` (`LOCATION`/`MAILING`), `address_type` (`DOM`/`FOR`), `address_1`, `address_2?`, `city`, `state`, `postal_code`, `country_code`, `country_name`, `telephone_number?`, `fax_number?`
- `identifiers[]` — `code`, `desc`, `identifier`, `issuer?`, `state?` (often empty `[]`)
- `other_names[]` — former/DBA names (`first_name`, `middle_name?`, `last_name`, `prefix?`, `suffix?` or `organization_name`, `type`; the internal `code` ordinal is dropped)
- `practiceLocations[]`; `endpoints[]` (FHIR/Direct; often empty `[]`) — each endpoint carries `endpoint`, `endpointType`/`endpointTypeDescription`, a free-text `endpointDescription`, `use`/`useDescription` (plus `useOtherDescription` when `use` is `OTHER`), `contentType`/`contentTypeDescription` (plus `contentOtherDescription` when the content type is `OTHER`), `affiliation`/`affiliationName`, and a routing address block (`address_1`, `address_2`, `address_type`, `city`, `state`, `postal_code`, `country_code`, `country_name`)

**Sparsity note (framework checklist):** `license`, `state`, `middle_name`, `credential`, `telephone_number`, and the entire `identifiers`/`endpoints`/`practiceLocations` arrays are frequently null/empty. Domain and output schemas mark these optional/nullable; normalization preserves absence (never fabricates). Tests must include a sparse-payload case.

---

## Tool Detail

### `npi_search_providers`

The workhorse. Wraps the one NPPES search call with NUCC specialty resolution and honest pagination disclosure.

**Inputs** (all optional individually, but at least one effective search criterion required — mirror the API's "No valid search criteria" rule by validating before the call):

- `name_search?` — convenience shortcut: a single person's name string, split into `first_name`/`last_name` heuristically. For precise control use the dedicated fields. (Names the 80% case per the convenience-shortcut pattern.)
- `first_name?`, `last_name?` — individual name parts. Wildcard `*` allowed with ≥2 leading chars (documented in `.describe()`).
- `organization_name?` — organization name (implies `provider_type: organization`). Wildcard same rule.
- `provider_type?` — `z.enum(['individual','organization'])` → maps to `enumeration_type` `NPI-1`/`NPI-2`. Omit to search both. NPPES rejects every mix of individual criteria (`first_name`, `last_name`, `NPI-1`) with organization criteria (`organization_name`, `NPI-2`) with its error `13`, confirmed live for each pairing, `organization_name` + a person name with no type included. The handler refuses the mix before any request as `mixed_provider_criteria`, naming the fields on each side (`name_search` counts as a person name). This is a handler check, not a schema refinement, so the recovery hint can name exactly the fields the caller sent (Design Decision 17).
- `specialty?` — plain-language specialty (e.g. "pediatric cardiologist"). **Resolved through the bundled NUCC set** to one or more `taxonomy_description` values before the call. The matched taxonomy is echoed in output.
- `taxonomy_description?` — escape hatch: an exact NUCC description to pass through unresolved, for callers who already have it. Validate that `specialty` and `taxonomy_description` aren't both set.
- `city?`, `state?` (2-letter, regex `^[A-Z]{2}$`), `postal_code?` — location. Note in `state`'s describe that the API rejects state-only searches; pair it with another criterion. `city` takes a trailing `*` after ≥2 characters; `postal_code` takes 5 or 9 digits, or a 2–9 digit prefix with one trailing `*` (`98*`, `981011*`). Any other `*` placement is rejected at the schema, naming the accepted shape.
- `limit?` — `z.number().int().min(1).max(200).default(10)`. Describe the 200 cap.
- `skip?` — `z.number().int().min(0).max(1000).default(0)`. Describe the 1000 ceiling and that a full page names the next `skip` in `nextPage`. The tool description states that **only the first 1200 matches are reachable** and that the terminal window returns `continuationPostalCodes`; the notice carries the continuation procedure, so neither is repeated here.

**Output** — compact rows for disambiguation:

```
providers: Array<{
  npi: string;                  // chaining key for npi_get_provider
  type: 'individual' | 'organization';
  name: string;                 // assembled "First Last" or organization_name
  credential?: string;
  primaryTaxonomy?: { code: string; description: string };  // the `primary: true` entry
  city?: string; state?: string; postalCode?: string;       // primary LOCATION address
  matchedLocation?: { city?: string; state?: string; postalCode?: string };  // see Location post-filter
  matchedOtherName?: { name: string; type?: string };  // see Other-name matches
  status: 'active' | 'deactivated';
}>
```

**Enrichment** (`ctx.enrich` — reaches both client surfaces):

- `ctx.enrich.echo(...)` — the resolved `taxonomy_description`(s) the `specialty` term mapped to (so the agent sees what was actually searched), plus the parsed criteria.
- **Practice-address location matching** — when `city`, `state`, or `postal_code` is provided, the service also sends `address_purpose=LOCATION`. Without it NPPES matches the requested location against a provider's mailing address as well as each practice location; with it the upstream match covers the primary `LOCATION` address and every `practiceLocations[]` entry but never the mailing address (Design Decision 11). A search with no location field sends no `address_purpose`.
- **Location post-filter** — the guarantee on top of that, so drops are now rare: when a location field is provided, the normalized rows are still filtered server-side. A row is kept when one professional location — the primary `LOCATION` address or a `practiceLocations[]` entry — satisfies every requested field on its own (`city`/`state` case-insensitive; an exact `postal_code` prefix-matched to tolerate 5-vs-9-digit ZIP+4; a trailing-`*` `city` or `postal_code` as a prefix the location must start with, so a ZIP+4 prefix skips 5-digit-only ZIPs as upstream does). A row whose only match is its `MAILING` row, or whose requested fields are split across two locations, is dropped. `city`/`state`/`postalCode` always describe the primary `LOCATION` address; a row kept on a secondary practice location also carries that location as `matchedLocation` (rendered as **Matched practice location** in `content[]`), so a Seattle search never shows a St. Louis address as a row's only location.
- **Other-name matches** — the service marks a row `matchedOtherName: { name, type? }` (rendered as **Matched other name**) when its current name fails a requested `last_name`, `organization_name`, or wildcard `first_name` and one of its `other_names[]` satisfies every field the current name fails (Design Decision 15). Rows, order, and paging are untouched.
- `ctx.enrich.truncated({ shown, cap })` — when the *raw upstream page* hit `limit` (keyed on the pre-filter count, so post-filtering never hides a full page). `shown` is the count of rows kept after the location filter. Paired with a note: the full page's size is not a grand total.
- `nextPage: { skip, limit }` — on a full page with further reachable rows: `skip + limit` with the same limit while that is ≤ 1000; past it, `skip 1000, limit 200`, and the notice says how many leading rows repeat (dedupe by NPI). Never a `skip` the schema rejects.
- `continuationPostalCodes: string[]` — only at the terminal window (a full page at `skip` 1000, `limit` 200): the `postal_code` prefixes that partition the same search (Design Decision 16) — `00*`–`99*` with no `postal_code`, the prefix plus each digit for a 2–4 or 6–8 digit prefix, and empty (a dead end the notice explains) for a 5-digit ZIP, a full ZIP+4, or a non-numeric postal code.
- `ctx.enrich.notice(...)` — one notice assembled from fragments (last-wins): empty upstream result → broaden / check specialty resolution / drop `state`-only, or, at `skip` > 0, that the matches end before that offset; upstream matched but no provider has a practice location matching every requested field → a distinct notice saying so; some rows dropped by the location filter → how many were filtered out; rows matched through an other name → how many, and that the registry sorts by current name; a full page → the page-size caveat plus the next page or the terminal-window continuation instructions (re-run per value from `skip` 0, page until a page returns fewer than `limit` rows, split a value that fills its own window, dedupe by NPI, non-US practice addresses unreached) or the dead end. No fragment states or implies a grand total.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_search_criteria` | `ValidationError` | No effective criterion provided (mirrors the API's `number:04`) | Provide at least one of name, organization, specialty, or city — state alone is not accepted by the registry. |
| `conflicting_specialty` | `ValidationError` | Both `specialty` and `taxonomy_description` were supplied | Pass either `specialty` (plain-language, resolved) or `taxonomy_description` (exact), not both. |
| `mixed_provider_criteria` | `ValidationError` | Individual criteria (`first_name`, `last_name`, `name_search`, `provider_type: individual`) combined with organization criteria (`organization_name`, `provider_type: organization`) — the registry's error `13`. Raised before any upstream call. | The hint names both sides as sent: drop the individual fields to search organizations, or the organization fields to search individuals. |
| `unresolved_specialty` | `NotFound` | `specialty` term matched no active NUCC taxonomy; the message names any inactive codes it matched, with their replacements. Also raised when the term is made only of stop words, singular or plural (`doctor`, `M.D.`, `specialists`, …), and names no specialty. Raised before any upstream call. | Call `npi_lookup_taxonomy` mode `resolve` to find a valid specialty, or pass `taxonomy_description` directly. A stop-word-only term instead points to `npi_lookup_taxonomy` mode `browse`: the `Allopathic & Osteopathic Physicians` grouping for `physician`/`doctor`/`md`/`do`. |
| `invalid_search_field` | `ValidationError` | API returned `Errors[]` for a field (e.g. wildcard <2 chars, bad enumeration_type) | Read the field error; wildcards need ≥2 leading characters and state needs a companion filter. |

### `npi_get_provider`

Batch fetch by NPI. The API has no native multi-NPI filter, so the handler checks each NPI's check digit, then fans out one `number=` call per valid NPI in parallel (`Promise.allSettled`, bounded), each returning 0 or 1 record. Designed for partial success.

**Input:** `npis` — `z.union([NpiString, z.array(NpiString).max(10)])` where `NpiString = z.string().regex(/^\d{10}$/)`. The schema carries only the 10-digit shape; its `.describe()` states the check-digit rule. The handler then verifies each NPI's check digit — the Luhn algorithm over the NPI prefixed with `80840`, per the CMS specification — and never sends a failing NPI to NPPES, which would answer `{"result_count":0,"results":[]}` and make a typo read as a deactivated provider. The leading digit is not checked (CMS issues NPIs starting with 1 or 2 "initially" and may use other first digits later). The same helper guards `npi://provider/{npi}`. A valid NPI that simply has no record returns `{"result_count":0,"results":[]}` (not `Errors[]`) and lands in `notFound[]`.

**Output** — decoded records, partial-success shape:

```
found: Array<FullProviderRecord>   // see Domain Mapping record shape, normalized
notFound: Array<{ npi, reason }>   // confirmed absence: valid NPI, result_count 0
errored: Array<{ npi, reason }>    // upstream/transport failure or malformed body (service unavailable, timeout) — unresolved, not absent; retry
invalid: Array<{ npi, reason }>    // failed the NPI check digit — never looked up
```

`FullProviderRecord` carries: `npi`, `type`, basic block (name/org fields incl. name prefix/suffix, credential, sex, status, sole proprietor, enumeration + last-updated dates, plus `createdEpoch`/`lastUpdatedEpoch` millisecond timestamps), the authorized-official block (incl. `namePrefix`/`nameSuffix`) for organizations, **all** `taxonomies[]` (code, description, primary, license, state, taxonomy_group), `addresses[]` (purpose, address_type, lines, city/state/zip, country_code, country_name, phone/fax) — every row for an organization, `LOCATION` rows only for an individual — `identifiers[]`, `otherNames[]` (first/middle/last, prefix/suffix, org name, credential, type), `practiceLocations[]`, `endpoints[]` (endpoint, type/use/content codes + descriptions, `endpointDescription`, `useOtherDescription`, `contentOtherDescription`, affiliation, and the endpoint routing address incl. `line2`). NPPES's `"--"` placeholder on any name prefix/suffix (individual, authorized-official, or other-name) normalizes to absence. **Professional-practice fidelity** — medical/correctness-sensitive data; pass through every professional field, only renaming/normalizing field names and the `status` enum, never fabricating an absent value. The one deliberate omission is an individual's non-`LOCATION` address rows (Data scope, Design Decision 10).

**Enrichment:** `ctx.enrich.total(found.length)`; notice when some NPIs returned nothing, failed upstream, or failed the check digit.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `invalid_npi_format` | `ValidationError` | Every requested NPI failed the check digit, so none was looked up. (A non-10-digit NPI is rejected earlier by the schema as `invalid_arguments`.) | The last digit does not match the check digit, usually a typo or transposed digits — re-copy the NPI, or find it by name with `npi_search_providers`. |
| `none_found` | `NotFound` | Every requested NPI with a valid check digit returned a **confirmed** no-record response (`result_count 0`) — none failed operationally. Names any NPIs that failed the check digit. | Verify the NPI(s); deactivated or never-enumerated numbers return nothing. Search by name to confirm. |

Operational failures (registry unavailable, timeout, malformed body) are **not** `none_found`: a rejected leg — already retried by the service — propagates the underlying `ServiceUnavailable`/`Timeout` error when the whole batch fails, or lands in `errored[]` on a partial batch. `notFound[]` is reserved for confirmed absence (`result_count 0`); a failure is never reported as a miss, and a check-digit failure is neither. Partial results — confirmed, errored, or invalid — do **not** throw. `npi://provider/{npi}` declares the same `invalid_npi_format` for a failing NPI, alongside `no_record`.

### `npi_lookup_taxonomy`

Offline NUCC resolver. Mode-dispatched.

**Input:** `mode` (`resolve`/`get`/`browse`), `query?` (resolve term), `code?` (`get`, regex `^\d{3}[A-Z0-9]{6}X$` style — validate against the loaded set rather than a brittle regex), `grouping?` (browse filter by top-level grouping), `section?` (`Individual`|`Non-Individual` — browse filter by NPI type), `limit?` (1–50, default 20), `skip?` (0–1000, default 0 — page past a truncated `resolve`/`browse` result; keep query/filters and `limit` fixed and raise `skip` by `limit` each call; `get` rejects `limit`/`skip` as unknown arguments).

**Output** (discriminated by mode for `format()`-parity):

- `resolve` / `browse` → `matches: Array<{ code, grouping, classification, specialization?, displayName, definition?, section, status, replacedBy? }>` where `section` is `Individual` | `Non-Individual` (maps to NPI-1 vs NPI-2 provider type), `status` is `active` | `inactive`, and `replacedBy` is the replacement code NUCC names for an inactive code, plus `truncated` when capped.
- `get` → single entry (same fields, plus `notes?` — the trimmed NUCC Notes cell, absent when empty) or a `no_match` error. List modes omit `notes` to keep pages compact; `get` is the path to one code's full record.

**Inactive codes:** NUCC records inactivity only in Notes (`marked inactive`). The generator derives `status` from that and `replacedBy` from `use <code>` / `use value <code>` in Notes, then Definition, and fails the build if a replacement is missing or itself inactive. `resolve` sets inactive entries aside inside the match loop — before ranking and the `skip`/`limit` slice, so pages stay contiguous — and reports the ones a query matched, so `no_match` (and `npi_search_providers`' `unresolved_specialty`) names them and their replacements. `get`, `browse`, and the resource return inactive codes, flagged.

**Matching (resolve):** strict token match — normalize (lowercase, strip punctuation), stem common specialty word-forms (`cardiologist`/`cardiology` → `cardiolog`), and require every query term to start a word of the `classification`+`specialization`+`displayName` text. Word-start matching means `dentist` reaches "Dental" but not "Independent", and `urologist` reaches "Urology" but not "Neurology". NUCC compounds are matched by their parts: a word beginning with a combining form (`neuro`, `cyto`, `dermato`, `cardio`, `psycho`, … — enumerated from the bundled data) is also indexed by its remainder, so `radiologist` still matches Neuroradiology and `pathologist` Cytopathology. A bare `therapist` matches the word "Therapist" whole: its stem `therap` also starts "therapy" and "therapeutic", which name treatments and physician specialties (Therapeutic Radiology), not the profession. A qualified query (`radiation therapist`, `occupational therapist`) keeps the wider word-start match. A one-letter query token matches only a whole word: as a word start it would match every word beginning with that letter. Before normalizing, a query's dotted abbreviation (single letters separated by periods) is joined into one word, so `P.A.`, `R.N.`, and `N.P.` resolve exactly as `pa`, `rn`, and `np`, and `M.D.` as the stop word `md`. `Ph.D.` is not a run of single letters and is left alone, and the index keeps NUCC's own text. Three query-side layers run first, all deterministic (the same category as the stemming, not a fuzzy layer):

- A **stop-word set** (`doctor`, `physician`, `specialist`, `provider`, `md`, `do`, each also in its plural form — `doctors`, `MDs`) is dropped from the required terms, so "heart doctor" and "heart doctors" both reduce to "heart" instead of carrying a word that appears in no entry. A dropped word still counts toward ranking: an entry whose own name carries it ranks ahead of its siblings, so "physician assistant" leads with Physician Assistant rather than Dental Assistant. A query made *only* of stop words (`physician`, `doctors`, `M.D.`, `do`, `specialist`, `providers`) names no specialty and matches nothing. `resolve` fails with `no_match`, and `npi_search_providers` `specialty` with `unresolved_specialty`, both before any upstream call, with a hint pointing to `browse`. For a stop word that names a physician, the hint names the `Allopathic & Osteopathic Physicians` grouping (Design Decision 18).
- An **alias table** maps everyday wording to NUCC's vocabulary: lay terms and abbreviations with no shared stem (`heart`→cardiovascular, `eye`→ophthalmology, `ent`→otolaryngology, `kidney`→nephrology/renal, `cancer`→oncology, `obgyn`→obstetrics/gynecology), spelling and naming differences (`orthopedist`/`orthopedic`→"Orthopaedic", `neurosurgeon`→"Neurological Surgery", `cardiac`→cardiovascular/cardiothoracic, `fertility`→infertility/reproductive endocrinology), credential abbreviations (`rn`→Registered Nurse, `np`→Nurse Practitioner, `pa`→Physician Assistant, `crna`→Certified Registered Nurse Anesthetist, `lpn`/`lvn`→Licensed Practical/Vocational Nurse, `emt`→every Emergency Medical Technician level, `er`→Emergency Medicine), and two-word phrases (`speech therapist`→"Speech-Language Pathologist", `primary care`→Family Medicine/Internal Medicine). A key matches as a *whole word*, so a short abbreviation like `ent` reaches Otolaryngology rather than landing inside `gastroENTerology`.
- A **preferred-entry table** names the representative general entry for a bare specialist term whose candidates otherwise tie: `oncologist`/`cancer`→Medical Oncology, `endocrinologist`→Endocrinology, Diabetes & Metabolism, `hematologist`→Hematology (Internal Medicine), `radiologist`→Diagnostic Radiology, `pathologist`→Anatomic Pathology & Clinical Pathology, `geriatrician`→Geriatric Medicine (Internal Medicine), `pharmacist`→Pharmacist, `emt`→Basic Emergency Medical Technician (not the shorter-named Paramedic). It applies only when the query reduces to one token, and only reorders.

Ranking, each signal lowest-first: preferred entry → physician grouping → the query names the entry's own specialty label (a dropped stop word in that label ranks higher still) → alias match → non-pediatric → shorter label → code. An entry is pediatric when its specialization says so, or, unless the query names pediatrics, when its classification is Pediatrics — so `sports medicine` leads with a Family Medicine code while `pediatric sports medicine` still reaches the Pediatrics one. Ranking never changes the match set. Strict-only is the ~90% case for an LLM caller; **no fuzzy fallback** (a model self-corrects better from "no match — browse the hierarchy" than from an approximate guess). Documented in the handler.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_match` | `NotFound` | `get` code matched nothing, or `resolve` query matched no active entry (the message names any inactive codes it matched) | Try a broader term, or use mode `browse` to walk groupings → classifications. An inactive-only match carries its own hint: use a named replacement or read the inactive entry with `get`. A stop-word-only query (`physician`, `M.D.`, `specialists`, …) carries a `browse` hint, naming the `Allopathic & Osteopathic Physicians` grouping for the physician words. |

---

## Workflow Analysis

Only `npi_get_provider` makes ≥1 upstream call per item (fan-out); `npi_search_providers` is a single call plus a local taxonomy lookup. No tool exceeds the "≥3 upstream calls" threshold for full call-flow tables, but the two non-trivial flows:

**`npi_search_providers`** (1 upstream call + local resolution):

| # | Call | Purpose |
|:--|:-----|:--------|
| 0 | `taxonomyService.resolve(specialty)` | local — plain term → `taxonomy_description`(s); throw `unresolved_specialty` on empty |
| 1 | `GET /api/?version=2.1&{params}` | the search (plus `address_purpose=LOCATION` when a location field is set); inspect 200 body for `Errors[]` → throw mapped error |
| 2 | normalize + slice + enrich | compact rows, echo resolved taxonomy, disclose page-size-not-total |

**`npi_get_provider`** (N parallel calls, N ≤ 10):

| # | Call | Purpose | Notes |
|:--|:-----|:--------|:------|
| 0 | check digit per NPI | local — failing NPIs go to `invalid[]` and are not fetched | all-invalid throws `invalid_npi_format` |
| 1..N | `GET /api/?version=2.1&number={npi}` | one per valid NPI, `Promise.allSettled` | fulfilled → 0/1 record; rejected → an operational failure (service/timeout/malformed body, already retried by the service) |
| N+1 | merge | partition → `found[]` / `notFound[]` (confirmed absence) / `errored[]` (operational failure), alongside `invalid[]`; all-confirmed-miss throws `none_found`, all-failed re-throws the underlying upstream error | partial success is the norm |

---

## Design Decisions

1. **Three tools, not four — `npi_find_by_specialty_location` folded into `npi_search_providers`.** The sketch floated a specialty+location convenience workflow. But `npi_search_providers` already accepts `specialty` + `city`/`state`/`postal_code` and does the NUCC resolution; a second tool would be the same upstream call with a renamed input subset — pure surface duplication and extra tool-selection load. "Endocrinologists in Seattle, WA" is already a single `npi_search_providers` call. Cut it; the search tool's `specialty` describe-text names the use case.

2. **`specialty` (resolved) and `taxonomy_description` (raw) are separate inputs.** The convenience-shortcut pattern: `specialty` is the 80%-case plain-language input that routes through NUCC; `taxonomy_description` is the escape hatch for callers holding an exact description. The substring-matching quirk (confirmed: "cardiology" matches "Pharmacist, Cardiology") makes resolution worth its keep — it turns a vague term into the *precise* description, and echoing the match back lets the agent see and correct it.

3. **`Errors[]`-on-200 handled in the service, surfaced as typed contract reasons.** The API's habit of returning HTTP 200 with an error body (never a 4xx) is the single biggest correctness trap. The service inspects every 200 for `Errors[]` and throws; tools map the common field errors to `no_search_criteria` / `invalid_npi_format` / `invalid_search_field` so the agent gets a real recovery path instead of an empty `results[]` it misreads as "no providers exist." The same inspection validates the success shape: a 200 body that is neither a non-empty `Errors[]` nor well-formed `results[]` is a `ServiceUnavailable` raised inside the retry, because treating it as an empty result or defaulting an unknown `status`/`enumeration_type` would fabricate a miss or a provider state.

4. **`result_count` is disclosed as page-size, never as a total.** Confirmed the API returns `result_count` = returned rows, with no grand-total field anywhere. Honest output says "showing N (at least N match)" and, on a full page, flags truncation with the narrow-your-query steer. Inventing or implying a total would be fabricated signal.

5. **Pagination ceiling is a first-class, disclosed constraint.** `skip` ≤ 1000 + `limit` ≤ 200 = 1200 reachable matches, and over-skip **silently clamps** (no error) — confirmed `skip=1000…2000` return the identical record. The `skip` describe-text and the truncation enrichment both name the wall, and a full page names the exact next page (`nextPage`) — never a `skip` past 1000 — because an agent paging blind would otherwise loop on the same window forever.

6. **`npi_get_provider` fans out and reports partial success.** No batch endpoint exists, so N parallel single-NPI calls with `Promise.allSettled`. Per-item `found[]`/`notFound[]`/`errored[]`/`invalid[]` (not a thrown error on the first miss) because mixed valid/deactivated/typo NPI sets are the realistic input. Client-side 10-digit regex validation avoids burning a round trip on the API's 200+`Errors[]` for malformed NPIs. The check digit is verified in the handler, not the schema: a schema refinement would reject a whole batch over one typo, and a check-digit failure is recoverable, so it belongs on a declared contract reason with per-NPI reporting. It stays out of the service, which serves any 10-digit number the registry accepts.

7. **NUCC bundled in-memory, not mirrored or canvas'd.** 883 static rows that change twice a year → load the CSV into a `Map` at `setup()`. `MirrorService` (SQLite+FTS5) is for 10⁴–10⁷ rows; DataCanvas is for analytical row sets; `ctx.state` is tenant-scoped. None fit reference data this small and global. Refresh = re-bundle the CSV at maintenance time.

8. **No prompts, two thin resources.** Pure lookup domain — no recurring multi-step interaction to template. Resources (`npi://provider/{npi}`, `npi://taxonomy/{code}`) are convenience twins of existing tools for resource-capable clients; the tool surface is fully self-sufficient for tool-only clients.

9. **Name `npi-providers`, prefix `npi_`.** "NPI" is a non-obvious acronym, so the `-providers` domain suffix earns its place (the skill's `{acronym}-{domain}` pattern). Not `nppes_` — the registry name is more opaque than NPI, which agents at least see on every claim/prescription.

10. **Only LOCATION address rows are kept for individual providers.** Reverses the original "not a redaction concern" stance. An individual's (NPI-1) `MAILING` row — address, phone, and fax — can be a home, differed from the practice location on most live individual records sampled, and contradicts the server's own "no personal or home data" scope. Withholding happens in `normalizeRecord()`, so `npi_get_provider` and `npi://provider/{npi}` share one rule, and it fails closed: any record not confirmed NPI-2 is treated as an individual, and for individuals every non-`LOCATION` row is withheld — `MAILING` and any row with a missing or unrecognized purpose alike. Search rows take city/state/ZIP from the `LOCATION` row by purpose (never by array index — live NPPES often lists `MAILING` first). Organization mailing addresses, `LOCATION` phone/fax, and `practiceLocations[]` stay: they are business contact data.

11. **Location searches match practice addresses upstream; the post-filter stays.** A search with `city`, `state`, or `postal_code` sends `address_purpose=LOCATION`, so mailing-only rows no longer take page slots and `skip` offsets inside the 1200-row window. The server-side filter keeps running as the guarantee that every returned row has one practice location matching every requested field, which the upstream parameter alone does not promise for fields split across locations.

12. **NUCC Notes ride `get` only.** The Notes column carries sources, revision history, and status remarks worth reading for one code, but adding it to list modes grows a worst-case 50-entry `browse` page by more than half. `get` and the resource return it; `resolve` and `browse` omit it.

13. **Inactive codes never resolve, but stay reachable.** A plain-language term should never send an inactive code to NPPES, so `resolve` (and with it `specialty` resolution) excludes them; `get`, `browse`, and the resource keep them flagged, since a claim or record can still carry one. Status is derived at build time from the `marked inactive` Notes marker — not the `Deactivated - ` display-name prefix, which NUCC dropped in v26.1 — so a refresh that breaks a replacement fails the build instead of shipping. There is no opt-in to resolve inactive codes; `taxonomy_description` passthrough still searches any description verbatim.

14. **Resolver precision comes from curated, enumerated tables, not fuzzy matching.** Query terms match at word starts, with a combining-form list enumerated from the bundled code set so legitimate compounds (Neuroradiology, Cytopathology) still match. Everyday wording NUCC doesn't use goes through the alias table, and a bare specialist term's representative entry through the preferred-entry table. A classification heuristic (prefer Internal/Family Medicine, demote Surgery and OB/GYN) was rejected: it left hematologist, radiologist, pathologist, and pharmacist wrong and moved `surgeon` to Plastic Surgery. Edit-distance matching would cover spelling variants without a table, but callers could no longer predict or audit a match.

15. **A row is marked as an other-name match only when that is provable.** The registry's first-name variant table is unpublished, so a current first name that differs from an exact `first_name` may still be a variant match (ROB for Robert); the rule therefore decides on `last_name`, `organization_name`, and wildcard `first_name` (which disables variants), comparing after folding case, punctuation, and spaces — never more strictly than the registry. It under-marks rather than over-marks: a provider whose other name supplies only an exact first name stays unmarked. Rows are labelled, never dropped or reordered, since the registry's current-name sort decides which rows are reachable at all.

16. **Past the 1200-match window, continue by practice ZIP prefix, driven by the caller.** Every US practice address carries a 5- or 9-digit ZIP, so the children of a 2–4 digit prefix (and of a 6–8 digit ZIP+4 prefix) cover it exactly; the union of `last_name=Smith, first_name=KE*`'s 2-digit leaves equals the parent (1,130 NPIs, 0 missing, 0 extra, 55 duplicates across leaves). Measured 2026-09-24, a national common surname splits below 1,200 within 3 digits and Family Medicine in CA within 4. The tool returns the next partition rather than walking it: `last_name=Smith` alone needs ≥329 sequential upstream pages. Other keys fail as partitions — `state` takes no wildcard, name prefixes overlap through other names and cannot express 1-character names, `taxonomy_description` is substring-matched. A 5-digit ZIP is the floor (its ZIP+4 children miss practice addresses recorded with only the 5 digits — 45 of 600 sampled at 77030; 77030, 10032, 55905, and 02115 each exceed 1,200 individual practitioners), and non-US practice addresses have no numeric ZIP; the tool names both dead ends. An exhaustive path would need the NPPES bulk file (≈1.1 GB zipped, ≈11.7 GB CSV monthly), a separate feature.

17. **Mixed individual/organization criteria fail in the handler, not the schema.** NPPES answers every such mix with error `13`, which reads as a generic field error. A root schema refinement would surface as `invalid_arguments` with a fixed message, and it can't be advertised in `inputSchema` anyway. The handler raises a typed `mixed_provider_criteria` whose message and hint list exactly the fields on each side, and it runs before specialty resolution and any request.

18. **A query made only of stop words fails with a `browse` hint instead of matching its own stems.** This replaces the earlier fallback that kept stop words as required terms when nothing else remained. That fallback answered `physician` (stem `physic`) with Radiological Physics and `do` with Doula: stem-prefix hits on unrelated words, never the physician the caller meant. The fallback's intent was that a stop-word-only query never comes back silently empty. That intent is kept: the query fails with `no_match` (or `unresolved_specialty` in `npi_search_providers`) and a hint to `browse`, naming the `Allopathic & Osteopathic Physicians` grouping when the words name a physician. A stop word counts in its plural form too (`physicians`, `doctors`, `MDs`), both for stripping and for the stop-word-only check, so `heart doctors` resolves exactly as `heart doctor` and `physicians` alone takes the `browse` path. A query with any other word is unaffected.

---

## Known Limitations

- **No total match count.** The registry never reports how many providers match a query — only the returned page. Counts are always "at least N."
- **1200-match reachable ceiling.** Broad queries (e.g. `last_name=smith`) have far more than 1200 matches, but only the first 1200 of one search are paginable. The server can't remove that constraint; it names the next page, and at the terminal window returns the practice-ZIP-prefix partition that continues the search (Design Decision 16). That partition is caller-driven, one search per prefix, and can't finish two cases: a single 5-digit ZIP holding more than 1,200 matches (77030, 10032, 55905, and 02115 do for individual practitioners), and providers whose practice addresses are all outside the US. For those the tool says no postal split remains; narrowing by name, specialty, or provider type reaches other subsets but guarantees no complete listing.
- **Other names crowd name searches.** Because the registry matches other names and sorts by current name, a common surname's reachable window can hold no current-name match at all (`last_name=Smith` → 1,200 former-name Smiths, ABBIATI … HUGGINS). Rows say so through `matchedOtherName`; narrowing (`state`, `first_name`, a postal prefix) brings current-name matches into reach. A provider matched only through an exact first name on an other name (e.g. KENYONA SMITH, other name ROBERT BUFORD, for `first_name=Robert`) stays unmarked, since a first-name variant match can't be told apart from it.
- **Substring taxonomy matching upstream.** Even a NUCC-resolved `taxonomy_description` is matched as a substring by the API, so an over-broad description can pull adjacent specialties. Resolution narrows this but can't fully constrain it; the echoed match lets the agent judge.
- **Upstream location matching includes mailing addresses unless restricted.** Without `address_purpose=LOCATION`, NPPES matches the requested `city`/`state`/`postal_code` against a provider's mailing address as well as each practice location, with or without a specialty. Confirmed live on five 200-row pages: Seattle, WA individuals, organizations, and `taxonomy_description=Cardiovascular Disease`; `postal_code=98195`; `last_name=SMITH&state=WA`. Without the parameter, 3–32 rows per page matched only on `MAILING`. With it, none did, and every row with a matching practice location on the unrestricted page was still returned, secondary-location matches included. The server sends the parameter on every location search (Design Decision 11). The Salt Lake City, UT cardiologist a Seattle search returns practices at a Seattle secondary location, so the row is kept and names it in `matchedLocation`.
- **US-only, NPI-holders-only.** NPPES covers only US providers enumerated with an NPI. No international providers, no providers who never obtained an NPI.

---

## Implementation Order

1. **Config + server identity** — `src/config/server-config.ts` (`NPPES_API_BASE_URL`, `NPPES_TIMEOUT_MS`); `createApp({ name: 'npi-providers-mcp-server', title: 'npi-providers-mcp-server', instructions: <public-data scope note> })`. Remove the echo definitions.
2. **`taxonomy-service`** — bundle `nucc_taxonomy_<version>.csv` (currently `nucc_taxonomy_261.csv`) under `src/services/taxonomy/data/`; load to in-memory index at `setup()`; `resolve`/`get`/`browse` methods + types. (No network — testable in isolation first.)
3. **`nppes-service`** — `fetchWithTimeout` + `withRetry`; the `Errors[]`-on-200 detector; raw→domain normalization; search + get-by-number methods + types.
4. **`npi_lookup_taxonomy`** — pure local tool over `taxonomy-service` (no upstream; quickest to verify the resolver DX).
5. **`npi_search_providers`** — composes `taxonomy-service.resolve` + `nppes-service.search` + enrichment.
6. **`npi_get_provider`** — fan-out + partial success over `nppes-service`.
7. **Resources** — `npi://provider/{npi}`, `npi://taxonomy/{code}` (thin wrappers over the services).
8. Tests at each step — including a sparse-payload NPPES case and an `Errors[]`-on-200 case; `bun run devcheck` after each addition.

Each step is independently testable; the taxonomy service and the local tool (2, 4) land before any live-API wiring.

---

## API Reference

- **Base:** `GET https://npiregistry.cms.hhs.gov/api/?version=2.1` — keyless, the only endpoint. `version=2.1` is required.
- **Search params:** `number`, `enumeration_type` (`NPI-1`|`NPI-2`), `first_name`, `last_name`, `organization_name`, `taxonomy_description`, `city`, `state`, `postal_code`, `address_purpose` (`LOCATION`|`MAILING`|`PRIMARY`|`SECONDARY`), `limit` (1–200, default 10, over-cap clamps silently to 200), `skip` (0–1000; skip=1000 is valid; any value >1000 silently clamps to 1000 — verified: skip=1001, 1500, 2000 all return identical records to skip=1000), `use_first_name_alias` (bool).
- **Wildcards:** `*` on `first_name`, `last_name`, `organization_name`, `city`, `postal_code`; **≥2 leading characters required** (else `Errors: number:03`). Every `*` is stripped and the rest prefix-matched (`9*8` ≡ `98*`); `state` rejects `*` (`05`).
- **Name matching:** name fields match the current name and every `other_names[]` entry; apostrophes and spaces are ignored; an exact `first_name` also matches first-name variants (`use_first_name_alias`, default `True`, not applied to wildcards). Results sort by current last name, then first name. `last_name` with `enumeration_type=NPI-2` → `Errors` `13` (cannot mix type 1 and type 2 criteria).
- **Response:** `{ result_count: <page size>, results: [ … ] }`. `result_count` is the count of returned rows, **not** a grand total.
- **Error envelope:** HTTP **200** with `{ "Errors": [ { "description", "field", "number" } ] }`. Observed codes: `03` wildcard-too-short, `04` no valid search criteria, `05` field special-char/wrong-length (e.g. bad `enumeration_type`), `06` NPI not 10 digits, `07` field requires additional criteria (e.g. `state` alone). Genuine transport failures (5xx, timeout) return real HTTP status.
- **NUCC taxonomy:** `https://www.nucc.org/images/stories/CSV/nucc_taxonomy_<version>.csv` (current `261` = v26.1, effective 7/1/2026), **883 codes**, 28 of them marked inactive in Notes, columns `Code, Grouping, Classification, Specialization, Definition, Notes, Display Name, Section`. 3-level hierarchy (Grouping → Classification → Specialization). `Section` is either `Individual` or `Non-Individual` and maps to NPI-1 vs NPI-2 provider type — expose in the `browse` mode output so callers can pre-filter by provider type. Taxonomy code format: all 883 codes match `^\d{3}[A-Z0-9]{6}X$` (verified). Bundled on disk, refreshed on NUCC's twice-yearly cadence.
