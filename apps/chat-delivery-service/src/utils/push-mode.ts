import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * What an MLS push tells Google and Apple - the server's switch for the content-free wake-up push
 * (owner, 2026-11-02; docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 *
 * `platform_config.push_mode` is owned by core-service (migration `018_platform_config_push_mode.sql`,
 * edited at `/admin/platform` by a global admin) and READ here, straight out of the shared database,
 * exactly as `calls-mode.ts` reads its column. The two values are held together by the column's CHECK
 * constraint; core's `PushMode` type is the same list (`pushModesAgree.test.ts`).
 *
 * - `full`: every push carries what it always has (`buildPushDataFields`). The default.
 * - `wake`: a push to a device whose registration declared `wake: true` carries only
 *   `type`, `queuedMessageId` and `silent`; the device fetches the rest (`GET /mls/push/wake`).
 *   A device that did not declare it keeps getting `full` - its binary would drop a wake frame.
 */
export type PushMode = 'full' | 'wake';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const PUSH_MODES: readonly PushMode[] = ['full', 'wake'];

/**
 * The mode as the database holds it RIGHT NOW. Read for every push that has a wake-capable
 * destination, never cached: turning the switch off must hold from the next push.
 *
 * Absent row: `full`, which is the column's default - core creates the row at boot, so an absent row
 * is a database core-service has not started against yet. Logged at ERROR, apart from a real `full`:
 * a switch left at its default is a decision, a missing row is a defect. A value outside the two, and
 * a failed query, THROW: the caller does not send that device's push and its fan-out logs the error;
 * the frame stays queued and is delivered at the device's next open. A switch nobody can read is
 * never guessed in either direction.
 */
export async function readPushMode(manager: EntityManager, logger: Logger): Promise<PushMode> {
  const rows: { push_mode?: unknown }[] = await manager.query(
    `SELECT push_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    logger.error(
      '[PUSH_SEND] platform_config row 1 is MISSING - push_mode read as full (has core-service booted against this database?)'
    );
    return 'full';
  }
  const value = rows[0]?.push_mode;
  if (typeof value === 'string' && (PUSH_MODES as readonly string[]).includes(value)) {
    return value as PushMode;
  }
  throw new Error(`platform_config.push_mode holds an unknown value: ${String(value)}`);
}
