import type { EntityManager } from 'typeorm';

/**
 * The advisory-lock key of one buyer's cotisation tiers in one association. `tier:` namespaces it
 * apart from any other advisory key; `hashtextextended` (below) makes it the one-key 64-bit form.
 */
export function buyerTierLockKey(associationId: string, userId: string): string {
  return `tier:${associationId}:${userId}`;
}

/**
 * Serialises, for the length of `manager`'s transaction, EVERYTHING that ranks, grants or swaps one
 * buyer's tiers in one association: a checkout opening, a settlement, a cash sale, a manual or
 * legacy grant, a paid form's grant, a raw tag grant (docs/wiki/cotisations.md "Rising to a higher
 * tier"). A transaction-scoped advisory lock, released by the commit or rollback and never by a
 * clock: the second comer blocks until the first COMMITS, and every caller reads the buyer's tier
 * state only after holding it, so under READ COMMITTED it sees the first one's writes.
 *
 * Nothing that calls another service may run while it is held: a slow peer would hold the buyer's
 * lock for as long as it is slow. A 64-bit hash collision between two buyers could only make them
 * wait for each other, never let two writers of one buyer through.
 */
export async function lockBuyerTiers(
  manager: EntityManager,
  associationId: string,
  userId: string
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    buyerTierLockKey(associationId, userId),
  ]);
}
