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
 * Where each segment begins in MEDIA time, in ms: the measured start (`placed`, seconds) where there is
 * one, and a stated estimate elsewhere. A segment's `atMs` is its ARRIVAL time on the server, and a replay
 * whose media is longer than its live (61 s of media for 54 s of live: a camera under its nominal rate)
 * runs AHEAD of it, while the player's bar reads media time. The estimate is therefore anchored on the
 * nearest measured segment and advances by the arrival-time gaps scaled by the replay's measured rate
 * (media seconds per arrival second between its first and last measured segments; 1 with fewer than two).
 * With nothing measured it IS the arrival time - the only statement there is.
 */
export function mediaStartsMs(
  segments: readonly LiveReplaySegment[],
  placed: ReadonlyMap<number, number>
): number[] {
  const measured = segments.flatMap((s, k) => {
    const at = placed.get(s.index);
    return at === undefined ? [] : [{ k, at: at * 1000 }];
  });
  if (measured.length === 0) return segments.map((s) => s.atMs);
  const first = measured[0];
  const last = measured[measured.length - 1];
  const live = segments[last.k].atMs - segments[first.k].atMs;
  const rate =
    measured.length >= 2 && live > 0 && last.at > first.at ? (last.at - first.at) / live : 1;
  const out: number[] = [];
  let anchor = -1;
  for (let k = 0; k < segments.length; k++) {
    if (anchor + 1 < measured.length && measured[anchor + 1].k === k) anchor++;
    if (anchor >= 0 && measured[anchor].k === k) out.push(measured[anchor].at);
    else if (anchor >= 0) {
      out.push(measured[anchor].at + (segments[k].atMs - segments[measured[anchor].k].atMs) * rate);
    } else {
      out.push(first.at - (segments[first.k].atMs - segments[k].atMs) * rate);
    }
  }
  return out;
}

/**
 * The position in `segments` (ascending by `atMs`) of the LAST segment whose start is at or before `ms` -
 * the join logic of a seek: that segment is self-contained (its init, then one fragment), so it can start
 * the picture. `ms` is MEDIA time and the starts are {@link mediaStartsMs}; without `placed` they are the
 * arrival times. Clamped: a target before the first is the first, past the last is the last. `-1` for an
 * empty list, so a caller can never index into nothing.
 */
export function segmentPositionAt(
  segments: readonly LiveReplaySegment[],
  ms: number,
  placed: ReadonlyMap<number, number> = new Map()
): number {
  if (segments.length === 0) return -1;
  const starts = mediaStartsMs(segments, placed);
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= ms) lo = mid;
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
