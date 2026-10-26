<div align="center">
  <h1>@cyanheads/npi-providers-mcp-server</h1>
  <p><b>Search NPPES providers and resolve NUCC specialty codes via MCP over STDIO or Streamable HTTP.</b>
  <div>3 Tools • 2 Data Resources • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/npi-providers-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fnpi-providers-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/npi-providers-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/npi-providers-mcp-server/releases/latest/download/npi-providers-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=npi-providers-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbnBpLXByb3ZpZGVycy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22npi-providers-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnpi-providers-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://npi-providers.caseyjhand.com/mcp](https://npi-providers.caseyjhand.com/mcp)

</div>

---

## Overview

The US healthcare provider directory from the NPI Registry. Search doctors and organizations by name, location, and specialty in plain language, decode any NPI to its provider record, and browse the NUCC specialty taxonomy.

### Tools

| Tool | Description |
|:---|:---|
| `npi_search_providers` | Search the NPPES registry by name, organization, location, provider type, and specialty. Plain-language specialties resolve through the bundled NUCC taxonomy before searching. |
| `npi_get_provider` | Fetch the NPPES professional-practice record for up to 10 NPIs — taxonomies, practice addresses, credentials, identifiers, endpoints, and status. Only LOCATION address rows are kept for individual providers. |
| `npi_lookup_taxonomy` | Resolve, fetch, or browse the NUCC Healthcare Provider Taxonomy — fully offline. |

### Resources

| Resource | Description |
|:---|:---|
| `npi://provider/{npi}` | A single provider's decoded record by NPI — the resource twin of `npi_get_provider`. |
| `npi://taxonomy/{code}` | A single NUCC taxonomy entry by code — the resource twin of `npi_lookup_taxonomy` mode `get`. |

All resource data is also reachable via tools; the resources are convenience twins for resource-capable clients.

The bundled `npi-providers-guide` skill is available at `skill://npi-providers-guide/SKILL.md`. It covers specialty cohorts, provider identity, and the limits of exhaustive directory searches.

## Capability reference

### `npi_search_providers` <sub>tool</sub>

- Inputs: `name_search` or `first_name` / `last_name` (individuals), `organization_name` (organizations), `provider_type`, `city` / `state` / `postal_code` (practice addresses only), and a plain-language `specialty` resolved through the bundled NUCC taxonomy, or an exact `taxonomy_description` (never both). At least one criterion is required, state alone is rejected, and individual and organization criteria can't be mixed. A trailing `*` needs at least 2 leading characters; `postal_code` takes 5 or 9 digits or a 2–9 digit prefix ending in `*`. Positive `limit` (clamped to 200, default 10), `skip` 0–1000. Optional `use_first_name_alias` controls upstream first-name variants; omitted defaults to true for a non-wildcard first name. When supplied for a wildcard/no-first-name search, the option is reported as inapplicable
- Output: compact rows (`npi`, name, primary taxonomy, primary practice `city` / `state` / `postalCode`, `status`), with `matchedLocation` / `matchedOtherName` naming the practice location or other name a row matched through, and `resolvedTaxonomies` / `appliedTaxonomyDescription` echoing the specialty resolution. `appliedFirstNameAlias` reports the effective boolean only for a non-wildcard first name. No true total is reported: a full page names `nextPage`, and the terminal window (`skip` 1000, `limit` 200) returns `continuationPostalCodes` that continue the search
- Typed error reasons: `no_search_criteria`, `conflicting_specialty`, `mixed_provider_criteria`, `unresolved_specialty`, `invalid_search_field`

---

### `npi_get_provider` <sub>tool</sub>

- Accepts `npis`: a single NPI or up to 100 raw entries, each exactly 10 digits. Deduplicates, checks every check digit, then looks up the first 10 distinct valid NPIs; optional `unprocessed` lists the remaining valid NPIs in order. With `NPI_CLAMP_LIMITS=false`, the raw array maximum is 10
- Partitions the batch into `found` (decoded records: taxonomies with license, practice addresses, credential, identifiers, FHIR/Direct endpoints, status — only LOCATION address rows for individual providers, so their mailing address is withheld), `notFound` (confirmed absence), `errored` (upstream failure — retry these), and `invalid` (failed the check digit, never looked up)
- Typed error reasons: `invalid_npi_format` (every NPI failed the check digit), `none_found` (every NPI looked up is a confirmed absence); an upstream failure surfaces as that underlying error instead. Error messages and structured error data retain every invalid NPI and any unprocessed remainder

---

### `npi_lookup_taxonomy` <sub>tool</sub>

- Modes: `resolve` (`query` → matching active codes), `get` (exact `code` → full entry with NUCC's `notes`), `browse` (walk grouping → classification → specialization, filterable by `grouping` and NUCC `section`). Section describes the taxonomy category, not a provider's NPI entity type; use search's `provider_type` for that. `resolve` / `browse` take positive `limit` (clamped to 50, default 20) and `skip` (0–1000) and disclose `truncated`; wrong-mode arguments are rejected before defaults apply
- Every entry carries `status` (`active` / `inactive`) and an inactive code's `replacedBy`; `resolve` excludes inactive codes, while `get` and `browse` return them. A resolved entry's `specialization` (or `classification` when absent) is the exact value `npi_search_providers.taxonomy_description` accepts
- Definitions and notes contain readable line breaks and list bullets in place of NUCC HTML markup; literal markers and source text remain intact
- Typed error reasons: `no_match`, `missing_argument`, `wrong_mode_argument`

---

### `npi://provider/{npi}` <sub>resource</sub>

- Returns the same decoded record as `npi_get_provider`, for one NPI, as `application/json` — only LOCATION address rows are kept for individual providers
- `npi` must be a well-formed 10-digit NPI; `invalid_npi_format` when it fails the NPI check digit (no registry request), `no_record` when the registry has none (deactivated or never enumerated)

---

### `npi://taxonomy/{code}` <sub>resource</sub>

- Returns the same entry as `npi_lookup_taxonomy` mode `get` (NUCC `notes`, `status`, and `replacedBy` included; inactive codes stay readable), as `application/json`; cached publicly for 24 hours
- `code` must match `^\d{3}[A-Z0-9]{6}X$`; `no_match` when no entry exists for the code

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NPI/NPPES-specific:

- **Keyless** — runs against the public CMS NPPES NPI Registry API (v2.1) with no API key or account
- **Bundled NUCC taxonomy** — the 883-code Healthcare Provider Taxonomy (v26.1) ships in the image and loads into an in-memory index at startup, so specialty resolution and code lookups work fully offline with no second upstream
- Specialty resolution turns a vague term ("heart doctor") into the precise taxonomy description the registry filters on, and echoes the match back for the agent to verify
- Detects the registry's quirk of returning HTTP 200 with an `Errors[]` body on validation failure and maps it to typed, recoverable error reasons

Agent-friendly output:

- Provenance on search — the resolved taxonomy and the exact `taxonomy_description` sent to the registry are echoed back, so agents can see what was actually searched and re-run with a different code
- Honest pagination — the returned count is disclosed as the page size, never a fabricated grand total; a full page names the exact next page, and a broad query that hits the 1200-match reachable ceiling gets the postal-code prefixes that continue it
- Graceful partial failure — `npi_get_provider` returns per-NPI `found` / `notFound` / `errored` / `invalid` rows instead of failing the whole batch

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http npi-providers-mcp-server https://npi-providers.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add npi-providers-mcp-server -- npx -y @cyanheads/npi-providers-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "npi-providers-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/npi-providers-mcp-server"]
    }
  }
}
```

No API key is required. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

No required variables — the server runs out of the box against the keyless NPPES registry. All variables below are optional overrides.

| Variable | Description | Default |
|:---|:---|:---|
| `NPPES_API_BASE_URL` | NPPES NPI Registry API base URL. Override for a private mirror or testing. | `https://npiregistry.cms.hhs.gov/api` |
| `NPPES_TIMEOUT_MS` | Per-request HTTP timeout for NPPES calls, in milliseconds. | `15000` |
| `NPI_CLAMP_LIMITS` | Clamp search limits to 200 and taxonomy limits to 50; accept 100 raw NPIs while looking up ten distinct valid NPIs. False restores schema upper bounds of 200, 50 and ten raw NPIs. Every actual clamp emits a notice, log and counter event. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto`. This server pins `stateless`; the schema default `auto` resolves to `stateful`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). The NPPES registry is keyless and the NUCC taxonomy is bundled.

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/npi-providers-mcp-server.git
  cd npi-providers-mcp-server && bun install
  cp .env.example .env   # optional NPPES base URL and timeout overrides
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t npi-providers-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=http -p 3010:3010 npi-providers-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/npi-providers-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and resources, inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/nppes` | NPPES NPI Registry API client — query building, `Errors[]`-on-200 detection, normalization. |
| `src/services/taxonomy` | Bundled NUCC taxonomy service — in-memory index for resolve / get / browse. |
| `skills/` | Published agent guide, delivered with the package and over MCP. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources in the `createApp()` arrays
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Data attribution

Provider data from the [CMS NPPES NPI Registry](https://npiregistry.cms.hhs.gov/) (public domain). The bundled specialty codes are the [NUCC Health Care Provider Taxonomy](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40), © American Medical Association on behalf of the National Uniform Claim Committee (NUCC), redistributed unmodified beyond formatting under the [NUCC permission](https://www.nucc.org/index.php/nucc-structure-mainmenu-36/contact-us-mainmenu-34?id=111). See [`NOTICE`](NOTICE).

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
