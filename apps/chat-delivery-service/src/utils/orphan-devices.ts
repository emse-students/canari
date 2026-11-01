import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ORPHAN_DEVICE_WARN_COUNT, RETENTION_WINDOW_MS } from '../retention.constants';
import { activeRevocationCutoff } from './revocation';

/**
 * ORPHAN DEVICES, COUNTED - the population the stale-device GC does not reach.
 *
 * An orphan device holds queued rows but has no `auth_sessions` row and no `push_token`, and is not
 * revoked: nothing can drain its queue, and while it keeps active seats every fan-out adds to it.
 * The hourly `detectStaleDevices` and `cleanupStaleDevices` collect a device whose key package (its
 * last connection) is older than {@link RETENTION_WINDOW_MS}; an orphan that connected inside that
 * window is NOT theirs, and that is the population four hand passes revoked through
 * `DELETE /api/mls/devices/:userId/:deviceId` (the procedure is in
 * `docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md`).
 *
 * A reaper for it was built and closed unmerged (#2880, owner, 2026-11-01): at the GC's 90 days it
 * was pre-empted by the GC, and no durable fact the server holds proves that a device inside them
 * was REPLACED rather than merely closed. So this is a REPORT and nothing else: it deletes nothing,
 * revokes nothing, and exists so a regrowth is seen the day it starts rather than found by hand.
 *
 * `$1` is the ban cutoff ({@link activeRevocationCutoff}), `$2` the GC's cutoff (now - 90 days).
 * `insideGcWindow` counts the orphans whose key package is younger than the GC's window - the ones
 * nothing else will ever collect.
 */
export const ORPHAN_DEVICES_SQL = `
WITH orphan AS (
  SELECT q."recipientId" AS "userId", q."deviceId" AS "deviceId", count(*)::int AS "rows"
    FROM queued_message q
   GROUP BY q."recipientId", q."deviceId"
  HAVING NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = q."deviceId")
     AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = q."deviceId")
     AND NOT EXISTS (SELECT 1 FROM revoked_device r
                      WHERE r."userId" = q."recipientId" AND r."deviceId" = q."deviceId"
                        AND r."revokedAt" > $1)
)
SELECT count(*)::int AS "devices",
       COALESCE(sum(o."rows"), 0)::int AS "rows",
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM key_package k
                                       WHERE k."userId" = o."userId" AND k."deviceId" = o."deviceId"
                                         AND k."createdAt" >= $2))::int AS "insideGcWindow"
  FROM orphan o`;

/** The day's count. */
export interface OrphanDeviceCount {
  devices: number;
  rows: number;
  insideGcWindow: number;
}

/**
 * Counts the orphan devices and prints ONE line: at WARN when the count exceeds
 * {@link ORPHAN_DEVICE_WARN_COUNT}, the smallest population a hand pass was ever run on; plainly
 * otherwise, every day, because the plain line is the regrowth-rate measurement nobody has yet.
 * Read-only.
 */
export async function reportOrphanDevices(
  db: Pick<DataSource, 'query'>,
  logger: Pick<Logger, 'log' | 'warn'>,
  now: number = Date.now()
): Promise<OrphanDeviceCount> {
  const rows = (await db.query(ORPHAN_DEVICES_SQL, [
    activeRevocationCutoff(now),
    new Date(now - RETENTION_WINDOW_MS),
  ])) as OrphanDeviceCount[];
  const count: OrphanDeviceCount = {
    devices: rows[0]?.devices ?? 0,
    rows: rows[0]?.rows ?? 0,
    insideGcWindow: rows[0]?.insideGcWindow ?? 0,
  };
  const line =
    `[ORPHAN_DEVICES] devices=${count.devices} rows=${count.rows} insideGcWindow=${count.insideGcWindow} ` +
    `warnAbove=${ORPHAN_DEVICE_WARN_COUNT} - queued rows, no session, no push token, not revoked`;
  if (count.devices > ORPHAN_DEVICE_WARN_COUNT) {
    logger.warn(
      `${line}; MORE than the smallest population a hand pass was run on - see the hand procedure in prod-queue-and-epoch-audit-2026-10-12.md`
    );
  } else {
    logger.log(line);
  }
  return count;
}
