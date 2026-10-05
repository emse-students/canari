/**
 * THE ONE ORDER A LIST OF PEOPLE IS READ IN: family name, then given name.
 *
 * A joined-up "Prenom NOM" string sorts on the GIVEN name, so the family name has to come from its
 * own column (`lastName`) - splitting the display string was rejected on the poster first
 * (`carte/generator.ts`): it guesses which token is the family name, and guesses wrong on a compound
 * surname ("Van Dupont"), a nickname or a mononym. A person with no family name on record sorts
 * under the name that is PRINTED for them, the only string a reader can look them up by.
 *
 * Pure and locale-pinned on purpose: `Intl.Collator('fr', { sensitivity: 'base' })` makes an accented
 * spelling, "emile" and "EMILE" one key, so neither accents nor case reorder a list, and hyphens and particles
 * ("BRETON--DESCHAMPS", "de La Fontaine") are compared as written - the same answer on every device,
 * whatever its own locale.
 */

/** The name columns a person's row may carry. Every one is optional: rosters differ in what they hold. */
export interface PersonNameParts {
  firstName?: string | null;
  lastName?: string | null;
  /** The printed full name, used as the family key only when `lastName` is missing. */
  displayName?: string | null;
}

/** The two keys a person sorts on, or `null` when nothing names them at all. */
export interface FamilyNameKey {
  family: string;
  given: string;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: false });

/**
 * The sort key of one person: `lastName`, else the printed name, else the given name alone.
 *
 * @returns `null` for a person nothing names - an unresolved or unknown member - so the caller
 *   can put them last rather than under an empty string, which would sort them FIRST.
 */
export function familyNameKey(parts: PersonNameParts | null | undefined): FamilyNameKey | null {
  if (!parts) return null;
  const first = parts.firstName?.trim() || '';
  const family = parts.lastName?.trim() || parts.displayName?.trim() || first;
  if (!family) return null;
  return { family, given: first };
}

/**
 * Compares two keys: family name, then given name, under the French base collation. A `null` key
 * (nobody named) sorts after every named one; two `null`s are equal, so the caller's tie-break
 * decides between them.
 */
export function compareFamilyNameKeys(a: FamilyNameKey | null, b: FamilyNameKey | null): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  return collator.compare(a.family, b.family) || collator.compare(a.given, b.given);
}

/**
 * Returns a new array ordered by family name then given name, unnamed people last.
 *
 * Two people who compare equal (same names up to accents and case, or both unnamed) are ordered by
 * `idOf` with a plain code-unit comparison - locale-free, so the order is identical on every device
 * and never depends on the order the input arrived in.
 *
 * @param items - The rows, in any order; not mutated.
 * @param partsOf - The name columns of one row; `null` when the row's person is not known yet.
 * @param idOf - A stable identifier of the row, for the final tie-break.
 */
export function sortByFamilyName<T>(
  items: readonly T[],
  partsOf: (item: T) => PersonNameParts | null | undefined,
  idOf: (item: T) => string
): T[] {
  const keyed = items.map((item) => ({ item, key: familyNameKey(partsOf(item)), id: idOf(item) }));
  keyed.sort((a, b) => {
    const byName = compareFamilyNameKeys(a.key, b.key);
    if (byName !== 0) return byName;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  return keyed.map((entry) => entry.item);
}
