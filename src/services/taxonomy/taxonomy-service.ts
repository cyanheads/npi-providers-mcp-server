/**
 * @fileoverview NUCC Healthcare Provider Taxonomy service — offline specialty
 * resolution over the bundled code set (NUCC v26.1, 883 codes, in-memory).
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
 * → `psychiatr`; `pediatrician` and `pediatrics` → `pediatric`. This is
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
 * Combining forms NUCC joins onto a specialty word to name a narrower one: "neuro" +
 * "radiology", "cyto" + "pathology", "cardio" + "vascular", "oto" + "laryngology". Query
 * tokens match at word starts, so without help "radiologist" would miss Neuroradiology.
 * Each indexed word that starts with one of these forms is also indexed by its remainder
 * (see `compoundParts`). The list is enumerated from the bundled code set: it covers the
 * indexed words that carry another specialty word after a combining form (Cytopathology,
 * Psychotherapy, Maxillofacial, Otorhinolaryngology, …) and leaves out prefixes that only
 * produce coincidental matches ("indepen·dent", "ne·urology", "tran·sport").
 */
const COMBINING_FORMS: readonly string[] = [
  'bio',
  'cardio',
  'cyto',
  'dento',
  'dermato',
  'electro',
  'gero',
  'hemo',
  'immuno',
  'kinesio',
  'maxillo',
  'mechano',
  'micro',
  'neuro',
  'oro',
  'oto',
  'pharmaco',
  'psycho',
  'rhino',
  'sub',
  'uro',
];

/** Shortest compound remainder indexed as a word of its own ("neuro·log" yields none). */
const MIN_COMPOUND_PART = 4;

/**
 * The specialty words inside an indexed compound: strip leading combining forms one at a
 * time ("electroneurodiagnostic" → "neurodiagnostic" → "diagnostic"), keeping each
 * remainder of at least `MIN_COMPOUND_PART` characters.
 */
function compoundParts(word: string): string[] {
  const parts: string[] = [];
  let rest = word;
  for (;;) {
    const form = COMBINING_FORMS.find(
      (f) => rest.startsWith(f) && rest.length - f.length >= MIN_COMPOUND_PART,
    );
    if (!form) return parts;
    rest = rest.slice(form.length);
    parts.push(rest);
  }
}

/** An entry's searchable text: its stemmed words, then each compound part after a ` | ` break. */
function searchableText(words: string[]): string {
  return [words.join(' '), ...words.flatMap(compoundParts)].join(' | ');
}

/**
 * Generic role nouns that name no NUCC specialty on their own (the vocabulary says
 * "Physician"/"Surgery", never "doctor"), so a plain-language phrase routinely carries
 * one — "heart doctor", "eye doctor" — that would zero the whole strict-AND query.
 * Stripped from the *query's required terms* only; the index keeps every word. A stripped
 * word still counts toward ranking: an entry whose own name carries it ("Physician
 * Assistant", "Clinical Nurse Specialist") ranks ahead of siblings (see `selfNameRank`).
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'doctor',
  'physician',
  'specialist',
  'provider',
  'md',
  'do',
]);

/** A query split into required stemmed tokens and the stemmed stop words stripped from it. */
interface QueryTokens {
  stopWords: string[];
  tokens: string[];
}

/**
 * Tokenize a *query*: normalize → split off stop-words → stem. Distinct from the index-side
 * `tokenize` (which keeps every word) so noise words don't zero a match. When the query is
 * *only* stop-words (e.g. "physician"), nothing is stripped, so a degenerate query still
 * resolves rather than silently becoming empty.
 */
function tokenizeQuery(s: string): QueryTokens {
  const n = normalize(s);
  if (n.length === 0) return { tokens: [], stopWords: [] };
  const raw = n.split(' ');
  const kept = raw.filter((t) => !STOP_WORDS.has(t));
  if (kept.length === 0) return { tokens: raw.map(stemToken).filter(Boolean), stopWords: [] };
  return {
    tokens: kept.map(stemToken).filter(Boolean),
    stopWords: raw.filter((t) => STOP_WORDS.has(t)).map(stemToken),
  };
}

/**
 * Query-side aliases from everyday wording to NUCC's own vocabulary, keyed by the stemmed
 * query token — or a two-token phrase, which takes precedence over its tokens. A key
 * matches an entry when the key itself appears as a whole word (or whole phrase), or when
 * any alias starts a word (or run of words) of the entry's text. The index keeps the
 * registry's own vocabulary.
 *   - Stem mismatches: `cardiolog` → "Cardiovascular Disease", `pulmonolog` → "Pulmonary
 *     Disease", `surgeon` → "Surgery"/"Surgical", `orthoped`/`orthopedic` → the
 *     "Orthopaedic" spelling, `neurosurgeon` → "Neurological Surgery", `cardiac` →
 *     "Cardiovascular"/"Cardiothoracic", `fertility` → "Infertility"/"Reproductive
 *     Endocrinology".
 *   - Lay terms and abbreviations with no stem in common: `heart`, `eye` (Ophthalmology),
 *     `ent` (Otolaryngology), `kidney`, `cancer`, `obgyn`; phrases `speech therap(y)` →
 *     "Speech-Language Pathologist", `primary care` → Family and Internal Medicine.
 * Whole-word matching of the key keeps a short abbreviation from landing inside an
 * unrelated word: bare "ent" reaches Otolaryngology, never "gastroENTerology". Terms whose
 * own word already names their specialty (radiology, neurology, …) need no alias.
 * Deterministic lexical normalization — the same category as the stemming above.
 */
const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  cardiolog: ['cardiovascular'],
  pulmonolog: ['pulmonary'],
  surgeon: ['surgery', 'surgical'],
  orthoped: ['orthopaedic', 'orthopedic'],
  orthopedic: ['orthopaedic'],
  neurosurgeon: ['neurological surgery'],
  neurosurgery: ['neurological surgery'],
  cardiac: ['cardiovascular', 'cardiothoracic'],
  fertility: ['infertility', 'reproductive endocrinolog'],
  heart: ['cardiovascular'],
  eye: ['ophthalmolog'],
  ent: ['otolaryngolog'],
  kidney: ['nephrolog', 'renal'],
  cancer: ['oncolog'],
  obgyn: ['obstetric', 'gynecolog'],
  'speech therap': ['speech language patholog'], // "speech therapist"
  'speech therapy': ['speech language patholog'],
  'primary care': ['family medicine', 'internal medicine'],
};

/**
 * Stems that, as the query's only token, match whole words only. `therap` (from
 * "therapist") also starts "therapy" and "therapeutic", which in NUCC name treatments
 * and physician specialties (Therapeutic Radiology, Nuclear Imaging & Therapy), not the
 * profession. A qualifier keeps the wider match: "radiation therapist" still reaches
 * Radiation Therapy, "occupational therapist" the Occupational Therapy Assistant.
 */
const WHOLE_WORD_WHEN_ALONE: ReadonlySet<string> = new Set(['therap']);

/**
 * A required query term — one token, or a two-token alias phrase — with its aliases and
 * whether the term itself must match a whole word (aliased keys, and `WHOLE_WORD_WHEN_ALONE`
 * stems queried alone) rather than a word start.
 */
interface QueryTerm {
  aliases: readonly string[];
  text: string;
  wholeWord: boolean;
}

/**
 * Look a query key up in a keyed table, own keys only, so a query token such as
 * "constructor" never reads a property off `Object.prototype`.
 */
function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Group stemmed query tokens into terms, taking a two-token alias phrase before its tokens. */
function toTerms(tokens: readonly string[]): QueryTerm[] {
  const terms: QueryTerm[] = [];
  for (let i = 0; i < tokens.length; ) {
    const phrase = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : '';
    const phraseAliases = lookup(TOKEN_ALIASES, phrase);
    if (phraseAliases) {
      terms.push({ text: phrase, aliases: phraseAliases, wholeWord: true });
      i += 2;
    } else {
      const text = tokens[i] as string;
      const aliases = lookup(TOKEN_ALIASES, text) ?? [];
      const alone = tokens.length === 1 && WHOLE_WORD_WHEN_ALONE.has(text);
      terms.push({ text, aliases, wholeWord: aliases.length > 0 || alone });
      i += 1;
    }
  }
  return terms;
}

/** True when a query token asks for pediatrics ("pediatric", "pediatrician", "pediatrics"). */
function namesPediatrics(tokens: readonly string[]): boolean {
  return tokens.some((t) => t.startsWith('pediatr'));
}

/**
 * The representative general entry for a bare specialist term, keyed by stemmed query
 * token. When a query reduces (after stop-word stripping) to exactly one token with a row
 * here, that entry ranks first if it matched; multi-token queries never consult it, and it
 * never adds or removes a match. Without it these terms tie on every other signal and the
 * shortest label wins — a sub-specialty or, for `pharmac`, a physician entry.
 */
export const PREFERRED_ENTRIES: Readonly<Record<string, string>> = {
  oncolog: '207RX0202X', // Medical Oncology, not Surgical Oncology
  cancer: '207RX0202X', // Medical Oncology
  endocrinolog: '207RE0101X', // Endocrinology, Diabetes & Metabolism, not Reproductive Endocrinology
  hematolog: '207RH0000X', // Hematology (Internal Medicine), not Hematology (Pathology)
  radiolog: '2085R0202X', // Diagnostic Radiology, not Neuroradiology
  patholog: '207ZP0102X', // Anatomic Pathology & Clinical Pathology, not Cytopathology
  geriatric: '207RG0300X', // Geriatric Medicine (Internal Medicine), not Geriatric Psychiatry
  pharmac: '183500000X', // Pharmacist, not Clinical Pharmacology (a physician)
};

/**
 * Word-start match: true when `phrase` begins one of the words of `hay`, or a run of them
 * ("dent" starts "dental"; it does not start "independent").
 */
function startsWord(hay: string, phrase: string): boolean {
  return ` ${hay}`.includes(` ${phrase}`);
}

/** Whole-word match: true when `phrase` is one of the words of `hay`, or a run of them. */
function hasWord(hay: string, phrase: string): boolean {
  return ` ${hay} `.includes(` ${phrase} `);
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
  /**
   * 1 for a pediatric variant — "Pediatric" in the specialization, or, when the query
   * doesn't itself name pediatrics, the Pediatrics classification (Sports Medicine, Sleep
   * Medicine under Pediatrics) — so it sorts after the adult/general specialty. 0 otherwise.
   */
  pediatricRank: 0 | 1;
  /**
   * 0 when the entry is `PREFERRED_ENTRIES`' row for a single-token query — the
   * representative general specialty, ahead of every other signal. 1 otherwise.
   */
  preferredRank: 0 | 1;
  /**
   * How much of the query names the entry's *own* specialty label (its specialization,
   * else its classification) — i.e. the entry IS that specialty, not a sibling under the
   * same umbrella that matched only via the broader classification text. Elevates
   * "Neurology Physician" (spec "Neurology") over "Epilepsy Physician" (matches only via
   * the shared "Psychiatry & Neurology" classification) for a "neurologist" query.
   *   0 — every query term, and a stop word stripped from the query, name the label
   *       ("physician assistant" → "Physician Assistant", not "Dental Assistant")
   *   1 — every query term names the label
   *   2 — otherwise
   */
  selfNameRank: 0 | 1 | 2;
  tier: MatchTier;
}

/** Per-entry match text, built once at index time. */
interface SearchText {
  /** Classification + specialization + display name, stemmed, plus compound parts. */
  hay: string;
  /** Length of the stemmed words alone — the shorter-label ranking tiebreak. */
  haystackLength: number;
  /** The entry's own specialty label (specialization, else classification), same shape. */
  self: string;
}

/** A resolve page plus every inactive entry the query matched (which resolve never returns). */
export interface ResolveResult {
  /** Inactive entries the query matched, sorted by code — not ranked, not paged. */
  inactiveMatches: TaxonomyEntry[];
  /** The ranked page of active matches (`slice(skip, skip + limit)`). */
  matches: TaxonomyEntry[];
}

/**
 * Name inactive entries for an error message: `<code> <display name> (replaced by <code>)`,
 * or `(no replacement named)`, joined by `; `. Empty when there are none.
 */
export function describeInactiveEntries(entries: readonly TaxonomyEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.code} ${e.displayName} (${e.replacedBy ? `replaced by ${e.replacedBy}` : 'no replacement named'})`,
    )
    .join('; ');
}

/** True when an entry's grouping is the physician (allopathic & osteopathic) grouping. */
function isPhysicianGrouping(grouping: string): boolean {
  return /allopathic|osteopathic/i.test(grouping);
}

/** In-memory NUCC taxonomy index with resolve / get / browse. */
export class TaxonomyService {
  private readonly byCode: Map<string, TaxonomyEntry>;
  /**
   * Per-entry stemmed match text: the full haystack, and the entry's "own specialty label"
   * (specialization, else classification) used to tell whether a query named *this*
   * specialty vs. only matched via the classification umbrella shared with siblings.
   */
  private readonly searchText: Map<string, SearchText>;
  private readonly groupings: string[];

  constructor(entries: readonly TaxonomyEntry[] = TAXONOMY_ENTRIES) {
    this.byCode = new Map();
    this.searchText = new Map();
    const groupingSet = new Set<string>();
    for (const e of entries) {
      this.byCode.set(e.code, e);
      // Build the haystack from stemmed tokens so query stems match (e.g. a
      // query "cardiolog" hits indexed "cardiology" → both stem to "cardiolog").
      const words = tokenize([e.classification, e.specialization ?? '', e.displayName].join(' '));
      this.searchText.set(e.code, {
        hay: searchableText(words),
        haystackLength: words.join(' ').length,
        self: searchableText(tokenize(e.specialization ?? e.classification)),
      });
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
   * strict token match: every query term (or one of its formal-vocabulary aliases)
   * must start a word of the entry's classification + specialization + display-name text,
   * so "dentist" reaches "Dental" but not "Independent", and "urologist" not "Neurology".
   * A compound NUCC word also counts as its parts after a combining form
   * (`COMBINING_FORMS`: "neuroradiology" is matched by "radiologist"). The query is first
   * stripped of generic noise words ("doctor", "specialist", …) and mapped through
   * `TOKEN_ALIASES`, so "heart doctor" reduces to "heart" and "ent" reaches
   * Otolaryngology. Aliased keys match as whole words, so a short abbreviation can't land
   * inside an unrelated word. No fuzzy fallback — a weak query is better served by an
   * honest "no match, browse the hierarchy" than an approximate guess the caller can't
   * audit.
   *
   * Ranking is a chain of transparent, rule-based signals (each lowest-first; see
   * `ResolveHit`): preferred general entry for a bare term (`PREFERRED_ENTRIES`) →
   * physician grouping → query names the entry's own specialty (a stripped stop word in
   * that name counts) → alias match (canonical general specialty) → non-pediatric (a
   * Pediatrics-classified entry counts as pediatric unless the query names pediatrics) →
   * shorter haystack → code. The net effect: a bare "cardiologist" resolves to
   * "Cardiovascular Disease Physician", not a cardiology pharmacist, technician, hospital,
   * or a narrow cardiology sub-specialty. Ranking never changes the match set.
   *
   * `skip` pages the fully-ranked, deterministic result set (`slice(skip, skip + limit)`);
   * ties break down to `code`, so paging never skips or duplicates an entry across calls.
   *
   * Codes NUCC marks inactive never resolve: they are set aside inside the match loop,
   * before ranking and the `skip`/`limit` slice, so pages stay contiguous. Exact `get`
   * and `browse` still return them.
   */
  resolve(query: string, limit: number, skip = 0): TaxonomyEntry[] {
    return this.resolveWithInactive(query, limit, skip).matches;
  }

  /**
   * `resolve`, plus the inactive entries the query matched, so a caller whose query
   * matched only inactive codes can name them and their replacements.
   */
  resolveWithInactive(query: string, limit: number, skip = 0): ResolveResult {
    const { tokens, stopWords } = tokenizeQuery(query);
    if (tokens.length === 0) return { matches: [], inactiveMatches: [] };
    const terms = toTerms(tokens);
    const preferredCode =
      tokens.length === 1 ? lookup(PREFERRED_ENTRIES, tokens[0] as string) : undefined;
    const pediatricQuery = namesPediatrics(tokens);
    const hits: ResolveHit[] = [];
    const inactiveMatches: TaxonomyEntry[] = [];
    for (const [code, entry] of this.byCode) {
      const text = this.searchText.get(code);
      if (!text) continue;
      const { hay, self } = text;

      // Every query term must match via the term itself or one of its aliases, at a word
      // start. Aliased keys (eye, ent, obgyn, …) and a lone `therap` must match a whole
      // word, so a short abbreviation can't land inside an unrelated one.
      let allMatch = true;
      let allMatchSelfName = true;
      let matchedAnAlias = false;
      for (const { text: term, aliases, wholeWord } of terms) {
        const inHay = wholeWord ? hasWord(hay, term) : startsWord(hay, term);
        const aliasInHay = aliases.some((a) => startsWord(hay, a));
        if (!inHay && !aliasInHay) {
          allMatch = false;
          break;
        }
        if (aliasInHay && !inHay) matchedAnAlias = true;
        const inSelf = wholeWord ? hasWord(self, term) : startsWord(self, term);
        if (!inSelf && !aliases.some((a) => startsWord(self, a))) {
          allMatchSelfName = false;
        }
      }
      if (!allMatch) continue;
      if (entry.status === 'inactive') {
        inactiveMatches.push(entry);
        continue;
      }

      const namesStopWord = stopWords.some((w) => hasWord(self, w));
      hits.push({
        entry,
        preferredRank: code === preferredCode ? 0 : 1,
        tier: isPhysicianGrouping(entry.grouping) ? MatchTier.PhysicianGrouping : MatchTier.Other,
        selfNameRank: allMatchSelfName ? (namesStopWord ? 0 : 1) : 2,
        aliasRank: matchedAnAlias ? 0 : 1,
        pediatricRank:
          /pediatric/i.test(entry.specialization ?? '') ||
          (!pediatricQuery && /pediatric/i.test(entry.classification))
            ? 1
            : 0,
        haystackLength: text.haystackLength,
      });
    }
    hits.sort(
      (a, b) =>
        a.preferredRank - b.preferredRank ||
        a.tier - b.tier ||
        a.selfNameRank - b.selfNameRank ||
        a.aliasRank - b.aliasRank ||
        a.pediatricRank - b.pediatricRank ||
        a.haystackLength - b.haystackLength ||
        a.entry.code.localeCompare(b.entry.code),
    );
    return {
      matches: hits.slice(skip, skip + limit).map((h) => h.entry),
      inactiveMatches: inactiveMatches.sort((a, b) => a.code.localeCompare(b.code)),
    };
  }

  /** Exact lookup by taxonomy code. Returns undefined when absent. */
  get(code: string): TaxonomyEntry | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  /**
   * Browse the hierarchy, optionally filtered by grouping (case-insensitive
   * substring) and/or NPI section. Every code is included, inactive ones flagged by
   * `status`. Entries are returned sorted by code. `skip` pages the
   * sorted set (`slice(skip, skip + limit)`); the code sort is total, so paging a grouping
   * larger than a single page never skips or duplicates an entry across calls.
   */
  browse(opts: {
    grouping?: string;
    section?: TaxonomySection;
    limit: number;
    skip?: number;
  }): TaxonomyEntry[] {
    const groupingNeedle = opts.grouping ? normalize(opts.grouping) : undefined;
    const out: TaxonomyEntry[] = [];
    for (const entry of this.byCode.values()) {
      if (opts.section && entry.section !== opts.section) continue;
      if (groupingNeedle && !normalize(entry.grouping).includes(groupingNeedle)) continue;
      out.push(entry);
    }
    out.sort((a, b) => a.code.localeCompare(b.code));
    const skip = opts.skip ?? 0;
    return out.slice(skip, skip + opts.limit);
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
