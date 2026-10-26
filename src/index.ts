#!/usr/bin/env node
/**
 * @fileoverview npi-providers-mcp-server MCP server entry point.
 * @module index
 */

import { type AnyToolDef, createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { providerResource } from './mcp-server/resources/definitions/provider.resource.js';
import { taxonomyResource } from './mcp-server/resources/definitions/taxonomy.resource.js';
import { createGetProviderTool } from './mcp-server/tools/definitions/get-provider.tool.js';
import { createLookupTaxonomyTool } from './mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { createSearchProvidersTool } from './mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from './services/nppes/nppes-service.js';
import { initTaxonomyService } from './services/taxonomy/taxonomy-service.js';

const tools: AnyToolDef[] = [];

await createApp({
  name: 'npi-providers-mcp-server',
  title: 'npi-providers-mcp-server',
  /**
   * No tool or resource calls `ctx.requestInput`, so nothing needs a session to
   * answer a mid-handler prompt. Declared here as the durable form; a deployment's
   * `MCP_SESSION_MODE` still wins when it carries a meaningful value.
   */
  sessionMode: 'stateless',
  cacheHints: {
    'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/list': { ttlMs: 3_600_000, cacheScope: 'public' },
    'resources/templates/list': { ttlMs: 3_600_000, cacheScope: 'public' },
  },
  tools,
  resources: [providerResource, taxonomyResource],
  skills: 'skills',
  instructions:
    'US healthcare provider directory over the live, keyless NPPES NPI Registry, plus a bundled NUCC taxonomy code set for offline specialty resolution. Public professional practice data only (name, practice address, specialty, credential, NPI) — no personal or home data, so only practice-location (LOCATION) addresses are kept for individual providers and their mailing address is withheld. Typical flow: npi_search_providers (resolve a name/specialty/place to candidate NPIs) → npi_get_provider (decode one or more NPIs to their provider records). Ground plain-language specialties with npi_lookup_taxonomy before searching. The registry never reports a true match total and one search reaches only its first 1200 matches by skip; npi_search_providers names the next page, and at that terminal window returns postal_code prefixes that continue the search.',
  setup() {
    const { clampLimits } = getServerConfig();
    initTaxonomyService();
    initNppesService();
    tools.push(
      createSearchProvidersTool(clampLimits),
      createGetProviderTool(clampLimits),
      createLookupTaxonomyTool(clampLimits),
    );
  },
});
