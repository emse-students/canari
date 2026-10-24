import { Logger } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { Group } from '../entities/group.entity';
import { heldKeyPackages, takeSharedSeatLock } from './seat-eviction';

const seatsLogger = new Logger('GroupMembership');

const logger = new Logger('GroupMembership');

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
 * **AND IT RECORDS AN ADMISSION THAT PRECEDED IT** (review of #2226). When a device row of this
 * person in this group is older than the enrolment - a commit admitted an invitee who came online
 * later - its instant goes on the interval as `admittedAt`, so the arrival no longer lives only in
 * a row that revoking the device deletes. It is read BEFORE the insert and written with it, so an
 * interval that already exists is left alone with whatever it recorded. A device revoked between
 * its admission and the enrolment is not recorded: the arrival is then the enrolment, later, which
 * costs that person history and hands nobody anything.
 *
 * **ONLY A ROW YOUNGER THAN THE PERSON'S LAST DEPARTURE COUNTS** (review of #2254). A removal deletes
 * the device rows, then closes the interval in a separate transaction, and a `registerDevice`
 * running in between can leave a pending row from the PREVIOUS membership. Taken as the re-add's
 * admission, it would date the new stretch from before the removal, and `for` would again answer
 * for people added while the person was out. So the read is bounded by the latest `leftAt`.
 *
 * **TWO CLOCKS AGAIN.** The device row's instant is the database's, `joinedAt` and `leftAt` are this
 * process's. A database clock running AHEAD makes a genuine earlier admission look no earlier than
 * the enrolment, and nothing is recorded - the arrival is then the enrolment, later: history lost,
 * nothing handed out. The same skew can make a row written just after a departure read as before
 * it, with the same outcome.
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
  const joinedAt = new Date();
  // Only a row of THIS stretch may stand for its admission: one older than the person's last
  // departure belongs to a previous membership (see the docstring).
  const previous = await manager
    .getRepository(GroupMembershipInterval)
    .createQueryBuilder('i')
    .select('MAX(i.leftAt)', 'lastLeftAt')
    .where('i.groupId = :groupId', { groupId })
    .andWhere('i.userId = :userId', { userId })
    .getRawOne<{ lastLeftAt: Date | string | null }>();
  const lastLeftAt = previous?.lastLeftAt ? new Date(previous.lastLeftAt) : null;
  const deviceQuery = manager
    .getRepository(DeviceGroupMembership)
    .createQueryBuilder('d')
    .select('MIN(d.createdAt)', 'firstDeviceAt')
    .where('d.groupId = :groupId', { groupId })
    .andWhere('d.userId = :userId', { userId });
  if (lastLeftAt) deviceQuery.andWhere('d.createdAt > :lastLeftAt', { lastLeftAt });
  const earliest = await deviceQuery.getRawOne<{ firstDeviceAt: Date | string | null }>();
  const firstDeviceAt = earliest?.firstDeviceAt ? new Date(earliest.firstDeviceAt) : null;
  const admittedAt =
    firstDeviceAt && firstDeviceAt.getTime() < joinedAt.getTime() ? firstDeviceAt : null;
  const opened = await manager
    .createQueryBuilder()
    .insert()
    .into(GroupMembershipInterval)
    .values({ groupId, userId, joinedAt, leftAt: null, admittedAt })
    .orIgnore()
    .returning(['id'])
    .execute();
  if (admittedAt && ((opened.raw as unknown[] | undefined) ?? []).length > 0) {
    logger.debug(
      `[GROUP_ENROL] group=${groupId.slice(0, 8)} user=${userId.slice(0, 8)} admitted ${joinedAt.getTime() - admittedAt.getTime()} ms before enrolment - arrival recorded on the interval`
    );
  }
}

/** What {@link writePendingSeats} did: the seats written, or why none was. */
export type PendingSeatsOutcome = 'written' | 'group_gone' | 'not_on_roster';

/**
 * Writes `pending` device memberships for `deviceIds` of `userId` in `groupId` - the seats a member
 * then fulfils with an Add and a Welcome - UNDER THE GROUP'S SEAT LOCK, against a re-read made
 * under it.
 *
 * A pending seat read off an unlocked roster could be written after a removal or a group's end
 * had already run, for a person no longer in it. Under the lock (shared: writers of seats never
 * wait for each other, an eviction takes it exclusive) the group row and the roster row are read
 * in the one order (`utils/seat-eviction.ts`), so a removal either ran before - and the roster
 * read finds no row - or waits, then deletes what this wrote.
 *
 * @param enrol true for an invite acceptance, which writes the roster row itself in the same
 *   transaction ({@link ensureGroupMember}); false for a device registration, which writes seats
 *   only where its owner is ALREADY on the roster.
 * @param manager a NON-transactional manager - this opens the transaction itself.
 */
export async function writePendingSeats(
  manager: EntityManager,
  groupId: string,
  userId: string,
  deviceIds: readonly string[],
  enrol: boolean
): Promise<PendingSeatsOutcome> {
  return manager.transaction(async (m) => {
    await takeSharedSeatLock(m, groupId);
    const [group] = await m.getRepository(Group).find({
      where: { id: groupId },
      select: { id: true, deletedAt: true },
      lock: { mode: 'pessimistic_read' },
    });
    if (!group || group.deletedAt) return 'group_gone';
    if (enrol) {
      await ensureGroupMember(m, groupId, userId);
    } else {
      const seat = await m.getRepository(GroupMember).findOne({
        where: { groupId, userId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!seat) return 'not_on_roster';
    }
    // Each row only beside its device's key package, read `FOR SHARE` under the lock
    // ({@link heldKeyPackages}): a device of an account being erased gets none.
    const keyed = await heldKeyPackages(
      m,
      deviceIds.map((deviceId) => ({ userId, deviceId }))
    );
    const writable = deviceIds.filter((deviceId) => keyed.has(`${userId}:${deviceId}`));
    if (writable.length < deviceIds.length) {
      seatsLogger.warn(
        `[PENDING_SEATS] group=${groupId} user=${userId.slice(0, 8)} ` +
          `${deviceIds.length - writable.length} device(s) NOT seated - no key package under the ` +
          `seat lock (the account or device is being erased)`
      );
    }
    if (writable.length > 0) {
      await m
        .createQueryBuilder()
        .insert()
        .into(DeviceGroupMembership)
        .values(
          writable.map((deviceId) => ({ userId, deviceId, groupId, status: 'pending' as const }))
        )
        .orIgnore()
        .execute();
    }
    return 'written';
  });
}

/**
 * Who a departure takes out: a person (`userId`), narrowed to one device and/or one group. An
 * omitted field widens the scope to every device or every group of that person - never further.
 */
export interface DepartureScope {
  userId: string;
  deviceId?: string;
  groupId?: string;
}

/** `value` as an id, or a throw naming the field: never an empty, blank or absent one. */
function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`endDeviceMemberships: ${field} must be a non-empty id`);
  }
  return value;
}

/**
 * Ends the device memberships a departure names and deletes, in the SAME transaction, what is
 * still queued for those devices: the Welcomes always (`'welcomes'`), or the whole queue of that
 * scope when the departure takes everything (`'all'`: an eviction, a revoked device, an erased
 * account).
 *
 * THE ONE IMPLEMENTATION FOR EVERY PATH THAT ENDS A DEVICE'S MEMBERSHIP. A device pulls its queue
 * whatever the roster says (`fetchMessages`), so a Welcome left behind lets a device that is out
 * enter the epoch the Welcome was built for, and read what members seal there until a commit
 * removes its leaf - which a self-leave never makes. Each path deleted its own rows, and the
 * Welcome was the row none of them named.
 *
 * NOT for a membership put back to `pending` (a kick, `deactivateDeviceMembership`) or a pending
 * seat the cron purges while the person stays on the roster: a Welcome queued there IS the Add the
 * device is owed.
 *
 * @param manager pass the transaction's manager, so the rows and the queue go together.
 * @returns how many device rows and queued rows were deleted, for the caller's log line.
 */
export async function endDeviceMemberships(
  manager: EntityManager,
  scope: DepartureScope,
  queue: 'welcomes' | 'all'
): Promise<{ memberships: number; queued: number }> {
  // A DELETE IS ONLY AS NARROW AS ITS FILTER, so every column the caller names must be a real id.
  // An absent `userId`, or a named `deviceId`/`groupId` that is empty, undefined or null, is a
  // caller's bug - refused here, before any statement exists, rather than handed to a builder that
  // might drop the column and delete other people's rows.
  const userId = requireId(scope.userId, 'userId');
  const deviceId = 'deviceId' in scope ? requireId(scope.deviceId, 'deviceId') : undefined;
  const groupId = 'groupId' in scope ? requireId(scope.groupId, 'groupId') : undefined;
  const narrowing = {
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
  };
  // The queue, then the device rows: the one delete order (`utils/seat-eviction.ts`).
  const queued = await manager.getRepository(QueuedMessage).delete({
    recipientId: userId,
    ...narrowing,
    ...(queue === 'welcomes' ? { isWelcome: true } : {}),
  });
  const memberships = await manager
    .getRepository(DeviceGroupMembership)
    .delete({ userId, ...narrowing });
  return { memberships: memberships.affected ?? 0, queued: queued.affected ?? 0 };
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

/**
 * Opens the missing interval of roster members who have none open, from each roster row's own
 * `joinedAt` - what the migration's backfill does. A roster member outside every open interval
 * would otherwise read as out of the group from their last close onwards: every row since then
 * would be withheld from them, and every answerer would withhold it too.
 *
 * Two writers can leave that state: a container still on pre-030 code while the migration was
 * applied, and `ensureGroupMember` interrupted between its two statements on a caller with no
 * transaction (the invitation join). Both readers of intervals call this before computing a window,
 * so whichever reads first heals it.
 *
 * **THE ROSTER READ AND THE INSERT ARE ONE TRANSACTION, AND THE ROSTER ROWS ARE HELD `FOR SHARE`**
 * (final review of #1878). Read without a lock, a removal committing between the read and the
 * insert found no open interval to close, and the insert then left an OPEN interval with no roster
 * row: on the re-add, `ensureGroupMember`'s ignored conflict kept it, and no window covered the
 * removal - the very leak these intervals exist to close. Held, the removal's DELETE waits for this
 * transaction, then closes the interval it opened; a row already deleted is not read at all.
 *
 * ONLY WHAT WAS STORED IS RETURNED (`RETURNING`): a concurrent repair whose insert hit the
 * conflict opened nothing, so it neither logs a repair nor adds a row that does not exist.
 *
 * @param userIds people the caller read with no open interval; the roster decides which of them
 *                are members, read under the lock.
 * @returns the intervals actually opened, for the caller to add to what it already read and to log.
 */
export async function openMissingIntervals(
  manager: EntityManager,
  groupId: string,
  userIds: readonly string[]
): Promise<Array<{ userId: string; joinedAt: Date; leftAt: null }>> {
  if (userIds.length === 0) return [];
  return manager.transaction(async (tx) => {
    const roster = await tx
      .getRepository(GroupMember)
      .createQueryBuilder('m')
      .select('m.userId', 'userId')
      .addSelect('m.joinedAt', 'joinedAt')
      .where('m.groupId = :groupId', { groupId })
      .andWhere('m.userId IN (:...userIds)', { userIds: [...userIds] })
      .setLock('pessimistic_read')
      .getRawMany<{ userId: string; joinedAt: Date }>();
    if (roster.length === 0) return [];
    const inserted = await tx
      .createQueryBuilder()
      .insert()
      .into(GroupMembershipInterval)
      .values(
        roster.map((m) => ({ groupId, userId: m.userId, joinedAt: m.joinedAt, leftAt: null }))
      )
      .orIgnore()
      .returning(['userId', 'joinedAt'])
      .execute();
    const raw = (inserted.raw ?? []) as Array<{ userId: string; joinedAt: Date | string }>;
    return raw.map((r) => ({ userId: r.userId, joinedAt: new Date(r.joinedAt), leftAt: null }));
  });
}

/** One window, in server milliseconds, during which a person was NOT a member. `until: null` = still out. */
export type ExclusionWindow = { from: number; until: number | null };

/**
 * The windows during which a person was out of a group, read from their membership intervals.
 *
 * A window is the stretch between the END of one interval and the START of the next - and, when the
 * latest interval is closed, from its end onwards. **The time before the FIRST interval is never a
 * window HERE**: that span is a group-conversation rule, added by {@link withheldWindows}, and this
 * function also feeds the server's own stream filter and the legacy `exclusions` field, whose
 * readers take a union. A person with one open interval has no window at all, and that
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
 * Everything a person may NOT be handed from a group's history: the gaps of {@link exclusionWindows}
 * and, in a GROUP conversation, everything before their first arrival (user, 2026-10-21: a new member
 * reads nothing from before they were added, as on WhatsApp and Signal).
 *
 * **Not in a 1:1.** Nobody is ever added to one, and its recorded arrivals are not arrivals: on
 * production 2026-10-21, 51 of 472 1:1 members had a first interval starting more than 10 minutes
 * after the conversation was created. Applying the span there would take a member's own past away
 * from their next device.
 *
 * **The first arrival is the EARLIER of the first interval and the person's first device row in the
 * group - a DECISION, not a proof: added = arrived** (as on WhatsApp, where a member is in the group
 * from the moment someone adds them). A device row is written when a commit admits the device
 * (`ValidateCommitBody.admits`), and it can wait there for an invitee who is offline, so an invitee
 * receives from the history what was sent between the invitation and their first connection - the
 * frames of that span were queued to them live anyway. `registerDevice` also re-creates rows for a
 * member's new device, which can only be later than their first. Intervals alone are not enough: on
 * production 2026-10-21, 4 of the 24 members who joined a group conversation late held a device row up
 * to 268 hours before their recorded first interval, and their next device would have lost that span.
 *
 * **A device row is not durable, so the enrolment copies it onto the interval** (`admittedAt`,
 * migration 033, review of #2226): revoking a device deletes its rows, and a late-enrolled member's
 * first row was the only record of their arrival, so their next device lost the span. The first
 * arrival is therefore the earliest of every interval's `joinedAt` and `admittedAt` and of the
 * device rows still present - the rows still count for an invitee admitted and not yet enrolled.
 *
 * **Two clocks, bounded.** An interval is stamped by this process (`new Date()`), a device row by the
 * database (`CreateDateColumn`, the transaction's start; `admittedAt` is that instant, copied). The admitting transaction commits BEFORE
 * the commit that lets the device read anything is fanned out, so the database instant can only be
 * early, by at most that one transaction - which can hand the newcomer frames sealed at the epoch
 * before theirs, received in those milliseconds. Unifying the clocks needs a column and a migration
 * for a bound of one transaction; that trade was declined.
 *
 * A person with neither - nothing admitted, nothing enrolled - is withheld everything.
 *
 * **THE PERSON WHO ARRIVED WITH THE GROUP HAS NO SPAN** (2026-10-22). Nothing precedes the creation,
 * so their span is empty - but not harmless: a client reads an UNDATED copy against every window
 * EDGE with a one-hour skew margin (`historyEntitlement.ts`), so `[0, creation)` made the creator drop
 * every undated history entry of the group's first hour, for good (GRP-7). An arrival within
 * {@link CREATION_ARRIVAL_BOUND_MS} of `groupCreatedAt`, on either side, is the creation. Measured on
 * the local estate: the creator's interval 4 ms after the group row, the next member 13.5 s.
 *
 * Pure, so the arithmetic is tested without a database.
 *
 * @param intervals one person's intervals in one group, in any order; `admittedAt` as recorded.
 * @param beforeFirstArrival true for a group conversation, false for a 1:1.
 * @param firstDeviceAt when the person's earliest device row in the group was written, or `null`.
 * @param groupCreatedAt when the group row was written, or `null` when it is not known.
 */
export function withheldWindows(
  intervals: ReadonlyArray<{ joinedAt: Date; leftAt: Date | null; admittedAt?: Date | null }>,
  beforeFirstArrival: boolean,
  firstDeviceAt: Date | null,
  groupCreatedAt: Date | null = null
): ExclusionWindow[] {
  const gaps = exclusionWindows(intervals);
  if (!beforeFirstArrival) return gaps;
  const arrivals = [
    ...intervals.map((i) => stretchStart(i)),
    ...(firstDeviceAt ? [firstDeviceAt.getTime()] : []),
  ];
  if (arrivals.length === 0) return [{ from: 0, until: null }];
  const firstArrival = Math.min(...arrivals);
  if (
    groupCreatedAt !== null &&
    Math.abs(firstArrival - groupCreatedAt.getTime()) <= CREATION_ARRIVAL_BOUND_MS
  ) {
    return gaps;
  }
  return [{ from: 0, until: firstArrival }, ...gaps];
}

/**
 * When a stretch of membership began, in server milliseconds: its recorded admission when one
 * preceded the enrolment, else the enrolment. The start of the person's presence, never the end of
 * a gap - {@link exclusionWindows} reads `joinedAt` alone.
 */
export function stretchStart(interval: { joinedAt: Date; admittedAt?: Date | null }): number {
  const joined = interval.joinedAt.getTime();
  return interval.admittedAt ? Math.min(joined, interval.admittedAt.getTime()) : joined;
}

/**
 * How close to the group row's instant a first arrival must be to BE the creation. The creator's
 * interval is written by the same request as the group row, on another clock (this process against
 * the database's): 4 ms apart on the local estate. A member added by the next commit arrives seconds
 * later (13.5 s measured), so one second separates the two with room on both sides.
 */
export const CREATION_ARRIVAL_BOUND_MS = 1000;

/**
 * Whether the server instant `at` falls inside one of `windows` - start included, end excluded, the
 * same rule the client applies (`historyEntitlement.ts`), so the two can never disagree on a border.
 */
export function insideExclusion(at: number, windows: readonly ExclusionWindow[]): boolean {
  return windows.some((w) => at >= w.from && (w.until === null || at < w.until));
}

/**
 * The history-stream rows a reader may have, given the reader's OWN exclusion windows in that group:
 * a row whose server time falls inside one is DROPPED - no id, no marker, nothing.
 *
 * **WHY THE SERVER, AND WHY HERE.** A Remove whose MLS commit never landed leaves the removed person's
 * leaf, and every frame sent while they were out is sealed at an epoch their old state can still
 * open. Live delivery and the queue never reach them (their device rows are gone), so the one road
 * back is this stream, walked after a re-add. The server knows both the window and the row's time,
 * so it withholds the ciphertext itself - a control that holds whatever the reader's build.
 *
 * **DROPPED, NEVER MARKED.** A marked row (`{ id, withheld }`, the first shape) stalled every store
 * build shipped before it for good: the old walk decodes `content` unconditionally, the decode
 * threw on `undefined`, the cursor was never saved and every later replay threw on the same row
 * (third review of #1878). A dropped row is one no build can trip on. The page stays FULL, because
 * the reader filling it keeps reading past what it drops (`readHistoryStreamPage`) - an empty page
 * is the end of the walk to every build. A row whose time cannot be read is dropped whenever a
 * window exists, as the client's rule withholds an undatable message.
 *
 * @returns the rows kept, and how many were dropped (for the caller's log line).
 */
export function withholdExcludedHistoryRows(
  rows: Record<string, unknown>[],
  windows: readonly ExclusionWindow[]
): { rows: Record<string, unknown>[]; withheld: number } {
  if (windows.length === 0) return { rows, withheld: 0 };
  const kept = rows.filter((row) => {
    const at = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : Number.NaN;
    return Number.isFinite(at) && !insideExclusion(at, windows);
  });
  return { rows: kept, withheld: rows.length - kept.length };
}

/**
 * The Redis hash naming the devices of people removed from `groupId` whose REMOVE commit has not
 * been queued to them yet: field `userId:deviceId`, value the user id of whoever removed them (for
 * the log line only - nothing is decided on it).
 *
 * **A REMOVAL IS RECORDED BEFORE ITS COMMIT, AND THE COMMIT MUST STILL REACH THE REMOVED PERSON.**
 * `removeGroupMember` deletes the device rows, closes the interval and deletes the roster row - so
 * no application frame reaches them from that instant - and the commit fan-out resolves recipients
 * from those very device rows. Without this hash the removed devices never received the commit
 * that removes them and kept the epoch's keys until a refused send told them.
 *
 * **KEYED TO THE COMMIT'S DECLARED INTENT, NOT TO "THE REMOVER'S NEXT COMMIT".** A commit says whom
 * it removes (`ValidateCommitBody.removes`), and only an entry it names is queued and consumed - so
 * two removals in parallel each reach their own person, and whoever commits the removal (the
 * remover, or any holder collecting a stray leaf after a global admin removed somebody without
 * committing) delivers it. An entry ends on STATE, never on a clock: consumed by the commit naming
 * it, or cleared when that device is in the tree again (admitted by a commit, or committing itself),
 * or with the group. An entry no commit will ever name - its removal committed by an older build,
 * which declares nothing - stays until one of those, one small field per device.
 *
 * A HINT, NOT THE RECORD: the removal itself is the Postgres rows, written first. Losing this hash
 * (Redis persists to a volume since 2026-08-12, so only a lost volume loses it) costs the removed
 * device the commit, which is the refused-send discovery it had anyway; it never re-admits anybody.
 */
export function partingKey(groupId: string): string {
  return `group:parting:${groupId}`;
}
