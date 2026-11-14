/**
 * THE RETENTION DURATIONS AS THE CLIENT READS THEM (owner, 2026-11-14: "the privacy policy renders the
 * values in force from the same source, so they can never disagree"; docs/wiki/retention-settings.md).
 *
 * The values are the server's: `GET /api/version` publishes `retention` from `platform_config`
 * (core migration 025), the same columns social-service and media-service read when they stamp the
 * expiry of a new item. The privacy policy and the live texts render them.
 *
 * {@link RETENTION_DEFAULTS} is the value each column is CREATED with - the one the code applied before
 * the setting existed - and is what a page shows only when no server answer was ever read on this
 * device (first launch offline, or a server older than the field), saying so
 * ({@link retentionInForce}). `retentionSettingsAgree.test.ts` holds it to the migration.
 */
/** The durations, in days, as `/api/version`'s `retention` carries them. */
export interface RetentionDays {
  /** A feed CanaReel, from its publication. */
  reelDays: number;
  /** A live replay, from the live's end. */
  liveReplayDays: number;
  /** A CanaReel sent in a conversation, from its upload. */
  chatReelDays: number;
  /** A file sent in a conversation, from its last download. */
  idleMediaDays: number;
}

/** The value each column is created with (core migration 025). */
export const RETENTION_DEFAULTS: Readonly<RetentionDays> = {
  reelDays: 365,
  liveReplayDays: 3,
  chatReelDays: 30,
  idleMediaDays: 90,
};

const KEYS = Object.keys(RETENTION_DEFAULTS) as (keyof RetentionDays)[];

/**
 * Each duration as the admin route names it (`retention*Days`), the column's bounds (its CHECK in core
 * migration 025, also core's DTO) - what `/admin/platform` offers. Held to the migration by
 * `retentionSettingsAgree.test.ts`.
 */
export const RETENTION_ADMIN_SETTINGS = [
  { key: 'retentionReelDays', publicKey: 'reelDays', minDays: 1, maxDays: 3650 },
  { key: 'retentionLiveReplayDays', publicKey: 'liveReplayDays', minDays: 1, maxDays: 365 },
  { key: 'retentionChatReelDays', publicKey: 'chatReelDays', minDays: 1, maxDays: 365 },
  { key: 'retentionIdleMediaDays', publicKey: 'idleMediaDays', minDays: 1, maxDays: 3650 },
] as const satisfies readonly {
  key: string;
  publicKey: keyof RetentionDays;
  minDays: number;
  maxDays: number;
}[];

/** The name of one retention setting, as the admin route spells it. */
export type RetentionAdminKey = (typeof RETENTION_ADMIN_SETTINGS)[number]['key'];

/**
 * The `retention` object of a `/api/version` body, or `null` when it is absent (a server older than
 * the setting) or any of the four is not a positive whole number - never a partial object, so a page
 * never mixes a served value with a default.
 */
export function parseRetention(raw: unknown): RetentionDays | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const days = {} as RetentionDays;
  for (const key of KEYS) {
    const value = obj[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
    days[key] = value;
  }
  return days;
}

/** Where the durations a page shows came from. */
export type RetentionSource = 'server' | 'defaults';

/**
 * The durations to show: the server's when this session has read them (live, or the cached
 * `/api/version` answer), else {@link RETENTION_DEFAULTS} with `source: 'defaults'`, which the caller
 * says on the page. Pure - it runs inside a `$derived` - so the caller logs the fallback once.
 */
export function retentionInForce(served: RetentionDays | null): {
  days: RetentionDays;
  source: RetentionSource;
} {
  if (served) return { days: served, source: 'server' };
  return { days: { ...RETENTION_DEFAULTS }, source: 'defaults' };
}
