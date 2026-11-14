/**
 * CanaReels' three numbers, each the ONE copy.
 *
 * Clients carry none of them: `GET /api/posts/reel-limits` publishes them, because an installed
 * APK keeps whatever it was built with and nothing keeps that in step with the box (the same
 * argument as `GET /api/media/limits`). See docs/wiki/services/reels.md.
 */

/** The longest reel, in milliseconds - decision C4. Declared by the client, refused above this. */
export const REEL_MAX_DURATION_MS = 90_000;

/**
 * The longest reel SENT IN A CONVERSATION, in milliseconds - the user's D-size decision of
 * 2026-10-09. A published reel stays at {@link REEL_MAX_DURATION_MS}. Served as
 * `chatMaxDurationMs`, so no client carries it (docs/wiki/frontend/modules/reels-in-chat.md).
 */
export const CHAT_REEL_MAX_DURATION_MS = 60_000;

/**
 * How many conversations one press of "Envoyer à..." may send a take to (reels-in-chat 15.2): each
 * target is one MLS or Graine send, and the whole press shares ONE file under one chat hold. Served
 * as `chatReelMaxTargets`, so the sheet refuses the next tick with a sentence and no client carries
 * the number.
 */
export const CHAT_REEL_MAX_TARGETS = 15;

/**
 * How long a reel lived when the lifetime became an admin setting: ONE YEAR (owner, 2026-11-09,
 * replacing C6's month). Since 2026-11-14 the value IN FORCE is `platform_config.retention_reel_days`
 * (core migration 025, created at this value), read at each publication and applied ONCE into
 * `posts.expiresAt` (`common/retention-settings.ts`); this constant is the year migration 158 moved
 * the earlier reels to, and nothing reads it to stamp a new reel.
 */
export const REEL_RETENTION_DAYS = 365;

/**
 * The widest frame a reel may have, as `width / height` after rotation: 4:5 (owner, 2026-11-09,
 * "every VERTICAL video of 90 s or less is a CanaReel"). Vertical means taller than wide by at least
 * Instagram's tallest feed format: 9:16 (0.5625, a phone held upright), 3:4 (0.75, the iOS system
 * camera's medium quality) and 4:5 (0.8) are reels; a square, a near-square crop and anything
 * landscape stay ordinary post videos. Served as `maxAspectRatio`, so no client carries it
 * (docs/wiki/services/reels.md#the-rule-what-is-a-canareel-owner-2026-11-09).
 */
export const REEL_MAX_ASPECT_RATIO = 4 / 5;

/** How far ahead of `expiresAt` `my-reels` says a reel is about to expire (save-to-gallery offer). */
export const REEL_EXPIRY_WARNING_DAYS = 7;

/** The two kinds a client may publish or filter a list by. */
export type PostKind = 'post' | 'reel';

/**
 * Every kind a `posts` row can be: the two a client publishes, and `replay` - a finished live kept
 * three days, created by social-service itself at the live's end and never by a client
 * (docs/wiki/live-replays.md, migration 156's `posts_kind_shape`).
 */
export type StoredPostKind = PostKind | 'replay';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a frame of `width` x `height` (after rotation, as the prepared file declares it) is vertical
 * enough to be a reel: both positive and `width / height <= REEL_MAX_ASPECT_RATIO`. A frame with no
 * dimensions is not one - the rule cannot be read on it.
 */
export function isReelFrame(width: unknown, height: unknown): boolean {
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width / height <= REEL_MAX_ASPECT_RATIO;
}

/**
 * Whether a loaded post is past its expiry - a reel past its lifetime or a replay past its three days
 * (`posts."expiresAt"`, NULL on a post that never expires) - one the worker has not reached yet.
 *
 * Every read EXCLUDES such a row in SQL; this is the same rule for the paths that load an entity
 * (`getById`, a reaction, a comment, a link preview), so a dead reel or replay is as unreachable by id
 * as it is in the feed. `now` is a parameter so a test never asserts a wall clock.
 */
export function isExpiredPost(
  post: { kind?: StoredPostKind | null; expiresAt?: Date | string | null },
  now: number = Date.now()
): boolean {
  // The kinds that expire, named: a row of any other kind is never read as dead.
  if ((post.kind !== 'reel' && post.kind !== 'replay') || !post.expiresAt) return false;
  return new Date(post.expiresAt).getTime() <= now;
}

/**
 * The numbers as the API serves them. `retentionDays` is the lifetime IN FORCE (the admin setting),
 * which the caller reads from `platform_config` - never a constant a later setting would contradict.
 */
export function reelLimits(retentionDays: number): {
  maxDurationMs: number;
  chatMaxDurationMs: number;
  chatReelMaxTargets: number;
  maxAspectRatio: number;
  retentionDays: number;
  warningWindowDays: number;
} {
  return {
    maxDurationMs: REEL_MAX_DURATION_MS,
    maxAspectRatio: REEL_MAX_ASPECT_RATIO,
    chatMaxDurationMs: CHAT_REEL_MAX_DURATION_MS,
    chatReelMaxTargets: CHAT_REEL_MAX_TARGETS,
    retentionDays,
    warningWindowDays: REEL_EXPIRY_WARNING_DAYS,
  };
}
