/**
 * @fileoverview Reads `content[]` Markdown back through markdown-it, the CommonMark
 * parser the framework's own read-back tests use, so a test asserts what a client
 * renders rather than which bytes were written. `readBackMismatch` checks a `format()`
 * against a schema-typed value: every string slot reads back as its value, and no slot
 * changes the document's blocks or authored markup.
 * @module tests/helpers/markdown-readback
 */

import { z } from '@cyanheads/mcp-ts-core';
import MarkdownIt, { type MarkdownIt as Parser, type Token } from 'markdown-it';
import { expect } from 'vitest';

/** CommonMark, and the default preset (GFM tables and strikethrough) with raw HTML on. */
export const PRESETS = ['commonmark', 'gfm'] as const;
export type Preset = (typeof PRESETS)[number];

const parsers: Record<Preset, Parser> = {
  commonmark: new MarkdownIt('commonmark'),
  gfm: new MarkdownIt('default', { html: true }),
};

/**
 * One node of a parse, in document order. A block token names its type, tag, and
 * whether a tight list hides it, plus the content of a leaf block (code, raw HTML).
 * Inline text merges into one `text` node per run, a hard break reading as `\n`; a soft
 * break (an authored line join) is its own node, so a line break that should have been
 * hard never reads as one. Any other inline token is `markup`.
 */
export type ReadNode =
  | { kind: 'block'; token: string }
  | { kind: 'text'; text: string; heading: boolean }
  | { kind: 'softbreak' }
  | { kind: 'markup'; token: string };

/** `markdown` as markdown-it parses it under `preset`. */
export function readMarkdown(markdown: string, preset: Preset): ReadNode[] {
  const nodes: ReadNode[] = [];
  let heading = false;
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type === 'inline') {
      readInline(token.children ?? [], heading, nodes);
      continue;
    }
    if (token.type === 'heading_open') heading = true;
    if (token.type === 'heading_close') heading = false;
    const parts = [token.type, token.tag, token.hidden ? 'hidden' : '', token.content];
    nodes.push({ kind: 'block', token: parts.filter(Boolean).join(' ') });
  }
  return nodes;
}

function readInline(children: Token[], heading: boolean, nodes: ReadNode[]): void {
  for (const child of children) {
    if (child.type === 'text' || child.type === 'text_special' || child.type === 'hardbreak') {
      const text = child.type === 'hardbreak' ? '\n' : child.content;
      const last = nodes.at(-1);
      if (last?.kind === 'text') last.text += text;
      else nodes.push({ kind: 'text', text, heading });
    } else if (child.type === 'softbreak') {
      nodes.push({ kind: 'softbreak' });
    } else {
      nodes.push({ kind: 'markup', token: [child.type, child.content].filter(Boolean).join(' ') });
    }
  }
}

/**
 * Every authored line of `markdown`'s inline runs (headings, paragraphs, list items),
 * split at soft breaks: plain text, a hard break as `\n`, markup as `⟨strong⟩…⟨/strong⟩`
 * or `⟨type:content⟩`. A list marker or heading marker is structure, not line text.
 */
export function readLines(markdown: string, preset: Preset = 'gfm'): string[] {
  const lines: string[] = [];
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type !== 'inline') continue;
    let line = '';
    for (const child of token.children ?? []) {
      if (child.type === 'softbreak') {
        lines.push(line);
        line = '';
      } else if (child.type === 'hardbreak') line += '\n';
      else if (child.type === 'text' || child.type === 'text_special') line += child.content;
      else if (child.nesting === 1) line += `⟨${child.tag}⟩`;
      else if (child.nesting === -1) line += `⟨/${child.tag}⟩`;
      else line += `⟨${child.type}:${child.content}⟩`;
    }
    lines.push(line);
  }
  return lines;
}

/** The block token types of `markdown`, in order (`heading_open`, `bullet_list_open`, …). */
export function blockTypes(markdown: string, preset: Preset = 'gfm'): string[] {
  return parsers[preset]
    .parse(markdown, {})
    .filter((token) => token.type !== 'inline')
    .map((token) => token.type);
}

/**
 * `value` with `map` applied to every string `schema` types as free text, in a fixed
 * walk order. Enums, numbers, and booleans pass through: the template renders them as
 * authored text or branches on them. A schema shape the walk doesn't know throws, so a
 * slot is never silently skipped.
 */
export function mapStringSlots<T>(schema: z.ZodType, value: T, map: (text: string) => string): T {
  return walk(schema, value, map) as T;
}

function walk(schema: z.ZodType, value: unknown, map: (text: string) => string): unknown {
  if (value === undefined) return value;
  if (schema instanceof z.ZodOptional) return walk(schema.unwrap() as z.ZodType, value, map);
  if (schema instanceof z.ZodString) return map(value as string);
  if (schema instanceof z.ZodArray) {
    return (value as unknown[]).map((item) => walk(schema.element as z.ZodType, item, map));
  }
  if (schema instanceof z.ZodObject) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, field] of Object.entries(schema.shape)) {
      if (key in out) out[key] = walk(field as z.ZodType, out[key], map);
    }
    return out;
  }
  if (
    schema instanceof z.ZodEnum ||
    schema instanceof z.ZodNumber ||
    schema instanceof z.ZodBoolean
  ) {
    return value;
  }
  throw new Error(`No string-slot walk for a ${schema.constructor.name} schema.`);
}

const SENTINEL = /zqs(\d+)z/g;

/**
 * The text a slot reads back as: in an ATX heading, its line breaks collapsed to one
 * space (a heading ends at a break); elsewhere CR and CRLF read as LF, since every
 * CommonMark parse normalizes line endings.
 */
function slotText(text: string, heading: boolean): string {
  return heading ? text.replace(/[\r\n]+/g, ' ') : text.replace(/\r\n?/g, '\n');
}

/**
 * Why `render(value)` does not read back, or `undefined` when it does. The reference is
 * `render` of the same value with every string slot swapped for an inert sentinel,
 * each sentinel then swapped back for its slot's text: under both presets the parse
 * must match it node for node — the same blocks and authored markup, and each slot's
 * exact text in the run it was placed in. Every slot must also render.
 */
export function readBackMismatch<T>(
  schema: z.ZodType,
  value: T,
  render: (value: T) => string,
): string | undefined {
  const slots: string[] = [];
  const marked = mapStringSlots(schema, value, (text) => {
    slots.push(text);
    return `zqs${slots.length - 1}z`;
  });
  const markedDoc = render(marked);
  const rendered = new Set([...markedDoc.matchAll(SENTINEL)].map((m) => Number(m[1])));
  const missing = slots.map((_, i) => i).filter((i) => !rendered.has(i));
  if (missing.length > 0) return `slots ${missing.join(', ')} never render`;
  const doc = render(value);
  for (const preset of PRESETS) {
    const expected = readMarkdown(markedDoc, preset).map((node) =>
      node.kind === 'text'
        ? {
            ...node,
            text: node.text.replace(SENTINEL, (_, i: string) =>
              slotText(slots[Number(i)] as string, node.heading),
            ),
          }
        : node,
    );
    const actual = readMarkdown(doc, preset);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return `${preset} parse differs.\nrendered:\n${doc}\nread:     ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`;
    }
  }
  return;
}

/** The number of string slots `schema` types in `value`. */
export function slotCount(schema: z.ZodType, value: unknown): number {
  let count = 0;
  mapStringSlots(schema, value, (text) => {
    count++;
    return text;
  });
  return count;
}

/** Asserts {@link readBackMismatch} finds nothing. */
export function expectReadsBack<T>(
  schema: z.ZodType,
  value: T,
  render: (value: T) => string,
): void {
  expect(readBackMismatch(schema, value, render)).toBeUndefined();
}
