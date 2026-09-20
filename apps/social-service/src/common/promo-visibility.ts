import type { EntityManager } from 'typeorm';

/**
 * How far back a viewer's own promo lets them look.
 *
 * A student of promo X joined the school in the August that opens year X, so nothing published or
 * scheduled before `X-08-01` is theirs in any sense: it is the school as it was before they arrived.
 * The posts feed has cut its history there since long before this file existed; the agenda did not,
 * and *"ce serait bien de mettre une limite pour remonter sur l'agenda en regle generale, comme on a
 * une limite pour les posts"* (user, 2026-09-20) is what made the rule shared rather than one
 * feed's private detail.
 *
 * **THIS IS A RELEVANCE LIMIT, NOT A CONFIDENTIALITY ONE, AND THE DIFFERENCE IS LOAD-BEARING.** The
 * aggregated agenda is a PUBLIC route, and its `.ics` twin is subscribed to by calendar apps that
 * send no identity at all and never will - so an event before the cutoff was never secret and is not
 * being hidden. What the cutoff buys is a history that stops where the viewer's own does. Anything
 * that ever needs to be SECRET must be refused by a guard, not by this.
 *
 * `null` means no limit, and there are exactly two ways to get one: a global admin (who is shown the
 * whole archive on purpose), and a viewer whose row carries no promo at all.
 */
export const PROMO_CUTOFF_MONTH_DAY = '08-01';

/**
 * Resolves the ISO date before which a viewer sees nothing, or `null` for no limit.
 *
 * **IT DOES NOT CATCH.** The query it runs is a primary-key lookup on `users`, through the very
 * manager the caller is about to run its own query on: a failure here means the database is gone,
 * and the next statement would fail anyway. The posts feed used to swallow it into an empty `catch`,
 * which turned a dead database into a silently wider feed - a fallback path, and one that logged
 * nothing to say it had been taken.
 *
 * @param manager the caller's own entity manager, so this shares its connection and its transaction
 * @param viewerUserId the signed-in viewer, or undefined for an anonymous read (no limit)
 * @param isAdmin true for a global admin, who is never limited
 */
export async function promoCutoffFor(
  manager: EntityManager,
  viewerUserId: string | undefined | null,
  isAdmin: boolean | undefined
): Promise<string | null> {
  if (isAdmin) return null;
  const uid = viewerUserId?.trim();
  if (!uid) return null;

  const rows: { promo: number | null }[] = await manager.query(
    `SELECT promo FROM users WHERE id = $1 LIMIT 1`,
    [uid]
  );
  const promo = rows[0]?.promo ?? null;
  return promo == null ? null : `${promo}-${PROMO_CUTOFF_MONTH_DAY}`;
}
