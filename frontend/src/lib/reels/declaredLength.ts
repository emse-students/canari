import type { PostEntity, PostMediaRef } from '$lib/posts/api';
import type { FullScreenPage } from './fullScreenPost';

/**
 * THE TOTAL LENGTH OF A FULL-SCREEN VIDEO, AS ITS PUBLISHER DECLARED IT, in ms - or `null` when
 * nobody declared one (owner, 2026-11-18: the seek line is fixed to the video's real total from the
 * first frame, so it never rewinds while segments load; `barLength` takes it from here).
 *
 * Where each case's length lives, in the order read:
 * 1. **The media's own `durationMs`**: a reel received in a conversation carries it in its message
 *    (`MediaRef.durationMs`, `MediaMsg.duration_ms`, written by the sender from the prepared file);
 *    `reelMessageAsPost` hands that ref to the viewer unchanged. It was dropped on the way to the
 *    player until now, so a conversation's reel had no declared length.
 * 2. **The post's `durationMs`** on a CanaReel (`posts.duration_ms`, required at publish, the file's
 *    prepared length, 1 to the server's `maxDurationMs`).
 * 3. **Nothing**: a post of one video that is not a CanaReel, and a carousel's video, declare no
 *    length anywhere. Their total comes from the file's own header or, for a stream, from its tail
 *    (`segmentedMediaStream`); until then the line draws no played part (`barLength`, `unknown`).
 */
export function declaredLengthMs(
  post: Pick<PostEntity, 'durationMs'>,
  ref: PostMediaRef,
  page: FullScreenPage
): number | null {
  const own = (ref as { durationMs?: unknown }).durationMs;
  if (typeof own === 'number' && own > 0) return own;
  if (page === 'reel' && typeof post.durationMs === 'number' && post.durationMs > 0) {
    return post.durationMs;
  }
  return null;
}
