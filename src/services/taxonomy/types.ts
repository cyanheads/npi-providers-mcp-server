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
 * A single NUCC Healthcare Provider Taxonomy entry, trimmed to the fields this
 * server surfaces. The upstream `Notes` column (citations, revision history) is
 * dropped at bundle time — it carries no value for resolution or display.
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
  /** NPI enumeration scope this taxonomy applies to. */
  section: TaxonomySection;
  /** Specialization within the classification, e.g. `Cardiovascular Disease`. Absent for top-level classification codes. */
  specialization?: string;
}
