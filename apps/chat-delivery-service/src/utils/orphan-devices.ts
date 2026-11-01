import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { RETENTION_WINDOW_MS } from '../retention.constants';
import { activeRevocationCutoff } from './revocation';

/**
 * ORPHAN DEVICES - the population the stale-device GC does not reach, defined ONCE.
 *
 * An orphan device holds queued rows but has no `auth_sessions` row and no `push_token`, is not
 * revoked, and showed no life in the last {@link ORPHAN_LIFE_WINDOW_MS}: nothing can drain its queue,
 * and while it keeps active seats every fan-out adds to it. The hourly `detectStaleDevices` and
 * `cleanupStaleDevices` collect a device whose key package (its last connection) is older than
 * {@link RETENTION_WINDOW_MS}; an orphan that connected inside that window is NOT theirs.
 *
 * A reaper for it was built and closed unmerged (#2880, owner, 2026-11-01): at the GC's 90 days it
 * was pre-empted by the GC, and no durable fact the server holds proves that a device inside them
 * was REPLACED rather than merely closed. So the count below is a REPORT, and the cleanup is a hand
 * procedure (`docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md`) that selects with
 * {@link ORPHAN_DEVICE_LIST_SQL} and re-checks each device with {@link ORPHAN_DEVICE_RECHECK_SQL} -
 * the same predicate as the count, so what the report counts is what a pass would revoke.
 *
 * THE LIFE CLAUSES, and their weight. A key package or one-time key package published, or a commit
 * logged, inside the window is durable evidence: those rows outlive their delivery. A frame SENT is
 * weak evidence - a queued row is deleted once delivered, so a device whose frames were all fetched
 * leaves no trace in `queued_message` - and is kept only because it costs nothing.
 *
 * SHAPE. `queued_message` is grouped FIRST, in its own CTE, and every other table is tested against
 * those grouped rows in a `WHERE ... NOT EXISTS`, which the planner turns into hash anti-joins: one
 * scan of each table, not one per group. `auth_sessions."deviceId"` has no index and `push_token`'s
 * is `(userId, deviceId)`; a correlated `NOT EXISTS` inside `HAVING` would scan both per group.
 * No index is added for a daily report.
 *
 * Parameters: `$1` the ban cutoff ({@link activeRevocationCutoff}), `$2` the life cutoff
 * (now - {@link ORPHAN_LIFE_WINDOW_MS}); `scope` may use `$3` and `$4`.
 */
const orphanCte = (scope: string) => `
WITH queued AS (
  SELECT q."recipientId" AS "userId", q."deviceId" AS "deviceId", count(*)::int AS "rows"
    FROM queued_message q${scope}
   GROUP BY q."recipientId", q."deviceId"
), orphan AS (
  SELECT g."userId", g."deviceId", g."rows"
    FROM queued g
   WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = g."deviceId")
     AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = g."deviceId")
     AND NOT EXISTS (SELECT 1 FROM revoked_device r
                      WHERE r."userId" = g."userId" AND r."deviceId" = g."deviceId"
                        AND r."revokedAt" > $1)
     AND NOT EXISTS (SELECT 1 FROM key_package k
                      WHERE k."userId" = g."userId" AND k."deviceId" = g."deviceId"
                        AND k."createdAt" > $2)
     AND NOT EXISTS (SELECT 1 FROM one_time_key_package o
                      WHERE o."userId" = g."userId" AND o."deviceId" = g."deviceId"
                        AND o."createdAt" > $2)
     AND NOT EXISTS (SELECT 1 FROM mls_commit_log c
                      WHERE c."senderDeviceId" = g."deviceId" AND c."createdAt" > $2)
     AND NOT EXISTS (SELECT 1 FROM queued_message m
                      WHERE m."senderDeviceId" = g."deviceId" AND m."createdAt" > $2)
)`;

/** How recent a sign of life keeps a device out of the orphans: 7 days. */
export const ORPHAN_LIFE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The daily count. `$3` is the GC's cutoff (now - 90 days): `insideGcWindow` counts the orphans
 * whose key package is younger than it - the ones nothing else will ever collect.
 */
export const ORPHAN_DEVICES_SQL = `${orphanCte('')}
SELECT count(*)::int AS "devices",
       COALESCE(sum(o."rows"), 0)::int AS "rows",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM key_package k
                                       WHERE k."userId" = o."userId" AND k."deviceId" = o."deviceId"
                                         AND k."createdAt" >= $3))::int AS "insideGcWindow"
  FROM orphan o`;

/** The hand procedure's allowlist (step 1): one row per orphan device. Parameters `$1`, `$2`. */
export const ORPHAN_DEVICE_LIST_SQL = `${orphanCte('')}
SELECT o."userId", o."deviceId", o."rows" FROM orphan o ORDER BY o."userId", o."deviceId"`;

/**
 * The hand procedure's re-check of ONE device right before its revoke call (step 4): `1` while it is
 * still an orphan, `0` once it is not. `$3` the user id, `$4` the device id.
 */
export const ORPHAN_DEVICE_RECHECK_SQL = `${orphanCte(
  `\n   WHERE q."recipientId" = $3 AND q."deviceId" = $4`
)}
SELECT count(*)::int AS "orphan" FROM orphan o`;

/** The parameters every one of the three statements starts with: `[ban cutoff, life cutoff]`. */
export function orphanDeviceParams(now: number = Date.now()): [Date, Date] {
  return [activeRevocationCutoff(now), new Date(now - ORPHAN_LIFE_WINDOW_MS)];
}

/** The day's count. */
export interface OrphanDeviceCount {
  devices: number;
  rows: number;
  insideGcWindow: number;
}

/**
 * Counts the orphan devices and prints ONE plain line. There is no threshold yet: no regrowth rate
 * has been measured, and a number not derived from one would be a guess - these daily lines ARE that
 * measurement. Every replica runs it, so one line per replica a day is expected. Read-only.
 */
export async function reportOrphanDevices(
  db: Pick<DataSource, 'query'>,
  logger: Pick<Logger, 'log'>,
  now: number = Date.now()
): Promise<OrphanDeviceCount> {
  const rows = (await db.query(ORPHAN_DEVICES_SQL, [
    ...orphanDeviceParams(now),
    new Date(now - RETENTION_WINDOW_MS),
  ])) as OrphanDeviceCount[];
  const count: OrphanDeviceCount = {
    devices: rows[0]?.devices ?? 0,
    rows: rows[0]?.rows ?? 0,
    insideGcWindow: rows[0]?.insideGcWindow ?? 0,
  };
  logger.log(
    `[ORPHAN_DEVICES] devices=${count.devices} rows=${count.rows} insideGcWindow=${count.insideGcWindow} ` +
      `- queued rows, no session, no push token, not revoked, no life in 7 days`
  );
  return count;
}
