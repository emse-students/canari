import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * How a new school mail reaches a phone that is not watching - the server's switch of mail lot 5
 * (owner, 2026-11-28; docs/wiki/mail-client-transport.md#as-built---lot-5).
 *
 * `platform_config.mail_push` is owned by core-service (migration `034_platform_config_mail_push.sql`,
 * edited at `/admin/platform` by a global admin) and READ here, straight out of the shared database,
 * exactly as `push-mode.ts` reads its column. The list is held together with the column's CHECK, core's
 * entity and the frontend by `mailPushModesAgree.test.ts`.
 *
 * - `none`: no server takes part. The alert hook pushes nothing and the subscription routes refuse.
 *   The default.
 * - `cloudflare`: the notice of the account's own filter rule, received by Cloudflare's Email Worker, becomes
 *   an EMPTY push to the account's subscribed devices.
 */
export type MailPush = 'none' | 'cloudflare';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const MAIL_PUSH_MODES: readonly MailPush[] = ['none', 'cloudflare'];

/** Whether this process has already accused a missing `platform_config` row. */
let missingRowAccused = false;

/**
 * The mode as the database holds it RIGHT NOW, read at every hook post and every subscription -
 * never cached, so turning the switch off holds from the next alert.
 *
 * Absent row: `none`, the value the row is CREATED with (the column's default), accused at ERROR once
 * per process. A value outside the two, and a failed query, THROW: the caller answers 503 and pushes
 * nothing - a value nobody can read is never guessed.
 */
export async function readMailPush(manager: EntityManager, logger: Logger): Promise<MailPush> {
  const rows: { mail_push?: unknown }[] = await manager.query(
    `SELECT mail_push FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    if (!missingRowAccused) {
      missingRowAccused = true;
      logger.error(
        '[MAIL_PUSH] platform_config row 1 is MISSING - mail_push read as none, the value the row is created with ' +
          '(has core-service booted against this database?); said once per process'
      );
    }
    return 'none';
  }
  const value = rows[0]?.mail_push;
  if (typeof value === 'string' && (MAIL_PUSH_MODES as readonly string[]).includes(value)) {
    return value as MailPush;
  }
  throw new Error(`platform_config.mail_push holds an unknown value: ${String(value)}`);
}

/** The mail tab's server switch (`platform_config.mail_mode`, core-service migration 033). */
export type MailMode = 'off' | 'on';

/**
 * `platform_config.mail_mode` as the database holds it RIGHT NOW: the alert hook pushes nothing while
 * the mail tab is off (no device may read a mailbox then). Absent row: `off`, the column's default.
 * A value outside the two, and a failed query, THROW - never guessed.
 */
export async function readMailMode(manager: EntityManager): Promise<MailMode> {
  const rows: { mail_mode?: unknown }[] = await manager.query(
    `SELECT mail_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) return 'off';
  const value = rows[0]?.mail_mode;
  if (value === 'off' || value === 'on') return value;
  throw new Error(`platform_config.mail_mode holds an unknown value: ${String(value)}`);
}
