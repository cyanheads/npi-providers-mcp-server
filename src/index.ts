#!/usr/bin/env node
/**
 * @fileoverview npi-providers-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { providerResource } from './mcp-server/resources/definitions/provider.resource.js';
import { taxonomyResource } from './mcp-server/resources/definitions/taxonomy.resource.js';
import { getProviderTool } from './mcp-server/tools/definitions/get-provider.tool.js';
import { lookupTaxonomyTool } from './mcp-server/tools/definitions/lookup-taxonomy.tool.js';
import { searchProvidersTool } from './mcp-server/tools/definitions/search-providers.tool.js';
import { initNppesService } from './services/nppes/nppes-service.js';
import { initTaxonomyService } from './services/taxonomy/taxonomy-service.js';

await createApp({
  name: 'npi-providers-mcp-server',
  title: 'npi-providers-mcp-server',
  tools: [searchProvidersTool, getProviderTool, lookupTaxonomyTool],
  resources: [providerResource, taxonomyResource],
  instructions:
    'US healthcare provider directory over the live, keyless NPPES NPI Registry, plus a bundled NUCC taxonomy code set for offline specialty resolution. Public professional practice data only (name, practice address, specialty, credential, NPI) — no personal or home data. Typical flow: npi_search_providers (resolve a name/specialty/place to candidate NPIs) → npi_get_provider (decode one or more NPIs to full records). Ground plain-language specialties with npi_lookup_taxonomy before searching. The registry never reports a true match total and only the first 1200 matches are reachable, so narrow broad queries with more filters.',
  setup() {
    initTaxonomyService();
    initNppesService();
  },
});
