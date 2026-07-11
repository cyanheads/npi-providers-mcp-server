# Developer Protocol

**Server:** npi-providers-mcp-server
**Version:** 0.1.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.14`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Overview

US healthcare provider directory over the live, **keyless** NPPES NPI Registry API (v2.1), plus a **bundled NUCC Healthcare Provider Taxonomy** code set (879 codes, v25.0) for offline specialty resolution. Three tools, two resources, no prompts:

- `npi_search_providers` — search by name, organization, location, provider type, and specialty; plain-language specialties resolve through the bundled taxonomy before searching.
- `npi_get_provider` — decode up to 10 NPIs to full records, fanning out one call per NPI with partial-success reporting.
- `npi_lookup_taxonomy` — offline NUCC resolver: `resolve` / `get` / `browse`.
- `npi://provider/{npi}` and `npi://taxonomy/{code}` — read-only resource twins of the get/lookup tools.

Two services: `nppes` (live HTTP, detects the registry's HTTP-200-with-`Errors[]` validation envelope and maps it to typed contract reasons) and `taxonomy` (in-memory NUCC index loaded at startup). No API key — `MCP_AUTH_MODE=none`, no `auth` scopes; all tools are read-only over public professional-practice data.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real example: `npi_lookup_taxonomy` (offline, mode-dispatched, typed error contract). See `src/mcp-server/tools/definitions/lookup-taxonomy.tool.ts` for the full definition.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

export const lookupTaxonomyTool = tool('npi_lookup_taxonomy', {
  description: 'Resolve and browse the NUCC Healthcare Provider Taxonomy — fully offline.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
      when: 'A resolve query or get code matched no taxonomy entry.',
      recovery: 'Try a broader term, or use mode browse to walk groupings then classifications.' },
  ],
  input: z.object({
    mode: z.enum(['resolve', 'get', 'browse']).describe('resolve: term → codes. get: code → entry. browse: walk hierarchy.'),
    query: z.string().optional().describe('For mode "resolve": the plain-language specialty term.'),
    limit: z.number().int().min(1).max(50).default(20).describe('Max entries for resolve/browse.'),
  }),
  output: z.object({
    matches: z.array(EntrySchema).describe('Matching taxonomy entries.'),
  }),
  handler(input, ctx) {
    const taxonomy = getTaxonomyService();
    if (input.mode === 'resolve') {
      const query = input.query?.trim();
      if (!query) throw ctx.fail('missing_argument', 'Mode "resolve" requires a `query`.');
      const hits = taxonomy.resolve(query, input.limit);
      if (hits.length === 0) throw ctx.fail('no_match', `No taxonomy matched "${query}".`);
      return { matches: hits.map(toEntry) };
    }
    // ... get / browse modes
  },
  // format() populates content[] — the markdown twin of structuredContent.
  // Both surfaces must carry the same data (lint-enforced: every output field appears in the text).
  format: (result) => [{ type: 'text', text: result.matches.map(renderEntry).join('\n\n') }],
});
```

### Resource

Real example: `npi://taxonomy/{code}`. See `src/mcp-server/resources/definitions/taxonomy.resource.ts`.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

export const taxonomyResource = resource('npi://taxonomy/{code}', {
  name: 'npi-taxonomy',
  title: 'NUCC taxonomy entry',
  description: 'A single NUCC taxonomy entry by code. The resource twin of npi_lookup_taxonomy mode "get".',
  mimeType: 'application/json',
  params: z.object({
    code: z.string().regex(/^\d{3}[A-Z0-9]{6}X$/).describe('A 10-character NUCC taxonomy code, e.g. "207RC0000X".'),
  }),
  errors: [
    { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
      when: 'No taxonomy entry exists for the given code.',
      recovery: 'Use npi_lookup_taxonomy mode resolve or browse to find a valid code.' },
  ],
  handler(params, ctx) {
    const entry = getTaxonomyService().get(params.code);
    if (!entry) throw ctx.fail('no_match', `No NUCC taxonomy entry for code ${params.code}.`);
    return entry;
  },
});
```

No prompts — this is a data/lookup server with no recurring multi-step interaction worth templating.

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z.string().url().default('https://npiregistry.cms.hhs.gov/api')
    .describe('NPPES NPI Registry API base URL. Override for a private mirror or testing.'),
  timeoutMs: z.coerce.number().int().min(1000).max(120000).default(15000)
    .describe('Per-request HTTP timeout for NPPES calls, in milliseconds.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'NPPES_API_BASE_URL',
    timeoutMs: 'NPPES_TIMEOUT_MS',
  });
  return _config;
}
```

Both vars are optional with defaults — the NPPES upstream is keyless, so the server starts with no configuration. `parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`NPPES_API_BASE_URL`) not the path (`apiBaseUrl`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'my-mcp-server',
  title: 'My Server',                         // human-readable display name
  websiteUrl: 'https://github.com/owner/repo', // canonical homepage URL
  description: 'One-line description.',        // wins over MCP_SERVER_DESCRIPTION
  icons: [{ src: 'https://example.com/icon.png', sizes: ['48x48'], mimeType: 'image/png' }],
  instructions: 'Use shortcut alpha for the most common case.', // session-level context
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.fail` / `ctx.recoveryFor` | Throw a typed contract error (`ctx.fail(reason, msg, …)`) and pull its declared recovery metadata (`ctx.recoveryFor(reason)`). Used by every tool and resource here. |
| `ctx.enrich` | Attach out-of-band metadata to the response (reaches both client surfaces) — `.notice()`, `.truncated({ shown, cap })`, `.total(n)`, plus declared enrichment fields. `npi_search_providers` echoes the resolved taxonomy and pagination caveats through it. |
| `ctx.signal` | `AbortSignal` for cancellation — forwarded into `fetchWithTimeout` in the NPPES service. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

This server is stateless: no `ctx.state` (the NUCC index is a global in-memory load, not tenant KV), no `ctx.elicit`, no `ctx.progress` (no `task: true` tools).

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required descriptive metadata for the agent's next move (≥ 5 words, lint-validated); for the wire `data.recovery.hint` (mirrored into `content[]` text), pass explicitly at the throw site when dynamic context matters: `ctx.fail('reason', msg, { recovery: { hint: '...' } })`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                                   # createApp() entry point — registers tools/resources, inits services
  config/
    server-config.ts                         # NPPES_API_BASE_URL, NPPES_TIMEOUT_MS (Zod schema)
  services/
    nppes/
      nppes-service.ts                        # NPPES API v2.1 client — query build, Errors[]-on-200 detection, normalization
      types.ts                                # NPPES domain + raw types
    taxonomy/
      taxonomy-service.ts                     # In-memory NUCC index — resolve / get / browse
      taxonomy-data.ts                         # Generated bundled NUCC index (879 codes)
      types.ts                                # TaxonomyEntry / TaxonomySection
      data/nucc_taxonomy_250.csv              # Source CSV (v25.0); regenerate taxonomy-data.ts from it
  mcp-server/
    tools/definitions/
      search-providers.tool.ts                # npi_search_providers
      get-provider.tool.ts                    # npi_get_provider
      lookup-taxonomy.tool.ts                 # npi_lookup_taxonomy
    resources/definitions/
      provider.resource.ts                    # npi://provider/{npi}
      taxonomy.resource.ts                    # npi://taxonomy/{code}
```

No `prompts/` — this server defines no prompts. The bundled NUCC index in `taxonomy-data.ts` is generated from `data/nucc_taxonomy_250.csv` by `scripts/generate-taxonomy-data.ts`; refresh on NUCC's twice-yearly release by dropping the new CSV, bumping `CSV_VERSION`, and re-running it.

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-mirror` | MirrorService: stand up a self-refreshing local mirror (SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `npm run tree` | Generate directory structure doc (`docs/tree.md`) |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm run lint:mcp` | Validate MCP tool/resource definitions against the spec |
| `npm run lint:packaging` | Verify `manifest.json` ↔ `server.json` env var consistency (run by devcheck) |
| `npm test` | Run tests |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `npm run release:github` | Create the GitHub release from the current tag |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getMyService } from '@/services/my-domain/my-service.js';
```

---

## Checklist

- [ ] Keyless invariant holds — no required env var, `MCP_AUTH_MODE=none`, no `auth` scopes on any tool/resource
- [ ] NPPES service detects the HTTP-200-with-`Errors[]` validation envelope and throws a typed contract reason (never returns an empty result set as "no providers")
- [ ] Pagination honesty — output discloses page-size-not-total and the 1200-match reachable ceiling; never fabricate a grand total
- [ ] Specialty resolution echoes the matched taxonomy (code + description) back to the caller
- [ ] Taxonomy code format `^\d{3}[A-Z0-9]{6}X$`; NPI format `^\d{10}$` — validated in schema before any API call
- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
