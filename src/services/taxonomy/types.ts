/**
 * @fileoverview Domain types for the NUCC Healthcare Provider Taxonomy service.
 * @module services/taxonomy/types
 */

/**
 * NPI enumeration scope a taxonomy applies to. Mirrors the NUCC `Section` column:
 * `Individual` taxonomies belong to NPI-1 (individual practitioners),
 * `Non-Individual` to NPI-2 (organizations).
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
  /** Definition / scope note. Absent for a handful of codes. */
  definition?: string;
  /** Human-readable display name, e.g. `Cardiovascular Disease Physician`. */
  displayName: string;
  /** Top-level grouping, e.g. `Allopathic & Osteopathic Physicians`. */
  grouping: string;
  /** NUCC `Notes` cell — sources, revision history, status remarks. Absent when the cell is empty. */
  notes?: string;
  /** For an inactive code, the active replacement code NUCC names. Absent when none is named. */
  replacedBy?: string;
  /** NPI enumeration scope this taxonomy applies to. */
  section: TaxonomySection;
  /** Specialization within the classification, e.g. `Cardiovascular Disease`. Absent for top-level classification codes. */
  specialization?: string;
  /** Whether NUCC still maintains the code. */
  status: TaxonomyStatus;
}
