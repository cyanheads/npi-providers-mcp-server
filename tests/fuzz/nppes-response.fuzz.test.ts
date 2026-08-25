/**
 * @fileoverview Seeded and adversarial tests for the external NPPES response
 * boundary. Global fetch is the only fake; NppesService parses every body.
 * @module tests/fuzz/nppes-response.fuzz.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NppesService } from '@/services/nppes/nppes-service.js';

const NPI = '1720034424';
const service = new NppesService('https://npiregistry.cms.hhs.gov/api', 15000);

function stubText(body: string): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  return stubText(JSON.stringify(body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NPPES response parser fuzzing', () => {
  it('handles empty success envelopes deterministically', async () => {
    const ctx = createMockContext();
    for (const body of [{}, { result_count: 0 }, { result_count: 0, results: [] }]) {
      stubJson(body);
      await expect(service.search({ lastName: 'NONE', limit: 10, skip: 0 }, ctx)).resolves.toEqual(
        [],
      );
      vi.unstubAllGlobals();
    }
  });

  it('normalizes generated sparse optional-field variants without fabricating absent values', async () => {
    const ctx = createMockContext();
    const optional = <T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | null | undefined> =>
      fc.oneof(fc.constant(undefined), fc.constant(null), arbitrary);
    const variant = fc.record({
      index: fc.integer({ min: 0, max: 100_000 }),
      individual: fc.boolean(),
      active: fc.boolean(),
      middleName: optional(fc.constant('Q')),
      credential: optional(fc.constant('MD')),
      officialFirstName: optional(fc.constant('ALEX')),
      officialLastName: optional(fc.constant('ADMIN')),
      taxonomyDescription: optional(fc.constant('Internal Medicine')),
      license: optional(fc.constant('WA-123')),
      taxonomyState: optional(fc.constant('WA')),
      address1: optional(fc.constant('500 CLINIC AVE')),
      address2: optional(fc.constant('SUITE 200')),
      city: optional(fc.constant('SEATTLE')),
      addressState: optional(fc.constant('WA')),
      postalCode: optional(fc.constant('981020000')),
    });

    await fc.assert(
      fc.asyncProperty(variant, async (sample) => {
        const raw = {
          number: Number(NPI),
          enumeration_type: sample.individual ? 'NPI-1' : 'NPI-2',
          basic: sample.individual
            ? {
                first_name: 'FUZZ',
                last_name: `PROVIDER${sample.index}`,
                status: sample.active ? 'A' : 'D',
                middle_name: sample.middleName,
                credential: sample.credential,
              }
            : {
                organization_name: `FUZZ HEALTH ${sample.index}`,
                status: sample.active ? 'A' : 'D',
                authorized_official_first_name: sample.officialFirstName,
                authorized_official_last_name: sample.officialLastName,
              },
          taxonomies: [
            {
              code: '207R00000X',
              desc: sample.taxonomyDescription,
              primary: true,
              license: sample.license,
              state: sample.taxonomyState,
            },
          ],
          addresses: [
            {
              address_purpose: 'LOCATION',
              address_1: sample.address1,
              address_2: sample.address2,
              city: sample.city,
              state: sample.addressState,
              postal_code: sample.postalCode,
            },
          ],
          identifiers: [],
          other_names: [],
          endpoints: [],
          practiceLocations: [],
        };
        stubJson({ result_count: 1, results: [raw] });
        try {
          const record = await service.getByNumber(NPI, ctx);
          expect(record?.npi).toBe(NPI);
          expect(record?.type).toBe(sample.individual ? 'individual' : 'organization');
          expect(record?.status).toBe(sample.active ? 'active' : 'deactivated');
          expect(record?.name.length).toBeGreaterThan(0);
          expect(record?.taxonomies[0]?.code).toBe('207R00000X');
        } finally {
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 75, seed: 0x4e505045 },
    );
  });

  it('maps a partial Errors envelope to a typed, non-retryable validation error', async () => {
    const fetchSpy = stubJson({ Errors: [{}] });
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_search_field', retryable: false },
    });
    expect(error.message).toBe('Validation error');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies malformed JSON as a typed upstream failure rather than returning empty data', async () => {
    const fetchSpy = stubText('{"result_count":1,"results":[');
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/parse NPPES response as JSON/i);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('classifies an HTML error page as a typed upstream failure', async () => {
    const fetchSpy = stubText('<!doctype html><html><body>upstream error</body></html>');
    const error = await service.getByNumber(NPI, createMockContext()).catch((cause) => cause);
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toMatch(/returned HTML instead of JSON/i);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it.skip('rejects structurally malformed or identity-less results with a typed upstream error (#15)', async () => {
    // https://github.com/cyanheads/npi-providers-mcp-server/issues/15
    const malformedBodies = [
      null,
      { Errors: {} },
      { result_count: 1, results: {} },
      { result_count: 1, results: [null] },
      { result_count: 1, results: [{}] },
      {
        result_count: 1,
        results: [
          {
            number: Number(NPI),
            enumeration_type: 'NPI-1',
            basic: { first_name: 'UNKNOWN', last_name: 'STATUS' },
          },
        ],
      },
    ];

    for (const body of malformedBodies) {
      stubJson(body);
      const outcome = await service
        .getByNumber(NPI, createMockContext())
        .then((record) => ({ record }))
        .catch((error) => ({ error }));
      expect(outcome).not.toHaveProperty('record');
      expect(outcome).toHaveProperty('error');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(McpError);
      vi.unstubAllGlobals();
    }
  });
});
