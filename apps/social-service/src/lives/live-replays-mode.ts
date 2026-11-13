import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Whether a live started now keeps a three-day replay (docs/wiki/live-replays.md, WP-R1).
 *
 * `platform_config.live_replays_mode` is owned by core-service (migration
 * `021_platform_config_live_replays_mode.sql`, moved at `/admin/platform` by a global admin) and READ
 * here, straight out of the shared database, as `lives-mode.ts` reads `lives_mode`. It is read ONCE,
 * at a live's start, and the answer is fixed on the row (`lives."keepsReplay"`, migration 156): a flip
 * mid-live never makes half a replay, and a flip back to `off` deletes no replay already published.
 *
 * - `off`: the live keeps its newest 20 segments and is deleted at its end, as always.
 * - `on`: the live keeps its last three hours and its end publishes a replay post.
 */
export type LiveReplaysMode = 'off' | 'on';

/** The two values, the same list as the column's CHECK (asserted across every copy). */
export const LIVE_REPLAYS_MODES: readonly LiveReplaysMode[] = ['off', 'on'];

/**
 * The mode as the database holds it RIGHT NOW, read inside the start's transaction.
 *
 * An absent row reads as `off`, the column's default, logged at ERROR apart from a real `off`: core
 * creates the row at boot, so its absence is a defect, and keeping no replay is the safe direction
 * for a retention switch. A value outside the two is a defect the CHECK forbids and THROWS, as does a
 * failed query: the start answers 500 rather than keep media under a value nobody can read. Read
 * BEFORE the start's transaction, so a refusal here aborts nothing.
 */
export async function readLiveReplaysMode(
  manager: EntityManager,
  logger: Logger
): Promise<LiveReplaysMode> {
  const rows: { live_replays_mode?: unknown }[] = await manager.query(
    `SELECT live_replays_mode FROM platform_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    logger.error(
      '[LIVE_REPLAY] platform_config row 1 is MISSING - live replays read as off (has core-service booted against this database?)'
    );
    return 'off';
  }
  const value = rows[0]?.live_replays_mode;
  if (typeof value === 'string' && (LIVE_REPLAYS_MODES as readonly string[]).includes(value)) {
    return value as LiveReplaysMode;
  }
  throw new Error(`platform_config.live_replays_mode holds an unknown value: ${String(value)}`);
}
