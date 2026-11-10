/**
 * THE PURE HALF OF A LIVE REPLAY (docs/wiki/live-replays.md): where a seek lands on the segment list,
 * the time left before the three days are up, the size a save announces, and which part of a save a
 * segment belongs to. No DOM, no clock, no network: the player, the card and the save feed it and
 * read the answer.
 */
import type { LiveReplaySegment } from './types';
import type { PostEntity } from '$lib/posts/api';

/** Whether a feed row is a live replay (`kind = 'replay'`): drawn full screen like a reel, from segments. */
export function isReplay(post: Pick<PostEntity, 'kind'>): boolean {
  return post.kind === 'replay';
}

/**
 * The position in `segments` (ascending by `atMs`) of the LAST segment whose `atMs` is at or before
 * `ms` - the join logic of a seek: that segment is self-contained (its init, then one fragment), so
 * it can start the picture. Clamped: a target before the first is the first, past the last is the
 * last. `-1` for an empty list, so a caller can never index into nothing.
 */
export function segmentPositionAt(segments: readonly LiveReplaySegment[], ms: number): number {
  if (segments.length === 0) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segments[mid].atMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The time left of a replay, in the coarsest unit that is not zero: `day`, `hour` or `minute`. */
export type ReplayTimeLeft = { unit: 'day' | 'hour' | 'minute'; count: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The time before `expiresAt`, against `serverNow` - BOTH the database's clock (the replay route
 * says them together), so a phone with a skewed clock draws the right number. Rounded DOWN to a whole
 * unit and never zero while time remains ("1 minute" is the floor); `null` once it is up or when
 * either stamp does not parse - the caller then shows no number rather than a guessed one.
 */
export function replayTimeLeft(expiresAt: string, serverNow: string): ReplayTimeLeft | null {
  const left = Date.parse(expiresAt) - Date.parse(serverNow);
  if (!Number.isFinite(left) || left <= 0) return null;
  if (left >= DAY_MS) return { unit: 'day', count: Math.floor(left / DAY_MS) };
  if (left >= HOUR_MS) return { unit: 'hour', count: Math.floor(left / HOUR_MS) };
  return { unit: 'minute', count: Math.max(1, Math.floor(left / MINUTE_MS)) };
}

/**
 * A replay row's COVER as the preview loader takes it (`loadLivePoster`): its live's last preview,
 * keyed by the LIVE's id - the memo the live's own card used - or null when the row names none
 * (the live stored no preview, or a server older than covers). The server serves it on the row.
 */
export function replayCoverOf(
  post: Pick<PostEntity, 'liveId' | 'poster' | 'posterKey'>
): { id: string; poster: { name: string; ageMs: number }; posterKey: string } | null {
  if (!post.liveId || !post.poster || !post.posterKey) return null;
  return { id: post.liveId, poster: post.poster, posterKey: post.posterKey };
}

/** What a save will write, said BEFORE it starts (20 minutes is about 300 MB): the segments' bytes, in whole MB. */
export function replaySaveMegabytes(segments: readonly Pick<LiveReplaySegment, 'bytes'>[]): number {
  const bytes = segments.reduce((n, s) => n + s.bytes, 0);
  return Math.max(1, Math.round(bytes / 1_000_000));
}

/**
 * The file name of a saved replay: its day, a short post id, and its part (the second part of a save
 * that crossed a changed init is `-2`; the first carries no number).
 */
export function replayFileName(postId: string, publishedAt: string, part: number): string {
  const suffix = part > 1 ? `-${part}` : '';
  return `canari-replay-${publishedAt.slice(0, 10)}-${postId.slice(0, 8)}${suffix}.mp4`;
}
