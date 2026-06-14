<div align="center">
  <h1>@cyanheads/npi-providers-mcp-server</h1>
  <p><b>Look up US healthcare providers in the NPPES NPI registry and resolve NUCC specialty codes via MCP. STDIO or Streamable HTTP.</b>
  <div>3 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/npi-providers-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/%40cyanheads%2Fnpi-providers-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/npi-providers-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/npi-providers-mcp-server/releases/latest/download/npi-providers-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=npi-providers-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbnBpLXByb3ZpZGVycy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22npi-providers-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fnpi-providers-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Three tools covering the provider directory — search the registry, decode an NPI to its full record, and resolve plain-language specialties through the bundled taxonomy:

| Tool | Description |
|:---|:---|
| `npi_search_providers` | Search the NPPES registry by name, organization, location, provider type, and specialty. Plain-language specialties resolve through the bundled NUCC taxonomy before searching. |
| `npi_get_provider` | Fetch the complete NPPES record for up to 10 NPIs — taxonomies, addresses, credentials, identifiers, endpoints, and status. |
| `npi_lookup_taxonomy` | Resolve, fetch, or browse the NUCC Healthcare Provider Taxonomy — fully offline. |

### `npi_search_providers`

Search the registry for individual practitioners and organizations, with specialty resolution and honest pagination disclosure.

- Search by `name_search` shortcut, explicit `first_name` / `last_name`, `organization_name`, `city` / `state` / `postal_code`, and `provider_type` (`individual` / `organization`)
- Plain-language `specialty` (e.g. "cardiologist") resolves through the bundled NUCC taxonomy to the registry's exact descriptions before searching; the resolved taxonomy is echoed back so you can see what was actually searched
- `taxonomy_description` escape hatch for callers who already hold an exact NUCC description (mutually exclusive with `specialty`)
- Trailing-wildcard (`*`) name matching, with the registry's ≥2-leading-character rule documented inline
- Discloses that the returned count is the page size — never a grand total — and that only the first 1200 matches are reachable, steering broad queries toward narrower filters

---

### `npi_get_provider`

Decode one or more NPIs into fully populated provider profiles — the tool to turn an NPI from a claim, prescription, or another health data source into a known provider.

- Batch fetch up to 10 NPIs per call; the 10-digit format is validated before any API call
- Returns every taxonomy (with its primary flag, license number and state), all practice and mailing addresses, credential, sex, sole-proprietor flag, enumeration and last-updated dates, secondary identifiers (Medicaid, etc.), and FHIR/Direct endpoints
- Partial-success reporting — well-formed NPIs with no registry record (deactivated or never enumerated) land in `notFound` rather than failing the whole call

---

### `npi_lookup_taxonomy`

Resolve and browse the NUCC Healthcare Provider Taxonomy — the specialty code set NPPES uses — fully offline from the bundled code set.

- `resolve` — turn a plain-language specialty into matching taxonomy codes and canonical descriptions (the value the search tools filter on)
- `get` — return the full entry for an exact taxonomy code
- `browse` — walk the hierarchy (grouping → classification → specialization), filterable by grouping and by NPI section (Individual/NPI-1 vs Non-Individual/NPI-2)

## Resources and prompts

| Type | Name | Description |
|:---|:---|:---|
| Resource | `npi://provider/{npi}` | A single provider's full decoded record by NPI — the resource twin of `npi_get_provider`. |
| Resource | `npi://taxonomy/{code}` | A single NUCC taxonomy entry by code — the resource twin of `npi_lookup_taxonomy` mode `get`. |

All resource data is also reachable via tools. The resources are convenience twins for resource-capable clients; tool-only clients lose nothing.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

NPI/NPPES-specific:

- **Keyless** — runs against the public CMS NPPES NPI Registry API (v2.1) with no API key or account
- **Bundled NUCC taxonomy** — the 879-code Healthcare Provider Taxonomy (v25.0) ships in the image and loads into an in-memory index at startup, so specialty resolution and code lookups work fully offline with no second upstream
- Specialty resolution turns a vague term ("heart doctor") into the precise taxonomy description the registry filters on, and echoes the match back for the agent to verify
- Detects the registry's quirk of returning HTTP 200 with an `Errors[]` body on validation failure and maps it to typed, recoverable error reasons

Agent-friendly output:

- Provenance on search — the resolved taxonomy and the exact `taxonomy_description` sent to the registry are echoed back, so agents can see what was actually searched and re-run with a different code
- Honest pagination — the returned count is disclosed as the page size, never a fabricated grand total, with the 1200-match reachable ceiling surfaced when a broad query is capped
- Graceful partial failure — `npi_get_provider` returns per-NPI `found` / `notFound` rows instead of failing the whole batch when some NPIs are deactivated or never enumerated

## Getting started

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

---

Provider data from the [CMS NPPES NPI Registry](https://npiregistry.cms.hhs.gov/) (public domain). Specialty codes from the [NUCC Health Care Provider Taxonomy](https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40) (NUCC, bundled).
