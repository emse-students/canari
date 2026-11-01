import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { MessagingService } from './messaging.service';
import { activeRevocationCutoff } from '../utils/revocation';
import { revokeDevice } from '../utils/revoke-device';
import { RETIRED_DEVICE_DAILY_BUDGET, RETIRED_DEVICE_LIFE_WINDOW_MS } from '../retention.constants';

/**
 * THE RETIRED-DEVICE REAPER - a device its owner REPLACED, revoked at the source (owner,
 * 2026-11-01: "Oui, la construire"; built OFF, activation owed to the owner).
 *
 * A device with no session and no push token keeps its active seats
 * (`dm_device_group_memberships`) and its key package, so every fan-out queues a row for it. Four
 * hand passes revoked that population through `DELETE /api/mls/devices/:userId/:deviceId`, and it
 * refilled each time. Deleting the rows alone is refilled within a day; the fix is to stop naming
 * the device as a destination, through the product's own revocation ({@link revokeDevice}) with
 * cause `retired`, which ends no session.
 *
 * **WHAT THE PREDICATE PROVES, AND WHAT IT DOES NOT** ({@link RETIRED_DEVICE_PREDICATE_SQL}). "No
 * session" and "no push token" prove nothing on their own: a session row dies after 7 idle days and
 * a web or desktop device never holds a push token. The device id's prefix has two values only,
 * `web` and `tauri`, so it cannot tell a desktop from a phone. And a key package's `createdAt` is
 * reset on every connection, so it dates the last connection, never an enrolment. So the predicate
 * proves a REPLACEMENT only from:
 *
 * - silence for {@link RETIRED_DEVICE_LIFE_WINDOW_MS} (90 days, the GC's own window), and
 * - a device of the same owner, same id prefix, same reported OS AND same device name, signed in
 *   now, whose ENROLMENT - its first published signature key, `device_signature_key.firstSeenAt`,
 *   a table nothing deletes - is later than this device's oldest undelivered row (and than this
 *   device's own first key, when it has one).
 *
 * **THE ENROLMENT DATE IS EXACT ONLY FOR A DEVICE ENROLLED AFTER MIGRATION 027** (2026-09-29): that
 * table has no backfill, so an older device's first row is its first upload after the migration,
 * which can be later than its real enrolment. A device whose name was never set (`deviceName` NULL)
 * is never proven replaced. Both limits are stated in `docs/wiki/services/chat-delivery.md`.
 *
 * **IDEMPOTENCE COMES FROM THE BAN ROW, NOT FROM A CLOCK**: a revoked device fails clause 3 forever,
 * and the daily budget is counted from the same rows - so a restart, a second replica or a run that
 * died half-way neither revokes anything twice nor spends the budget twice.
 */

/** The environment key of the reaper's switch, rendered per estate by `infrastructure/deploy/render-env.sh`. */
export const RETIRED_DEVICE_REAPER_ENV = 'RETIRED_DEVICE_REAPER';

/**
 * What the reaper does on its run:
 * - `off` - nothing; not a query is made, and the boot line is the only line. THE DEFAULT, and
 *   what both estates ship.
 * - `dry-run` - selects, lists each candidate and counts them, and writes nothing.
 * - `on` - revokes each candidate, within {@link RETIRED_DEVICE_DAILY_BUDGET} per rolling day.
 */
export type RetiredDeviceReaperMode = 'off' | 'dry-run' | 'on';

const MODES: readonly RetiredDeviceReaperMode[] = ['off', 'dry-run', 'on'];

/**
 * READS THE SWITCH, ONCE, AT BOOT. Unset or empty is `off`. Anything outside the three values
 * THROWS, so the service does not boot: a destructive control whose switch cannot be read is never
 * read as open, and a typo is not silently read as closed either.
 */
export function readRetiredDeviceReaperMode(
  raw: string | undefined,
  logger: Pick<Logger, 'log'>
): RetiredDeviceReaperMode {
  const value = raw?.trim() ?? '';
  const mode = (value === '' ? 'off' : value) as RetiredDeviceReaperMode;
  if (!MODES.includes(mode)) {
    throw new Error(
      `${RETIRED_DEVICE_REAPER_ENV} must be one of ${MODES.join(', ')}, got "${value}"`
    );
  }
  logger.log(`[RETIRED_REAPER] ${RETIRED_DEVICE_REAPER_ENV}=${mode}`);
  return mode;
}

/**
 * THE PREDICATE, AS ONE STATEMENT - a conjunction, each clause numbered as its fixtures are
 * (`retired-device-reaper.integration.spec.ts`). The population is every `(user, device)` that holds a
 * queued row AND a key package (the OS and name it reported are read from it). It qualifies when:
 *
 * 1. no `auth_sessions` row names the device - of any age, for any user;
 * 2. no `push_token` row names it;
 * 3. it is not revoked - no `revoked_device` row inside the ban window (`$2`);
 * 4. no life since `$1` (90 days): no queued frame it sent, no commit it sent, no key package and no
 *    one-time key package it published - its own key package's `createdAt` is its last connection;
 * 5. its owner has ANOTHER device that (a) has the same id prefix, (b) reported the same `deviceOs`
 *    and (c) the same non-NULL `deviceName` on its key package, (d) holds an unexpired session
 *    (`$3` is now), and (e) ENROLLED after this device stopped draining: its first
 *    `device_signature_key.firstSeenAt` is later than this device's oldest queued row and than this
 *    device's own first signature key, if it has one. No signature key for the other device: no
 *    proof, kept.
 *
 * `$4` is the limit. `$5`/`$6` restrict the statement to ONE device - the re-check right before its
 * revocation - and are NULL for the selection. `matched` is the count before the limit. The oldest
 * queues come first.
 */
export const RETIRED_DEVICE_PREDICATE_SQL = `
WITH queued AS (
  SELECT q."recipientId" AS "userId", q."deviceId" AS "deviceId",
         min(q."createdAt") AS "oldestQueuedAt", count(*)::int AS "queuedRows"
    FROM queued_message q
   WHERE ($5::varchar IS NULL OR (q."recipientId" = $5::varchar AND q."deviceId" = $6::varchar))
   GROUP BY q."recipientId", q."deviceId"
)
SELECT d."userId", d."deviceId", d."oldestQueuedAt", d."queuedRows",
       count(*) OVER ()::int AS "matched"
  FROM queued d
  JOIN key_package kd ON kd."userId" = d."userId" AND kd."deviceId" = d."deviceId"
 WHERE NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s."deviceId" = d."deviceId")
   AND NOT EXISTS (SELECT 1 FROM push_token t WHERE t."deviceId" = d."deviceId")
   AND NOT EXISTS (SELECT 1 FROM revoked_device r
                    WHERE r."userId" = d."userId" AND r."deviceId" = d."deviceId"
                      AND r."revokedAt" > $2)
   AND NOT EXISTS (SELECT 1 FROM queued_message o
                    WHERE o."senderDeviceId" = d."deviceId" AND o."createdAt" > $1)
   AND NOT EXISTS (SELECT 1 FROM mls_commit_log c
                    WHERE c."senderDeviceId" = d."deviceId" AND c."createdAt" > $1)
   AND NOT EXISTS (SELECT 1 FROM key_package k
                    WHERE k."deviceId" = d."deviceId" AND k."createdAt" > $1)
   AND NOT EXISTS (SELECT 1 FROM one_time_key_package p
                    WHERE p."deviceId" = d."deviceId" AND p."createdAt" > $1)
   AND EXISTS (
     SELECT 1
       FROM key_package k2
       JOIN auth_sessions s2
         ON s2."deviceId" = k2."deviceId" AND s2."userId" = k2."userId" AND s2."expiresAt" > $3
       JOIN LATERAL (SELECT min(e."firstSeenAt") AS "enrolledAt" FROM device_signature_key e
                      WHERE e."userId" = k2."userId" AND e."deviceId" = k2."deviceId") b ON true
      WHERE k2."userId" = d."userId" AND k2."deviceId" <> d."deviceId"
        AND split_part(k2."deviceId", '-', 1) = split_part(d."deviceId", '-', 1)
        AND k2."deviceOs" = kd."deviceOs"
        AND k2."deviceName" = kd."deviceName"
        AND b."enrolledAt" > d."oldestQueuedAt"
        AND b."enrolledAt" > COALESCE(
              (SELECT min(e2."firstSeenAt") FROM device_signature_key e2
                WHERE e2."userId" = d."userId" AND e2."deviceId" = d."deviceId"),
              '-infinity'::timestamp))
 ORDER BY d."oldestQueuedAt" ASC, d."userId" ASC, d."deviceId" ASC
 LIMIT $4`;

/**
 * The `retired` bans written in the last day (`$1` = now - 24 h): what the daily budget has spent.
 * Durable state, so a restart or a second replica reads the same number.
 */
export const RETIRED_BUDGET_SPENT_SQL = `
SELECT count(*)::int AS "spent" FROM revoked_device
 WHERE reason = 'retired' AND "revokedAt" > $1`;

/**
 * A session of the owner, created since the selection, that is not yet bound to a device
 * (`auth_sessions."deviceId"` is NULL until `bindDevice`): it may be the very device about to be
 * revoked signing in again, so the revocation waits for a later run.
 */
export const OWNER_UNBOUND_SESSION_SQL = `
SELECT 1 FROM auth_sessions
 WHERE "userId" = $1 AND "deviceId" IS NULL AND "createdAt" >= $2
 LIMIT 1`;

/** One device the predicate names. */
export interface RetiredDeviceCandidate {
  userId: string;
  deviceId: string;
  oldestQueuedAt: Date;
  queuedRows: number;
}

/** The selection: who, at most `limit` of them, and how many matched before the limit. */
export interface RetiredDeviceSelection {
  matched: number;
  candidates: RetiredDeviceCandidate[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Runs {@link RETIRED_DEVICE_PREDICATE_SQL}. Read-only: a dry run is this and nothing else.
 *
 * @param only restricts the statement to one device - the re-check right before a revocation
 */
export async function selectRetiredDevices(
  db: Pick<DataSource, 'query'>,
  opts: { now: number; limit: number; only?: { userId: string; deviceId: string } }
): Promise<RetiredDeviceSelection> {
  const rows = (await db.query(RETIRED_DEVICE_PREDICATE_SQL, [
    new Date(opts.now - RETIRED_DEVICE_LIFE_WINDOW_MS),
    activeRevocationCutoff(opts.now),
    new Date(opts.now),
    opts.limit,
    opts.only?.userId ?? null,
    opts.only?.deviceId ?? null,
  ])) as Array<RetiredDeviceCandidate & { matched: number }>;
  return {
    matched: rows[0]?.matched ?? 0,
    candidates: rows.map(({ userId, deviceId, oldestQueuedAt, queuedRows }) => ({
      userId,
      deviceId,
      oldestQueuedAt,
      queuedRows,
    })),
  };
}

/** How much of the daily budget is left, read from the `retired` bans of the last 24 hours. */
export async function remainingDailyBudget(
  db: Pick<DataSource, 'query'>,
  now: number,
  budget: number
): Promise<number> {
  const rows = (await db.query(RETIRED_BUDGET_SPENT_SQL, [new Date(now - DAY_MS)])) as Array<{
    spent: number;
  }>;
  return Math.max(0, budget - (rows[0]?.spent ?? 0));
}

/** What one run did - also its summary line. */
export interface RetiredDeviceReaperRun {
  mode: RetiredDeviceReaperMode;
  matched: number;
  revoked: number;
  /** Selected, then not revoked at the re-check: no longer matching, or an owner signing in. */
  skipped: number;
  failed: number;
  queuedMessagesDeleted: number;
  /** Budget left when the run started. */
  budgetLeft: number;
}

/**
 * ONE RUN OF THE REAPER, in the given mode.
 *
 * `on`: the selection is limited to what is left of the DAILY budget. Each candidate is then
 * re-checked right before it is revoked - the same predicate restricted to it, no session of its
 * owner created since the selection that is not yet bound to a device, and the budget read again -
 * and revoked through {@link revokeDevice} with cause `retired`. Each device has its own `try`: one
 * failure is logged at ERROR and the run goes on.
 *
 * **THE RE-CHECK NARROWS THE RACE, IT DOES NOT CLOSE IT.** It and the revocation are not one
 * transaction, and a sign-in between the two (or one whose session is never bound to a device id)
 * is not seen. Such a device is refused `DEVICE_REVOKED` + `retired` and enrols again under a fresh
 * id - its history comes back from peers, not from its purged queue.
 *
 * The summary line ACCUSES (WARN) whenever the run revoked anything or the candidates exceeded the
 * budget, and is an ERROR when a revocation failed.
 */
export async function runRetiredDeviceReaper(deps: {
  mode: RetiredDeviceReaperMode;
  db: Pick<DataSource, 'query'>;
  messaging: Pick<MessagingService, 'purgeDeviceFootprint' | 'notifyDeviceRevoked'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  now?: () => number;
  budget?: number;
}): Promise<RetiredDeviceReaperRun> {
  const { mode, db, messaging, logger } = deps;
  const now = deps.now ?? Date.now;
  const budget = deps.budget ?? RETIRED_DEVICE_DAILY_BUDGET;
  const run: RetiredDeviceReaperRun = {
    mode,
    matched: 0,
    revoked: 0,
    skipped: 0,
    failed: 0,
    queuedMessagesDeleted: 0,
    budgetLeft: 0,
  };
  // Off is silent: the boot line already says so.
  if (mode === 'off') return run;

  run.budgetLeft = await remainingDailyBudget(db, now(), budget);

  if (mode === 'dry-run') {
    // A dry run lists up to one full budget, whatever has been spent, so the owner sees a day's worth.
    const selection = await selectRetiredDevices(db, { now: now(), limit: budget });
    run.matched = selection.matched;
    for (const c of selection.candidates) {
      logger.log(
        `[RETIRED_REAPER] would revoke user=${c.userId} device=${c.deviceId} ` +
          `oldestQueued=${new Date(c.oldestQueuedAt).toISOString()} queuedRows=${c.queuedRows}`
      );
    }
    const line =
      `[RETIRED_REAPER] mode=dry-run matched=${run.matched} listed=${selection.candidates.length} ` +
      `budget=${budget} budgetLeft=${run.budgetLeft} - nothing written`;
    if (run.matched > budget) logger.warn(`${line}; MORE THAN ONE DAY'S BUDGET matches`);
    else logger.log(line);
    return run;
  }

  if (run.budgetLeft === 0) {
    logger.warn(
      `[RETIRED_REAPER] mode=on daily budget of ${budget} spent - nothing selected until it frees`
    );
    return run;
  }

  const selectedAt = new Date(now());
  const selection = await selectRetiredDevices(db, {
    now: selectedAt.getTime(),
    limit: run.budgetLeft,
  });
  run.matched = selection.matched;

  for (const c of selection.candidates) {
    try {
      if ((await remainingDailyBudget(db, now(), budget)) === 0) {
        run.skipped += 1;
        logger.warn(
          `[RETIRED_REAPER] kept user=${c.userId} device=${c.deviceId}: the daily budget was spent meanwhile`
        );
        continue;
      }
      const recheck = await selectRetiredDevices(db, {
        now: now(),
        limit: 1,
        only: { userId: c.userId, deviceId: c.deviceId },
      });
      if (recheck.candidates.length === 0) {
        run.skipped += 1;
        logger.log(
          `[RETIRED_REAPER] kept user=${c.userId} device=${c.deviceId}: no longer matches at the re-check`
        );
        continue;
      }
      const unbound = (await db.query(OWNER_UNBOUND_SESSION_SQL, [
        c.userId,
        selectedAt,
      ])) as unknown[];
      if (unbound.length > 0) {
        run.skipped += 1;
        logger.log(
          `[RETIRED_REAPER] kept user=${c.userId} device=${c.deviceId}: the owner signed in since the selection and the session names no device yet`
        );
        continue;
      }
      const { purge, recordedReason, signalled } = await revokeDevice(
        messaging,
        db,
        c.userId,
        c.deviceId,
        'retired'
      );
      run.revoked += 1;
      run.queuedMessagesDeleted += purge.queuedMessagesDeleted;
      logger.log(
        `[RETIRED_REAPER] revoked user=${c.userId} device=${c.deviceId} reason=${recordedReason} ` +
          `oldestQueued=${new Date(c.oldestQueuedAt).toISOString()} groupsCleaned=${purge.groupsCleaned} ` +
          `keyPackagesDeleted=${purge.keyPackagesDeleted} oneTimeKeyPackagesDeleted=${purge.oneTimeKeyPackagesDeleted} ` +
          `queuedMessagesDeleted=${purge.queuedMessagesDeleted} signalled=${signalled}`
      );
    } catch (e) {
      run.failed += 1;
      logger.error(
        `[RETIRED_REAPER] FAILED to revoke user=${c.userId} device=${c.deviceId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }

  const summary =
    `[RETIRED_REAPER] mode=on matched=${run.matched} budgetLeft=${run.budgetLeft} revoked=${run.revoked} ` +
    `skipped=${run.skipped} failed=${run.failed} queuedMessagesDeleted=${run.queuedMessagesDeleted}`;
  if (run.failed > 0) logger.error(summary);
  else if (run.revoked > 0 || run.matched > run.budgetLeft) logger.warn(summary);
  else logger.log(summary);
  return run;
}
