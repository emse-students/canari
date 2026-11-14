/**
 * The entries of a `cursus` column as a set-returning SQL expression - `jsonb_array_elements` over
 * it when it IS a list, over an empty list otherwise. Unguarded, one row holding a JSON `null` or an
 * object would fail the whole query for everyone ("cannot extract elements from a scalar").
 */
export function cursusEntriesSql(column: string): string {
  return `jsonb_array_elements(CASE WHEN jsonb_typeof(${column}) = 'array' THEN ${column} ELSE '[]'::jsonb END)`;
}

/**
 * An entry `cursusViewsOf` keeps, in SQL (alias `entry`): an object whose formation is a non-empty
 * string and whose promo is an integer. The two readers of the column must agree on what an entry
 * is, or the directory would find somebody through an entry their price never reads.
 */
export const WELL_FORMED_ENTRY_SQL =
  "jsonb_typeof(entry) = 'object' AND jsonb_typeof(entry->'formation') = 'string' " +
  "AND entry->>'formation' <> '' AND jsonb_typeof(entry->'promo') = 'number' " +
  "AND (entry->>'promo') ~ '^-?[0-9]+$'";

/**
 * The directory's promo and formation filters as ONE `WHERE` fragment (alias `user`), or null when
 * neither is asked.
 *
 * A person matches through ANY well-formed cursus entry OR through the legacy `promo`/`formation`
 * columns - the union `cursusViewsOf` prices on (D32 only ever adds: nobody the directory found
 * before drops out). Both filters are read from the SAME place - one entry, or the legacy pair -
 * so "ICM 2024" never matches somebody in ICM since 2021 and in another formation since 2024.
 *
 * The formation is a substring, accent- and case-insensitive, as the filter always was.
 */
export function cursusEntryFilter(
  promo: number | null | undefined,
  formation: string
): { sql: string; params: Record<string, unknown> } | null {
  const onEntry: string[] = [WELL_FORMED_ENTRY_SQL];
  const onLegacy: string[] = [];
  const params: Record<string, unknown> = {};
  if (promo != null) {
    // Two parameters: one compared as text (a JSON value), one as the integer column - PostgreSQL
    // deduces ONE type per parameter, and refuses a parameter used as both.
    onEntry.push("entry->>'promo' = :cursusPromoText");
    onLegacy.push('user.promo = :legacyPromo');
    params.cursusPromoText = String(promo);
    params.legacyPromo = promo;
  }
  if (formation.length > 0) {
    onEntry.push("unaccent(LOWER(entry->>'formation')) LIKE unaccent(LOWER(:cursusFormation))");
    onLegacy.push('unaccent(LOWER(user.formation)) LIKE unaccent(LOWER(:cursusFormation))');
    params.cursusFormation = `%${formation}%`;
  }
  if (onLegacy.length === 0) return null;
  return {
    sql:
      `(EXISTS (SELECT 1 FROM ${cursusEntriesSql('user.cursus')} AS entry WHERE ` +
      `${onEntry.join(' AND ')}) OR (${onLegacy.join(' AND ')}))`,
    params,
  };
}
