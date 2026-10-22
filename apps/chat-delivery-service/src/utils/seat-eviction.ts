import type { EntityManager } from 'typeorm';

/**
 * THE SEAT LOCK, AND THE CLAIM A SEAT IS WRITTEN AGAINST.
 *
 * Two kinds of writer decide whether a person has a routed seat in a group: an EVICTION (a key
 * group's departure, `InternalController.evictFromDistributionGroup`; a conversation's removal,
 * `MembersController.removeGroupMember`) and an ACTIVATION that creates a seat (an accepted commit's
 * committer, a key group's publisher - `MessagingService.activateDeviceMembership`). The activation
 * is decided by a check made BEFORE any lock - the roster, or social-service's entitlement over HTTP,
 * which is never awaited under a lock. So it is made against a CLAIM:
 *
 * 1. {@link claimSeat} reads the person's eviction row, before the check;
 * 2. the check runs, unlocked;
 * 3. under {@link withSeatLock}, {@link seatClaimHolds} re-reads the row - a database read, nothing
 *    else - and the seat is written only if no eviction rewrote it and no departure is in progress.
 *
 * Every eviction rewrites the row under the same lock ({@link recordSeatEviction}), so one of three
 * orders holds: it ran before the claim (the check sees the departure), between the claim and the
 * write (the generation moved, nothing is written), or after the write (it deletes the seat).
 *
 * The lock is a Postgres transaction-scoped advisory lock: released by the commit or the rollback
 * itself, so it has no expiry and termination never rests on a clock.
 */

/** The advisory-lock key of `groupId`'s seats. */
function seatLockKey(groupId: string): string {
  return `seat:${groupId}`;
}

/**
 * Takes `groupId`'s seat lock in the transaction `m` carries, until it commits or rolls back. For a
 * caller that already holds a transaction (the commit's advance); everyone else uses
 * {@link withSeatLock}. `m` MUST be transactional - outside one, the lock ends with the statement.
 */
export async function takeSeatLock(m: EntityManager, groupId: string): Promise<void> {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [seatLockKey(groupId)]);
}

/** Runs `fn` in one transaction holding `groupId`'s seat lock. */
export async function withSeatLock<T>(
  manager: EntityManager,
  groupId: string,
  fn: (m: EntityManager) => Promise<T>
): Promise<T> {
  return manager.transaction(async (m) => {
    await takeSeatLock(m, groupId);
    return fn(m);
  });
}

/** What {@link claimSeat} read: the eviction row of one person in one group, as it stood. */
export interface SeatClaim {
  groupId: string;
  userId: string;
  /** 0 when the person was never evicted. */
  generation: number;
  /** A key group's departure was in progress when the claim was taken. */
  owed: boolean;
}

/** Reads one eviction row; an absent row is generation 0, nothing owed. */
async function readEviction(
  m: EntityManager,
  groupId: string,
  userId: string
): Promise<{ generation: number; owed: boolean }> {
  const rows = (await m.query(
    `SELECT "generation", "owed" FROM dm_seat_evictions WHERE "groupId" = $1 AND "userId" = $2`,
    [groupId, userId]
  )) as Array<{ generation: number | string; owed: boolean }>;
  const row = rows[0];
  return row
    ? { generation: Number(row.generation), owed: !!row.owed }
    : { generation: 0, owed: false };
}

/**
 * Takes a claim on a seat of `userId` in `groupId`: read BEFORE the check that decides the
 * activation, so any eviction after that check is visible to {@link seatClaimHolds}.
 */
export async function claimSeat(
  manager: EntityManager,
  groupId: string,
  userId: string
): Promise<SeatClaim> {
  return { groupId, userId, ...(await readEviction(manager, groupId, userId)) };
}

/**
 * Whether `claim` still stands - read under the seat lock (`m` must hold it). It stands when no
 * eviction rewrote the row since the claim and no departure is in progress.
 *
 * @returns `null` when it stands, otherwise why not, for the caller's log line.
 */
export async function seatClaimHolds(
  m: EntityManager,
  claim: SeatClaim
): Promise<null | 'evicted_since_claim' | 'departure_in_progress'> {
  const now = await readEviction(m, claim.groupId, claim.userId);
  if (now.generation !== claim.generation) return 'evicted_since_claim';
  if (now.owed) return 'departure_in_progress';
  return null;
}

/**
 * Records an eviction of `userId` from `groupId` - the generation moves, so every older claim fails.
 * Call it under the seat lock (`m` must hold it), in the transaction that deletes the seats.
 *
 * @param owed true for a key group's eviction made BEFORE social-service's roster write (a departure
 *   in progress); false for one made after it, or for a removal whose roster write is this very
 *   transaction.
 * @returns the new generation, for the caller's log line.
 */
export async function recordSeatEviction(
  m: EntityManager,
  groupId: string,
  userId: string,
  owed: boolean
): Promise<number> {
  const rows = (await m.query(
    `INSERT INTO dm_seat_evictions ("groupId", "userId", "generation", "owed", "updatedAt")
     VALUES ($1, $2, 1, $3, now())
     ON CONFLICT ("groupId", "userId") DO UPDATE
       SET "generation" = dm_seat_evictions."generation" + 1, "owed" = EXCLUDED."owed", "updatedAt" = now()
     RETURNING "generation"`,
    [groupId, userId, owed]
  )) as Array<{ generation: number | string }>;
  return Number(rows[0]?.generation ?? 0);
}

/**
 * Of `userIds`, those whose departure from `groupId` is in progress - read under the seat lock (`m`
 * must hold it). A commit's admits are not recorded for them.
 */
export async function departingUsers(
  m: EntityManager,
  groupId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = (await m.query(
    `SELECT "userId" FROM dm_seat_evictions WHERE "groupId" = $1 AND "owed" AND "userId" = ANY($2)`,
    [groupId, [...userIds]]
  )) as Array<{ userId: string }>;
  return new Set(rows.map((r) => r.userId));
}
