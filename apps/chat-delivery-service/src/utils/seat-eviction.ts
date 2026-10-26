import type { EntityManager } from 'typeorm';
import { KeyPackage } from '../entities/key-package.entity';

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
 * 1. {@link claimSeat} reads the GROUP's seat generation (`dm_groups."seatGeneration"`) and whether
 *    the person has a departure in progress there, before the check;
 * 2. the check runs, unlocked;
 * 3. under {@link withSeatLock}, {@link seatClaimHolds} re-reads both - a database read, nothing
 *    else - and the seat is written only if no eviction in the group moved the generation and no
 *    departure is in progress.
 *
 * Every eviction moves the generation under the same lock ({@link bumpSeatGeneration}), so one of
 * three orders holds: it ran before the claim (the check sees the departure), between the claim and
 * the write (the generation moved, nothing is written), or after the write (it deletes the seat).
 *
 * THE GENERATION IS THE GROUP'S, NOT THE PERSON'S, SO NOTHING NAMING AN ACCOUNT HAS TO OUTLIVE IT.
 * An account erasure cuts each group's seats and moves that group's generation, so a claim the
 * erased account took before the erasure is refused after it, while the account's eviction rows are
 * deleted with the rest of the account. The cost: a claim in a group where SOMEONE ELSE was evicted
 * meanwhile is refused once too, and its writer retries - evictions are rare, and an overtaken claim
 * already meant one refusal and a retry.
 *
 * A KEY GROUP'S DEPARTURE IS NAMED, and that is what the person's own row (`dm_seat_evictions`) is
 * still for. Its first eviction (before social-service's roster write) sets `owedDeparture` to the
 * row's own generation; the second (after the roster write) and the hourly drain settle THAT
 * departure and no other ({@link settleSeatDeparture}). The row refuses claims only through
 * `owedDeparture`; the generation that refuses an overtaken claim is the group's.
 *
 * WHAT A SEAT CARRIES IS WRITTEN UNDER THE SAME LOCK. A route in the gateway's set is written only
 * under it, against a re-read of the active rows (`MessagingService.restoreRoutes`); a send's queued
 * frames under it SHARED, against a re-read of who holds a seat (`enqueueForLiveGroup`). An eviction
 * deletes all three under it, so none outlives the seat it was written for.
 *
 * THE ONE ORDER, so no two of these writers wait on each other in a cycle: the seat lock, then the
 * `dm_groups` row, then `dm_group_members` and its interval, then `queued_message`, then
 * `dm_device_group_memberships`, then `dm_seat_evictions` last. A removal
 * (`MembersController.removeGroupMember`), an eviction (`MessagingService.evictSeats`,
 * `eraseSeats`), one device's departure (`endDeviceMemberships`) and a group's end
 * (`GROUP_OWNED_TABLES`, which takes no seat lock; its callers write or lock the `dm_groups` row
 * first) all delete in it. Each eviction moves the group's generation FIRST, right after the lock:
 * that is its `dm_groups` row, second in the order.
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

/**
 * Takes `groupId`'s seat lock SHARED in the transaction `m` carries: it waits for any writer holding
 * the lock (an eviction, a commit's admits) and keeps the next one waiting until `m` ends, while
 * other shared holders - concurrent sends into one group - never wait for each other. For a write
 * that does not change a seat but must not outlive one (a queued frame). `m` MUST be transactional.
 */
export async function takeSharedSeatLock(m: EntityManager, groupId: string): Promise<void> {
  await m.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))`, [
    seatLockKey(groupId),
  ]);
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

/**
 * Which of `devices` still have their key package, read `FOR SHARE` in `m` - the read every writer
 * that admits a device into a group (an `active` row, or a `pending` one owed a Welcome) makes
 * first, under the group's seat lock, so the result is the set of `userId:deviceId` keys it may
 * write a row for. TWO KNOWN EXCEPTIONS:
 *
 * - The demotion (`MessagingService.deactivateDeviceMembership`), deliberately: it only UPDATES a
 *   row that exists to `pending` and removes its route itself - it never inserts one, so it admits
 *   nobody - and the stale-device cron demotes precisely a device with no recent key package, so
 *   requiring one would make it a no-op.
 * - `MembersController.addGroupMember`'s CREATION BOOTSTRAP only (a creator registering itself into
 *   its new, empty group): it reads the key packages outside any lock and writes the roster row, its
 *   interval and `pending` seats with no seat lock. Every other call of that route writes device
 *   seats through `writePendingSeats` and enrols nobody (ADM-3, 2026-10-25), so a peer's invite can
 *   no longer re-enrol an erased account; the creator's own erasure racing its group creation
 *   can still leave a row (backlog, P2 "addGroupMember can enrol an erased account after the final erasure pass").
 *
 * THE KEY PACKAGE IS WHAT AN ACCOUNT ERASURE TAKES FIRST, in a transaction of its own
 * (`InternalController.deleteUserData`), and AGAIN before its last sweep. A writer either holds the
 * key package before a delete - which then waits for it, and the per-group cut run after takes the
 * row with its routes - or finds it gone and writes nothing. The account itself can republish one
 * while a token it holds is still valid, which is what the sweep and the erasure's final pass (run
 * once no token is) are for; no device row is deleted outside a cut, so a seat that outran the sweep
 * keeps its row beside its route until the final pass cuts both. A writer that only UPDATES a row
 * needs no read: a deleted row matches nothing.
 */
export async function heldKeyPackages(
  m: EntityManager,
  devices: ReadonlyArray<{ userId: string; deviceId: string }>
): Promise<Set<string>> {
  if (devices.length === 0) return new Set();
  const rows = await m.getRepository(KeyPackage).find({
    where: devices.map(({ userId, deviceId }) => ({ userId, deviceId })),
    select: { userId: true, deviceId: true },
    lock: { mode: 'pessimistic_read' },
  });
  return new Set(rows.map((r) => `${r.userId}:${r.deviceId}`));
}

/** What {@link claimSeat} read: the group's seat generation and the person's departure, as they stood. */
export interface SeatClaim {
  groupId: string;
  userId: string;
  /** The group's seat generation when the claim was taken; every eviction in the group moves it. */
  generation: number;
  /** A key group's departure of this person was in progress when the claim was taken. */
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
 * Reads what a claim compares: `groupId`'s seat generation and whether `userId` has a departure in
 * progress there. One statement, one row; a group with no row reads generation 0.
 */
async function readSeatClaimState(
  m: EntityManager,
  groupId: string,
  userId: string
): Promise<{ generation: number; owed: boolean }> {
  const rows = (await m.query(
    `SELECT (SELECT "seatGeneration" FROM dm_groups WHERE id = $1) AS "generation",
            (SELECT "owedDeparture" FROM dm_seat_evictions
              WHERE "groupId" = $1 AND "userId" = $2) AS "owedDeparture"`,
    [groupId, userId]
  )) as Array<{ generation: number | string | null; owedDeparture: number | string | null }>;
  const row = rows[0];
  return {
    generation: Number(row?.generation ?? 0),
    owed: row !== undefined && row.owedDeparture !== null && row.owedDeparture !== undefined,
  };
}

/**
 * Takes a claim on a seat of `userId` in `groupId`: read BEFORE the check that decides the
 * activation, so any eviction in the group after that check is visible to {@link seatClaimHolds}.
 */
export async function claimSeat(
  manager: EntityManager,
  groupId: string,
  userId: string
): Promise<SeatClaim> {
  const now = await readSeatClaimState(manager, groupId, userId);
  return { groupId, userId, generation: now.generation, owed: now.owed };
}

/**
 * Whether `claim` still stands - read under the seat lock (`m` must hold it). It stands when no
 * eviction in the group moved its generation since the claim and the person has no departure in
 * progress. An eviction of SOMEONE ELSE in the group refuses it too: one refusal, and its writer
 * retries with a new claim.
 *
 * @returns `null` when it stands, otherwise why not, for the caller's log line.
 */
export async function seatClaimHolds(
  m: EntityManager,
  claim: SeatClaim
): Promise<null | 'evicted_since_claim' | 'departure_in_progress'> {
  const now = await readSeatClaimState(m, claim.groupId, claim.userId);
  if (now.generation !== claim.generation) return 'evicted_since_claim';
  if (now.owed) return 'departure_in_progress';
  return null;
}

/**
 * `groupId`'s seat generation as it stands - 0 for a group with no row. Never decreases: every
 * writer only increments it ({@link bumpSeatGeneration}), so a number read here is never later than
 * the group's current one.
 */
export async function readSeatGeneration(m: EntityManager, groupId: string): Promise<number> {
  const rows = (await m.query(`SELECT "seatGeneration" FROM dm_groups WHERE id = $1`, [
    groupId,
  ])) as Array<{ seatGeneration: number | string }>;
  return Number(rows[0]?.seatGeneration ?? 0);
}

/**
 * Moves `groupId`'s seat generation, so no claim on a seat of that group taken before it passes
 * {@link seatClaimHolds} after it. EVERY eviction calls it FIRST under the seat lock (`m` must hold
 * it) - the `dm_groups` row, second in the one order - an account erasure's cut included. A group
 * with no row moves nothing.
 */
export async function bumpSeatGeneration(m: EntityManager, groupId: string): Promise<void> {
  await m.query(`UPDATE dm_groups SET "seatGeneration" = "seatGeneration" + 1 WHERE id = $1`, [
    groupId,
  ]);
}

/**
 * Records an eviction of `userId` from `groupId` in the person's own row - what names a key group's
 * departure. It does NOT refuse a claim: the eviction's {@link bumpSeatGeneration}, called first, does.
 * Call it under the seat lock (`m` must hold it), last, in the transaction that deletes the seats.
 *
 * @param beginsDeparture true for a key group's eviction made BEFORE social-service's roster write:
 *   the departure it begins is named by the new generation and stays owed until settled
 *   ({@link settleSeatDeparture}). false for any other eviction, which leaves a departure already in
 *   progress as it is - and CREATES NO ROW: with no departure to name, a row would only be a record
 *   naming the person, and one arriving after an account erasure would outlive it.
 * @returns the new generation - the departure's name when it begins one; 0 when no row was written.
 */
export async function recordSeatEviction(
  m: EntityManager,
  groupId: string,
  userId: string,
  beginsDeparture: boolean
): Promise<number> {
  const rows = (await m.query(
    `INSERT INTO dm_seat_evictions ("groupId", "userId", "generation", "owedDeparture", "updatedAt")
     SELECT $1::uuid, $2::varchar, 1, CASE WHEN $3::boolean THEN 1 ELSE NULL END, now()
      WHERE $3::boolean
         OR EXISTS (SELECT 1 FROM dm_seat_evictions
                     WHERE "groupId" = $1::uuid AND "userId" = $2::varchar)
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
  // Wrapped in a SELECT: a bare UPDATE ... RETURNING answers `[rows, count]` through the driver, so
  // its length was 2 whether a row matched or not.
  const rows = (await m.query(
    `WITH settled AS (
       UPDATE dm_seat_evictions SET "owedDeparture" = NULL, "updatedAt" = now()
       WHERE "groupId" = $1 AND "userId" = $2 AND "owedDeparture" = $3
       RETURNING "generation"
     )
     SELECT "generation" FROM settled`,
    [groupId, userId, departure]
  )) as Array<{ generation: number | string }>;
  return rows.length > 0;
}
