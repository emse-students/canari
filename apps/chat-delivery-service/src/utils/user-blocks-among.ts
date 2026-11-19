import type { EntityManager } from 'typeorm';

/**
 * NOT part of the declared duplicate `user-blocks.ts` (whose social-service copy must stay
 * byte-identical in substance): only a group call needs the blocks inside a whole member set.
 * It reads the same `user_blocks` table, owned by core-service, for the same reason.
 */

/**
 * Every block standing INSIDE a set of accounts, as `[blocker, blocked]` pairs - ONE query whatever
 * the set's size, where `isBlockedBetween` per pair would cost n(n-1)/2 round trips on every
 * ring of a large conversation. A group call reads it to drop the members a block separates.
 */
export async function blocksAmong(
  manager: EntityManager,
  userIds: readonly string[]
): Promise<[string, string][]> {
  const ids = [...new Set(userIds.filter((id) => !!id))];
  if (ids.length < 2) return [];
  const rows: { blockerId: string; blockedId: string }[] = await manager.query(
    `SELECT "blockerId", "blockedId" FROM user_blocks
     WHERE "blockerId" = ANY($1) AND "blockedId" = ANY($1)`,
    [ids]
  );
  return rows.map((r) => [r.blockerId, r.blockedId]);
}
