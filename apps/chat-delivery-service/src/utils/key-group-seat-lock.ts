import type { EntityManager } from 'typeorm';

/**
 * Runs `fn` in one transaction holding the per-group SEAT LOCK of a key-distribution group: a
 * Postgres transaction-scoped advisory lock, released by the commit or the rollback itself, so it
 * has no expiry and no clock.
 *
 * WHAT IT MAKES EXCLUSIVE. The two writers that decide whether a user has a routed seat in a key
 * group: the eviction social-service asks for when the user stops belonging to the scope
 * (`InternalController.evictFromDistributionGroup`), and the activation an accepted external commit
 * grants its committer (`MessagingService.validateCommit`), whose entitlement is read INSIDE the
 * lock. One runs entirely before the other: an activation that follows an eviction re-reads the
 * entitlement after it, and an eviction that follows an activation deletes the row it wrote.
 * Social-service evicts a second time once the roster row is gone, so the re-read after that
 * second eviction answers `false` (channel-encryption, "WP-21, and the gate it had nowhere to
 * live").
 *
 * The Redis routing set is written inside `fn` by both sides, so it is ordered by the same lock.
 */
export async function withKeyGroupSeatLock<T>(
  manager: EntityManager,
  groupId: string,
  fn: (m: EntityManager) => Promise<T>
): Promise<T> {
  return manager.transaction(async (m) => {
    await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `keygroup-seat:${groupId}`,
    ]);
    return fn(m);
  });
}
