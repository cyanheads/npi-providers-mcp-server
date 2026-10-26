/**
 * @fileoverview Domain types for the NUCC Healthcare Provider Taxonomy service.
 * @module services/taxonomy/types
 */

/**
 * NUCC `Section` column. Individual includes Group codes; Non-Individual covers
 * facilities, suppliers and agencies. NPPES enumeration_type determines provider entity type.
 */
export type TaxonomySection = 'Individual' | 'Non-Individual';

/**
 * Whether NUCC still maintains a code. NUCC records inactivity only in the `Notes`
 * column (`marked inactive`); the bundle generator derives this field from it.
 */
export type TaxonomyStatus = 'active' | 'inactive';

/**
 * A single NUCC Healthcare Provider Taxonomy entry: every upstream column, trimmed,
 * plus the `status` and `replacedBy` fields the bundle generator derives from them.
 */
export interface TaxonomyEntry {
  /** Classification within the grouping, e.g. `Internal Medicine`. */
  classification: string;
  /** Taxonomy code, e.g. `207RC0000X`. Matches `^\d{3}[A-Z0-9]{6}X$`. */
  code: string;
  /** Definition / scope note, with known NUCC HTML breaks/lists converted to plain text. Absent for a handful of codes. */
  definition?: string;
  /** Human-readable display name, e.g. `Cardiovascular Disease Physician`. */
  displayName: string;
  /** Top-level grouping, e.g. `Allopathic & Osteopathic Physicians`. */
  grouping: string;
  /** NUCC Notes with known HTML breaks/lists converted to plain text; all other interior bytes retained. Absent when the cell is empty. */
  notes?: string;
  /** For an inactive code, the active replacement code NUCC names. Absent when none is named. */
  replacedBy?: string;
  /** NUCC section, independent of provider entity type. */
  section: TaxonomySection;
  /** Specialization within the classification, e.g. `Cardiovascular Disease`. Absent for top-level classification codes. */
  specialization?: string;
  /** Whether NUCC still maintains the code. */
  status: TaxonomyStatus;
}
