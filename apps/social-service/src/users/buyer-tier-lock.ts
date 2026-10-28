import type { EntityManager } from 'typeorm';

/**
 * The advisory-lock key of an association's cotisation tiers as a whole: what a tier RETAG (a
 * `variantKey` change renaming every holder's tag) holds EXCLUSIVE, and every per-buyer path holds
 * SHARED. `tier:` namespaces it apart from any other advisory key.
 */
export function associationTierLockKey(associationId: string): string {
  return `tier:${associationId}`;
}

/**
 * The advisory-lock key of one buyer's cotisation tiers in one association. `hashtextextended`
 * (below) makes it the one-key 64-bit form; it can never equal `associationTierLockKey`'s string.
 */
export function buyerTierLockKey(associationId: string, userId: string): string {
  return `tier:${associationId}:${userId}`;
}

/**
 * Serialises, for the length of `manager`'s transaction, EVERYTHING that ranks, grants, swaps or
 * revokes one buyer's tiers in one association: a checkout opening, a settlement, a cash sale, a
 * manual, legacy or form grant, a raw tag grant, a tag revocation (docs/wiki/cotisations.md "Rising
 * to a higher tier"). Two transaction-scoped advisory locks, released by the commit or rollback and
 * never by a clock, in THE ONE ORDER every path follows:
 *
 *   association (shared) -> buyer (exclusive) -> checkout row -> user_tags
 *
 * The association lock is SHARED, so buyers never wait for each other; a tier retag takes it
 * EXCLUSIVE (`lockAssociationTiers`) and so waits for every per-buyer transaction in flight and
 * holds the next ones back while it renames tags. The second comer on a buyer blocks until the
 * first COMMITS; every caller reads the products, the tier keys and the buyer's tags only after
 * holding both, so under READ COMMITTED it sees the earlier writer's commit.
 *
 * Every read inside the transaction goes through `manager`: a read on another pool connection
 * would make a lock holder wait for a free connection while holding the lock. Nothing that calls
 * another service may run while it is held. A 64-bit hash collision could only make two keys wait
 * for each other, never let two writers of one buyer through.
 */
export async function lockBuyerTiers(
  manager: EntityManager,
  associationId: string,
  userId: string
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [
    associationTierLockKey(associationId),
  ]);
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    buyerTierLockKey(associationId, userId),
  ]);
}

/**
 * Takes the association's tier lock EXCLUSIVE for `manager`'s transaction: the tier retag's lock,
 * and the creation of a tier whose key is derived from its label (it reads the sibling keys and
 * inserts one, so two creates of one label must not both read the key as free).
 * It never takes a buyer lock, so it cannot deadlock against a per-buyer path, which takes the
 * association lock first.
 */
export async function lockAssociationTiers(
  manager: EntityManager,
  associationId: string
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    associationTierLockKey(associationId),
  ]);
}
