/**
 * @fileoverview Record an applied tool limit without high-cardinality metric labels.
 * @module utils/limit-clamp
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';

let counter: ReturnType<typeof createCounter> | undefined;

/** Records one actual clamp after startup configuration and telemetry initialization. */
export function recordLimitClamp(
  ctx: Pick<Context, 'log'>,
  event: {
    tool: 'npi_search_providers' | 'npi_get_provider' | 'npi_lookup_taxonomy';
    requested: number;
    applied: number;
  },
): void {
  counter ??= createCounter('mcp.npi.limit_clamps', 'Tool requests whose limit was clamped');
  counter.add(1, { [ATTR_MCP_TOOL_NAME]: event.tool });
  ctx.log.notice('Tool limit clamped.', event);
}
