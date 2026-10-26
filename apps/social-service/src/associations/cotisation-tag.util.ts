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
 * Derives the canonical cotisation tag for an association (or one of its named tiers) from its
 * slug and validity mode. This is the single source of truth for the tag string - it MUST be
 * used both when provisioning membership products and when checking product/form member-gating, so
 * product pricing and gating stay aligned. (It once said "and forms' `pricingTagName`"; migration
 * 050 removed that column precisely because it stored this function's OUTPUT.)
 *
 * - `lifetime`: tag `cotisant:<slug>`, never expires.
 * - `dated`: tag `cotisant:<slug>-<academicYear>` (e.g. `cotisant:bde-2026-2027`), rolled over
 *   every academic year so per-year rosters stay clean; expires 31 August of the end year.
 * - `variant`: when set, suffixes the tag with `-<variant>` (e.g. an association with several
 *   cotisation tiers, such as Le Cercle's "avec-alcool"/"sans-alcool" forfaits) so each tier gets
 *   its own tag namespace. Omitted, the tag is unchanged from the single-tier form (back-compat).
 */
export function deriveCotisationTag(
  slug: string,
  mode: CotisationMode,
  now: Date = new Date(),
  variant?: string | null
): CotisationTag {
  const base = variant ? `${slug}-${variant}` : slug;
  if (mode === 'lifetime') {
    return { tagName: `cotisant:${base}`, expiresAt: null };
  }
  const academicYear = getAcademicYear(now);
  const endYear = Number(academicYear.split('-')[1]);
  const expiresAt = new Date(Date.UTC(endYear, 7, 31, 23, 59, 59)); // 31 Aug, end of day UTC
  return { tagName: `cotisant:${base}-${academicYear}`, expiresAt };
}

/** Longest key `variantKeyFromLabel` produces, before any collision suffix. */
const VARIANT_KEY_MAX = 60;

/** The key of a tier whose label holds no letter or digit at all (an emoji, punctuation). */
const VARIANT_KEY_EMPTY_LABEL = 'palier';

/**
 * Derives a new tier's `variantKey` from the label a person typed: lowercase, ASCII-folded
 * (`"Cotisation Alcoolisée"` -> `"cotisation-alcoolisee"`), every run of other characters one
 * hyphen, and unique among `taken` (the association's existing keys) by a `-2`, `-3`... suffix.
 *
 * The key is a TECHNICAL id (it names the tier's tag and is what Le Cercle reads as `tier`), so a
 * person never types it; it is derived once, at creation, and never follows a later label edit -
 * renaming a forfait must not move its cotisants to another tag.
 */
export function variantKeyFromLabel(label: string, taken: Iterable<string | null>): string {
  const folded = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, VARIANT_KEY_MAX)
    .replace(/-+$/, '');
  const base = folded || VARIANT_KEY_EMPTY_LABEL;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Returns the distinct `variantKey`s among an association's `membership` products, one per
 * cotisation tier - `[null]` (the base, un-suffixed tier) when the association has no explicit
 * tiered products yet. Used to enumerate "any tier" tag names for `membersOnly`/generic cotisant
 * gating, so a multi-tier association isn't wrongly gated on just the base tag.
 *
 * Named tiers are returned BEFORE the base tier. Callers that stop at the first tag the user
 * holds (`getCotisantStatusBySlug`) would otherwise report `tier: null` for someone who still
 * carries a legacy base tag alongside a named one - and a consumer such as Le Cercle reads that
 * null as "no forfait", refusing a real alcohol cotisant their drink.
 */
export function tierVariantKeys(products: Array<{ variantKey: string | null }>): (string | null)[] {
  if (products.length === 0) return [null];
  const keys = [...new Set(products.map((p) => p.variantKey))];
  return keys.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
}
