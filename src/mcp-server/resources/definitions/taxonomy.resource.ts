/**
 * @fileoverview npi://taxonomy/{code} — a single NUCC taxonomy entry by code.
 * The resource twin of npi_lookup_taxonomy mode "get".
 * @module mcp-server/resources/definitions/taxonomy.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

export const taxonomyResource = resource('npi://taxonomy/{code}', {
  name: 'npi-taxonomy',
  title: 'NUCC taxonomy entry',
  description:
    'A single NUCC Healthcare Provider Taxonomy entry by code (grouping, classification, specialization, definition, display name, NPI section). The resource twin of npi_lookup_taxonomy mode "get". Fully offline.',
  mimeType: 'application/json',
  params: z.object({
    code: z
      .string()
      .regex(/^\d{3}[A-Z0-9]{6}X$/, 'A NUCC taxonomy code matches ^\\d{3}[A-Z0-9]{6}X$.')
      .describe('A 10-character NUCC taxonomy code, e.g. "207RC0000X".'),
  }),

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No taxonomy entry exists for the given code.',
      recovery: 'Use npi_lookup_taxonomy mode resolve or browse to find a valid code.',
    },
  ],

  handler(params, ctx) {
    const entry = getTaxonomyService().get(params.code);
    if (!entry) {
      throw ctx.fail('no_match', `No NUCC taxonomy entry for code ${params.code}.`, {
        ...ctx.recoveryFor('no_match'),
      });
    }
    return entry;
  },
});
