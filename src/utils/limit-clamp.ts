/**
 * @fileoverview Record an applied tool limit without high-cardinality metric labels.
 * @module utils/limit-clamp
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

// Binds to the global MeterProvider on each `add`, so module scope is safe before telemetry starts.
const counter = createCounter('mcp.npi.limit_clamps', 'Tool requests whose limit was clamped');

/** Records one applied clamp: a counter event labeled by tool, and a `notice` log with the values. */
export function recordLimitClamp(
  ctx: Pick<Context, 'log'>,
  event: {
    tool: 'npi_search_providers' | 'npi_get_provider' | 'npi_lookup_taxonomy';
    requested: number;
    applied: number;
  },
): void {
  counter.add(1, { [ATTR_MCP_TOOL_NAME]: event.tool });
  ctx.log.notice('Tool limit clamped.', event);
}
