import { DefaultNamingStrategy } from 'typeorm';
import { isUniqueViolation } from '../common/pg-errors';

/**
 * THE SLUG OF AN ASSOCIATION, LIST OR INSTITUTION IS DERIVED, NEVER TYPED (user, 2026-10-26: a
 * technical id is never shown to, typed by, or edited by a person). It stays the URL segment and the
 * unique key; only its authorship moved from the creator to the server.
 */

/** How many numbered candidates (`-2` .. `-N`) a collision may walk before the create gives up. */
export const SLUG_MAX_ATTEMPTS = 50;

/** The shape both the DTO and the service hold a slug to. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,49}$/;

/**
 * Slugs that would shadow a static route under `/associations`, `/lists` or `/institutions`: the
 * folder names of `frontend/src/routes/{associations,lists,institutions}` that are not dynamic
 * (`new`, and `edit` under `[slug]`). `association-slug.util.spec.ts` reads those folders and fails
 * when this set and the routes differ, so a new static page cannot be shadowed by a name.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(['new', 'edit']);

/**
 * Letters that NFD does not decompose, mapped by hand BEFORE folding: without it "Cœur" lost its
 * `œ` and "Straße" its `ß`, giving `cur` and `strae`.
 */
const LIGATURES: Readonly<Record<string, string>> = {
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
};

/**
 * Folds a display name to a slug: lowercase, ligatures expanded, ASCII-folded, hyphenated, no edge
 * hyphen. Returns '' when the name holds no letter or digit at all (the caller falls back to a
 * neutral base).
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[æœßøđðłþ]/g, (c) => LIGATURES[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The candidate slugs for a name, in order: the bare base, then `base-2`, `base-3`... The base is cut
 * so that even the longest suffix still fits the 50 characters of {@link SLUG_PATTERN}. A name with nothing sluggable falls back to `asso`.
 */
export function slugCandidates(name: string): string[] {
  const folded = slugifyName(name) || 'asso';
  // A reserved word is never offered bare: the first candidate is already the numbered one.
  const reserved = RESERVED_SLUGS.has(folded);
  const base = folded;
  const room = 50 - `-${SLUG_MAX_ATTEMPTS}`.length;
  const cut = (s: string, n: number) => s.slice(0, n).replace(/-+$/, '');
  const padded = base.length < 2 ? `${base}-x` : base;
  const out = reserved ? [] : [cut(padded, 50)];
  for (let n = 2; n <= SLUG_MAX_ATTEMPTS; n++) out.push(`${cut(padded, room)}-${n}`);
  return out;
}

/** The Postgres name TypeORM gives the `UNIQUE` on `associations.slug` (the entity's `unique: true`). */
export const SLUG_UNIQUE_CONSTRAINT = new DefaultNamingStrategy().uniqueConstraintName(
  'associations',
  ['slug']
);

/**
 * Whether a driver error is the unique violation of the SLUG index specifically - never any other
 * `23505`, which a retry with another suffix would not cure and must not hide.
 */
export function isSlugUniqueViolation(err: unknown): boolean {
  return (
    isUniqueViolation(err) && (err as { constraint?: string }).constraint === SLUG_UNIQUE_CONSTRAINT
  );
}
