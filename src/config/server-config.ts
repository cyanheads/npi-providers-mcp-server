/**
 * @fileoverview Server-specific configuration for the NPPES NPI Registry upstream.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * auth, storage) is handled by @cyanheads/mcp-ts-core.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiBaseUrl: z
    .string()
    .url()
    .default('https://npiregistry.cms.hhs.gov/api')
    .describe('NPPES NPI Registry API base URL. Override for a private mirror or testing.'),
  timeoutMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(15000)
    .describe('Per-request HTTP timeout for NPPES calls, in milliseconds.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiBaseUrl: 'NPPES_API_BASE_URL',
    timeoutMs: 'NPPES_TIMEOUT_MS',
  });
  return _config;
}
