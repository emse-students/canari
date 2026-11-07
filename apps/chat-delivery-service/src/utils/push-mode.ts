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
 * - `wake`: a push to a device whose registration declared the matching wake version
 *   ({@link MLS_WAKE_VERSION} for an MLS frame, {@link ENVELOPE_WAKE_VERSION} for a
 *   `sendPushToUser` push) carries only `type`, its key and `silent`; the device fetches the rest
 *   (`GET /mls/push/wake`). A device below that version keeps getting `full` - its binary would drop
 *   the wake (docs/wiki/protocols/content-free-push.md).
 */
export type PushMode = 'full' | 'wake';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const PUSH_MODES: readonly PushMode[] = ['full', 'wake'];

/**
 * The wake a binary understands, as its registration declares it (`push_token.wakeVersion`,
 * migration 046). Cumulative: a binary at {@link ENVELOPE_WAKE_VERSION} understands the MLS wake too.
 *
 * - {@link MLS_WAKE_VERSION}: an MLS frame may be sent as a wake (`queuedMessageId`) - step 1.
 * - {@link ENVELOPE_WAKE_VERSION}: a `sendPushToUser` push may be too (`envelopeId`) - WP-W3.
 */
export const MLS_WAKE_VERSION = 1;
/** See {@link MLS_WAKE_VERSION}. The highest version this server serves. */
export const ENVELOPE_WAKE_VERSION = 2;

/**
 * The wake version this server may act on for one registration: `wakeVersion`, but only while
 * `wakeCapable` agrees - and 0 otherwise.
 *
 * Until `wakeCapable` is dropped (WP-W3c) the row can be written by a server that does not know
 * `wakeVersion`: an old replica still serving during a rotation, or a rollback to a release before
 * 046, writes `wakeCapable` from the body (false for a binary that does not say `wake: true`, a
 * downgraded one included) and leaves `wakeVersion` as the last new server set it. The two then
 * disagree, and only `wakeCapable` was written by the latest registration. Reading 0 there sends the
 * full push - the contract every binary understands - until the next registration on a new server
 * writes both again. Remove with `wakeCapable` (docs/wiki/legacy-compatibility.md).
 */
export function effectiveWakeVersion(token: { wakeVersion: number; wakeCapable: boolean }): number {
  return token.wakeCapable ? token.wakeVersion : 0;
}

/**
 * The wake version a registration declares, from its body.
 *
 * - `wakeVersion`, an integer from 0 up: the declaration of a binary that knows versions. A version
 *   above the highest this server serves is stored as that highest, because versions are cumulative
 *   (a future binary understands everything below it) - a newer app against an older server is
 *   woken for what the server can send, never for what it cannot.
 * - otherwise `wake: true` is version 1: the declaration every binary of step 1 sends (#2918) - a
 *   shim with its removal condition in docs/wiki/legacy-compatibility.md.
 * - anything else, an absent field included, is 0 - a build that predates the wake, or a downgrade,
 *   is never sent a frame it would drop. `malformed` says the body tried and failed, so the
 *   registration can accuse it.
 */
export function parseWakeVersion(body: { wake?: unknown; wakeVersion?: unknown }): {
  version: number;
  malformed: boolean;
} {
  const declared = body.wakeVersion;
  if (declared !== undefined) {
    if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) {
      return { version: Math.min(declared, ENVELOPE_WAKE_VERSION), malformed: false };
    }
    return { version: 0, malformed: true };
  }
  return { version: body.wake === true ? MLS_WAKE_VERSION : 0, malformed: false };
}

/** Whether this process has already accused a missing `platform_config` row (see `readPushMode`). */
let missingRowAccused = false;

/**
 * The mode as the database holds it RIGHT NOW. Read for every push that has a wake-capable
 * destination, never cached: turning the switch off must hold from the next push.
 *
 * Absent row: `full`, and that is not a guess - it is the value the row is CREATED with (the
 * column's `DEFAULT 'full'`, and core's `DEFAULT_ROW`), and core creates the row at boot, so an
 * absent row is a database core-service has not started against yet and the switch has never been
 * moved. Accused at ERROR ONCE PER PROCESS (`[PUSH_MODE]`), never once per push: the defect is one
 * fact about the database, and a line per push would bury it. A value outside the two, and a failed
 * query, THROW: the caller does not send that device's push and its fan-out logs the error; the
 * frame stays queued and is delivered at the device's next open. A value nobody can read is never
 * guessed in either direction.
 */
export async function readPushMode(manager: EntityManager, logger: Logger): Promise<PushMode> {
  const rows: { push_mode?: unknown }[] = await manager.query(
    `SELECT push_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    if (!missingRowAccused) {
      missingRowAccused = true;
      logger.error(
        '[PUSH_MODE] platform_config row 1 is MISSING - push_mode read as full, the value the row is created with ' +
          '(has core-service booted against this database?); said once per process'
      );
    }
    return 'full';
  }
  const value = rows[0]?.push_mode;
  if (typeof value === 'string' && (PUSH_MODES as readonly string[]).includes(value)) {
    return value as PushMode;
  }
  throw new Error(`platform_config.push_mode holds an unknown value: ${String(value)}`);
}
