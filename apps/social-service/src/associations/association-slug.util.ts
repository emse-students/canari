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
 * Folds a display name to a slug: lowercase, ASCII-folded, hyphenated, no edge hyphen. Returns ''
 * when the name holds no letter or digit at all (the caller falls back to a neutral base).
 */
export function slugifyName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The candidate slugs for a name, in order: the bare base, then `base-2`, `base-3`... The base is cut
 * so that even the longest suffix still fits the 50 characters of {@link SLUG_PATTERN}. A name with nothing sluggable falls back to `asso`.
 */
export function slugCandidates(name: string): string[] {
  const base = slugifyName(name) || 'asso';
  const room = 50 - `-${SLUG_MAX_ATTEMPTS}`.length;
  const cut = (s: string, n: number) => s.slice(0, n).replace(/-+$/, '');
  const padded = base.length < 2 ? `${base}-x` : base;
  const out = [cut(padded, 50)];
  for (let n = 2; n <= SLUG_MAX_ATTEMPTS; n++) out.push(`${cut(padded, room)}-${n}`);
  return out;
}
