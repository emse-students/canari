/**
 * How many communities one account may create and hold. Both are counted from the `workspaces`
 * table when a creation is asked, so they hold across replicas and across a deploy.
 */

/**
 * Communities one account may create in an hour. A creation writes the community, its roles and
 * its first salon and mints an MLS distribution group in chat-delivery; a person creates one or
 * two at a time, so ten leaves room and keeps a loop from filling both services.
 */
export const COMMUNITY_CREATIONS_PER_HOUR = 10;

/** Communities one account may hold as their creator when `COMMUNITY_OWNED_MAX` is unset. */
export const COMMUNITY_OWNED_MAX_DEFAULT = 20;

/**
 * The communities one account may hold as their creator, from `COMMUNITY_OWNED_MAX` (a positive
 * integer) or {@link COMMUNITY_OWNED_MAX_DEFAULT}. THROWS on a value that is set and is not one:
 * a typo must stop the service at boot, never mean "no limit".
 */
export function communityOwnedMax(
  raw: string | undefined = process.env.COMMUNITY_OWNED_MAX
): number {
  if (raw === undefined || raw.trim() === '') return COMMUNITY_OWNED_MAX_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`COMMUNITY_OWNED_MAX must be a positive integer, got "${raw}"`);
  }
  return value;
}
