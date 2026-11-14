/**
 * WHAT IS A CANAREEL - the one classifier on the client (owner, 2026-11-14): **"Toute vidéo verticale
 * et/ou inférieure à 90 s est un CanaReel, y compris depuis la galerie"** - a VERTICAL video (up to
 * `maxVerticalDurationMs`) or a SHORT one (up to `maxDurationMs`, any frame, drawn with bars), whether
 * it was filmed in the CanaReels tab or imported from the gallery into a post composer; only a long
 * landscape or square video stays an ordinary post video.
 *
 * The numbers are the server's (`GET /api/posts/reel-limits`: `rule`, `maxDurationMs`,
 * `maxVerticalDurationMs`, `maxAspectRatio`), the same ones `assertCreateKindShape` refuses a declared
 * reel against, so a client never carries a copy that could drift from the door. "Vertical" is
 * `width / height <= maxAspectRatio` (4:5) on the PREPARED file's frame, rotation baked in by
 * `prepareVideoForUpload` ([reels (server)](docs/wiki/services/reels.md#the-rule-what-is-a-canareel)).
 *
 * THE VERSION-SKEW GATE: the OR applies only when the server serves `rule: 'vertical-or-short'`. A
 * server older than 2026-11-14 serves no `rule` and refuses a landscape reel, so against it this
 * client keeps the rule of 2026-11-09 - vertical AND 90 s or less - which both doors accept.
 *
 * A post that carries something a reel cannot (a poll, an attached form, a linked event, a schedule,
 * another attachment) stays a post whatever its video is: the server refuses each on a reel, and the
 * member chose them.
 */
import type { CreatePostPayload, ReelLimits } from '$lib/posts/api';
import { durationLabel } from '$lib/legal/retentionLabel';
import { m } from '$lib/paraglide/messages';
import { VIDEO_DURATION_GRACE_SECONDS } from '$lib/video/prepareVideoForUpload';

/** The numbers the rule reads, as the server served them. */
export interface ReelRule {
  /** A SHORT video: a reel whatever its frame under the OR rule, the whole cap under the AND rule. */
  maxDurationMs: number;
  maxAspectRatio: number;
  /**
   * The longest VERTICAL reel - present only when the server applies `'vertical-or-short'` (the
   * version-skew gate): absent, the rule is the 2026-11-09 one, vertical AND short.
   */
  maxVerticalDurationMs?: number;
}

/**
 * The rule from a `reel-limits` answer, or `null` when the server serves no `maxAspectRatio` - an
 * estate older than the rule, which neither refuses a landscape reel nor knows the composer's video
 * may be one: the caller then keeps the behaviour that estate was built for, and says so.
 */
export function reelRuleOf(
  limits: Pick<ReelLimits, 'maxDurationMs' | 'maxAspectRatio' | 'rule' | 'maxVerticalDurationMs'>
): ReelRule | null {
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
  const { rule, maxVerticalDurationMs } = limits;
  if (rule !== 'vertical-or-short') {
    console.debug(
      `[reel-rule] the server applies vertical AND ${maxDurationMs} ms (rule=${String(rule)}): an estate older than 2026-11-14`
    );
    return { maxDurationMs, maxAspectRatio };
  }
  if (
    typeof maxVerticalDurationMs !== 'number' ||
    !Number.isFinite(maxVerticalDurationMs) ||
    maxVerticalDurationMs < maxDurationMs
  ) {
    // The server names the OR rule but no usable vertical cap: the AND rule is still one its door
    // accepts, so the client keeps it - and the line accuses the server's answer.
    console.error(
      `[reel-rule] rule=vertical-or-short served without a usable maxVerticalDurationMs (${String(maxVerticalDurationMs)}): applying vertical AND short`
    );
    return { maxDurationMs, maxAspectRatio };
  }
  return { maxDurationMs, maxAspectRatio, maxVerticalDurationMs };
}

/**
 * The longest a video of this frame may be and still be a reel, or `null` when no length makes it
 * one (a landscape or square video under the 2026-11-09 rule). `vertical` is `isReelFrame`'s answer.
 */
export function reelCapForFrame(rule: ReelRule, vertical: boolean): number | null {
  if (vertical) return rule.maxVerticalDurationMs ?? rule.maxDurationMs;
  return rule.maxVerticalDurationMs === undefined ? null : rule.maxDurationMs;
}

/** The longest any reel may be under this rule: the cap a gallery pick is prepared under. */
export function longestReelMs(rule: ReelRule): number {
  return rule.maxVerticalDurationMs ?? rule.maxDurationMs;
}

/**
 * The sentence a composer shows above a video that will be published as a CanaReel: the rule as
 * the server applies it, and the lifetime in force.
 */
export function reelRuleNotice(rule: ReelRule, retentionDays: number): string {
  const seconds = Math.round(rule.maxDurationMs / 1000);
  const lifetime = durationLabel(retentionDays);
  return rule.maxVerticalDurationMs === undefined
    ? m.reels_publish_from_composer_notice({ seconds, lifetime })
    : m.reels_publish_rule_vertical_or_short_notice({ seconds, lifetime });
}

/** A gallery pick the CanaReels camera refuses, and why - or `null` when it is taken. */
export type ReelPickRefusal =
  | { reason: 'too-long'; capMs: number }
  | { reason: 'vertical-too-long'; capMs: number }
  | { reason: 'not-vertical' }
  | { reason: 'long-landscape'; shortMs: number };

/**
 * Whether the CanaReels camera takes a video picked from the gallery, read on what the engine
 * DISPLAYED (`readVideoMetadata`; a `null` is a value it could not read). A length or a frame that
 * could not be read never refuses alone: the publish reads the PREPARED file, the one the server is
 * told, and decides there (`publishReel`).
 *
 * `capMs` is the destination's cap (`captureCapMs`): the chat cap for a take sent in a conversation,
 * which keeps the 2026-11-09 rule (vertical AND within the cap), and the feed's `maxDurationMs`
 * otherwise. `rule` null is an estate older than the vertical rule: the cap alone.
 *
 * A CONVERSATION REFUSES A FRAME IT CANNOT READ (review of #3528, 2026-11-14): the chat rule demands
 * vertical, and a frame not read is not proven vertical - no later step re-reads it for a chat, so
 * letting it through would send whatever it is. The feed lets it through, its publish deciding.
 */
export function reelPickRefusal(
  picked: { durationMs: number | null; width: number | null; height: number | null },
  rule: ReelRule | null,
  capMs: number,
  destination: 'feed' | 'chat'
): ReelPickRefusal | null {
  const { durationMs, width, height } = picked;
  const frameKnown = width !== null && height !== null;
  const vertical =
    rule !== null && frameKnown && isReelFrame(width ?? undefined, height ?? undefined, rule);
  if (!rule || rule.maxVerticalDurationMs === undefined || destination === 'chat') {
    if (durationMs !== null && durationMs > capMs) return { reason: 'too-long', capMs };
    if (rule && !vertical && (frameKnown || destination === 'chat')) {
      return { reason: 'not-vertical' };
    }
    return null;
  }
  if (durationMs === null) return null;
  if (frameKnown && !vertical) {
    return durationMs > rule.maxDurationMs
      ? { reason: 'long-landscape', shortMs: rule.maxDurationMs }
      : null;
  }
  // Vertical, or a frame the engine could not read: the longest any reel may be.
  return durationMs > rule.maxVerticalDurationMs
    ? { reason: 'vertical-too-long', capMs: rule.maxVerticalDurationMs }
    : null;
}

/** The toast a refused pick shows. */
export function reelPickRefusalText(refusal: ReelPickRefusal): string {
  switch (refusal.reason) {
    case 'too-long':
      return m.reels_capture_too_long({ seconds: Math.round(refusal.capMs / 1000) });
    case 'vertical-too-long':
      return m.reels_capture_too_long_minutes({ minutes: Math.round(refusal.capMs / 60_000) });
    case 'not-vertical':
      return m.reels_capture_not_vertical();
    case 'long-landscape':
      return m.reels_capture_long_landscape({ seconds: Math.round(refusal.shortMs / 1000) });
  }
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

/**
 * THE ONE DECISION ON A LENGTH, for every path that makes a reel - the CanaReels camera's publish
 * (`publishReel`) and the composer's queue (`reelDeclarationFor`) - so a take of one length is a reel
 * on both or on neither (review of #3528, 2026-11-14): the length the reel DECLARES, in whole ms
 * within `[1, capMs]`, or `null` when it is not a reel (no length, none above zero, no cap for its
 * frame, or past the cap's grace).
 *
 * The grace is `prepareVideoForUpload`'s half second (`VIDEO_DURATION_GRACE_SECONDS`): a recorder
 * told to stop at the cap writes a container ending a few hundredths later. That clip IS a reel of
 * the cap's length, and the server refuses a declaration over the cap, so it declares the cap.
 */
export function reelDeclaredDurationMs(
  durationMs: number | undefined,
  capMs: number | null
): number | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0)
    return null;
  if (capMs === null || durationMs > capMs + VIDEO_DURATION_GRACE_SECONDS * 1000) return null;
  const ms = Math.round(durationMs);
  if (ms > capMs) {
    console.debug(`[reel-rule] ${ms} ms is within the grace; declared as ${capMs}`);
  }
  return Math.min(capMs, Math.max(1, ms));
}

/** The length `video` declares as a reel under `rule`, or `null` when it is not one. */
function reelDeclaredDurationOf(video: ReelVideoShape, rule: ReelRule): number | null {
  const cap = reelCapForFrame(rule, isReelFrame(video.width, video.height, rule));
  return reelDeclaredDurationMs(video.durationMs, cap);
}

/**
 * Whether ONE video, on its own, is a CanaReel: a length within its frame's cap and its grace
 * (`reelCapForFrame`, `reelDeclaredDurationMs`) - vertical or short under the OR rule, vertical and
 * short under the older one.
 */
export function isReelVideo(video: ReelVideoShape, rule: ReelRule): boolean {
  return reelDeclaredDurationOf(video, rule) !== null;
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
  const durationMs = reelDeclaredDurationOf(video, rule);
  return durationMs === null ? null : { kind: 'reel', durationMs };
}

/**
 * A reel's lifetime as a member reads it: "1 an" for the year (365 days), "{n} jours" otherwise - the
 * server's `retentionDays` is the number, this only words it.
 */
export function reelLifetimeLabel(days: number): string {
  return durationLabel(days);
}
