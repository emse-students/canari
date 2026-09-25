import type { EntityManager } from 'typeorm';

/**
 * THE BLOCK LIST A FEED FILTERS ON, AND WHY IT IS NOT IN `user-blocks.ts` NEXT DOOR.
 *
 * That file is a DECLARED DUPLICATE of `chat-delivery-service/src/utils/user-blocks.ts`
 * (`.github/scripts/lib/declared-duplicates.mjs`): the two copies are compared on every pull
 * request and must agree, because they are the same refusal at two different mutations. This
 * function has no counterpart there - chat-delivery serves no feed - so putting it beside its
 * sibling would either drift the pair or plant dead code in the other service. It lives here
 * instead, and moving it back is what a later tidy-up must not do.
 *
 * WHAT IT ANSWERS: every account hidden from this viewer, in EITHER direction - the ones they
 * blocked and the ones who blocked them.
 *
 * SYMMETRIC for the same reason `isBlockedBetween` is, and the second half is the one that matters
 * here: a feed hiding only the people the viewer blocked would still push the blocker's posts at
 * the person they blocked, which turns a closed door into a one-way mirror.
 *
 * Core-service caps a blocker at 200 rows, which is what makes it safe to hand the whole list to a
 * query as one array parameter rather than joining on the table from another service's schema.
 *
 * MIRRORS `UserBlocksService.invisibleUserIdsFor`, which owns the table - the same deliberate
 * duplication as `isBlockedBetween` in `user-blocks.ts`, and for the same reason.
 */
export async function blockedUserIdsFor(
  manager: EntityManager,
  viewerId: string | undefined
): Promise<string[]> {
  if (!viewerId) return [];
  const rows: { otherId: string }[] = await manager.query(
    `SELECT "blockedId" AS "otherId" FROM user_blocks WHERE "blockerId" = $1
     UNION
     SELECT "blockerId" AS "otherId" FROM user_blocks WHERE "blockedId" = $1`,
    [viewerId]
  );
  return rows.map((r) => r.otherId);
}
