/**
 * THE STRIKE LADDER OF A BROADCASTER (WP-L8b; owner, 2026-10-20; lives.md "The strike ladder").
 *
 *   1st cut on record  -> a WARNING (the cut's notice) and the live cut;
 *   2nd cut and later  -> the right to broadcast SUSPENDED for 30 days from that cut;
 *   3 cuts on record   -> staff MAY WITHDRAW the right (`live_broadcast_withdrawals`) - a person's
 *                         decision, never written by the code.
 *
 * EVERYTHING HERE IS READ FROM DURABLE ROWS, NEVER FROM A FLAG A CLOCK CLEARS: the cuts on record are
 * `live_cuts` rows whose `"cutAt"` is inside the rolling window, a suspension is a cut row with a
 * high enough `strike` whose 30 days have not run, a withdrawal is a row. Every time is the
 * DATABASE's clock, so no instance's clock is compared with another's.
 *
 * Pure functions over an `EntityManager`, so the cut and the start (`LivesService`) and the
 * moderation queue (`ModerationService`) read ONE definition without a module cycle.
 */
import type { EntityManager } from 'typeorm';
import {
  LIVE_STRIKE_WINDOW_MS,
  LIVE_SUSPENSION_FROM_STRIKE,
  LIVE_SUSPENSION_MS,
  LIVE_WITHDRAWAL_FROM_CUTS,
} from './live.constants';

/** A member's standing with the right to broadcast. */
export interface LiveStanding {
  /** Their lives staff cut, still on record (the rolling {@link LIVE_STRIKE_WINDOW_MS}). */
  cutsOnRecord: number;
  /** When the latest running suspension ends, or null when none runs. */
  suspendedUntil: Date | null;
  /** When staff withdrew the right, or null when it is not withdrawn. */
  withdrawnAt: Date | null;
  /**
   * {@link LIVE_WITHDRAWAL_FROM_CUTS} cuts are on record and the right is not withdrawn: the
   * withdrawal is due, and it is a moderator's decision to take.
   */
  withdrawalDue: boolean;
}

/** What one recorded cut does to its broadcaster. */
export type LiveStrikeConsequence = 'warning' | 'suspended';

/** The consequence of a cut recorded at `strike` on its broadcaster's ladder. */
export function consequenceOf(strike: number): LiveStrikeConsequence {
  return strike >= LIVE_SUSPENSION_FROM_STRIKE ? 'suspended' : 'warning';
}

/**
 * SERIALISES EVERY CHANGE TO ONE ACCOUNT'S STANDING: a cut computing its strike, a start reading
 * the standing it is refused by, a withdrawal and its lift. A transaction-scoped advisory lock keyed
 * by the account, taken BEFORE any row lock by every caller, so two cuts of two lives of one
 * broadcaster never both count the other as absent, and a start never slips between a cut's count
 * and its commit.
 */
export async function lockStanding(manager: EntityManager, userId: string): Promise<void> {
  await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended('live_standing:' || $1, 0))`, [
    userId,
  ]);
}

/**
 * The broadcaster's OTHER cuts on record, `liveId`'s excepted - the count a new cut's strike is
 * 1 + of, and the `priorCuts` a moderator reads.
 */
export async function otherCutsOnRecord(
  manager: EntityManager,
  broadcasterId: string,
  liveId: string
): Promise<number> {
  const [{ n }]: { n: number }[] = await manager.query(
    `SELECT count(*)::int AS n FROM live_cuts
      WHERE "broadcasterId" = $1 AND "liveId" <> $2
        AND "cutAt" > now() - $3::float8 * interval '1 millisecond'`,
    [broadcasterId, liveId, LIVE_STRIKE_WINDOW_MS]
  );
  return n;
}

/** The standing of each account in `userIds` (every one present in the map, none skipped). */
export async function standingsOf(
  manager: EntityManager,
  userIds: readonly string[]
): Promise<Map<string, LiveStanding>> {
  const out = new Map<string, LiveStanding>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows: {
    userId: string;
    cutsOnRecord: number;
    suspendedUntil: Date | null;
    withdrawnAt: Date | null;
  }[] = await manager.query(
    `SELECT u.id AS "userId",
            (SELECT count(*)::int FROM live_cuts c
              WHERE c."broadcasterId" = u.id
                AND c."cutAt" > now() - $2::float8 * interval '1 millisecond') AS "cutsOnRecord",
            (SELECT max(c."cutAt" + $3::float8 * interval '1 millisecond') FROM live_cuts c
              WHERE c."broadcasterId" = u.id AND c.strike >= $4
                AND c."cutAt" + $3::float8 * interval '1 millisecond' > now()) AS "suspendedUntil",
            (SELECT w."withdrawnAt" FROM live_broadcast_withdrawals w
              WHERE w."userId" = u.id) AS "withdrawnAt"
       FROM unnest($1::varchar[]) AS u(id)`,
    [ids, LIVE_STRIKE_WINDOW_MS, LIVE_SUSPENSION_MS, LIVE_SUSPENSION_FROM_STRIKE]
  );
  for (const r of rows) {
    out.set(r.userId, {
      cutsOnRecord: r.cutsOnRecord,
      suspendedUntil: r.suspendedUntil,
      withdrawnAt: r.withdrawnAt,
      withdrawalDue: r.withdrawnAt === null && r.cutsOnRecord >= LIVE_WITHDRAWAL_FROM_CUTS,
    });
  }
  return out;
}

/** One account's standing ({@link standingsOf} for one id). */
export async function standingOf(manager: EntityManager, userId: string): Promise<LiveStanding> {
  return (await standingsOf(manager, [userId])).get(userId)!;
}
