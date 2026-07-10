/** Validity mode for an association's cotisation program. */
export type CotisationMode = 'lifetime' | 'dated';

/** Canonical cotisation tag name and its expiry, derived from an association's slug and mode. */
export interface CotisationTag {
  /** Tag name granted to cotisants, e.g. `"cotisant:bde"` or `"cotisant:bde-2026-2027"`. */
  tagName: string;
  /** When the tag expires; null for `lifetime` mode. */
  expiresAt: Date | null;
}

/**
 * Returns the current academic year label (e.g. `"2026-2027"`) for a given date.
 * The academic year starts in September: from September onward it is
 * `<currentYear>-<currentYear+1>`; before September it is `<currentYear-1>-<currentYear>`.
 */
export function getAcademicYear(now: Date = new Date()): string {
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 8 ? year : year - 1; // month 8 = September (0-indexed)
  return `${startYear}-${startYear + 1}`;
}

/**
 * Derives the canonical cotisation tag for an association from its slug and validity mode.
 * This is the single source of truth for the tag string - it MUST be used both when
 * provisioning the canonical membership product and when checking product/form
 * member-gating, so product pricing, gating, and forms' `pricingTagName` all stay aligned.
 *
 * - `lifetime`: tag `cotisant:<slug>`, never expires.
 * - `dated`: tag `cotisant:<slug>-<academicYear>` (e.g. `cotisant:bde-2026-2027`), rolled over
 *   every academic year so per-year rosters stay clean; expires 31 August of the end year.
 */
export function deriveCotisationTag(
  slug: string,
  mode: CotisationMode,
  now: Date = new Date()
): CotisationTag {
  if (mode === 'lifetime') {
    return { tagName: `cotisant:${slug}`, expiresAt: null };
  }
  const academicYear = getAcademicYear(now);
  const endYear = Number(academicYear.split('-')[1]);
  const expiresAt = new Date(Date.UTC(endYear, 7, 31, 23, 59, 59)); // 31 Aug, end of day UTC
  return { tagName: `cotisant:${slug}-${academicYear}`, expiresAt };
}
