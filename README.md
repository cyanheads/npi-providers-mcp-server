<div align="center">
  <h1>@cyanheads/npi-providers-mcp-server</h1>
  <p><b>Search NPPES providers and resolve NUCC specialty codes via MCP over STDIO or Streamable HTTP.</b>
  <div>3 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/npi-providers-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fnpi-providers-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/npi-providers-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

US healthcare provider directory over the NPPES NPI Registry, with plain-language specialty terms resolved offline against a bundled NUCC taxonomy. Search providers by name, organization, location, and specialty; decode NPIs into professional-practice provider records; and resolve or browse the NUCC taxonomy directly. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

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

## Capability reference

### `npi_search_providers` <sub>tool</sub>

- Search by `name_search` shortcut, explicit `first_name` / `last_name`, `organization_name`, `city` / `state` / `postal_code`, and `provider_type` (`individual` / `organization`); at least one criterion is required and the registry rejects state-only searches
- Plain-language `specialty` resolves through the bundled NUCC taxonomy to the registry's exact description before searching, echoed back via `resolvedTaxonomies` / `appliedTaxonomyDescription`; `taxonomy_description` is an escape hatch for an already-known exact description (mutually exclusive with `specialty`)
- Trailing-wildcard (`*`) name/organization matching requires at least 2 leading characters
- Each row's `city` / `state` / `postalCode` is the primary practice location. A location search matches practice addresses only, never mailing addresses: a row is returned only when the primary practice location or another practice location matches every requested location field (any other row the registry returns is filtered out, with a `notice` counting it), and a row kept on another practice location names it in `matchedLocation`
- `limit` 1–200 (default 10), `skip` 0–1000; the registry never reports a true match total, only the first 1200 matches are reachable, and the response discloses page-size-not-total via `truncated` / `notice`
- Typed error reasons: `no_search_criteria`, `conflicting_specialty`, `unresolved_specialty`, `invalid_search_field`

---

### `npi_get_provider` <sub>tool</sub>

- Accepts a single NPI or up to 10; each must be exactly 10 digits, and each is checked against its NPI check digit before any API call
- Returns every taxonomy (with primary flag, license number and state), practice addresses with phone and fax, credential, sex, sole-proprietor flag, enumeration and last-updated dates, secondary identifiers, and FHIR/Direct endpoints (with their descriptions and routing address)
- Only LOCATION (practice) address rows are kept for individual providers, so their mailing address — often a home address — is withheld; organizations keep both LOCATION and MAILING rows
- Four-way partition: `found` (resolved records), `notFound` (confirmed absence — deactivated or never enumerated), `errored` (upstream failure, distinct from absence — retry these), `invalid` (failed the NPI check digit — never looked up)
- Throws `invalid_npi_format` when every requested NPI fails the check digit, and `none_found` only when every NPI looked up is a confirmed absence; an upstream failure on any NPI surfaces as that underlying error instead

---

### `npi_lookup_taxonomy` <sub>tool</sub>

- Three modes: `resolve` (plain-language term → matching codes/descriptions), `get` (exact code → full entry), `browse` (walk grouping → classification → specialization, filterable by grouping and NPI `section`)
- `resolve` / `browse` cap results at `limit` (≤50, default 20) and disclose `truncated`; page past the cap with `skip` (0–1000, raised by `limit` each call)
- A resolved entry's `specialization` (or `classification` when specialization is absent) is the exact value `npi_search_providers.taxonomy_description` accepts
- Typed error reasons: `no_match`, `missing_argument`

---

### `npi://provider/{npi}` <sub>resource</sub>

- Returns the same decoded record as `npi_get_provider`, for one NPI, as `application/json` — only LOCATION address rows are kept for individual providers
- `npi` must be a well-formed 10-digit NPI; `invalid_npi_format` when it fails the NPI check digit (no registry request), `no_record` when the registry has none (deactivated or never enumerated)

---

### `npi://taxonomy/{code}` <sub>resource</sub>

- Returns the same entry as `npi_lookup_taxonomy` mode `get`, as `application/json`; cached publicly for 24 hours
- `code` must match `^\d{3}[A-Z0-9]{6}X$`; `no_match` when no entry exists for the code

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

NPI/NPPES-specific:

- **Keyless** — runs against the public CMS NPPES NPI Registry API (v2.1) with no API key or account
- **Bundled NUCC taxonomy** — the 879-code Healthcare Provider Taxonomy (v25.0) ships in the image and loads into an in-memory index at startup, so specialty resolution and code lookups work fully offline with no second upstream
- Specialty resolution turns a vague term ("heart doctor") into the precise taxonomy description the registry filters on, and echoes the match back for the agent to verify
- Detects the registry's quirk of returning HTTP 200 with an `Errors[]` body on validation failure and maps it to typed, recoverable error reasons

Agent-friendly output:

- Provenance on search — the resolved taxonomy and the exact `taxonomy_description` sent to the registry are echoed back, so agents can see what was actually searched and re-run with a different code
- Honest pagination — the returned count is disclosed as the page size, never a fabricated grand total, with the 1200-match reachable ceiling surfaced when a broad query is capped
- Graceful partial failure — `npi_get_provider` returns per-NPI `found` / `notFound` / `errored` / `invalid` rows instead of failing the whole batch

## Getting started

### Public Hosted Instance

A public instance is available at `https://npi-providers.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "npi-providers-mcp-server": {
      "type": "streamable-http",
      "url": "https://npi-providers.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. No API key is required — the upstream NPPES registry is keyless.

```json
{
  "mcpServers": {
    "npi-providers-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/npi-providers-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "npi-providers-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/npi-providers-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "npi-providers-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/npi-providers-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key — the NPPES NPI Registry API is public and keyless. The NUCC taxonomy is bundled, so there is no second data source to provision.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/npi-providers-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd npi-providers-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env only if you need to override the NPPES base URL or timeout
```

## Configuration

No required variables — the server runs out of the box against the keyless NPPES registry. All variables below are optional overrides.

| Variable | Description | Default |
|:---|:---|:---|
| `NPPES_API_BASE_URL` | NPPES NPI Registry API base URL. Override for a private mirror or testing. | `https://npiregistry.cms.hhs.gov/api` |
| `NPPES_TIMEOUT_MS` | Per-request HTTP timeout for NPPES calls, in milliseconds. | `15000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto`. This server pins `stateless`; the schema default `auto` resolves to `stateful`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
