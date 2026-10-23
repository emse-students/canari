import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Whether an estate lets lives answer - the server's RUNTIME kill switch (owner, 2026-10-21).
 *
 * `platform_config.lives_mode` is owned by core-service (migration `015_platform_config_lives_mode.sql`,
 * edited at `/admin/platform` by a global admin) and READ here, straight out of `auth_db`, as
 * chat-delivery's `calls-mode.ts` reads `calls_mode`: the switch has to be enforced where a live is
 * served, and an internal HTTP hop to core would cost a round trip on every live request. The two
 * values are held together by the column's CHECK constraint; core's `LivesMode` type is the same list.
 *
 * - `off`: every live route answers 404, the answer of the `LIVE_ENABLED` deploy lock.
 * - `on`: the live routes answer, PROVIDED `LIVE_ENABLED` is on as well - the two are ANDed.
 */
export type LivesMode = 'off' | 'on';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const LIVES_MODES: readonly LivesMode[] = ['off', 'on'];

/**
 * The mode as the database holds it RIGHT NOW. Read on every live request, never cached: a kill
 * must hold from the next request, not from the next cache expiry. The cost is one primary-key read
 * of a one-row table per request.
 *
 * Absent row: `off`, the column's default - core creates the row at boot, so an absent row is a
 * database core-service has not started against yet, and no live may answer on it. Logged at ERROR,
 * apart from a real `off`: a closed switch is a decision, a missing row is a defect. A value outside
 * the two is a defect (the CHECK forbids it) and THROWS, as does a failed query: the request answers
 * 500 and nothing live is served - the safe direction for a kill switch.
 */
export async function readLivesMode(manager: EntityManager, logger: Logger): Promise<LivesMode> {
  const rows: { lives_mode?: unknown }[] = await manager.query(
    `SELECT lives_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    logger.error(
      '[LIVE] platform_config row 1 is MISSING - lives read as off (has core-service booted against this database?)'
    );
    return 'off';
  }
  const value = rows[0]?.lives_mode;
  if (typeof value === 'string' && (LIVES_MODES as readonly string[]).includes(value)) {
    return value as LivesMode;
  }
  throw new Error(`platform_config.lives_mode holds an unknown value: ${String(value)}`);
}
