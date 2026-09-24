/**
 * @fileoverview npi://provider/{npi} — a single provider's decoded NPPES record by
 * NPI. The resource twin of npi_get_provider for one NPI.
 * @module mcp-server/resources/definitions/provider.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { hasValidNpiCheckDigit } from '@/mcp-server/npi-check-digit.js';
import { getNppesService } from '@/services/nppes/nppes-service.js';

export const providerResource = resource('npi://provider/{npi}', {
  name: 'npi-provider',
  title: 'NPI provider record',
  description:
    "A single provider's decoded NPPES record by NPI number — the resource twin of npi_get_provider for one NPI: the registry's professional-practice data, keeping only LOCATION address rows for individual providers (their mailing address is withheld). Read-only, stable URI, useful as injectable context when an NPI is already known.",
  mimeType: 'application/json',
  params: z.object({
    npi: z
      .string()
      .regex(/^\d{10}$/, 'An NPI is exactly 10 digits.')
      .describe(
        'A 10-digit National Provider Identifier whose last digit is its check digit (Luhn over the number prefixed with 80840).',
      ),
  }),

  errors: [
    {
      reason: 'no_record',
      code: JsonRpcErrorCode.NotFound,
      when: 'The NPI has a valid check digit but no NPPES record (deactivated or never enumerated).',
      recovery: 'Verify the NPI; search by name with npi_search_providers to find a valid one.',
    },
    {
      reason: 'invalid_npi_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The NPI fails the NPI check digit, so it was not looked up.',
      recovery:
        'The last digit does not match the NPI check digit, which usually means a typo or transposed digits — re-copy the NPI, or find it by name with npi_search_providers.',
    },
  ],

  async handler(params, ctx) {
    if (!hasValidNpiCheckDigit(params.npi)) {
      throw ctx.fail('invalid_npi_format', `NPI ${params.npi} fails the NPI check digit.`, {
        ...ctx.recoveryFor('invalid_npi_format'),
      });
    }
    const record = await getNppesService().getByNumber(params.npi, ctx);
    if (!record) {
      throw ctx.fail('no_record', `No NPPES record for NPI ${params.npi}.`, {
        ...ctx.recoveryFor('no_record'),
      });
    }
    return record;
  },
});
