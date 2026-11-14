/**
 * THE RETENTION DURATIONS A GLOBAL ADMIN SETS (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * One entry per duration: the `platform_config` column that holds it (migration 025), the value the
 * column is created with - the one the code applied before the setting existed - and the bounds the
 * column's CHECK and the admin DTO both refuse beyond. The list is the ONE copy core holds; the
 * readers in social-service and media-service and the frontend's privacy policy are held to it by
 * `retentionSettingsAgree.test.ts`.
 *
 * READ AT CREATION, NEVER AT THE SWEEP: each service stamps the expiry of a new item from the value in
 * force, so a lowered duration applies to new content only - nothing already stored moves.
 */
export const RETENTION_SETTINGS = [
  {
    key: 'retentionReelDays',
    column: 'retention_reel_days',
    defaultDays: 365,
    minDays: 1,
    maxDays: 3650,
  },
  {
    key: 'retentionLiveReplayDays',
    column: 'retention_live_replay_days',
    defaultDays: 3,
    minDays: 1,
    maxDays: 365,
  },
  {
    key: 'retentionChatReelDays',
    column: 'retention_chat_reel_days',
    defaultDays: 30,
    minDays: 1,
    maxDays: 365,
  },
  {
    key: 'retentionIdleMediaDays',
    column: 'retention_idle_media_days',
    defaultDays: 90,
    minDays: 1,
    maxDays: 3650,
  },
] as const;

/** The name of one retention setting, as the admin API and `PlatformConfigPublic` spell it. */
export type RetentionKey = (typeof RETENTION_SETTINGS)[number]['key'];

/** Every retention duration, in days, as the platform holds it now. */
export type RetentionDays = Record<RetentionKey, number>;

/**
 * The durations as `GET /api/version` publishes them (`retention`), named for the reader: the privacy
 * policy renders them, and media-service's relay and social-service read the same columns.
 */
export type PublicRetention = {
  reelDays: number;
  liveReplayDays: number;
  chatReelDays: number;
  idleMediaDays: number;
};

/** The public shape of {@link RetentionDays}. */
export function publicRetention(days: RetentionDays): PublicRetention {
  return {
    reelDays: days.retentionReelDays,
    liveReplayDays: days.retentionLiveReplayDays,
    chatReelDays: days.retentionChatReelDays,
    idleMediaDays: days.retentionIdleMediaDays,
  };
}
