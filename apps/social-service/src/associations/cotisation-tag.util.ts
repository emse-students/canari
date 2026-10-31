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

/** Room kept for a collision suffix (`-2` ... `-999`), so a suffixed key still fits the tag. */
const VARIANT_KEY_SUFFIX_ROOM = 4;

/** The tag column's length (`user_tags.tagName`, `association_products.grantedTagName`). */
const TAG_NAME_MAX = 100;

/** The key of a tier whose label holds no letter or digit at all (an emoji, punctuation). */
const VARIANT_KEY_EMPTY_LABEL = 'palier';

/** Ligatures NFD does not decompose, folded to the letters they stand for. */
const LIGATURES: ReadonlyArray<[string, string]> = [
  [String.fromCharCode(0x153), 'oe'],
  [String.fromCharCode(0xe6), 'ae'],
  [String.fromCharCode(0xdf), 'ss'],
];

/**
 * The longest key, collision suffix excluded, that keeps a tier's tag within the tag column in
 * BOTH modes: the dated form (`cotisant:<slug>-<key>-YYYY-YYYY`) is the longer one, so the budget is
 * measured on it, through `deriveCotisationTag` itself. Below 1, no named tier fits this slug.
 */
export function variantKeyCap(slug: string): number {
  // `cotisant:<slug>-YYYY-YYYY`, plus the hyphen a key is joined with.
  const fixedPart = deriveCotisationTag(slug, 'dated').tagName.length + 1;
  return Math.min(VARIANT_KEY_MAX, TAG_NAME_MAX - fixedPart - VARIANT_KEY_SUFFIX_ROOM);
}

/**
 * A tier key that is, or ends with, an academic year: its tag would read as a `dated` tag of
 * another tier (`cotisant:<slug>-<key>` against `cotisant:<slug>-YYYY-YYYY`). Refused on a typed
 * key (`ProductsService.assertVariantKeyFree`, 400 `TIER_KEY_YEAR_SHAPED`) and never produced by
 * `variantKeyFromLabel` - the one pattern both read.
 */
export const YEAR_SHAPED_VARIANT_KEY = /(^|-)\d{4}-\d{4}$/;

/** A trailing run of academic years (`-2024-2025`, `-2023-2024-2025`) on a hyphenated key. */
const YEAR_TAIL = /(?:^|-)\d{4}(?:-\d{4})+$/;

/** `key` without a trailing academic-year run nor the hyphens around what is left. */
function withoutYearTail(key: string): string {
  return key.replace(YEAR_TAIL, '').replace(/^-+|-+$/g, '');
}

/** Highest collision suffix `variantKeyFromLabel` tries: `-999` is what `variantKeyCap` keeps room for. */
const VARIANT_KEY_SUFFIX_MAX = 10 ** (VARIANT_KEY_SUFFIX_ROOM - 1) - 1;

/**
 * Thrown by `variantKeyFromLabel` when the base key and every suffix up to `-999` are unavailable: a
 * longer suffix would overflow the tag column (`variantKeyCap` keeps room for four characters), so
 * the derivation stops rather than hand the database a tag it cannot store.
 */
export class VariantKeySpaceExhaustedError extends Error {
  constructor(readonly base: string) {
    super(
      `variantKeyFromLabel: "${base}" and every suffix up to -${VARIANT_KEY_SUFFIX_MAX} are taken`
    );
    this.name = 'VariantKeySpaceExhaustedError';
  }
}

/**
 * Derives a new tier's `variantKey` from the label a person typed: lowercase, ASCII-folded
 * (accents dropped, ligatures spelled out), every run of other characters one hyphen, a trailing
 * academic year removed, at most `cap` characters, and free - not among `taken` (the association's
 * existing keys) and not `isUnavailable` (a stem another association derives, or one whose tags
 * are still held under a deleted tier) - by a `-2`, `-3`... `-999` suffix, past which it throws
 * `VariantKeySpaceExhaustedError`.
 *
 * The result NEVER matches `YEAR_SHAPED_VARIANT_KEY`, which the server refuses with a 400: a
 * manager who typed "Cotisation 2024-2025" never typed a key, so the label must not earn a refusal
 * about one. The year tail is removed (a dated tag already ENDS in the academic year, so
 * "Cotisation 2026-2027" derives `cotisation`, then `cotisation-2` when that one is taken), and
 * removed AGAIN after the length cap since a cut can expose one. A suffix of at most three digits
 * cannot form a year. A single year ("Promo 2024") is kept: `promo-2024` is not year-shaped.
 *
 * The key is a TECHNICAL id (it names the tier's tag and is what Le Cercle reads as `tier`), so a
 * person never types it; it is derived once, at creation, and never follows a later label edit -
 * renaming a forfait must not move its cotisants to another tag.
 */
export function variantKeyFromLabel(
  label: string,
  taken: Iterable<string | null>,
  cap: number = VARIANT_KEY_MAX,
  isUnavailable: (key: string) => boolean = () => false
): string {
  if (cap < 1) throw new RangeError(`variantKeyFromLabel: no room for a key (cap ${cap})`);
  let lowered = label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  for (const [ligature, letters] of LIGATURES) lowered = lowered.split(ligature).join(letters);
  const hyphenated = withoutYearTail(lowered.replace(/[^a-z0-9]+/g, '-'));
  const folded = withoutYearTail(hyphenated.slice(0, cap));
  const base = folded || VARIANT_KEY_EMPTY_LABEL.slice(0, cap);
  const used = new Set(taken);
  const unusable = (key: string): boolean => used.has(key) || isUnavailable(key);
  if (!unusable(base)) return base;
  for (let n = 2; n <= VARIANT_KEY_SUFFIX_MAX; n += 1) {
    if (!unusable(`${base}-${n}`)) return `${base}-${n}`;
  }
  throw new VariantKeySpaceExhaustedError(base);
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

/**
 * The part of an association's cotisation tag that does not depend on the year:
 * `<slug>` for the base tier, `<slug>-<variant>` for a named one. Every tag the tier grants is
 * `cotisant:<stem>` (lifetime) or `cotisant:<stem>-<academicYear>` (dated).
 */
export function cotisationStem(slug: string, variant?: string | null): string {
  return variant ? `${slug}-${variant}` : slug;
}

const ACADEMIC_YEAR_SUFFIX = /^\d{4}-\d{4}$/;

/**
 * Whether two cotisation stems can derive the same tag name in some mode and year: when they are
 * equal, or when one is the other followed by `-<academicYear>` (a lifetime tag of the longer
 * then equals a dated tag of the shorter). Any other pair derives disjoint names, since a dated
 * tag adds exactly one academic-year suffix. Two DIFFERENT associations' stems must never collide,
 * or one association's grants would write the other's tag names.
 */
export function cotisationStemsCollide(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return long.startsWith(`${short}-`) && ACADEMIC_YEAR_SUFFIX.test(long.slice(short.length + 1));
}
