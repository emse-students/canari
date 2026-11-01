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

/** How long a reel lives - decision C6. Applied ONCE, at creation, into `posts.expiresAt`. */
export const REEL_RETENTION_DAYS = 30;

/** How far ahead of `expiresAt` `my-reels` says a reel is about to expire (save-to-gallery offer). */
export const REEL_EXPIRY_WARNING_DAYS = 7;

/** The two kinds a `posts` row can be. */
export type PostKind = 'post' | 'reel';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a loaded post is a reel past its expiry - one the worker has not reached yet.
 *
 * Every read EXCLUDES such a reel in SQL; this is the same rule for the paths that load an entity
 * (`getById`, a reaction, a comment, a link preview), so a dead reel is as unreachable by id as it
 * is in the feed. `now` is a parameter so a test never asserts a wall clock.
 */
export function isExpiredReel(
  post: { kind?: PostKind | null; expiresAt?: Date | string | null },
  now: number = Date.now()
): boolean {
  if (post.kind !== 'reel' || !post.expiresAt) return false;
  return new Date(post.expiresAt).getTime() <= now;
}

/** The numbers as the API serves them. */
export function reelLimits(): {
  maxDurationMs: number;
  chatMaxDurationMs: number;
  chatReelMaxTargets: number;
  retentionDays: number;
  warningWindowDays: number;
} {
  return {
    maxDurationMs: REEL_MAX_DURATION_MS,
    chatMaxDurationMs: CHAT_REEL_MAX_DURATION_MS,
    chatReelMaxTargets: CHAT_REEL_MAX_TARGETS,
    retentionDays: REEL_RETENTION_DAYS,
    warningWindowDays: REEL_EXPIRY_WARNING_DAYS,
  };
}
