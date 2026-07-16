// ── Cotisation tag presentation ─────────────────────────────────────────────
// Cotisation tags are stored as raw system slugs (e.g. `cotisant:bde-2026-2027`).
// These helpers turn them into human-friendly labels and resolve the issuing
// association (name + logo) so the UI never surfaces the raw slug.

import { getAssociation, type Association } from './api';

const COTISANT_PREFIX = /^cotisant:/i;
// Trailing academic-year range, e.g. `-2026-2027` or a single year `-2026`.
const YEAR_RANGE = /-((?:19|20)\d{2})(?:-((?:19|20)\d{2}))?$/;

/** Parsed, display-ready form of a cotisation tag slug. */
export interface FormattedCotisationTag {
  /** Human-friendly acronym/label, e.g. "BDE" or "BDE Partenaires". */
  acronym: string;
  /** Academic-year period encoded in the slug, e.g. "2026-2027", or null. */
  period: string | null;
  /** The original, untouched slug. */
  raw: string;
}

/**
 * Parses a raw cotisation tag slug into a friendly acronym + optional period.
 * Short words (<=4 chars) are upper-cased as acronyms (bde -> BDE); longer
 * words are capitalized. Falls back to the raw slug for unexpected shapes.
 */
export function formatCotisationTag(tagName: string): FormattedCotisationTag {
  const raw = (tagName ?? '').trim();
  let rest = raw.replace(COTISANT_PREFIX, '');

  let period: string | null = null;
  const ym = rest.match(YEAR_RANGE);
  if (ym && ym.index !== undefined) {
    period = ym[2] ? `${ym[1]}-${ym[2]}` : ym[1];
    rest = rest.slice(0, ym.index);
  }

  const words = rest.split(/[-_\s]+/).filter(Boolean);
  const acronym = words
    .map((w) => (w.length <= 4 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

  return { acronym: acronym || raw, period, raw };
}

// Memoized issuing-association lookups: dedupes concurrent and repeated calls
// across every tag row (profile, purchases, admin roster) to a single request.
const issuingCache = new Map<string, Promise<Association | null>>();

/**
 * Resolves (and caches) the association that issued a cotisation tag, so the
 * tag can be rendered with its real name and logo. Returns null when the tag
 * has no issuing association or the lookup fails (caller falls back to slug).
 */
export function resolveIssuingAssociation(id: string | null): Promise<Association | null> {
  if (!id) return Promise.resolve(null);
  let pending = issuingCache.get(id);
  if (!pending) {
    pending = getAssociation(id).catch(() => null);
    issuingCache.set(id, pending);
  }
  return pending;
}
