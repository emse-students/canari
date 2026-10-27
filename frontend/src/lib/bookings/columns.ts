/**
 * THE COLUMNS LEVEL IS HIDDEN WHILE A SPACE HAS ITS ONE DEFAULT COLUMN (D44, user 2026-10-23).
 *
 * The data model is unchanged: a space books through its resources, and since WP-R1 the server
 * creates every space with one, named after it. What changes is the screen: with that one column
 * the organiser edits the space's hours directly and the booker reads no column name - "Ajouter une
 * colonne" is what reveals the level.
 *
 * THE PREDICATE IS THE SERVER'S RENAME RULE (`renameDefaultColumn` in social-service's
 * `booking-spaces.service.ts`): exactly one column AND it bears the space's name. A single column
 * named otherwise (a space set up before WP-R1, "Piano" in "Foyer") is a VISIBLE column, renamable
 * and deletable. Renaming a single column to the space's own name makes it the hidden column, and it
 * follows the space's later renames from then on.
 */
export function columnsHidden(spaceName: string, resources: readonly { name: string }[]): boolean {
  return resources.length === 1 && resources[0].name === spaceName;
}

/**
 * The words that name WHERE a booking is: the space, then its column - or the space alone when the
 * column bears the space's name, so a hidden column (or any column named like its space) is never
 * read twice ("Salle de musique - Salle de musique"). The server's `.ics` summary applies the same
 * rule (`bookingPlace` in `booking-calendar.ts`).
 */
export function bookingPlace(spaceName: string, resourceName: string): string {
  return resourceName === spaceName ? spaceName : `${spaceName} - ${resourceName}`;
}
