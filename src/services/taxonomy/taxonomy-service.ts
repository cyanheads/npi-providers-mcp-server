/**
 * @fileoverview NUCC Healthcare Provider Taxonomy service — offline specialty
 * resolution over the bundled code set (NUCC v26.1, 883 codes, in-memory).
 * @module services/taxonomy/taxonomy-service
 *
 * Loads the generated `taxonomy-data.ts` into an in-memory index once at startup
 * (server-level reference data — not tenant-scoped, no network). Provides the three
 * lookup modes the surface needs: strict-token `resolve` (plain term → codes),
 * exact `get` (by code), and hierarchy `browse`; plus the text that searches the NPPES
 * registry for a code (`taxonomyDescriptionOf`) and the decode of a `taxonomy_description`
 * value that names a code or display name (`decodeTaxonomyDescription`). A resolved search also
 * takes its candidate taxonomies (`specialtyCandidates`) and the codes its rows must hold
 * (`resolvedCodeSet`) from here. No external dependency.
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

/**
 * Tokenize index text: its words split as a query's are (`queryWords`, dotted abbreviations
 * joined), then stemmed, dropping empties. "Clinical Genetics (M.D.)" indexes `md`, the word a
 * query "M.D." or "MD" carries, never the letters `m` and `d`.
 */
function tokenize(s: string): string[] {
  return queryWords(s).map(stemToken).filter(Boolean);
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
 * Words that name no NUCC specialty on their own, so a plain-language phrase routinely
 * carries one that would zero the whole strict-AND query: generic role nouns (the vocabulary
 * says "Physician"/"Surgery", never "doctor" — "heart doctor", "eye doctors", "eye dr"), and the
 * connective "and", which NUCC mostly writes as "&" and normalization drops ("obstetrics and
 * gynecology"). Stripped, singular or plural (see `stopWordOf`), from the *query's required
 * terms* only; the index keeps every word. A stripped word still counts toward ranking: an
 * entry whose own name carries it ("Physician Assistant", "Clinical Nurse Specialist") ranks
 * ahead of siblings (see `selfNameRank`), and one whose own name joins the query's words with
 * "and" ranks ahead of the "&" spellings that stripping "and" lets match (see `connectiveRank`).
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'doctor',
  'dr',
  'physician',
  'specialist',
  'provider',
  'md',
  'do',
  'and',
]);

/**
 * The stop word a normalized query word is, singular or plural ("doctors" → "doctor",
 * "MDs" → "md"), or `undefined` when it is not one.
 */
function stopWordOf(word: string): string | undefined {
  if (STOP_WORDS.has(word)) return word;
  const singular = word.endsWith('s') ? word.slice(0, -1) : '';
  return STOP_WORDS.has(singular) ? singular : undefined;
}

/** A query split into required stemmed tokens and the stemmed stop words stripped from it. */
interface QueryTokens {
  stopWords: string[];
  tokens: string[];
}

/**
 * Join a dotted abbreviation — single letters separated by periods — into one word:
 * "P.A." → "PA", "c.r.n.a" → "crna". Normalization would otherwise split it into one-letter
 * tokens. "Ph.D." is not a run of single letters and is left alone. Applied to query and
 * index text alike, so NUCC's "(M.D.)" and "(D.M.D.)" index as `md` and `dmd`.
 */
function joinDottedLetters(s: string): string {
  return s.replace(/(?<![\p{L}\p{N}])\p{L}(?:\.\p{L})+(?![\p{L}\p{N}])\.?/gu, (run) =>
    run.replaceAll('.', ''),
  );
}

/** A query's normalized words, dotted abbreviations joined first. Empty for a blank query. */
function queryWords(s: string): string[] {
  const n = normalize(joinDottedLetters(s));
  return n.length === 0 ? [] : n.split(' ');
}

/** Stop words that name a physician, so a query of them points at the physician grouping. */
const PHYSICIAN_STOP_WORDS: ReadonlySet<string> = new Set([
  'doctor',
  'dr',
  'physician',
  'md',
  'do',
]);

/**
 * Whether a query is made only of stop words (singular or plural), and so names no specialty:
 * `'physician'` when one of them names a physician ("doctors", "M.D."), `'other'` for
 * "specialist"/"provider" alone, `undefined` when the query carries any other word (or none).
 * `resolve` returns nothing for such a query; callers use this to point at `browse` instead of
 * a bare miss.
 */
export function stopWordOnlyQuery(query: string): 'physician' | 'other' | undefined {
  const words = queryWords(query);
  const stopWords = words.map(stopWordOf).filter((w) => w !== undefined);
  if (words.length === 0 || stopWords.length < words.length) return;
  return stopWords.some((w) => PHYSICIAN_STOP_WORDS.has(w)) ? 'physician' : 'other';
}

/**
 * Tokenize a *query*: join dotted abbreviations → normalize → split off stop-words (singular
 * or plural) → stem. Distinct from the index-side `tokenize` (which keeps every word) so noise
 * words don't zero a match. A query made only of stop-words (e.g. "physicians", "M.D.") names
 * no specialty and yields no required terms, so it matches nothing — matching the stop words'
 * own stems would answer "physician" with Radiological Physics. Callers name the miss through
 * {@link stopWordOnlyQuery} and point at `browse`.
 */
function tokenizeQuery(s: string): QueryTokens {
  const raw = queryWords(s);
  const kept = raw.filter((t) => !stopWordOf(t));
  if (kept.length === 0) return { tokens: [], stopWords: [] };
  return {
    tokens: kept.map(stemToken).filter(Boolean),
    stopWords: raw.flatMap((t) => stopWordOf(t) ?? []).map(stemToken),
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
 *   - Lay terms with no stem in common: `heart`, `eye` (Ophthalmology), `kidney`, `cancer`,
 *     and the body parts and conditions people name a doctor by — `skin`, `stomach`, `lung`,
 *     `liver`, `bone`, `foot` (Podiatrist), `brain`/`nerve` (Neurology), `ear`/`nose`/`throat`
 *     (Otolaryngology), `tooth`/`teeth` (Dentist), `arthritis`, `hormone`/`thyroid`,
 *     `prostate`/`bladder` (Urology); phrases `speech therap(y)` → "Speech-Language
 *     Pathologist", `primary care` and `pcp` → Family and Internal Medicine, `general
 *     practitioner` → General Practice, `pain management` → Pain Medicine, `nursing home` →
 *     the skilled and intermediate-care nursing facilities.
 *   - Abbreviations: `ent` (Otolaryngology), `obgyn`, `ob` (Obstetrics), `gy` (Gynecology),
 *     `mr` (MRI), `gp`, `gi`, `id` (Infectious Disease), `pt`/`ot` (Physical and Occupational
 *     Therapist), `em` (every Emergency label, Emergency Medicine first; "EMS" stems to it);
 *     credentials `rn`, `np`, `pa`, `crna`, `lpn`, `lvn`, `emt`, `at` (Athletic Trainer),
 *     `dmd`/`dd` ("DMD"/"DDS", Dentist), and `er` (Emergency Medicine), each to the NUCC name
 *     of that profession.
 *   - Word forms NUCC varies: `recreational` → "Recreation Therapist" (NUCC also writes
 *     "Recreational Therapist Assistant").
 * Keys and aliases are written in the stemmed form `stemToken` produces — "infectious" is
 * `infectiou`, "arthritis" `arthriti` — or they never compare equal to anything.
 * Whole-word matching of the key keeps a short abbreviation from landing inside an
 * unrelated word: bare "ent" reaches Otolaryngology, never "gastroENTerology"; "ot" never
 * "OTolaryngology". A key of one or two letters gets a row only where a word start was its
 * sole route to the right entry: such a token without a row matches only a whole word (see
 * `MAX_WHOLE_WORD_LENGTH`). Terms whose own word already names their specialty (radiology,
 * neurology, …) need no alias. Deterministic lexical normalization — the same category as
 * the stemming above.
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
  skin: ['dermatolog'],
  stomach: ['gastroenterolog'],
  lung: ['pulmonary', 'pulmonolog'],
  liver: ['hepatolog'],
  bone: ['orthopaedic'],
  foot: ['podiatr'], // PREFERRED_ENTRIES puts Podiatrist ahead of the physician tier
  brain: ['neurolog'],
  nerve: ['neurolog'],
  ear: ['otolaryngolog'],
  nose: ['otolaryngolog'],
  throat: ['otolaryngolog'],
  tooth: ['dent'],
  teeth: ['dent'],
  arthriti: ['rheumatolog'], // stemmed "arthritis"
  hormone: ['endocrinolog'],
  thyroid: ['endocrinolog'],
  prostate: ['urolog'],
  bladder: ['urolog'],
  obgyn: ['obstetric', 'gynecolog'],
  ob: ['obstetric'],
  gy: ['gynecolog'], // "gy", "OB/GY": what "gyn" reaches
  mr: ['mri'], // "MR", "MR imaging": the two MRI entries
  em: ['emergency'], // also "EMS"; Emergency Medicine leads on the shorter label
  gp: ['general practice'],
  gi: ['gastroenterolog'],
  id: ['infectiou disease'], // stemmed "infectious disease"
  pt: ['physical therap'],
  ot: ['occupational therap'],
  recreational: ['recreation'],
  'speech therap': ['speech language patholog'], // "speech therapist"
  'speech therapy': ['speech language patholog'],
  'primary care': ['family medicine', 'internal medicine'],
  pcp: ['family medicine', 'internal medicine'],
  'general practitioner': ['general practice'],
  'pain management': ['pain medicine'],
  // Skilled Nursing Facility, Nursing Facility/Intermediate Care Facility — a bare
  // "nursing facility" would also start Nursing Facility Supplies
  'nursing home': ['skilled nursing', 'nursing facility intermediate'],
  rn: ['registered nurse'],
  np: ['nurse practitioner'],
  pa: ['physic assistant'], // stemmed "physician assistant"
  crna: ['nurse anesthet'], // "Nurse Anesthetist, Certified Registered"
  lpn: ['licensed practical nurse'],
  lvn: ['licensed vocational nurse'],
  emt: ['emergency medical technic'], // every level; PREFERRED_ENTRIES puts Basic first
  er: ['emergency medicine'],
  at: ['athletic trainer'],
  dmd: ['dent'], // stemmed "dentist"; PREFERRED_ENTRIES puts Dentist ahead of the physician tier
  dd: ['dent'], // stemmed "dds"
};

/**
 * Stems that, as the query's only token, match whole words only. `therap` (from
 * "therapist") also starts "therapy" and "therapeutic", which in NUCC name treatments
 * and physician specialties (Therapeutic Radiology, Nuclear Imaging & Therapy), not the
 * profession. A qualifier keeps the wider match: "radiation therapist" still reaches
 * Radiation Therapy, "occupational therapist" the Occupational Therapy Assistant. The
 * reverse holds for a qualified "therapy", which also names the profession (`WORD_FORMS`).
 */
const WHOLE_WORD_WHEN_ALONE: ReadonlySet<string> = new Set(['therap']);

/**
 * Indexed words a token also matches whole when the query has another term, ranked as the
 * token itself, not as an alias. The stemmer keeps "therapy" apart from "therapist" (`therap`),
 * so a bare "therapy" stays on treatment labels, but "physical therapy" names the Physical
 * Therapist as well as the Physical Therapy Assistant and Clinic/Center. Matched as the word
 * itself, a facility the query names ("physical therapy clinic") keeps its lead; an alias match
 * would outrank it.
 */
const WORD_FORMS: Readonly<Record<string, readonly string[]>> = { therapy: ['therap'] };

/**
 * The longest stemmed token that matches only a whole word, never a word start: one or two
 * letters starting a word are a coincidence ("im" → Imaging, "ed" → Educator). Such a token
 * reaches a longer word only through a `TOKEN_ALIASES` row (`ob`, `em`, `pa`, …).
 */
const MAX_WHOLE_WORD_LENGTH = 2;

/**
 * A required query term — one token, or a two-token alias phrase — with its aliases, the
 * indexed words it also matches whole (`WORD_FORMS`), and whether the term itself must match
 * a whole word (aliased keys, tokens of up to `MAX_WHOLE_WORD_LENGTH` letters, and
 * `WHOLE_WORD_WHEN_ALONE` stems queried alone) rather than a word start.
 */
interface QueryTerm {
  aliases: readonly string[];
  forms: readonly string[];
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
      terms.push({ text: phrase, aliases: phraseAliases, forms: [], wholeWord: true });
      i += 2;
    } else {
      const text = tokens[i] as string;
      const aliases = lookup(TOKEN_ALIASES, text) ?? [];
      const alone = tokens.length === 1;
      terms.push({
        text,
        aliases,
        forms: alone ? [] : (lookup(WORD_FORMS, text) ?? []),
        wholeWord:
          aliases.length > 0 ||
          (alone && WHOLE_WORD_WHEN_ALONE.has(text)) ||
          text.length <= MAX_WHOLE_WORD_LENGTH,
      });
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
  emt: '146N00000X', // Basic Emergency Medical Technician, not the shorter-named Paramedic
  foot: '213E00000X', // Podiatrist, not Orthopaedic Foot and Ankle Surgery (a physician)
  dmd: '122300000X', // Dentist, not the physician Oral & Maxillofacial Surgery (D.M.D.)
  hormone: '207RE0101X', // Endocrinology, Diabetes & Metabolism, not Reproductive Endocrinology
  thyroid: '207RE0101X', // Endocrinology, Diabetes & Metabolism
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
  /**
   * 0 when the query says "and" and the entry's own specialty label (specialization, else
   * classification) spells it too, holding every query term: "Oral and Maxillofacial Surgery"
   * is the Dentist and Clinic/Center specialization written that way, ahead of the physician
   * classification NUCC writes "Oral & Maxillofacial Surgery", which matches only because the
   * stop word "and" is stripped. 1 otherwise, and for every query without "and".
   */
  connectiveRank: 0 | 1;
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
  /**
   * The ranked page of active matches (`slice(skip, skip + limit)`); `specialtyCandidates`
   * adds the later same-text candidates past its cap.
   */
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

/**
 * The registry's own wording for codes whose NUCC v26.1 text it rejects as a
 * `taxonomy_description` (error 14), keyed by code. NPPES matches the classification and
 * specialization text it stores, which for these codes differs from NUCC's: "Psych/Mental
 * Health" for "Psychiatric/Mental Health", "MilitaryU.S. Coast Guard" with no slash, "Spec/Tech"
 * for "Specialist/Technologist", and "Hearing  Aid Equipment" with two spaces (the registry
 * doesn't fold whitespace). Each wording was verified live against rows that hold the code.
 * Three active codes have NUCC text the registry rejects and no wording of their own found
 * (`207QD0401X` and `207QB0505X` Diabetology, `146E00000X` Community Paramedic), so they keep
 * NUCC's text.
 */
const REGISTRY_WORDING: Readonly<Record<string, string>> = {
  '363LP0808X': 'Psych/Mental Health',
  '163WP0808X': 'Psych/Mental Health',
  '364SP0808X': 'Psych/Mental Health',
  '163WP0809X': 'Psych/Mental Health, Adult',
  '364SP0809X': 'Psych/Mental Health, Adult',
  '163WP0807X': 'Psych/Mental Health, Child & Adolescent',
  '364SP0807X': 'Psych/Mental Health, Child & Adolescent',
  '364SP0810X': 'Psych/Mental Health, Child & Family',
  '364SP0811X': 'Psych/Mental Health, Chronically Ill',
  '364SP0812X': 'Psych/Mental Health, Community',
  '364SP0813X': 'Psych/Mental Health, Geropsychiatric',
  '207SC0300X': 'Clinical Cytogenetic',
  '1223D0004X': 'Dentist Anesthesiologist Speciality',
  '261QM1100X': 'MilitaryU.S. Coast Guard Outpatient',
  '332000000X': 'MilitaryU.S. Coast Guard Pharmacy',
  '341800000X': 'MilitaryU.S. Coast Guard Transport',
  '251T00000X': 'PACE Provider Organization',
  '246Y00000X': 'Spec/Tech, Health Info',
  '246Q00000X': 'Spec/Tech, Pathology',
  '246X00000X': 'Spec/Tech, Cardiovascular',
  '332S00000X': 'Hearing  Aid Equipment',
};

/**
 * The `taxonomy_description` text that searches the registry for an entry: the registry's own
 * wording where it differs from NUCC's (`REGISTRY_WORDING`), else the specialization, else the
 * classification. The registry matches a case-insensitive prefix of one taxonomy's
 * classification or specialization, never the combined form or the display name ("…
 * Physician"), so the specialization is the narrowest text it accepts for a code. Specialty
 * resolution and code decoding both send this text.
 */
export function taxonomyDescriptionOf(entry: TaxonomyEntry): string {
  return lookup(REGISTRY_WORDING, entry.code) ?? entry.specialization ?? entry.classification;
}

/**
 * An entry's classification and, when it has one, its specialization: the two names the
 * registry matches a taxonomy on, and the parts of its `Classification, Specialization` text.
 */
export function taxonomyNamesOf(entry: TaxonomyEntry): string[] {
  return entry.specialization
    ? [entry.classification, entry.specialization]
    : [entry.classification];
}

/** A NUCC taxonomy code, upper case: three digits, six letters or digits, `X`. */
const NUCC_CODE = /^\d{3}[A-Z0-9]{6}X$/;

/** What a `taxonomy_description` value names (`TaxonomyService.decodeTaxonomyDescription`). */
export type TaxonomyDescriptionDecode =
  /** An active code or a decodable display name: search with `taxonomyDescription`. */
  | { entry: TaxonomyEntry; kind: 'decoded'; taxonomyDescription: string }
  /** Shaped like a NUCC code (`code`, upper case), but no bundled entry has it. */
  | { code: string; kind: 'unknown_code' }
  /** A code NUCC marks inactive; `entry.replacedBy` names its replacement when NUCC records one. */
  | { entry: TaxonomyEntry; kind: 'inactive_code' }
  /** Neither: search with the value as written, trimmed (`text`). */
  | { kind: 'free_text'; text: string };

/**
 * The display names a `taxonomy_description` decodes, lower-cased, each to its active entry.
 * Left out:
 *   - a name that is a case-insensitive prefix of any bundled classification or specialization.
 *     The registry may accept it as written, and decoding it can change a working search:
 *     "Critical Access Hospital" reaches clinics (Clinic/Center, Critical Access Hospital), its
 *     decode "Critical Access" reaches hospitals.
 *   - a name whose active entries would send different texts.
 * Inactive entries take no part, so an inactive entry never decodes by name.
 */
function decodableDisplayNames(entries: readonly TaxonomyEntry[]): Map<string, TaxonomyEntry> {
  const decodable = new Map<string, TaxonomyEntry>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    const name = entry.displayName.toLowerCase();
    const seen = decodable.get(name);
    if (!seen) decodable.set(name, entry);
    else if (taxonomyDescriptionOf(seen) !== taxonomyDescriptionOf(entry)) conflicting.add(name);
  }
  const bundledNames = [
    ...new Set(entries.flatMap((e) => taxonomyNamesOf(e).map((n) => n.toLowerCase()))),
  ];
  for (const name of decodable.keys()) {
    if (conflicting.has(name) || bundledNames.some((n) => n.startsWith(name))) {
      decodable.delete(name);
    }
  }
  return decodable;
}

/** True when an entry's grouping is the physician (allopathic & osteopathic) grouping. */
function isPhysicianGrouping(grouping: string): boolean {
  return /allopathic|osteopathic/i.test(grouping);
}

/** Browse filters: grouping by substring, classification by exact name, and NUCC section. */
export interface BrowseFilters {
  classification?: string;
  grouping?: string;
  section?: TaxonomySection;
}

/** A grouping or classification name with the number of entries browse returns for it. */
export interface NameCount {
  count: number;
  name: string;
}

/**
 * A normalized grouping or classification name with each standalone "and" dropped. NUCC writes
 * most two-part names with "&", which normalization turns into a space, and a few with "and";
 * folding both lets "Allopathic and Osteopathic Physicians" reach "Allopathic & Osteopathic
 * Physicians" and the reverse. No two NUCC grouping or classification names fold alike, and
 * none folds to an empty string.
 */
function foldAnd(normalized: string): string {
  return normalized
    .split(' ')
    .filter((word) => word !== 'and')
    .join(' ');
}

/**
 * The test a browse `grouping` filter applies to a grouping name: the filter is a
 * case-insensitive substring of the normalized name, or — when it still names something once
 * folded — a run of whole words of the folded name. The folded comparison only adds matches,
 * so "and" spelled for "&" reaches its grouping ("Allopathic and Osteopathic Physicians",
 * "Speech, Language & Hearing"), while a filter cutting through an "and" ("language an") or a
 * word beside one ("e and", "and H") keeps exactly its plain match: once "and" is dropped, a
 * word fragment would match inside almost any name. A bare "and" keeps its substring match
 * rather than matching everything.
 */
function groupingFilter(filter: string): (grouping: string) => boolean {
  const plain = normalize(filter);
  const folded = foldAnd(plain);
  return (grouping) => {
    const name = normalize(grouping);
    return name.includes(plain) || (folded !== '' && hasWord(foldAnd(name), folded));
  };
}

/** Count entries by one of their names, as `{ name, count }` rows sorted by name. */
function countBy(
  entries: readonly TaxonomyEntry[],
  nameOf: (entry: TaxonomyEntry) => string,
): NameCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = nameOf(entry);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** In-memory NUCC taxonomy index with resolve / get / browse. */
export class TaxonomyService {
  private readonly byCode: Map<string, TaxonomyEntry>;
  /** Lower-cased display name → the active entry it decodes to (`decodableDisplayNames`). */
  private readonly byDisplayName: Map<string, TaxonomyEntry>;
  /**
   * Per-entry stemmed match text: the full haystack, and the entry's "own specialty label"
   * (specialization, else classification) used to tell whether a query named *this*
   * specialty vs. only matched via the classification umbrella shared with siblings.
   */
  private readonly searchText: Map<string, SearchText>;

  constructor(entries: readonly TaxonomyEntry[] = TAXONOMY_ENTRIES) {
    this.byCode = new Map();
    this.searchText = new Map();
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
    }
    this.byDisplayName = decodableDisplayNames(entries);
  }

  /** Total number of indexed taxonomy entries. */
  get size(): number {
    return this.byCode.size;
  }

  /**
   * Each grouping `filters` reach, with the number of entries browse returns in it under
   * them (inactive codes included), sorted by name. Empty when the filters reach no entry.
   */
  listGroupings(filters: BrowseFilters = {}): NameCount[] {
    return countBy(this.filtered(filters), (e) => e.grouping);
  }

  /**
   * Each classification `filters` reach, with the number of entries browse returns for it
   * under them — the total that `classification: name` with the same filters pages through —
   * sorted by name. Two names (Legal Medicine, Specialist/Technologist) sit in two groupings
   * each, so without a grouping filter a row counts both.
   */
  listClassifications(filters: BrowseFilters = {}): NameCount[] {
    return countBy(this.filtered(filters), (e) => e.classification);
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
   * Otolaryngology. Aliased keys and tokens of one or two letters match as whole words, so a
   * short abbreviation can't land inside an unrelated word ("im" never reaches Imaging). In a
   * query with another term, "therapy" also matches the word "Therapist" (`WORD_FORMS`), so
   * "physical therapy" reaches the Physical Therapist. No fuzzy fallback — a weak query is
   * better served by an honest "no match, browse the hierarchy" than an approximate guess the
   * caller can't audit.
   *
   * Ranking is a chain of transparent, rule-based signals (each lowest-first; see
   * `ResolveHit`): preferred general entry for a bare term (`PREFERRED_ENTRIES`) → the
   * entry's own specialty spells the query's "and" → physician grouping → query names the
   * entry's own specialty (a stripped stop word in that name counts) → alias match
   * (canonical general specialty) → non-pediatric (a Pediatrics-classified entry counts as
   * pediatric unless the query names pediatrics) → shorter haystack → code. The net effect:
   * a bare "cardiologist" resolves to "Cardiovascular Disease Physician", not a cardiology
   * pharmacist, technician, hospital, or a narrow cardiology sub-specialty. Ranking never
   * changes the match set.
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
    const spellsAnd = stopWords.includes('and');
    const hits: ResolveHit[] = [];
    const inactiveMatches: TaxonomyEntry[] = [];
    for (const [code, entry] of this.byCode) {
      const text = this.searchText.get(code);
      if (!text) continue;
      const { hay, self } = text;

      // Every query term must match via the term itself, one of its whole word forms, or one
      // of its aliases at a word start. Aliased keys (eye, ent, obgyn, …), tokens of one or two
      // letters, and a lone `therap` must match a whole word, so a short abbreviation can't
      // land inside an unrelated one. A word form counts as the term itself.
      let allMatch = true;
      let allMatchSelfName = true;
      let matchedAnAlias = false;
      for (const { text: term, aliases, forms, wholeWord } of terms) {
        const inHay =
          (wholeWord ? hasWord(hay, term) : startsWord(hay, term)) ||
          forms.some((f) => hasWord(hay, f));
        const aliasInHay = aliases.some((a) => startsWord(hay, a));
        if (!inHay && !aliasInHay) {
          allMatch = false;
          break;
        }
        if (aliasInHay && !inHay) matchedAnAlias = true;
        const inSelf =
          (wholeWord ? hasWord(self, term) : startsWord(self, term)) ||
          forms.some((f) => hasWord(self, f));
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
        connectiveRank: allMatchSelfName && spellsAnd && hasWord(self, 'and') ? 0 : 1,
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
        a.connectiveRank - b.connectiveRank ||
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
   * Decode a `taxonomy_description` value, trimmed. A NUCC code in any case decodes to its
   * entry and `taxonomyDescriptionOf` text, or reports the code unknown or inactive, which no
   * search should be sent for. An exact display name in any case (inner spacing as NUCC writes
   * it) decodes the same way, unless the registry may accept it as written
   * (`decodableDisplayNames`). Anything else is free text.
   */
  decodeTaxonomyDescription(value: string): TaxonomyDescriptionDecode {
    const text = value.trim();
    const code = text.length === 10 ? text.toUpperCase() : undefined;
    if (code && NUCC_CODE.test(code)) {
      const entry = this.byCode.get(code);
      if (!entry) return { kind: 'unknown_code', code };
      if (entry.status === 'inactive') return { kind: 'inactive_code', entry };
      return { kind: 'decoded', entry, taxonomyDescription: taxonomyDescriptionOf(entry) };
    }
    const entry = this.byDisplayName.get(text.toLowerCase());
    return entry
      ? { kind: 'decoded', entry, taxonomyDescription: taxonomyDescriptionOf(entry) }
      : { kind: 'free_text', text };
  }

  /**
   * The active entries whose registry search text (`taxonomyDescriptionOf`) is `text`,
   * case-insensitively, sorted by code. When the registry finds no taxonomy for such a text
   * (its error 14), resolving or decoding any of these codes sends that text again.
   */
  searchedBy(text: string): TaxonomyEntry[] {
    const key = text.toLowerCase();
    return [...this.byCode.values()]
      .filter((e) => e.status === 'active' && taxonomyDescriptionOf(e).toLowerCase() === key)
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  /**
   * Browse the hierarchy, optionally filtered by grouping, classification, and NUCC section.
   * Every code is included, inactive ones flagged by `status`. Entries are returned sorted by
   * code. `skip` pages the sorted set (`slice(skip, skip + limit)`); the code sort is total,
   * so paging a grouping larger than a single page never skips or duplicates an entry across
   * calls.
   *   - `grouping` is a case-insensitive substring; whole words also match with "and" compared
   *     like "&", without narrowing any plain match (`groupingFilter`).
   *   - `classification` is a case-insensitive exact name, "and" folded — a substring would let
   *     "Urology" pull in "Psychiatry & Neurology". A filter that folds to nothing ("&", "and")
   *     names no classification and matches nothing.
   */
  browse(opts: BrowseFilters & { limit: number; skip?: number }): TaxonomyEntry[] {
    const skip = opts.skip ?? 0;
    return this.filtered(opts)
      .sort((a, b) => a.code.localeCompare(b.code))
      .slice(skip, skip + opts.limit);
  }

  /** The entries browse returns under `filters`, unsorted and unpaged. */
  private filtered(filters: BrowseFilters): TaxonomyEntry[] {
    const inGrouping =
      filters.grouping === undefined ? undefined : groupingFilter(filters.grouping);
    const classification =
      filters.classification === undefined ? undefined : foldAnd(normalize(filters.classification));
    return [...this.byCode.values()].filter(
      (entry) =>
        (!filters.section || entry.section === filters.section) &&
        (inGrouping === undefined || inGrouping(entry.grouping)) &&
        (classification === undefined ||
          foldAnd(normalize(entry.classification)) === classification),
    );
  }
}

// --- Resolved taxonomies of a specialty search ---

/**
 * The candidates a specialty term resolves to for a search: `resolveWithInactive`'s first
 * `limit` matches, then every later match that sends the first one's registry text
 * (`taxonomyDescriptionOf`, case-insensitive) at the same level — specialization or
 * classification — in rank order. The registry answers that text with every code that sends
 * it, so the cap never decides which of those codes a search keeps; a same-text code at the
 * other level (the physician Pediatrics classification and the nursing Pediatrics
 * specializations) is a different specialty and stays out. `inactiveMatches` passes through.
 */
export function specialtyCandidates(
  taxonomy: TaxonomyService,
  query: string,
  limit: number,
): ResolveResult {
  const { matches, inactiveMatches } = taxonomy.resolveWithInactive(query, taxonomy.size);
  const [first] = matches;
  if (!first) return { matches, inactiveMatches };
  const text = taxonomyDescriptionOf(first).toLowerCase();
  const specialization = Boolean(first.specialization);
  const sendsFirstText = (entry: TaxonomyEntry) =>
    Boolean(entry.specialization) === specialization &&
    taxonomyDescriptionOf(entry).toLowerCase() === text;
  return {
    matches: [...matches.slice(0, limit), ...matches.slice(limit).filter(sendsFirstText)],
    inactiveMatches,
  };
}

/**
 * The codes a search row must hold one of to match the resolved taxonomies `entries`. A
 * specialization code stands for itself. A classification-level code stands for every bundled
 * code of its classification, inactive ones included, since the registry matches its text
 * against each of them; the classification is scoped to the entry's grouping, where two
 * names (Legal Medicine, Specialist/Technologist) each head a second, unrelated classification.
 */
export function resolvedCodeSet(
  taxonomy: TaxonomyService,
  entries: readonly TaxonomyEntry[],
): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const entry of entries) {
    if (entry.specialization) {
      codes.add(entry.code);
      continue;
    }
    const members = taxonomy.browse({ classification: entry.classification, limit: taxonomy.size });
    for (const member of members) {
      if (member.grouping === entry.grouping) codes.add(member.code);
    }
  }
  return codes;
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
