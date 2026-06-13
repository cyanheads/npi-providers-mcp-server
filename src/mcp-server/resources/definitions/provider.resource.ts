/**
 * @fileoverview npi://provider/{npi} — a single provider's full decoded record by
 * NPI. The resource twin of npi_get_provider for one NPI.
 * @module mcp-server/resources/definitions/provider.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getNppesService } from '@/services/nppes/nppes-service.js';

export const providerResource = resource('npi://provider/{npi}', {
  name: 'npi-provider',
  title: 'NPI provider record',
  description:
    "A single provider's full decoded NPPES record by NPI number — the resource twin of npi_get_provider for one NPI. Read-only, stable URI, useful as injectable context when an NPI is already known.",
  mimeType: 'application/json',
  params: z.object({
    npi: z
      .string()
      .regex(/^\d{10}$/, 'An NPI is exactly 10 digits.')
      .describe('A 10-digit National Provider Identifier.'),
  }),

  errors: [
    {
      reason: 'no_record',
      code: JsonRpcErrorCode.NotFound,
      when: 'The NPI is well-formed but has no NPPES record (deactivated or never enumerated).',
      recovery: 'Verify the NPI; search by name with npi_search_providers to find a valid one.',
    },
  ],

  async handler(params, ctx) {
    const record = await getNppesService().getByNumber(params.npi, ctx);
    if (!record) {
      throw ctx.fail('no_record', `No NPPES record for NPI ${params.npi}.`, {
        ...ctx.recoveryFor('no_record'),
      });
    }
    return record;
  },
});
