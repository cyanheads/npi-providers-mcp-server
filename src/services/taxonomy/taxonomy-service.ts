/**
 * @fileoverview NUCC Healthcare Provider Taxonomy service — offline specialty
 * resolution over the bundled code set (879 codes, in-memory).
 * @module services/taxonomy/taxonomy-service
 *
 * Loads the generated `taxonomy-data.ts` into an in-memory index once at startup
 * (server-level reference data — not tenant-scoped, no network). Provides the three
 * lookup modes the surface needs: strict-token `resolve` (plain term → codes),
 * exact `get` (by code), and hierarchy `browse`. No external dependency.
 */

import { TAXONOMY_ENTRIES } from './taxonomy-data.js';
import type { TaxonomyEntry, TaxonomySection } from './types.js';

/**
 * Normalize a string for token matching: lowercase, strip diacritics, collapse
 * any non-alphanumeric run to a single space, trim. Shared by index build and query.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Stem a single normalized token to a shared root for common medical-specialty
 * word-forms, so plain-language queries match the registry's formal nouns:
 * `cardiologist` and `cardiology` both → `cardiolog`; `psychiatrist`/`psychiatry`
 * → `psychiatr`; `pediatrician` → `pediatr` (a substring of `pediatric`). This is
 * deterministic morphological normalization — the same category as the case/diacritic
 * folding above — not a fuzzy guess. Applied identically to indexed text and queries.
 */
function stemToken(t: string): string {
  return t
    .replace(/ologists?$/, 'olog')
    .replace(/ology$/, 'olog')
    .replace(/iatrists?$/, 'iatr')
    .replace(/iatry$/, 'iatr')
    .replace(/icians?$/, 'ic')
    .replace(/ists?$/, '')
    .replace(/s$/, '');
}

/** Tokenize via normalize + stem, dropping empties. */
function tokenize(s: string): string[] {
  const n = normalize(s);
  if (n.length === 0) return [];
  return n.split(' ').map(stemToken).filter(Boolean);
}

/**
 * Generic role words that people append to lay specialty phrases. They usually
 * are not part of the NUCC specialty label, so keeping them in a strict AND
 * query makes useful phrases like "heart doctor" fail. Keep an all-stop query
 * unchanged so terms such as "doctor" still get an honest no-match.
 */
const QUERY_STOP_TOKENS = new Set(['doctor', 'special', 'provider', 'md', 'do']);

/** Tokenize a user query and drop generic lay-role words when other signal remains. */
function tokenizeQuery(s: string): string[] {
  const tokens = tokenize(s);
  const withoutStops = tokens.filter((t) => !QUERY_STOP_TOKENS.has(t));
  return withoutStops.length > 0 ? withoutStops : tokens;
}

/**
 * Lay-term → NUCC-formal token aliases, applied to the *query* only (the index keeps
 * the registry's own vocabulary). A handful of common specialist words share no stem
 * with the taxonomy's formal specialty name, so strict-token resolve would miss the
 * canonical general entry entirely:
 *   - `cardiolog` (cardiologist/cardiology) → general entry is "Cardiovascular Disease"
 *   - `pulmonolog` (pulmonologist) → general entry is "Pulmonary Disease"
 *   - `surgeon` → the taxonomy spells the profession "Surgery"/"Surgical"
 * Scoped to genuine stem mismatches — terms whose own word already appears in the
 * taxonomy (radiology, endocrinology, neurology, …) need no alias; ranking surfaces
 * their physician entry. A query token matches an entry if the token *or any of its
 * aliases* is present, so the base token still matches its own sub-specialties (e.g.
 * "cardiolog" → "Interventional Cardiology") while the alias reaches the general one.
 * Deterministic lexical normalization — the same category as the stemming above.
 */
const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  cardiolog: ['cardiovascular'],
  cancer: ['oncolog'],
  ent: ['otolaryngolog'],
  eye: ['ophthalmolog'],
  heart: ['cardiovascular'],
  kidney: ['nephrolog'],
  obgyn: ['obstetric', 'gynecolog'],
  pulmonolog: ['pulmonary'],
  surgeon: ['surgery', 'surgical'],
};

/**
 * A query token plus any formal-vocabulary aliases. The token itself comes first; the
 * remainder are aliases — used both for matching and to prefer alias hits (which point
 * at the canonical general specialty) when ranking.
 */
function matchVariants(token: string): { token: string; aliases: string[] } {
  const aliases = TOKEN_ALIASES[token];
  return { token, aliases: aliases ? [...aliases] : [] };
}

/**
 * Match tier for a resolve hit — a transparent, rule-based ordering, lowest first.
 * A bare plain-language specialty term ("cardiologist", "psychiatrist") almost always
 * means the practitioner is a *physician* of that specialty — not a different profession
 * that carries the word as a modifier ("Pharmacist, Cardiology", "Cardiology Technician")
 * and not an organization ("Psychiatric Hospital"). So physician entries rank above all
 * non-physician ones:
 *   0 — physician grouping (Allopathic & Osteopathic Physicians)
 *   1 — everything else (Pharmacist, Technician, Hospital, Chiropractor, …)
 */
const MatchTier = { PhysicianGrouping: 0, Other: 1 } as const;
type MatchTier = (typeof MatchTier)[keyof typeof MatchTier];

/** A resolved match with the signals used for deterministic ranking (each lowest-first). */
interface ResolveHit {
  /**
   * 0 when the entry matched a token's formal alias (e.g. "cardiovascular" for a
   * "cardiologist" query) — aliases target the canonical general specialty, so these
   * win the tiebreak over narrower sub-specialties that matched only the base token.
   * 1 otherwise. Inert for queries with no aliased token.
   */
  aliasRank: 0 | 1;
  entry: TaxonomyEntry;
  /** Combined haystack length — shorter (more specific) entries rank first within a tier. */
  haystackLength: number;
  /** Pediatric sub-specialties sort after the adult/general specialty within a tier. */
  pediatricRank: 0 | 1;
  /**
   * 0 when every query token matches the entry's *own* specialty label (its specialization,
   * else its classification) — i.e. the entry IS that specialty, not a sibling under the same
   * umbrella that matched only via the broader classification text. Elevates "Neurology
   * Physician" (spec "Neurology") over "Epilepsy Physician" (matches only via the shared
   * "Psychiatry & Neurology" classification) for a "neurologist" query. 1 otherwise.
   */
  selfNameRank: 0 | 1;
  tier: MatchTier;
}

/** True when an entry's grouping is the physician (allopathic & osteopathic) grouping. */
function isPhysicianGrouping(grouping: string): boolean {
  return /allopathic|osteopathic/i.test(grouping);
}

/** In-memory NUCC taxonomy index with resolve / get / browse. */
export class TaxonomyService {
  private readonly byCode: Map<string, TaxonomyEntry>;
  /** Per-entry normalized search text (classification + specialization + displayName). */
  private readonly searchText: Map<string, string>;
  /**
   * Per-entry normalized "own specialty label" — the specialization if present, else the
   * classification. Used to tell whether a query named *this* specialty vs. only matched
   * via the broader classification umbrella shared with siblings (ranking signal).
   */
  private readonly selfNameText: Map<string, string>;
  private readonly groupings: string[];

  constructor(entries: readonly TaxonomyEntry[] = TAXONOMY_ENTRIES) {
    this.byCode = new Map();
    this.searchText = new Map();
    this.selfNameText = new Map();
    const groupingSet = new Set<string>();
    for (const e of entries) {
      this.byCode.set(e.code, e);
      // Build the haystack from stemmed tokens so query stems match (e.g. a
      // query "cardiolog" hits indexed "cardiology" → both stem to "cardiolog").
      this.searchText.set(
        e.code,
        tokenize([e.classification, e.specialization ?? '', e.displayName].join(' ')).join(' '),
      );
      this.selfNameText.set(e.code, tokenize(e.specialization ?? e.classification).join(' '));
      groupingSet.add(e.grouping);
    }
    this.groupings = [...groupingSet].sort();
  }

  /** Total number of indexed taxonomy entries. */
  get size(): number {
    return this.byCode.size;
  }

  /** All distinct top-level groupings, sorted. */
  listGroupings(): string[] {
    return [...this.groupings];
  }

  /**
   * Resolve a plain-language specialty term to matching taxonomy entries via
   * strict token match: every query token (or one of its formal-vocabulary aliases)
   * must appear as a substring in the entry's classification + specialization +
   * display-name text. No fuzzy fallback — a weak query is better served by an honest
   * "no match, browse the hierarchy" than an approximate guess the caller can't audit.
   *
   * Ranking is a chain of transparent, rule-based signals (each lowest-first; see
   * `ResolveHit`): physician grouping → query names the entry's own specialty → alias
   * match (canonical general specialty) → non-pediatric → shorter haystack → code. The
   * net effect: a bare "cardiologist" resolves to "Cardiovascular Disease Physician", not
   * a cardiology pharmacist, technician, hospital, or a narrow cardiology sub-specialty.
   */
  resolve(query: string, limit: number): TaxonomyEntry[] {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];
    const variants = tokens.map(matchVariants);
    const hasAliases = variants.some((v) => v.aliases.length > 0);
    const hits: ResolveHit[] = [];
    for (const [code, entry] of this.byCode) {
      const hay = this.searchText.get(code);
      if (!hay) continue;
      const selfHay = this.selfNameText.get(code) ?? '';

      // Every query token must match via the token itself or one of its aliases.
      let allMatch = true;
      let allMatchSelfName = true;
      let matchedAnAlias = false;
      for (const { token, aliases } of variants) {
        const inHay = hay.includes(token);
        const aliasInHay = aliases.some((a) => hay.includes(a));
        if (!inHay && !aliasInHay) {
          allMatch = false;
          break;
        }
        if (aliasInHay && !inHay) matchedAnAlias = true;
        if (!selfHay.includes(token) && !aliases.some((a) => selfHay.includes(a))) {
          allMatchSelfName = false;
        }
      }
      if (!allMatch) continue;

      hits.push({
        entry,
        tier: isPhysicianGrouping(entry.grouping) ? MatchTier.PhysicianGrouping : MatchTier.Other,
        selfNameRank: allMatchSelfName ? 0 : 1,
        aliasRank: hasAliases && matchedAnAlias ? 0 : 1,
        pediatricRank: /pediatric/i.test(entry.specialization ?? '') ? 1 : 0,
        haystackLength: hay.length,
      });
    }
    hits.sort(
      (a, b) =>
        a.tier - b.tier ||
        a.selfNameRank - b.selfNameRank ||
        a.aliasRank - b.aliasRank ||
        a.pediatricRank - b.pediatricRank ||
        a.haystackLength - b.haystackLength ||
        a.entry.code.localeCompare(b.entry.code),
    );
    return hits.slice(0, limit).map((h) => h.entry);
  }

  /** Exact lookup by taxonomy code. Returns undefined when absent. */
  get(code: string): TaxonomyEntry | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  /**
   * Browse the hierarchy, optionally filtered by grouping (case-insensitive
   * substring) and/or NPI section. Entries are returned sorted by code.
   */
  browse(opts: { grouping?: string; section?: TaxonomySection; limit: number }): TaxonomyEntry[] {
    const groupingNeedle = opts.grouping ? normalize(opts.grouping) : undefined;
    const out: TaxonomyEntry[] = [];
    for (const entry of this.byCode.values()) {
      if (opts.section && entry.section !== opts.section) continue;
      if (groupingNeedle && !normalize(entry.grouping).includes(groupingNeedle)) continue;
      out.push(entry);
    }
    out.sort((a, b) => a.code.localeCompare(b.code));
    return out.slice(0, opts.limit);
  }
}

// --- Init / accessor pattern ---

let _service: TaxonomyService | undefined;

/** Initialize the taxonomy service. Call from `setup()` in createApp. */
export function initTaxonomyService(): void {
  _service = new TaxonomyService();
}

/** Get the initialized taxonomy service. Throws if not initialized. */
export function getTaxonomyService(): TaxonomyService {
  if (!_service) {
    throw new Error('TaxonomyService not initialized — call initTaxonomyService() in setup()');
  }
  return _service;
}
