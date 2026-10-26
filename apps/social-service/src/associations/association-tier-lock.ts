import type { EntityManager } from 'typeorm';

/**
 * The advisory-lock key of ONE association's set of cotisation tiers. `tier:` namespaces it apart
 * from every other advisory key; `hashtextextended(key, 0)` (below) makes it the 64-bit form.
 */
export function associationTierLockKey(associationId: string): string {
  return `tier:${associationId}`;
}

/**
 * Serialises, for the length of `manager`'s transaction, every change to WHICH tiers an
 * association has - today the creation of a tier whose key is derived from its label, which reads
 * the sibling keys and then inserts one: two creates of the same label would otherwise both read
 * the key as free and insert it twice (docs/wiki/cotisations.md "A new tier's key is derived from
 * its label"). A transaction-scoped lock, released by the commit or rollback and never by a clock;
 * the second comer blocks until the first COMMITS, then reads the siblings on the same manager and
 * sees the first one's row.
 *
 * Nothing that calls another service may run while it is held. A 64-bit hash collision between two
 * associations could only make them wait for each other, never let two writers of one through.
 */
export async function lockAssociationTiers(
  manager: EntityManager,
  associationId: string
): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    associationTierLockKey(associationId),
  ]);
}
