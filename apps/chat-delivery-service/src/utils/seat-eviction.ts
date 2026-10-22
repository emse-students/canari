import type { EntityManager } from 'typeorm';

/**
 * THE SEAT LOCK, AND THE CLAIM A SEAT IS WRITTEN AGAINST.
 *
 * Two kinds of writer decide whether a person has a seat in a group: an EVICTION (a key group's
 * departure, `InternalController.evictFromDistributionGroup`; a conversation's removal,
 * `MembersController.removeGroupMember`) and a write that CREATES a seat (an accepted commit's
 * committer and its admits, a key group's publisher). The creation is decided by a check made
 * BEFORE any lock - the roster, or social-service's entitlement over HTTP, which is never awaited
 * under a lock. So it is made against a CLAIM:
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
 * A KEY GROUP'S DEPARTURE IS NAMED. Its first eviction (before social-service's roster write) sets
 * `owedDeparture` to its own generation; the second (after the roster write) and the hourly drain
 * settle THAT departure and no other ({@link settleSeatDeparture}).
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

/** One eviction row as stored; an absent row is generation 0, no departure in progress. */
export interface SeatEvictionState {
  generation: number;
  /** The departure in progress, named by the generation that began it, or null. */
  owedDeparture: number | null;
}

/** Reads one eviction row; an absent row is generation 0, nothing owed. */
export async function readSeatEviction(
  m: EntityManager,
  groupId: string,
  userId: string
): Promise<SeatEvictionState> {
  const rows = (await m.query(
    `SELECT "generation", "owedDeparture" FROM dm_seat_evictions WHERE "groupId" = $1 AND "userId" = $2`,
    [groupId, userId]
  )) as Array<{ generation: number | string; owedDeparture: number | string | null }>;
  const row = rows[0];
  if (!row) return { generation: 0, owedDeparture: null };
  return {
    generation: Number(row.generation),
    owedDeparture: row.owedDeparture === null ? null : Number(row.owedDeparture),
  };
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
  const now = await readSeatEviction(manager, groupId, userId);
  return { groupId, userId, generation: now.generation, owed: now.owedDeparture !== null };
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
  const now = await readSeatEviction(m, claim.groupId, claim.userId);
  if (now.generation !== claim.generation) return 'evicted_since_claim';
  if (now.owedDeparture !== null) return 'departure_in_progress';
  return null;
}

/**
 * Records an eviction of `userId` from `groupId` - the generation moves, so every older claim fails.
 * Call it under the seat lock (`m` must hold it), in the transaction that deletes the seats.
 *
 * @param beginsDeparture true for a key group's eviction made BEFORE social-service's roster write:
 *   the departure it begins is named by the new generation and stays owed until settled
 *   ({@link settleSeatDeparture}). false for any other eviction, which leaves a departure already in
 *   progress as it is.
 * @returns the new generation - the departure's name when it begins one.
 */
export async function recordSeatEviction(
  m: EntityManager,
  groupId: string,
  userId: string,
  beginsDeparture: boolean
): Promise<number> {
  const rows = (await m.query(
    `INSERT INTO dm_seat_evictions ("groupId", "userId", "generation", "owedDeparture", "updatedAt")
     VALUES ($1, $2, 1, CASE WHEN $3 THEN 1 ELSE NULL END, now())
     ON CONFLICT ("groupId", "userId") DO UPDATE
       SET "generation" = dm_seat_evictions."generation" + 1,
           "owedDeparture" = CASE WHEN $3 THEN dm_seat_evictions."generation" + 1
                                  ELSE dm_seat_evictions."owedDeparture" END,
           "updatedAt" = now()
     RETURNING "generation"`,
    [groupId, userId, beginsDeparture]
  )) as Array<{ generation: number | string }>;
  return Number(rows[0]?.generation ?? 0);
}

/**
 * Settles the departure named `departure`, if it is still the one in progress - under the seat lock
 * (`m` must hold it). A later departure that began meanwhile is left owed: only its own settlement
 * may clear it.
 *
 * @returns whether that departure was the one in progress and is now settled.
 */
export async function settleSeatDeparture(
  m: EntityManager,
  groupId: string,
  userId: string,
  departure: number
): Promise<boolean> {
  const rows = (await m.query(
    `UPDATE dm_seat_evictions SET "owedDeparture" = NULL, "updatedAt" = now()
     WHERE "groupId" = $1 AND "userId" = $2 AND "owedDeparture" = $3
     RETURNING "generation"`,
    [groupId, userId, departure]
  )) as Array<{ generation: number | string }>;
  return rows.length > 0;
}
