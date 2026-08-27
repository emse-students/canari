import type { EntityManager } from 'typeorm';

/**
 * Does a block stand between these two accounts, whichever of them asked for it?
 *
 * `user_blocks` is owned by core-service (migration `007_user_blocks.sql`), which serves the routes
 * that create and lift a block. It is READ here, straight out of `auth_db`, because a block has to
 * be enforced where it is bypassed: hiding somebody from the user search stops nobody who already
 * knows a uuid, so the refusal belongs at the mutation - here, the invitation into a private salon.
 * Reading another service's table with plain SQL is what this repo already does a dozen times over
 * (`SELECT ... FROM users`), and an internal HTTP hop on this path would buy a boundary and cost a
 * round trip on every invitation.
 *
 * SYMMETRIC, and that is the whole question this function answers. Asking "did the target block the
 * actor" would leave the blocker able to invite the person they blocked, which turns a closed door
 * into a one-way channel.
 *
 * DUPLICATED IN `chat-delivery-service` ON PURPOSE - see the note at the head of `service-urls.ts`:
 * `libs/shared-ts` existed, was imported by nothing, and was deleted on 2026-08-27. Creating a
 * shared package for one query would add a build stage to two production images.
 */
export async function isBlockedBetween(
  manager: EntityManager,
  a: string,
  b: string
): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const rows: unknown[] = await manager.query(
    `SELECT 1 FROM user_blocks
     WHERE ("blockerId" = $1 AND "blockedId" = $2)
        OR ("blockerId" = $2 AND "blockedId" = $1)
     LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}
