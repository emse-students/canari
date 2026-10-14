import { IsNull, type EntityManager } from 'typeorm';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';

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
 * **IT ALSO OPENS THE MEMBERSHIP INTERVAL** (user, 2026-10-14: a Remove holds against a later
 * re-add). The partial unique index allows one open interval per person and group, so the insert
 * ignores a conflict exactly as the membership row does: a second enrolment changes nothing, and an
 * enrolment that finds its row but no open interval - a crash between the two statements on a
 * caller with no transaction - opens one now rather than leaving the person outside every interval.
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
  await manager
    .createQueryBuilder()
    .insert()
    .into(GroupMembershipInterval)
    .values({ groupId, userId, leftAt: null })
    .orIgnore()
    .execute();
}

/**
 * Ends a user's membership of a group: deletes the `dm_group_members` row and closes the open
 * interval, in whatever transaction `manager` carries.
 *
 * The two writes are one fact - "this person is out from now" - so a caller passes a
 * transactional manager and they commit together. The live row keeps its hard-delete semantics
 * (every membership guard reads its absence); the interval is what remembers that it existed.
 *
 * @returns how many membership rows and open intervals were affected, for the caller's log line.
 *          `closed: 0` with `deleted: 1` is a member enrolled before migration 029 by a writer that
 *          was still running old code - the caller reports it.
 */
export async function endGroupMembership(
  manager: EntityManager,
  groupId: string,
  userId: string
): Promise<{ deleted: number; closed: number }> {
  const del = await manager.getRepository(GroupMember).delete({ groupId, userId });
  const upd = await manager
    .getRepository(GroupMembershipInterval)
    .update({ groupId, userId, leftAt: IsNull() }, { leftAt: () => 'now()' });
  return { deleted: del.affected ?? 0, closed: upd.affected ?? 0 };
}

/** One window, in server milliseconds, during which a person was NOT a member. `until: null` = still out. */
export type ExclusionWindow = { from: number; until: number | null };

/**
 * The windows during which a person was out of a group, read from their membership intervals.
 *
 * A window is the stretch between the END of one interval and the START of the next - and, when the
 * latest interval is closed, from its end onwards. **The time before the FIRST interval is never a
 * window**: a person who arrived late keeps whatever the existing history policy hands a new member,
 * which this change does not touch. A person with one open interval has no window at all, and that
 * is also what a brand-new device of a continuous member sees - intervals are per USER, never per
 * device, so a wipe or a new phone opens nothing.
 *
 * Pure, so the arithmetic is tested without a database.
 *
 * @param intervals one person's intervals in one group, in any order.
 */
export function exclusionWindows(
  intervals: ReadonlyArray<{ joinedAt: Date; leftAt: Date | null }>
): ExclusionWindow[] {
  const ordered = [...intervals].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
  const windows: ExclusionWindow[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const left = ordered[i].leftAt;
    if (left === null) continue;
    const next = ordered[i + 1];
    windows.push({ from: left.getTime(), until: next ? next.joinedAt.getTime() : null });
  }
  return windows;
}
