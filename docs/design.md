# npi-providers-mcp-server — Design

US healthcare provider directory over the live, keyless **NPPES NPI Registry API v2.1** (`https://npiregistry.cms.hhs.gov/api/?version=2.1`), plus a bundled **NUCC Healthcare Provider Taxonomy** code set (879 codes) for offline specialty resolution. Look up any physician, practitioner, or organization by NPI, name, specialty, or location; decode the full record (taxonomies, addresses, credentials, identifiers, status).

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `npi_search_providers` | Search the NPPES registry for individual practitioners and healthcare organizations by name, organization name, location, provider type, and specialty. The specialty filter accepts plain-language terms (e.g. "cardiologist") and resolves them to the registry's taxonomy descriptions before searching. Returns a compact result row per provider — NPI, name, primary specialty, city/state, enumeration type, and active/deactivated status — suitable for disambiguation; call `npi_get_provider` with an NPI for the full record. | `name_search?`, `first_name?`, `last_name?`, `organization_name?`, `specialty?`, `taxonomy_description?`, `provider_type?` (`individual`/`organization`), `city?`, `state?`, `postal_code?`, `limit?` (1–200, default 10), `skip?` (0–1000) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_get_provider` | Fetch the complete NPPES record for one or more NPI numbers (up to 10 per call). Returns every taxonomy with its primary flag, license number and state; all practice and mailing addresses; credential, gender, sole-proprietor flag; enumeration and last-updated dates; active/deactivated status; secondary identifiers (Medicaid, etc.); and FHIR/Direct endpoints. This is the decode tool — turn an NPI from a claim, prescription, or another health server into a known provider. | `npis` (string or array of up to 10, each 10 digits) | `readOnlyHint: true`, `openWorldHint: true` |
| `npi_lookup_taxonomy` | Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses. Fully offline (bundled). Modes: `resolve` turns a plain-language specialty into matching taxonomy codes and their canonical descriptions (the value the search tools filter on); `get` returns the full entry for an exact code; `browse` walks the hierarchy (grouping → classification → specialization). Grounds the `specialty` filter the search tools accept, so a weak query like "heart doctor" maps to the correct code instead of returning nothing. | `mode` (`resolve`/`get`/`browse`), `query?` (resolve), `code?` (get), `grouping?` (browse), `section?` (`Individual`\|`Non-Individual` — browse filter by NPI type), `limit?` (1–50, default 20) | `readOnlyHint: true`, `openWorldHint: false` |

Three tools. `npi_find_by_specialty_location` from the sketch is **folded into `npi_search_providers`** — the search tool already takes `specialty` + `city`/`state`/`postal_code`, so a separate workflow tool would duplicate the surface without earning its keep (see Design Decisions).

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `npi://provider/{npi}` | A single provider's full decoded record by NPI number — the resource twin of `npi_get_provider` for one NPI. Read-only, stable URI, useful as injectable context when an NPI is already known. | None (single record) |
| `npi://taxonomy/{code}` | A single NUCC taxonomy entry by code (grouping, classification, specialization, definition, display name). The resource twin of `npi_lookup_taxonomy` `mode: get`. | None (single record) |

Both resources are fully covered by the tool surface — they exist only as convenience for resource-capable clients. Tool-only clients lose nothing.

### Prompts

None. This is a data/lookup server with no recurring multi-step interaction pattern worth templating.

---

## Overview

**What it wraps.** NPPES (National Plan and Provider Enumeration System) is CMS's public directory of every US healthcare provider that holds an NPI (National Provider Identifier) — the identifier on every US claim, prescription, and EHR record. The registry exposes essentially **one parameterized search endpoint**; this server turns it into goal-shaped tools and adds the taxonomy-resolution layer the raw API lacks.

**Who it's for.** Health-IT, claims, and provider-data engineers; care-navigation and referral assistants; clinical-research ops resolving an investigator or site. Agents resolving an NPI → name + specialty, or finding providers by specialty and place.

**Where it sits.** The health cluster has drugs/devices (`openfda`), trials (`clinicaltrials`), literature (`pubmed`), surveillance (`cdc-health`, `who-gho`) — but no provider directory. This is the *who* layer the rest of the cluster references via the NPI.

**Data scope.** Public professional practice data only — name, practice/mailing address, specialty, credential, NPI. NPPES is a public directory by design; no home or personal data beyond what a provider self-publishes as practice info. A one-line scope note belongs in the server `instructions`, not a redaction concern.

---

## Requirements

- **Keyless.** No API key, no auth on the upstream. Server runs `MCP_AUTH_MODE=none`; no `auth` scopes on tools (read-only, public data).
- **Read-only.** No write path to NPPES exists; every tool is `readOnlyHint: true`.
- **Specialty resolution is the core DX win.** The API filters by `taxonomy_description` with **substring matching** — `taxonomy_description=cardiology` matches *"Pharmacist, Cardiology"* as readily as *"Cardiovascular Disease Physician"*. Plain specialty words must resolve through the bundled NUCC set to the precise description/code, and the **matched taxonomy must be surfaced in output** so the agent sees what it actually searched.
- **Status fidelity.** Records can be deactivated/reactivated. Surface `status` (`A` active / deactivated) and `last_updated` so an agent never treats a deactivated NPI as current.
- **Honest pagination.** `result_count` is the **returned page size, not the grand total** (confirmed: `limit=5` → `result_count: 5`). The API never reports a true match count. Output must say "showing N (at least N match)" — never imply a total it doesn't have.
- **Hard pagination ceiling.** `skip` max is **1000**, `limit` max **200** → only the first **1200 matches** are reachable, and `skip` beyond 1000 **silently clamps** (returns the same window, no error — confirmed `skip=1000…2000` all return the identical record). For broad queries this is a real footgun: the tool must disclose when results are capped and steer toward narrower filters rather than letting an agent page into a wall.
- **Quirky error envelope.** The API returns **HTTP 200 with an `{"Errors":[{description, field, number}]}` body** for validation failures — never a 4xx (confirmed across bad-NPI, no-criteria, bad-enum, wildcard-too-short, state-only cases). The service layer must detect `Errors[]` on a 200 and throw, mapping to the right MCP error code. Genuine HTTP 5xx/timeouts still bubble as `ServiceUnavailable`.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nppes-service` | NPPES NPI Registry API v2.1 (live HTTP). Builds the query, calls `fetchWithTimeout`, **inspects the 200 body for `Errors[]`** and throws on presence, normalizes the raw record into the domain shape. | `npi_search_providers`, `npi_get_provider`, `npi://provider/{npi}` |
| `taxonomy-service` | Bundled NUCC Healthcare Provider Taxonomy CSV (879 codes), loaded into an in-memory index at `setup()`. Strict-token resolve (plain term → code + description), exact get-by-code, hierarchy browse. No external dependency. | `npi_lookup_taxonomy`, `npi://taxonomy/{code}`, and the `specialty` resolution step inside `npi_search_providers` |

**Resilience (`nppes-service`).** `withRetry` around the full fetch+parse pipeline; base delay ~500ms (the CMS API is generally fast and generous, ephemeral failures dominate). `fetchWithTimeout` handles non-OK → `ServiceUnavailable`. The `Errors[]`-on-200 check sits **inside** the retried method so a transient HTML error page (rare) classifies as transient, not `SerializationError`.

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
- `basic` — individuals: `first_name`, `last_name`, `middle_name?`, `name_prefix?`, `credential?`, `sex?`, `sole_proprietor`, `status` (`A`/deactivated), `enumeration_date`, `last_updated`, `certification_date?`. Organizations: `organization_name`, `organizational_subpart`, `authorized_official_{first_name,last_name,credential,name_prefix,name_suffix,telephone_number,title_or_position}` fields, `status`, `enumeration_date`, `last_updated`, `certification_date?` (present on some org records, absent on others — treat as optional for both types).
- `taxonomies[]` — `code`, `desc`, `primary` (bool), `license?` (nullable), `state?` (nullable), `taxonomy_group`
- `addresses[]` — `address_purpose` (`LOCATION`/`MAILING`), `address_type` (`DOM`/`FOR`), `address_1`, `address_2?`, `city`, `state`, `postal_code`, `country_code`, `country_name`, `telephone_number?`, `fax_number?`
- `identifiers[]` — `code`, `desc`, `identifier`, `issuer?`, `state?` (often empty `[]`)
- `other_names[]` — former/DBA names (`first_name`, `middle_name?`, `last_name`, `prefix?`, `suffix?` or `organization_name`, `type`; the internal `code` ordinal is dropped)
- `practiceLocations[]`; `endpoints[]` (FHIR/Direct; often empty `[]`) — each endpoint carries `endpoint`, `endpointType`/`endpointTypeDescription`, `use`/`useDescription`, `contentType`/`contentTypeDescription`, `affiliation`/`affiliationName`, and a routing address block (`address_1`, `address_type`, `city`, `state`, `postal_code`, `country_code`, `country_name`)

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
  city?: string; state?: string; postalCode?: string;
  status: 'active' | 'deactivated';
}>
```

**Enrichment** (`ctx.enrich` — reaches both client surfaces):

- `ctx.enrich.echo(...)` — the resolved `taxonomy_description`(s) the `specialty` term mapped to (so the agent sees what was actually searched), plus the parsed criteria.
- **Location post-filter** — when `city`, `state`, or `postal_code` is provided, the normalized rows are filtered server-side to the requested location, because NPPES does **not** treat location as a hard filter for specialty searches and returns out-of-location rows (`city` case-insensitive; `postal_code` prefix-matched to tolerate 5-vs-9-digit ZIP+4). The row carries `postalCode` so `postal_code` has something to filter against.
- `ctx.enrich.truncated({ shown, cap })` — when the *raw upstream page* hit `limit` (keyed on the pre-filter count, so post-filtering never hides a full page). `shown` is the count of rows kept after the location filter. Paired with a note: `result_count` is page size, not a grand total; more may exist; narrow filters or page with `skip` (≤1000).
- `ctx.enrich.notice(...)` — one notice assembled from fragments (last-wins): empty upstream result → broaden / check specialty resolution / drop `state`-only; upstream matched but nothing in the requested location → a distinct notice naming that NPPES doesn't hard-filter location; some rows dropped by the location filter → how many were filtered out.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `no_search_criteria` | `InvalidParams` | No effective criterion provided (mirrors the API's `number:04`) | Provide at least one of name, organization, specialty, or city — state alone is not accepted by the registry. |
| `unresolved_specialty` | `NotFound` | `specialty` term matched no NUCC taxonomy | Call `npi_lookup_taxonomy` mode `resolve` to find a valid specialty, or pass `taxonomy_description` directly. |
| `invalid_search_field` | `InvalidParams` | API returned `Errors[]` for a field (e.g. wildcard <2 chars, bad enumeration_type) | Read the field error; wildcards need ≥2 leading characters and state needs a companion filter. |

### `npi_get_provider`

Batch fetch by NPI. The API has no native multi-NPI filter, so the handler fans out one `number=` call per NPI in parallel (`Promise.allSettled`, bounded), each returning 0 or 1 record. Designed for partial success.

**Input:** `npis` — `z.union([NpiString, z.array(NpiString).max(10)])` where `NpiString = z.string().regex(/^\d{10}$/)`. Describe: a single NPI or up to 10; the 10-digit format is validated client-side (Zod) to avoid a round trip. Note: a valid 10-digit NPI that simply has no record returns `{"result_count":0,"results":[]}` (not `Errors[]`) — the service detects empty results and lands the NPI in `notFound[]`.

**Output** — full decoded records, partial-success shape:

```
found: Array<FullProviderRecord>   // see Domain Mapping record shape, normalized
notFound: Array<{ npi, reason }>   // confirmed absence: well-formed NPI, result_count 0
errored: Array<{ npi, reason }>    // upstream/transport failure (service unavailable, timeout) — unresolved, not absent; retry
```

`FullProviderRecord` carries: `npi`, `type`, basic block (name/org fields incl. name prefix/suffix, credential, sex, status, sole proprietor, enumeration + last-updated dates, plus `createdEpoch`/`lastUpdatedEpoch` millisecond timestamps), the authorized-official block (incl. `namePrefix`/`nameSuffix`) for organizations, **all** `taxonomies[]` (code, description, primary, license, state, taxonomy_group), **all** `addresses[]` (purpose, address_type, lines, city/state/zip, country_code, country_name, phone/fax), `identifiers[]`, `otherNames[]` (first/middle/last, prefix/suffix, org name, credential, type), `practiceLocations[]`, `endpoints[]` (endpoint, type/use/content codes + descriptions, affiliation, and the endpoint routing address). NPPES's `"--"` placeholder on any name prefix/suffix (individual, authorized-official, or other-name) normalizes to absence. **Curate-nothing fidelity** — medical/correctness-sensitive data; pass through the full record, only renaming/normalizing field names and the `status` enum.

**Enrichment:** `ctx.enrich.total(found.length)`; notice when some NPIs returned nothing.

**Errors:**

| reason | code | when | recovery |
|:-------|:-----|:-----|:---------|
| `invalid_npi_format` | `InvalidParams` | An NPI isn't exactly 10 digits (caught by Zod schema before the API call; the API would return `Errors: number:06` for the same input) | NPIs are exactly 10 digits — check the value; use `npi_search_providers` to find one by name. |
| `none_found` | `NotFound` | Every requested NPI returned a **confirmed** no-record response (`result_count 0`) — none failed operationally | Verify the NPI(s); deactivated or never-enumerated numbers return nothing. Search by name to confirm. |

Operational failures (registry unavailable, timeout) are **not** `none_found`: a rejected leg — already retried by the service — propagates the underlying `ServiceUnavailable`/`Timeout` error when the whole batch fails, or lands in `errored[]` on a partial batch. `notFound[]` is reserved for confirmed absence (`result_count 0`); a failure is never reported as a miss. Partial results — confirmed or errored — do **not** throw.

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
| 1 | `GET /api/?version=2.1&{params}` | the search; inspect 200 body for `Errors[]` → throw mapped error |
| 2 | normalize + slice + enrich | compact rows, echo resolved taxonomy, disclose page-size-not-total |

**`npi_get_provider`** (N parallel calls, N ≤ 10):

| # | Call | Purpose | Notes |
|:--|:-----|:--------|:------|
| 1..N | `GET /api/?version=2.1&number={npi}` | one per NPI, `Promise.allSettled` | fulfilled → 0/1 record; rejected → an operational failure (service/timeout, already retried by the service) |
| N+1 | merge | three-way partition → `found[]` / `notFound[]` (confirmed absence) / `errored[]` (operational failure); all-confirmed-miss throws `none_found`, all-failed re-throws the underlying upstream error | partial success is the norm |

---

## Design Decisions

1. **Three tools, not four — `npi_find_by_specialty_location` folded into `npi_search_providers`.** The sketch floated a specialty+location convenience workflow. But `npi_search_providers` already accepts `specialty` + `city`/`state`/`postal_code` and does the NUCC resolution; a second tool would be the same upstream call with a renamed input subset — pure surface duplication and extra tool-selection load. "Endocrinologists in Seattle, WA" is already a single `npi_search_providers` call. Cut it; the search tool's `specialty` describe-text names the use case.

2. **`specialty` (resolved) and `taxonomy_description` (raw) are separate inputs.** The convenience-shortcut pattern: `specialty` is the 80%-case plain-language input that routes through NUCC; `taxonomy_description` is the escape hatch for callers holding an exact description. The substring-matching quirk (confirmed: "cardiology" matches "Pharmacist, Cardiology") makes resolution worth its keep — it turns a vague term into the *precise* description, and echoing the match back lets the agent see and correct it.

3. **`Errors[]`-on-200 handled in the service, surfaced as typed contract reasons.** The API's habit of returning HTTP 200 with an error body (never a 4xx) is the single biggest correctness trap. The service inspects every 200 for `Errors[]` and throws; tools map the common field errors to `no_search_criteria` / `invalid_npi_format` / `invalid_search_field` so the agent gets a real recovery path instead of an empty `results[]` it misreads as "no providers exist."

4. **`result_count` is disclosed as page-size, never as a total.** Confirmed the API returns `result_count` = returned rows, with no grand-total field anywhere. Honest output says "showing N (at least N match)" and, on a full page, flags truncation with the narrow-your-query steer. Inventing or implying a total would be fabricated signal.

5. **Pagination ceiling is a first-class, disclosed constraint.** `skip` ≤ 1000 + `limit` ≤ 200 = 1200 reachable matches, and over-skip **silently clamps** (no error) — confirmed `skip=1000…2000` return the identical record. The `skip` describe-text and the truncation enrichment both name the wall, because an agent paging blind would otherwise loop on the same window forever.

6. **`npi_get_provider` fans out and reports partial success.** No batch endpoint exists, so N parallel single-NPI calls with `Promise.allSettled`. Per-item `found[]`/`notFound[]` (not a thrown error on the first miss) because mixed valid/deactivated/typo NPI sets are the realistic input. Client-side 10-digit regex validation avoids burning a round trip on the API's 200+`Errors[]` for malformed NPIs.

7. **NUCC bundled in-memory, not mirrored or canvas'd.** 879 static rows that change twice a year → load the CSV into a `Map` at `setup()`. `MirrorService` (SQLite+FTS5) is for 10⁴–10⁷ rows; DataCanvas is for analytical row sets; `ctx.state` is tenant-scoped. None fit reference data this small and global. Refresh = re-bundle the CSV at maintenance time.

8. **No prompts, two thin resources.** Pure lookup domain — no recurring multi-step interaction to template. Resources (`npi://provider/{npi}`, `npi://taxonomy/{code}`) are convenience twins of existing tools for resource-capable clients; the tool surface is fully self-sufficient for tool-only clients.

9. **Name `npi-providers`, prefix `npi_`.** "NPI" is a non-obvious acronym, so the `-providers` domain suffix earns its place (the skill's `{acronym}-{domain}` pattern). Not `nppes_` — the registry name is more opaque than NPI, which agents at least see on every claim/prescription.

---

## Known Limitations

- **No total match count.** The registry never reports how many providers match a query — only the returned page. Counts are always "at least N."
- **1200-match reachable ceiling.** Broad queries (e.g. `last_name=smith`) have far more than 1200 matches, but only the first 1200 are paginable; the rest are unreachable without narrower filters. This is an upstream constraint the server discloses but can't remove.
- **Substring taxonomy matching upstream.** Even a NUCC-resolved `taxonomy_description` is matched as a substring by the API, so an over-broad description can pull adjacent specialties. Resolution narrows this but can't fully constrain it; the echoed match lets the agent judge.
- **Location is not an upstream hard filter for specialty searches.** When `taxonomy_description` is present, NPPES returns providers outside the requested `city`/`state`/`postal_code` (confirmed live — e.g. a Seattle, WA cardiologist search returns Salt Lake City, UT rows whose own `LOCATION` address is out-of-state). The server post-filters the normalized rows to the requested location and discloses how many were dropped, but this is a server-side correction of upstream behavior, not an upstream capability.
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
