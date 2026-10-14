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
 * **BOTH INSTANTS OF AN INTERVAL COME FROM THIS PROCESS'S CLOCK** (`new Date()`), because that is
 * the clock `sendMessage` stamps `queued_message.createdAt` with - the server time a window is
 * compared against. The database's `now()` is a different clock; the two agree only by accident.
 * Every column is `timestamp WITHOUT time zone`, so the stated invariant is that this container
 * runs in UTC (measured on production 2026-10-14, as is Postgres) - see history-reconciliation.
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
    .values({ groupId, userId, joinedAt: new Date(), leftAt: null })
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
 *          `closed: 0` with `deleted: 1` is a member enrolled before migration 030 by a writer that
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
    .update({ groupId, userId, leftAt: IsNull() }, { leftAt: new Date() });
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

/**
 * Whether the server instant `at` falls inside one of `windows` - start included, end excluded, the
 * same rule the client applies (`historyEntitlement.ts`), so the two can never disagree on a border.
 */
export function insideExclusion(at: number, windows: readonly ExclusionWindow[]): boolean {
  return windows.some((w) => at >= w.from && (w.until === null || at < w.until));
}

/**
 * The history-stream rows a reader may have, given the reader's OWN exclusion windows in that group:
 * a row whose server time falls inside one keeps its `id` and nothing else, marked `withheld`.
 *
 * **WHY THE SERVER, AND WHY HERE.** A Remove whose MLS commit never landed leaves the removed person's
 * leaf, and every frame sent while they were out is sealed at an epoch their old state can still
 * open. Live delivery and the queue never reach them (their device rows are gone), so the one road
 * back is this stream, walked after a re-add. The server knows both the window and the row's time,
 * so it withholds the ciphertext itself - a control that holds whatever the reader's build.
 *
 * **THE ID STAYS** so a reader's cursor still advances past the row: a page whose rows were dropped
 * outright would read as the end of the stream, or be asked for again for ever. A row whose time
 * cannot be read is withheld whenever a window exists, as the client's rule withholds an undatable
 * message.
 *
 * @returns the rows, and how many were withheld (for the caller's log line).
 */
export function withholdExcludedHistoryRows(
  rows: Record<string, unknown>[],
  windows: readonly ExclusionWindow[]
): { rows: Record<string, unknown>[]; withheld: number } {
  if (windows.length === 0) return { rows, withheld: 0 };
  let withheld = 0;
  const out = rows.map((row) => {
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : Number.NaN;
    if (Number.isFinite(at) && !insideExclusion(at, windows)) return row;
    withheld++;
    return { id: row['id'], withheld: '1' };
  });
  return { rows: out, withheld };
}

/**
 * The Redis hash naming the devices of people removed from `groupId` whose removal commit has not
 * been fanned out yet: field `userId:deviceId`, value the REMOVER's user id.
 *
 * **A REMOVAL IS RECORDED BEFORE ITS COMMIT, AND THE COMMIT MUST STILL REACH THE REMOVED PERSON.**
 * `removeGroupMember` deletes the roster row, closes the interval and deletes the device rows - so
 * no application frame reaches them from that instant - and the commit fan-out resolves recipients
 * from those very device rows. Without this hash the removed devices never received the commit
 * that removes them and kept the epoch's keys until a refused send told them. The remover's next
 * commit is queued to these devices too, and consumes the entries (`sendMessage`).
 *
 * A HINT, NOT THE RECORD: the removal itself is the Postgres rows, written first. Losing this hash
 * (Redis has persisted to a volume since 2026-08-12) costs the removed device the commit, which is
 * the refused-send discovery it had anyway; it never re-admits anybody.
 */
export function partingKey(groupId: string): string {
  return `group:parting:${groupId}`;
}
