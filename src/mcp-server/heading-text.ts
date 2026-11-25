/**
 * @fileoverview The text an ATX heading slot shows for registry or NUCC text.
 * @module mcp-server/heading-text
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * `text` encoded for an ATX heading (`## ${headingText(name)}`): each run of line
 * breaks collapsed to one space, then escaped so a CommonMark parse reads it back.
 * A heading ends at a line break, so a break left in place would push the rest of the
 * value out of the heading; every other slot keeps breaks as the escaper's hard breaks.
 */
export function headingText(text: string): string {
  return escapeMarkdownInline(text.replace(/[\r\n]+/g, ' '));
}
