/**
 * The directory's promo and formation filters as ONE `WHERE` fragment over `users.cursus` (alias
 * `user`), or null when neither is asked.
 *
 * EVERY entry counts (D32: two cursus are two cursus, not a first one and a footnote) and both
 * filters are read from the SAME entry - "ICM 2024" is one cursus, so somebody in ICM since 2021
 * and in another formation since 2024 is not it. The `promo`/`formation` columns are the first
 * entry only (`legacyColumns`) and are not read here.
 *
 * The formation is a substring, accent- and case-insensitive, as the filter always was.
 */
export function cursusEntryFilter(
  promo: number | null | undefined,
  formation: string
): { sql: string; params: Record<string, unknown> } | null {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};
  if (promo != null) {
    // Compared as text: `promo` is a JSON number, and a cast of a malformed entry would fail the
    // whole query rather than not match.
    conditions.push("entry->>'promo' = :cursusPromo");
    params.cursusPromo = String(promo);
  }
  if (formation.length > 0) {
    conditions.push("unaccent(LOWER(entry->>'formation')) LIKE unaccent(LOWER(:cursusFormation))");
    params.cursusFormation = `%${formation}%`;
  }
  if (conditions.length === 0) return null;
  return {
    sql:
      'EXISTS (SELECT 1 FROM jsonb_array_elements(user.cursus) AS entry WHERE ' +
      `${conditions.join(' AND ')})`,
    params,
  };
}
