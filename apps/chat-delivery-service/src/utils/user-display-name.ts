/**
 * THE ONE PRECEDENCE FOR A PERSON'S NAME, ON THE SERVER SIDE.
 *
 * This file is BYTE-IDENTICAL in chat-delivery-service and social-service, declared as such in
 * `.github/scripts/lib/declared-duplicates.mjs`, for the reason every other copied file here gives:
 * there is no shared TypeScript package, and creating one would add a build stage to two more
 * production images to save thirty lines ([libs](docs/wiki/libs.md)). It declares the minimal row
 * shape itself rather than either service's model, which is what lets the copies stay identical.
 *
 * THE PRECEDENCE IS `firstName lastName` FIRST. Both services preferred `displayName` until
 * 2026-09-22 where the client preferred the pair, so one account could be titled one way in a push
 * notification and another way in the screen that notification opened - reported by the user on
 * 2026-09-18. The pair wins because it is the STRUCTURED identity: initials, the trombinoscope's
 * surname sort and the chat's first-name-only label are all derived from it, so preferring anything
 * else names a person one way and abbreviates them another. `displayName` is Authentik's free-form
 * `name` claim, kept as the fallback for an account whose parts never arrived.
 *
 * THE BEHAVIOUR IS ASSERTED AGAINST `libs/contracts/user-display-name.cases.json`, which the
 * frontend's own implementation reads too - that one cannot be a copy of this file, so the two
 * halves of the guarantee are different mechanisms: identical text here, identical ANSWERS there.
 */

/** The three name columns of the shared `users` table, as every reader of them sees them. */
export interface UserNameRow {
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * The name a person is called, from the three columns that could carry one.
 *
 * Returns '' when the row carries no name at all. Each caller supplies its own answer for that
 * case - the actor id where a notification must still address somebody, `null` on a roster row
 * where the client has a resolver of its own, '' where the name is decoration.
 */
export function formatUserDisplayName(row: UserNameRow): string {
  const first = row.firstName?.trim() ?? '';
  const last = row.lastName?.trim() ?? '';
  const fromParts = [first, last].filter((part) => part.length > 0).join(' ');
  return fromParts || row.displayName?.trim() || '';
}

/**
 * The same name, from a row read through a raw query whose columns are typed `unknown`.
 *
 * `manager.query` hands back `any`, so every caller narrows it by hand - and the narrowing belongs
 * beside the rule it feeds rather than beside each copy of the call.
 */
export function formatUserDisplayNameFromRaw(row: Record<string, unknown>): string {
  const read = (key: string): string | null => (typeof row[key] === 'string' ? row[key] : null);
  return formatUserDisplayName({
    displayName: read('displayName'),
    firstName: read('firstName'),
    lastName: read('lastName'),
  });
}
