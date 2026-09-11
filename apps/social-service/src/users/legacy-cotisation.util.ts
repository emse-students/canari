/**
 * Normalizes one name part for matching: strips diacritics, lowercases, and reduces every run of
 * non-alphanumeric characters to a single space. Hyphens, apostrophes and multiple spaces all
 * collapse the same way, so `"AIT LAHCEN"`, `"Ait-Lahcen"` and `"ait  lahcen"` are one value.
 *
 * `\p{Mn}` is what NFD leaves behind once an accented letter is decomposed - the combining mark
 * itself. Spelling it as a named property rather than a literal codepoint range keeps this source
 * ASCII, which the repository requires and which stops an editor from silently mangling the class.
 */
function normalizeNamePart(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Builds the key a legacy cotisation row and a signing-in user are matched on.
 *
 * This is the ONE implementation: the import script and the claim must produce byte-identical keys
 * or they match nothing at all. Neither legacy estate carries an email and Canari's `users` table
 * has no email column, so the natural key `(lastName, firstName, promo)` is the only one available.
 * It was measured before being chosen - zero collisions among the 1169 Cercle cotisants carrying a
 * promo, and zero inside any year group of the BDE sheet - but it stays a natural key, which is why
 * the staging table refuses an ambiguous load rather than trusting it blindly.
 *
 * Returns `null` when any part is missing. A user with no promo has no key, and must be skipped
 * rather than matched on the name alone: the same first-and-last name appears in two different year
 * groups of the BDE sheet, so a promo-less match would hand one person's cotisation to another.
 *
 * A name carrying `?` is refused for the same reason it cannot be guessed. Le Cercle's legacy base
 * holds no non-ASCII byte at all: every accent was destroyed long before the export and replaced by
 * a literal `?` (two of them per accented letter), across 150 of its 1169 cotisants. Stripped like
 * any other punctuation, `"Cl??ment"` would yield the perfectly valid-looking key `cl ment` that no
 * sign-in can ever match - a silent loss of one cotisant in eight. Repair the name against a
 * reference before staging it, or leave the row for a human; do not mint a key that cannot match.
 */
export function normalizeMatchKey(
  lastName: string | null | undefined,
  firstName: string | null | undefined,
  promo: number | null | undefined
): string | null {
  if (promo === null || promo === undefined || !Number.isInteger(promo) || promo <= 0) return null;
  if ((lastName ?? '').includes('?') || (firstName ?? '').includes('?')) return null;
  const last = normalizeNamePart(lastName ?? '');
  const first = normalizeNamePart(firstName ?? '');
  if (!last || !first) return null;
  return `${last}|${first}|${promo}`;
}
