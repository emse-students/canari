/**
 * WHAT IS A CANAREEL - the one classifier on the client (owner, 2026-11-09): **every VERTICAL video of
 * 90 s or less is a CanaReel**, whether it was filmed in the CanaReels tab or imported from the gallery
 * into a post composer; every other video (landscape, square, longer) stays an ordinary post video.
 *
 * The numbers are the server's (`GET /api/posts/reel-limits`: `maxDurationMs`, `maxAspectRatio`), the
 * same ones `assertCreateKindShape` refuses a declared reel against, so a client never carries a copy
 * that could drift from the door. "Vertical" is `width / height <= maxAspectRatio` (4:5) on the
 * PREPARED file's frame, rotation baked in by `prepareVideoForUpload`
 * ([reels (server)](docs/wiki/services/reels.md#the-rule-what-is-a-canareel-owner-2026-11-09)).
 *
 * A post that carries something a reel cannot (a poll, an attached form, a linked event, a schedule,
 * another attachment) stays a post whatever its video is: the server refuses each on a reel, and the
 * member chose them.
 */
import type { CreatePostPayload, ReelLimits } from '$lib/posts/api';
import { durationLabel } from '$lib/legal/retentionLabel';

/** The two numbers the rule reads, as the server served them. */
export interface ReelRule {
  maxDurationMs: number;
  maxAspectRatio: number;
}

/**
 * The rule from a `reel-limits` answer, or `null` when the server serves no `maxAspectRatio` - an
 * estate older than the rule, which neither refuses a landscape reel nor knows the composer's video
 * may be one: the caller then keeps the behaviour that estate was built for, and says so.
 */
export function reelRuleOf(limits: Pick<ReelLimits, 'maxDurationMs' | 'maxAspectRatio'>) {
  const { maxDurationMs, maxAspectRatio } = limits;
  if (
    typeof maxAspectRatio !== 'number' ||
    !Number.isFinite(maxAspectRatio) ||
    maxAspectRatio <= 0 ||
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs <= 0
  ) {
    console.warn(
      `[reel-rule] the server serves no usable vertical rule (maxAspectRatio=${String(maxAspectRatio)}): an estate older than 2026-11-09`
    );
    return null;
  }
  return { maxDurationMs, maxAspectRatio } satisfies ReelRule;
}

/** Whether a frame is vertical enough to be a reel; a frame with no dimensions is not one. */
export function isReelFrame(
  width: number | undefined,
  height: number | undefined,
  rule: Pick<ReelRule, 'maxAspectRatio'>
): boolean {
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return width / height <= rule.maxAspectRatio;
}

/** One video as the rule reads it: its prepared frame and its length in whole ms. */
export interface ReelVideoShape {
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Whether ONE video, on its own, is a CanaReel: vertical and 1 ms to `maxDurationMs` long. */
export function isReelVideo(video: ReelVideoShape, rule: ReelRule): boolean {
  const { durationMs } = video;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return false;
  if (durationMs < 1 || durationMs > rule.maxDurationMs) return false;
  return isReelFrame(video.width, video.height, rule);
}

const present = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';

/** A media of a post about to be created, with what preparing it told (a video's length). */
export interface ClassifiedMedia extends ReelVideoShape {
  /** `'video'` or a `video/*` type: the rule reads videos only. */
  type: string;
}

/**
 * What a new post must declare to be published as the rule says: `{ kind: 'reel', durationMs }` when
 * its ONLY content is one video that is a CanaReel (a caption is fine), `null` when it is a post.
 */
export function reelDeclarationFor(
  payload: Pick<
    CreatePostPayload,
    'polls' | 'attachedFormId' | 'linkedCalendarEventId' | 'scheduledAt' | 'kind'
  >,
  media: readonly ClassifiedMedia[],
  rule: ReelRule
): { kind: 'reel'; durationMs: number } | null {
  if (media.length !== 1) return null;
  const [video] = media;
  if (video.type !== 'video' && !video.type.startsWith('video/')) return null;
  const carries = (
    ['polls', 'attachedFormId', 'linkedCalendarEventId', 'scheduledAt'] as const
  ).find((field) => present(payload[field]));
  if (carries) {
    console.debug(`[reel-rule] the post carries ${carries}: it stays a post`);
    return null;
  }
  if (!isReelVideo(video, rule)) return null;
  return { kind: 'reel', durationMs: Math.round(video.durationMs!) };
}

/**
 * A reel's lifetime as a member reads it: "1 an" for the year (365 days), "{n} jours" otherwise - the
 * server's `retentionDays` is the number, this only words it.
 */
export function reelLifetimeLabel(days: number): string {
  return durationLabel(days);
}
