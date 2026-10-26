/**
 * @fileoverview Exercise installed-entry startup, dotenv precedence and advertised bounds.
 * @module tests/integration/startup-config.integration.test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';

const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const responseSchema = z.object({
  id: z.number(),
  result: z.object({
    tools: z.array(z.object({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) })),
  }),
});

async function inspectStartup(runtime: string, fileValue: string | undefined, envValue?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'npi-config-test-'));
  try {
    if (fileValue !== undefined)
      await writeFile(join(cwd, '.env'), `NPI_CLAMP_LIMITS=${fileValue}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      MCP_AUTH_MODE: 'none',
      OTEL_ENABLED: 'false',
      MCP_LOG_LEVEL: 'error',
    };
    delete env.NPI_CLAMP_LIMITS;
    if (envValue !== undefined) env.NPI_CLAMP_LIMITS = envValue;
    const child = spawn(runtime, [entry], { cwd, env, signal: AbortSignal.timeout(15_000) });
    let stdout = '';
    let stderr = '';
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.split('\n').some((line) => line.includes('"id":2'))) child.stdin.end();
    });
    child.stdin.on('error', () => {
      /* An invalid config exits before consuming requests. */
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    const code = await closed;
    return { stdout, stderr, code };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe.each(['node', 'bun'])('%s startup configuration', (runtime) => {
  it.each([
    { file: undefined, env: undefined, clamped: true },
    { file: 'false', env: undefined, clamped: false },
    { file: 'true', env: undefined, clamped: true },
    { file: 'false', env: 'true', clamped: true },
    { file: 'true', env: 'false', clamped: false },
  ])('advertises resolved bounds for $file / $env', async ({ file, env, clamped }) => {
    const run = await inspectStartup(runtime, file, env);
    expect(run.code, run.stderr).toBe(0);
    const responses = run.stdout
      .trim()
      .split('\n')
      .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    const tools = responseSchema.parse(responses.find((response) => response.id === 2)).result
      .tools;
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
    const properties = (name: string) =>
      z.record(z.string(), z.unknown()).parse(schemas.get(name)?.properties);
    const searchLimit = z
      .object({ maximum: z.number().optional() })
      .parse(properties('npi_search_providers').limit);
    const taxonomyLimit = z
      .object({ maximum: z.number().optional() })
      .parse(properties('npi_lookup_taxonomy').limit);
    if (clamped) {
      expect(searchLimit.maximum).not.toBe(200);
      expect(taxonomyLimit.maximum).not.toBe(50);
    } else {
      expect(searchLimit.maximum).toBe(200);
      expect(taxonomyLimit.maximum).toBe(50);
    }
    const npis = z
      .object({ anyOf: z.array(z.object({ type: z.string(), maxItems: z.number().optional() })) })
      .parse(properties('npi_get_provider').npis);
    expect(npis.anyOf.find((option) => option.type === 'array')?.maxItems).toBe(clamped ? 100 : 10);
    expect(schemas.get('npi_lookup_taxonomy')).toMatchObject({ type: 'object' });
    expect(schemas.get('npi_lookup_taxonomy')).not.toHaveProperty('oneOf');
  });

  it('fails invalid configuration cleanly before serving', async () => {
    const run = await inspectStartup(runtime, 'not-a-boolean');
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Configuration error');
    expect(run.stderr).toContain('NPI_CLAMP_LIMITS');
    expect(run.stderr).not.toContain('at getServerConfig');
  });
});
