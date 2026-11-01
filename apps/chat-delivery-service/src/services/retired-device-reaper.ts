import type { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { MessagingService } from './messaging.service';
import { activeRevocationCutoff } from '../utils/revocation';
import { revokeDevice } from '../utils/revoke-device';
import { RETIRED_DEVICE_LIFE_WINDOW_MS, RETIRED_DEVICE_REAP_CAP } from '../retention.constants';

/**
 * THE RETIRED-DEVICE REAPER - a device nobody can reach any more, revoked at the source (owner,
 * 2026-11-01: "Oui, la construire"; built OFF, activation owed to the owner).
 *
 * A device with no session and no push token keeps its active seats
 * (`dm_device_group_memberships`) and its key package, so every fan-out queues a row for it forever:
 * the hand passes of 2026-10-12, 2026-10-24 and 2026-11-01 (286 devices) revoked that population
 * through `DELETE /api/mls/devices/:userId/:deviceId`, and it refilled each time. Deleting the rows
 * alone is refilled within a day; the fix is to stop naming the device as a destination, through the
 * product's own revocation ({@link revokeDevice}) with cause `retired`, which ends no session.
 *
 * **THE SELECTION IS AN ALLOWLIST** ({@link RETIRED_DEVICE_PREDICATE_SQL}): a device is revoked only
 * when every clause PROVES it is replaced, never because something about it is merely old - age alone
 * cannot tell "replaced" from "offline" (`prod-queue-and-epoch-audit-2026-10-12.md`, section 6).
 *
 * **IDEMPOTENCE COMES FROM THE BAN ROW, NOT FROM A CLOCK**: a revoked device fails clause 3 forever,
 * so a second run, a second replica or a run that crashed half-way revokes nothing twice. The daily
 * interval decides only how soon a newly replaced device is collected.
 */

/** The environment key of the reaper's switch, a literal row of `infrastructure/deploy/env-manifest.tsv`. */
export const RETIRED_DEVICE_REAPER_ENV = 'RETIRED_DEVICE_REAPER';

/**
 * What the reaper does on its run:
 * - `off` - nothing; not a query is made. THE DEFAULT, and what both estates ship.
 * - `dry-run` - selects, lists each candidate and counts them, and writes nothing.
 * - `on` - revokes each candidate, at most {@link RETIRED_DEVICE_REAP_CAP} per run.
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
 * THE PREDICATE, AS ONE STATEMENT - a conjunction, each clause numbered as its test is
 * (`retired-device-reaper.integration.spec.ts`). The population is every `(user, device)` that holds a
 * queued row; a device qualifies when ALL of these hold:
 *
 * 1. it has no `auth_sessions` row - of any age, for any user: an expired row still present keeps it;
 * 2. it has no `push_token` row;
 * 3. it is not revoked - no `revoked_device` row inside the ban window (`$2`), the one reading of
 *    "is this device banned" ({@link activeRevocationCutoff});
 * 4. it showed no life since `$1` ({@link RETIRED_DEVICE_LIFE_WINDOW_MS}): no queued frame it sent,
 *    no commit it sent, no key package and no one-time key package it published;
 * 5. its owner has ANOTHER device of the SAME platform (the device id's prefix: `web`, `tauri`,
 *    `ios`) that holds an UNEXPIRED session (`$3` is now) and a key package NEWER than this device's
 *    oldest queued row - proof that the owner moved on after this device stopped draining.
 *
 * `$4` is the cap. `$5`/`$6` restrict the statement to ONE device - the re-check right before its
 * revocation - and are NULL for the selection. `matched` is the count before the cap. The oldest
 * queues come first, so a capped run takes the longest-abandoned devices.
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
   AND EXISTS (SELECT 1 FROM key_package k2
                 JOIN auth_sessions s2
                   ON s2."deviceId" = k2."deviceId" AND s2."userId" = k2."userId"
                  AND s2."expiresAt" > $3
                WHERE k2."userId" = d."userId" AND k2."deviceId" <> d."deviceId"
                  AND split_part(k2."deviceId", '-', 1) = split_part(d."deviceId", '-', 1)
                  AND k2."createdAt" > d."oldestQueuedAt")
 ORDER BY d."oldestQueuedAt" ASC, d."userId" ASC, d."deviceId" ASC
 LIMIT $4`;

/** One device the predicate names. */
export interface RetiredDeviceCandidate {
  userId: string;
  deviceId: string;
  oldestQueuedAt: Date;
  queuedRows: number;
}

/** The selection: who, at most `cap` of them, and how many matched before the cap. */
export interface RetiredDeviceSelection {
  matched: number;
  candidates: RetiredDeviceCandidate[];
}

/**
 * Runs {@link RETIRED_DEVICE_PREDICATE_SQL}. Read-only: a dry run is this and nothing else.
 *
 * @param only restricts the statement to one device - the re-check right before a revocation
 */
export async function selectRetiredDevices(
  db: Pick<DataSource, 'query'>,
  opts: { now: number; cap: number; only?: { userId: string; deviceId: string } }
): Promise<RetiredDeviceSelection> {
  const rows = (await db.query(RETIRED_DEVICE_PREDICATE_SQL, [
    new Date(opts.now - RETIRED_DEVICE_LIFE_WINDOW_MS),
    activeRevocationCutoff(opts.now),
    new Date(opts.now),
    opts.cap,
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

/** What one run did - also its summary line. */
export interface RetiredDeviceReaperRun {
  mode: RetiredDeviceReaperMode;
  matched: number;
  revoked: number;
  /** Selected, then no longer matching at the re-check (a sign-in, a ban by another run). */
  skipped: number;
  failed: number;
  queuedMessagesDeleted: number;
}

/**
 * ONE RUN OF THE REAPER, in the given mode.
 *
 * `on`: each candidate is RE-CHECKED against the same predicate right before it is revoked - the
 * selection may be minutes old, and a destructive repair is gated on the state being broken NOW -
 * then revoked through {@link revokeDevice} with cause `retired`. Each device has its own `try`: one
 * failure is logged at ERROR and the run goes on. The summary line ACCUSES (WARN) whenever the run
 * revoked anything or matched more than the cap, and is an ERROR when a revocation failed: a
 * mechanism that revokes devices is never silent about having done so.
 */
export async function runRetiredDeviceReaper(deps: {
  mode: RetiredDeviceReaperMode;
  db: Pick<DataSource, 'query'>;
  messaging: Pick<MessagingService, 'purgeDeviceFootprint' | 'notifyDeviceRevoked'>;
  logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  now?: () => number;
  cap?: number;
}): Promise<RetiredDeviceReaperRun> {
  const { mode, db, messaging, logger } = deps;
  const now = deps.now ?? Date.now;
  const cap = deps.cap ?? RETIRED_DEVICE_REAP_CAP;
  const run: RetiredDeviceReaperRun = {
    mode,
    matched: 0,
    revoked: 0,
    skipped: 0,
    failed: 0,
    queuedMessagesDeleted: 0,
  };
  // Off is silent: the boot line already says so, and a daily line restating it is noise.
  if (mode === 'off') return run;

  const selection = await selectRetiredDevices(db, { now: now(), cap });
  run.matched = selection.matched;

  if (mode === 'dry-run') {
    for (const c of selection.candidates) {
      logger.log(
        `[RETIRED_REAPER] would revoke user=${c.userId} device=${c.deviceId} ` +
          `oldestQueued=${new Date(c.oldestQueuedAt).toISOString()} queuedRows=${c.queuedRows}`
      );
    }
    const line =
      `[RETIRED_REAPER] mode=dry-run matched=${run.matched} listed=${selection.candidates.length} ` +
      `cap=${cap} - nothing written`;
    if (run.matched > cap) logger.warn(`${line}; MORE THAN ONE RUN'S CAP matches`);
    else logger.log(line);
    return run;
  }

  for (const c of selection.candidates) {
    try {
      const recheck = await selectRetiredDevices(db, {
        now: now(),
        cap: 1,
        only: { userId: c.userId, deviceId: c.deviceId },
      });
      if (recheck.candidates.length === 0) {
        run.skipped += 1;
        logger.log(
          `[RETIRED_REAPER] kept user=${c.userId} device=${c.deviceId}: no longer matches at the re-check`
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
    `[RETIRED_REAPER] mode=on matched=${run.matched} cap=${cap} revoked=${run.revoked} ` +
    `skipped=${run.skipped} failed=${run.failed} queuedMessagesDeleted=${run.queuedMessagesDeleted}`;
  if (run.failed > 0) logger.error(summary);
  else if (run.revoked > 0 || run.matched > cap) logger.warn(summary);
  else logger.log(summary);
  return run;
}
