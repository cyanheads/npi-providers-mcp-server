/**
 * @fileoverview NPI check-digit validation shared by npi_get_provider and
 * npi://provider/{npi}. The handlers apply it before any NPPES request; the NPPES
 * service deliberately does not, since the registry answers a failing NPI with
 * an ordinary empty result.
 * @module mcp-server/npi-check-digit
 */

/**
 * Whether a 10-digit NPI carries a valid check digit: the Luhn algorithm over the
 * number prefixed with the `80840` health-industry issuer code, per the CMS NPI
 * check-digit specification. The leading digit is not checked — CMS reserves
 * first digits beyond 1 and 2 for future use rather than ruling them invalid.
 */
export function hasValidNpiCheckDigit(npi: string): boolean {
  const digits = `80840${npi}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
