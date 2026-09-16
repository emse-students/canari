import type { EntityManager } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';

/**
 * Enrols a user into a group at the user level, and leaves an enrolment that already exists
 * EXACTLY as it is.
 *
 * Two endpoints put rows into `dm_group_members` - `POST mls/groups/:groupId/members` and the
 * invitation-link join - and until 2026-09-16 they disagreed about what a second call means. The
 * invitation path ignored the conflict; the add path rewrote `joinedAt` on every call. That column
 * is a `@CreateDateColumn`, so the disagreement was not cosmetic: it decided whether the table can
 * answer "when did this person arrive" at all.
 *
 * It could not. `processBulkAddition` calls `registerMember` for the CALLER before adding anybody,
 * so every invitation a member sent moved their own arrival forward. Measured on the production
 * group of 2026-09-16: the group was created at 14:17 and NOT ONE of its 31 rows was dated 14:17,
 * while the account that ran the invitations carried 14:25:12 - six seconds before the batch of six
 * it was in the middle of adding. An investigation read that as the adder having no membership for
 * the first five minutes of a group it was committing adds to, which never happened.
 *
 * So the conflict is ignored here, for both callers, and `joinedAt` means the one thing its type
 * says it means. A re-admitted member starts again because `removeGroupMember` DELETES the row -
 * the arrival is re-created, never refreshed in place.
 *
 * Nothing reads `joinedAt` today: it leaves the service on no endpoint, and `getGroupUserMembers`
 * selects `userId` alone. Its only reader is a human at a `psql` prompt, which is exactly the reader
 * a column that lies costs the most.
 *
 * @param manager Entity manager to run on - pass the transaction's manager where one is open, so
 *                the enrolment commits with the device memberships beside it.
 * @param groupId Group being joined.
 * @param userId Person joining. A row already present is left untouched, role included.
 */
export async function ensureGroupMember(
  manager: EntityManager,
  groupId: string,
  userId: string
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(GroupMember)
    .values({ groupId, userId, role: 'member' as const })
    .orIgnore()
    .execute();
}
