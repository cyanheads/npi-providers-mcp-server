/**
 * @fileoverview The NPPES reachable-window arithmetic for npi_search_providers: the
 * next page after a full page, and the postal_code prefixes that continue a search
 * past its terminal window.
 * @module mcp-server/search-window
 *
 * NPPES caps `skip` at 1000 and `limit` at 200, so one search reaches only its first
 * 1200 matches, and a larger `skip` silently returns the skip-1000 window again.
 * Past that window the only lossless way on is to partition the search by practice
 * ZIP prefix: every US practice address carries a 5- or 9-digit ZIP, so the children
 * of a 2–4 digit prefix (one more digit each) cover it exactly, as do the children of
 * a 6–8 digit ZIP+4 prefix. A 5-digit ZIP cannot be split — its ZIP+4 children miss
 * providers recorded with only the 5 digits — and a non-US address has no numeric
 * ZIP at all.
 */

/** The largest `skip` the registry honors. */
export const MAX_SKIP = 1000;

/** The largest `limit` the registry honors. */
export const MAX_LIMIT = 200;

/** A page of the same search: the `skip`/`limit` to send next. */
export interface NextPage {
  limit: number;
  skip: number;
}

/**
 * The page after a full page at `skip`/`limit`, or `undefined` when that page already
 * reached the last reachable match (the terminal window: skip 1000, limit 200). When
 * `skip + limit` passes 1000 the only page left is skip 1000, limit 200, whose first
 * `skip + limit - 1000` rows repeat rows already returned.
 */
export function nextPage(skip: number, limit: number): NextPage | undefined {
  const end = skip + limit;
  if (end <= MAX_SKIP) return { skip: end, limit };
  if (end < MAX_SKIP + MAX_LIMIT) return { skip: MAX_SKIP, limit: MAX_LIMIT };
  return;
}

/** How the terminal window continues: postal_code values to re-run with, or why none remain. */
export type PostalContinuation = { postalCodes: string[] } | { deadEnd: string };

const DIGITS = [...'0123456789'];

/**
 * The postal_code values that partition a search at its terminal window. No
 * postal_code → the 100 two-digit prefixes `00*`–`99*`; a prefix of 2–4 or 6–8
 * digits → that prefix plus each digit. A 5-digit ZIP, a full ZIP+4, or a value
 * that is not a numeric ZIP prefix ends the postal split.
 */
export function postalContinuation(postalCode: string | undefined): PostalContinuation {
  if (!postalCode) {
    return { postalCodes: DIGITS.flatMap((a) => DIGITS.map((b) => `${a}${b}*`)) };
  }
  const digits = /^(\d+)\*?$/.exec(postalCode)?.[1];
  if (digits?.length === 5) {
    return {
      deadEnd: `postal_code ${postalCode} is already a full 5-digit ZIP, and its ZIP+4 prefixes would miss providers recorded with only the 5-digit ZIP`,
    };
  }
  if (digits?.length === 9) {
    return { deadEnd: `postal_code ${postalCode} is already a full ZIP+4` };
  }
  if (!digits || !postalCode.endsWith('*')) {
    return { deadEnd: `postal_code ${postalCode} is not a numeric ZIP prefix` };
  }
  return { postalCodes: DIGITS.map((d) => `${digits}${d}*`) };
}
