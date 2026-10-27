/**
 * THE COLUMNS LEVEL IS HIDDEN WHILE A SPACE HAS EXACTLY ONE COLUMN (D44, user 2026-10-23).
 *
 * The data model is unchanged: a space books through its resources, and since WP-R1 the server
 * creates every space with one, named after it. What changes is the screen: with one column the
 * organiser edits the space's hours directly and the booker reads no column name - "Ajouter une
 * colonne" is what reveals the level. One predicate, so the editor and the booker's page can never
 * disagree on whether a space shows its columns.
 */
export function columnsHidden(resources: readonly unknown[]): boolean {
  return resources.length === 1;
}
