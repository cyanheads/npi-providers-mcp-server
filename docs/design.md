# npi-providers-mcp-server — Design

US healthcare provider directory over the live, keyless **NPPES NPI Registry API v2.1** (`https://npiregistry.cms.hhs.gov/api/?version=2.1`), plus a bundled **NUCC Healthcare Provider Taxonomy** code set (879 codes) for offline specialty resolution. Look up any physician, practitioner, or organization by NPI, name, specialty, or location; decode its professional-practice record (taxonomies, practice addresses, credentials, identifiers, endpoints, status — only LOCATION address rows are kept for individual providers).

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `npi_search_providers` | Search the NPPES registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. The specialty filter accepts plain-language terms (e.g. "cardiologist") and resolves them to the registry's taxonomy descriptions before searching. Returns a compact result row per provider — NPI, name, primary specialty, city/state/ZIP (plus the matching practice location when a location search matched a secondary one), enumeration type, and active/deactivated status — suitable for disambiguation; call `npi_get_provider` with an NPI for the full record. | `name_search?`, `first_name?`, `last_name?`, `organization_name?`, `specialty?`, `taxonomy_description?`, `provider_type?` (`individual`/`organization`), `city?`, `state?`, `postal_code?`, `limit?` (1–200, default 10), `skip?` (0–1000) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_get_provider` | Fetch the NPPES professional-practice record for one or more NPI numbers (up to 10 per call). Returns every taxonomy with its primary flag, license number and state; practice addresses with phone/fax (only LOCATION rows are kept for individual providers, so their mailing address is withheld; organizations also carry their mailing address); credential, sex, sole-proprietor flag; enumeration and last-updated dates; active/deactivated status; secondary identifiers (Medicaid, etc.); and FHIR/Direct endpoints. This is the decode tool — turn an NPI from a claim, prescription, or another health server into a known provider. | `npis` (string or array of up to 10, each 10 digits with a valid check digit) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_lookup_taxonomy` | Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses. Fully offline (bundled). Modes: `resolve` turns a plain-language specialty into matching taxonomy codes and their canonical descriptions (the value the search tools filter on); `get` returns the full entry for an exact code; `browse` walks the hierarchy (grouping → classification → specialization). Grounds the `specialty` filter the search tools accept, so a weak query like "heart doctor" maps to the correct code instead of returning nothing. | `mode` (`resolve`/`get`/`browse`), `query?` (resolve), `code?` (get), `grouping?` (browse), `section?` (`Individual`\|`Non-Individual` — browse filter by NPI type), `limit?` (1–50, default 20) | `readOnlyHint: true`, `openWorldHint: false` |

Three tools. `npi_find_by_specialty_location` from the sketch is **folded into `npi_search_providers`** — the search tool already takes `specialty` + `city`/`state`/`postal_code`, so a separate workflow tool would duplicate the surface without earning its keep (see Design Decisions).

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `npi://provider/{npi}` | A single provider's decoded record by NPI number — the resource twin of `npi_get_provider` for one NPI, keeping the same LOCATION-only address rows for individual providers. Read-only, stable URI, useful as injectable context when an NPI is already known. | None (single record) |
| `npi://taxonomy/{code}` | A single NUCC taxonomy entry by code (grouping, classification, specialization, definition, display name). The resource twin of `npi_lookup_taxonomy` `mode: get`. | None (single record) |

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
- **Hard pagination ceiling.** `skip` max is **1000**, `limit` max **200** → only the first **1200 matches** are reachable, and `skip` beyond 1000 **silently clamps** (returns the same window, no error — confirmed `skip=1000…2000` all return the identical record). For broad queries this is a real footgun: the tool must disclose when results are capped and steer toward narrower filters rather than letting an agent page into a wall.
- **Quirky error envelope.** The API returns **HTTP 200 with an `{"Errors":[{description, field, number}]}` body** for validation failures — never a 4xx (confirmed across bad-NPI, no-criteria, bad-enum, wildcard-too-short, state-only cases). The service layer must detect `Errors[]` on a 200 and throw, mapping to the right MCP error code. Genuine HTTP 5xx/timeouts still bubble as `ServiceUnavailable`.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nppes-service` | NPPES NPI Registry API v2.1 (live HTTP). Builds the query, calls `fetchWithTimeout`, **inspects the 200 body for `Errors[]`** and throws on presence, normalizes the raw record into the domain shape. | `npi_search_providers`, `npi_get_provider`, `npi://provider/{npi}` |
| `taxonomy-service` | Bundled NUCC Healthcare Provider Taxonomy CSV (879 codes), loaded into an in-memory index at `setup()`. Strict-token resolve (plain term → code + description), exact get-by-code, hierarchy browse. No external dependency. | `npi_lookup_taxonomy`, `npi://taxonomy/{code}`, and the `specialty` resolution step inside `npi_search_providers` |

**Resilience (`nppes-service`).** `withRetry` around the full fetch+parse+validate pipeline; base delay ~500ms (the CMS API is generally fast and generous, ephemeral failures dominate). `fetchWithTimeout` handles non-OK → `ServiceUnavailable`. The `Errors[]`-on-200 check sits **inside** the retried method so a transient HTML error page (rare) classifies as transient, not `SerializationError`. So does shape validation: the body must be an object carrying either a non-empty `Errors` array or a `results` array, and every result must carry a 10-digit `number`, `enumeration_type` `NPI-1`/`NPI-2`, and a `basic` object with `status` `A`/`D`, with the six array fields (`taxonomies`, `addresses`, `practiceLocations`, `identifiers`, `other_names`, `endpoints`) arrays of objects when present and non-null, and every taxonomy carrying a non-blank string `code` (its identity — live pages carry one on every row). That is exactly what normalization needs to run without a native throw or an invented value: every other scalar it reads passes through `trimmed()` (or `epochNumber()` for the two epochs), so a wrong-typed scalar reads as absent. Anything else throws `ServiceUnavailable` from inside the retried closure — retried like unparseable JSON, then surfaced as an upstream failure, never a miss or a defaulted identity. One malformed row fails a whole search rather than being dropped (a dropped row would silently shrink a full page). Name is not required; an identity-only record is labelled `NPI <number>`.

**Taxonomy backend choice.** 879 rows → a plain in-memory `Map`/array index built once at startup (server-level, no framework primitive). Not `MirrorService` (overkill for <1k static rows), not `ctx.state` (global reference data, not tenant-scoped), not DataCanvas (categorical reference data, not analytical rows). Refreshed by re-bundling the CSV on NUCC's twice-yearly release cadence (a maintenance task, not a runtime fetch).

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

**Confirmed upstream search parameters** (probed live): `number` (NPI), `enumeration_type` (`NPI-1`/`NPI-2`), `first_name`, `last_name`, `organization_name`, `taxonomy_description`, `city`, `state`, `postal_code`, `address_purpose` (`LOCATION`/`MAILING`/`PRIMARY`/`SECONDARY`), `limit` (≤200), `skip` (≤1000), `use_first_name_alias`. Wildcards (`*`) allowed on name fields but **require ≥2 leading characters**. `state` alone is rejected ("requires additional search criteria"); `city`-only and `taxonomy_description`-only are accepted.

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
- `provider_type?` — `z.enum(['individual','organization'])` → maps to `enumeration_type` `NPI-1`/`NPI-2`. Omit to search both.
- `specialty?` — plain-language specialty (e.g. "pediatric cardiologist"). **Resolved through the bundled NUCC set** to one or more `taxonomy_description` values before the call. The matched taxonomy is echoed in output.
- `taxonomy_description?` — escape hatch: an exact NUCC description to pass through unresolved, for callers who already have it. Validate that `specialty` and `taxonomy_description` aren't both set.
- `city?`, `state?` (2-letter, regex `^[A-Z]{2}$`), `postal_code?` — location. Note in `state`'s describe that the API rejects state-only searches; pair it with another criterion.
- `limit?` — `z.number().int().min(1).max(200).default(10)`. Describe the 200 cap.
- `skip?` — `z.number().int().min(0).max(1000).default(0)`. Describe the 1000 ceiling and that **only the first 1200 matches are reachable**; beyond that, narrow the query.

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
  status: 'active' | 'deactivated';
}>
```

**Enrichment** (`ctx.enrich` — reaches both client surfaces):

- `ctx.enrich.echo(...)` — the resolved `taxonomy_description`(s) the `specialty` term mapped to (so the agent sees what was actually searched), plus the parsed criteria.
- **Practice-address location matching** — when `city`, `state`, or `postal_code` is provided, the service also sends `address_purpose=LOCATION`. Without it NPPES matches the requested location against a provider's mailing address as well as each practice location; with it the upstream match covers the primary `LOCATION` address and every `practiceLocations[]` entry but never the mailing address (Design Decision 11). A search with no location field sends no `address_purpose`.
- **Location post-filter** — the guarantee on top of that, so drops are now rare: when a location field is provided, the normalized rows are still filtered server-side. A row is kept when one professional location — the primary `LOCATION` address or a `practiceLocations[]` entry — satisfies every requested field on its own (`city`/`state` case-insensitive; `postal_code` prefix-matched to tolerate 5-vs-9-digit ZIP+4). A row whose only match is its `MAILING` row, or whose requested fields are split across two locations, is dropped. `city`/`state`/`postalCode` always describe the primary `LOCATION` address; a row kept on a secondary practice location also carries that location as `matchedLocation` (rendered as **Matched practice location** in `content[]`), so a Seattle search never shows a St. Louis address as a row's only location.
- `ctx.enrich.truncated({ shown, cap })` — when the *raw upstream page* hit `limit` (keyed on the pre-filter count, so post-filtering never hides a full page). `shown` is the count of rows kept after the location filter. Paired with a note: `result_count` is page size, not a grand total; more may exist; narrow filters or page with `skip` (≤1000).
- `ctx.enrich.notice(...)` — one notice assembled from fragments (last-wins): empty upstream result → broaden / check specialty resolution / drop `state`-only; upstream matched but no provider has a practice location matching every requested field → a distinct notice saying so; some rows dropped by the location filter → how many were filtered out.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_search_criteria` | `ValidationError` | No effective criterion provided (mirrors the API's `number:04`) | Provide at least one of name, organization, specialty, or city — state alone is not accepted by the registry. |
| `conflicting_specialty` | `ValidationError` | Both `specialty` and `taxonomy_description` were supplied | Pass either `specialty` (plain-language, resolved) or `taxonomy_description` (exact), not both. |
| `unresolved_specialty` | `NotFound` | `specialty` term matched no NUCC taxonomy | Call `npi_lookup_taxonomy` mode `resolve` to find a valid specialty, or pass `taxonomy_description` directly. |
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

**Input:** `mode` (`resolve`/`get`/`browse`), `query?` (resolve term), `code?` (`get`, regex `^\d{3}[A-Z0-9]{6}X$` style — validate against the loaded set rather than a brittle regex), `grouping?` (browse filter by top-level grouping), `section?` (`Individual`|`Non-Individual` — browse filter by NPI type), `limit?` (1–50, default 20), `skip?` (0–1000, default 0 — page past a truncated `resolve`/`browse` result; keep query/filters and `limit` fixed and raise `skip` by `limit` each call; ignored for `get`).

**Output** (discriminated by mode for `format()`-parity):

- `resolve` / `browse` → `matches: Array<{ code, grouping, classification, specialization?, displayName, definition?, section }>` where `section` is `Individual` | `Non-Individual` (maps to NPI-1 vs NPI-2 provider type), plus `truncated` when capped.
- `get` → single `entry` (same fields) or `none_found` error.

**Matching (resolve):** strict token match — normalize (lowercase, strip punctuation), require every query token to appear across the `classification`+`specialization`+`displayName` text. Two query-side normalization layers run first, both deterministic (the same category as the stemming, not a fuzzy layer): a **stop-word set** (`doctor`, `physician`, `specialist`, `provider`, `md`, `do`) is stripped so a plain-language phrase like "heart doctor" reduces to "heart" instead of carrying a token that appears in no entry; and a **lay-term alias table** maps abbreviations/colloquialisms that share no stem with the formal NUCC name (`heart`→cardiovascular, `eye`→ophthalmology, `ent`→otolaryngology, `kidney`→nephrology/renal, `cancer`→oncology, `obgyn`→obstetrics/gynecology) to the registry's vocabulary. Aliased base tokens match as *whole words*, not substrings, so a short abbreviation like `ent` reaches Otolaryngology rather than substring-hitting `gastroENTerology`. Strict-only is the ~90% case for an LLM caller; **no fuzzy fallback** (a model self-corrects better from "no match — browse the hierarchy" than from an approximate guess). Documented in the handler.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_match` | `NotFound` | `resolve` query or `get` code matched nothing | Try a broader term, or use mode `browse` to walk groupings → classifications. |

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

5. **Pagination ceiling is a first-class, disclosed constraint.** `skip` ≤ 1000 + `limit` ≤ 200 = 1200 reachable matches, and over-skip **silently clamps** (no error) — confirmed `skip=1000…2000` return the identical record. The `skip` describe-text and the truncation enrichment both name the wall, because an agent paging blind would otherwise loop on the same window forever.

6. **`npi_get_provider` fans out and reports partial success.** No batch endpoint exists, so N parallel single-NPI calls with `Promise.allSettled`. Per-item `found[]`/`notFound[]`/`errored[]`/`invalid[]` (not a thrown error on the first miss) because mixed valid/deactivated/typo NPI sets are the realistic input. Client-side 10-digit regex validation avoids burning a round trip on the API's 200+`Errors[]` for malformed NPIs. The check digit is verified in the handler, not the schema: a schema refinement would reject a whole batch over one typo, and a check-digit failure is recoverable, so it belongs on a declared contract reason with per-NPI reporting. It stays out of the service, which serves any 10-digit number the registry accepts.

7. **NUCC bundled in-memory, not mirrored or canvas'd.** 879 static rows that change twice a year → load the CSV into a `Map` at `setup()`. `MirrorService` (SQLite+FTS5) is for 10⁴–10⁷ rows; DataCanvas is for analytical row sets; `ctx.state` is tenant-scoped. None fit reference data this small and global. Refresh = re-bundle the CSV at maintenance time.

8. **No prompts, two thin resources.** Pure lookup domain — no recurring multi-step interaction to template. Resources (`npi://provider/{npi}`, `npi://taxonomy/{code}`) are convenience twins of existing tools for resource-capable clients; the tool surface is fully self-sufficient for tool-only clients.

9. **Name `npi-providers`, prefix `npi_`.** "NPI" is a non-obvious acronym, so the `-providers` domain suffix earns its place (the skill's `{acronym}-{domain}` pattern). Not `nppes_` — the registry name is more opaque than NPI, which agents at least see on every claim/prescription.

10. **Only LOCATION address rows are kept for individual providers.** Reverses the original "not a redaction concern" stance. An individual's (NPI-1) `MAILING` row — address, phone, and fax — can be a home, differed from the practice location on most live individual records sampled, and contradicts the server's own "no personal or home data" scope. Withholding happens in `normalizeRecord()`, so `npi_get_provider` and `npi://provider/{npi}` share one rule, and it fails closed: any record not confirmed NPI-2 is treated as an individual, and for individuals every non-`LOCATION` row is withheld — `MAILING` and any row with a missing or unrecognized purpose alike. Search rows take city/state/ZIP from the `LOCATION` row by purpose (never by array index — live NPPES often lists `MAILING` first). Organization mailing addresses, `LOCATION` phone/fax, and `practiceLocations[]` stay: they are business contact data.

11. **Location searches match practice addresses upstream; the post-filter stays.** A search with `city`, `state`, or `postal_code` sends `address_purpose=LOCATION`, so mailing-only rows no longer take page slots and `skip` offsets inside the 1200-row window. The server-side filter keeps running as the guarantee that every returned row has one practice location matching every requested field, which the upstream parameter alone does not promise for fields split across locations.

---

## Known Limitations

- **No total match count.** The registry never reports how many providers match a query — only the returned page. Counts are always "at least N."
- **1200-match reachable ceiling.** Broad queries (e.g. `last_name=smith`) have far more than 1200 matches, but only the first 1200 are paginable; the rest are unreachable without narrower filters. This is an upstream constraint the server discloses but can't remove.
- **Substring taxonomy matching upstream.** Even a NUCC-resolved `taxonomy_description` is matched as a substring by the API, so an over-broad description can pull adjacent specialties. Resolution narrows this but can't fully constrain it; the echoed match lets the agent judge.
- **Upstream location matching includes mailing addresses unless restricted.** Without `address_purpose=LOCATION`, NPPES matches the requested `city`/`state`/`postal_code` against a provider's mailing address as well as each practice location, with or without a specialty. Confirmed live on five 200-row pages: Seattle, WA individuals, organizations, and `taxonomy_description=Cardiovascular Disease`; `postal_code=98195`; `last_name=SMITH&state=WA`. Without the parameter, 3–32 rows per page matched only on `MAILING`. With it, none did, and every row with a matching practice location on the unrestricted page was still returned, secondary-location matches included. The server sends the parameter on every location search (Design Decision 11). The Salt Lake City, UT cardiologist a Seattle search returns practices at a Seattle secondary location, so the row is kept and names it in `matchedLocation`.
- **US-only, NPI-holders-only.** NPPES covers only US providers enumerated with an NPI. No international providers, no providers who never obtained an NPI.

---

## Implementation Order

1. **Config + server identity** — `src/config/server-config.ts` (`NPPES_API_BASE_URL`, `NPPES_TIMEOUT_MS`); `createApp({ name: 'npi-providers-mcp-server', title: 'npi-providers-mcp-server', instructions: <public-data scope note> })`. Remove the echo definitions.
2. **`taxonomy-service`** — bundle `nucc_taxonomy_250.csv` under `src/services/taxonomy/data/`; load to in-memory index at `setup()`; `resolve`/`get`/`browse` methods + types. (No network — testable in isolation first.)
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
- **Wildcards:** trailing `*` on name fields; **≥2 leading characters required** (else `Errors: number:03`).
- **Response:** `{ result_count: <page size>, results: [ … ] }`. `result_count` is the count of returned rows, **not** a grand total.
- **Error envelope:** HTTP **200** with `{ "Errors": [ { "description", "field", "number" } ] }`. Observed codes: `03` wildcard-too-short, `04` no valid search criteria, `05` field special-char/wrong-length (e.g. bad `enumeration_type`), `06` NPI not 10 digits, `07` field requires additional criteria (e.g. `state` alone). Genuine transport failures (5xx, timeout) return real HTTP status.
- **NUCC taxonomy:** `https://www.nucc.org/images/stories/CSV/nucc_taxonomy_<version>.csv` (current `250` = v25.0), **879 codes**, columns `Code, Grouping, Classification, Specialization, Definition, Notes, Display Name, Section`. 3-level hierarchy (Grouping → Classification → Specialization). `Section` is either `Individual` or `Non-Individual` and maps to NPI-1 vs NPI-2 provider type — expose in the `browse` mode output so callers can pre-filter by provider type. Taxonomy code format: all 879 codes match `^\d{3}[A-Z0-9]{6}X$` (verified). Bundled on disk, refreshed on NUCC's twice-yearly cadence.
