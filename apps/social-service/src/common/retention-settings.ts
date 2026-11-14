import type { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * The retention durations a global admin sets (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * `platform_config.retention_*` is owned by core-service (migration
 * `025_platform_config_retention.sql`, moved at `/admin/platform`) and READ here, straight out of the
 * shared database, as `live-replays-mode.ts` reads its column. Read at the CREATION of an item - a
 * reel's publication, a replay's end - and stamped into its `expiresAt`, so a lowered duration applies
 * to new content only. Never cached: a change holds from the next creation.
 *
 * The four columns and their defaults are core's `RETENTION_SETTINGS`; this list is held to it by the
 * frontend's `retentionSettingsAgree.test.ts`.
 */
export type RetentionDays = {
  reelDays: number;
  liveReplayDays: number;
  chatReelDays: number;
  idleMediaDays: number;
};

/** Each duration, the column that holds it and the value the column is created with. */
export const RETENTION_COLUMNS = [
  { key: 'reelDays', column: 'retention_reel_days', defaultDays: 365 },
  { key: 'liveReplayDays', column: 'retention_live_replay_days', defaultDays: 3 },
  { key: 'chatReelDays', column: 'retention_chat_reel_days', defaultDays: 30 },
  { key: 'idleMediaDays', column: 'retention_idle_media_days', defaultDays: 90 },
] as const satisfies readonly { key: keyof RetentionDays; column: string; defaultDays: number }[];

/** Whether this process has already accused a missing `platform_config` row. */
let missingRowAccused = false;

/**
 * The durations as the database holds them RIGHT NOW.
 *
 * Absent row: the values the row is CREATED with (the columns' defaults, core's `DEFAULT_ROW`), which
 * is not a guess - core creates the row at boot, so an absent row is a database core has not started
 * against yet and nobody has moved a duration. Accused at ERROR ONCE PER PROCESS (`[RETENTION]`), the
 * push-mode precedent: the defect is one fact about the database. A value that is not a positive
 * integer, and a failed query, THROW: the creation fails rather than stamp an expiry nobody can read.
 */
export async function readRetentionDays(
  manager: EntityManager,
  logger: Logger
): Promise<RetentionDays> {
  const rows: Record<string, unknown>[] = await manager.query(
    `SELECT ${RETENTION_COLUMNS.map((c) => c.column).join(', ')} FROM platform_config WHERE id = 1 LIMIT 1`
  );
  const row = rows[0];
  if (!row) {
    if (!missingRowAccused) {
      missingRowAccused = true;
      logger.error(
        '[RETENTION] platform_config row 1 is MISSING - the retention durations read as the values the row is created with ' +
          '(has core-service booted against this database?); said once per process'
      );
    }
    return Object.fromEntries(
      RETENTION_COLUMNS.map((c) => [c.key, c.defaultDays])
    ) as RetentionDays;
  }
  const days = {} as RetentionDays;
  for (const { key, column } of RETENTION_COLUMNS) {
    const value = row[column];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`platform_config.${column} holds an unusable value: ${String(value)}`);
    }
    days[key] = value;
  }
  logger.debug(
    `[RETENTION] read ${RETENTION_COLUMNS.map((c) => `${c.key}=${days[c.key]}`).join(' ')}`
  );
  return days;
}
