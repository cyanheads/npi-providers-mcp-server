/**
 * @fileoverview Bundle pruning must preserve executable SDK skill modules.
 * @module tests/scripts/mcpb-runtime-skills.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/client/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'skills/npi-providers-guide/SKILL.md',
];
const agentDocs = [
  'node_modules/example/skills/guide/SKILL.md',
  'node_modules/@scope/example/framework-skills/guide/SKILL.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/guide.md',
  'node_modules/example/SKILL.md',
  'node_modules/example/docs/SKILL.md',
];

describe('MCPB dependency skill entries', () => {
  it.each(runtimeEntries)('retains runtime or published entry %s', (entry) => {
    expect(cleaner.test(entry)).toBe(false);
  });

  it('still strips dependency agent docs and keeps both classifiers aligned', () => {
    expect(filterAgentDocEntries([...runtimeEntries, ...agentDocs])).toEqual(agentDocs);
    const linterSource = readFileSync(
      new URL('../../scripts/lint-packaging.ts', import.meta.url),
      'utf8',
    );
    expect(linterSource.match(/export const AGENT_DOC_ENTRY =\s*([^\n]+);/)?.[1]).toBe(
      cleaner.toString(),
    );
  });
});
