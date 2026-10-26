/**
 * @fileoverview Clamp telemetry emits bounded metric labels and exact log facts.
 * @module tests/utils/limit-clamp.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

const { add, createCounter } = vi.hoisted(() => {
  const add = vi.fn();
  return { add, createCounter: vi.fn(() => ({ add })) };
});

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter,
}));

describe('limit clamp telemetry', () => {
  it('initializes lazily and records one bounded counter event per call', async () => {
    const { recordLimitClamp } = await import('@/utils/limit-clamp.js');
    expect(createCounter).not.toHaveBeenCalled();
    const ctx = createMockContext();
    vi.spyOn(ctx.log, 'notice');
    const events = [
      { tool: 'npi_search_providers', requested: 201, applied: 200 },
      { tool: 'npi_get_provider', requested: 12, applied: 10 },
      { tool: 'npi_lookup_taxonomy', requested: 101, applied: 100 },
    ] as const;
    for (const event of events) recordLimitClamp(ctx, event);
    expect(createCounter).toHaveBeenCalledExactlyOnceWith(
      'mcp.npi.limit_clamps',
      'Tool requests whose limit was clamped',
    );
    expect(add.mock.calls).toEqual(events.map(({ tool }) => [1, { 'mcp.tool.name': tool }]));
    expect(ctx.log.notice).toHaveBeenCalledTimes(3);
    for (const event of events)
      expect(ctx.log.notice).toHaveBeenCalledWith('Tool limit clamped.', event);
  });
});
