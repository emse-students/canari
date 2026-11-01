/**
 * THE SHARP FIRST FRAME OF THE REELS THIS DEVICE HAS DECRYPTED, FOR THE SESSION (owner, 2026-10-31:
 * a loading reel showed a yellow play glyph on a neutral box; it must show its first frame).
 *
 * A reel becomes a poster here when its video is in the decrypted pool - the NEXT reel once its
 * preload is in (`ReelPreload`), the reel on screen once its file is whole - so a swipe, forward
 * or back, lands on the frame the player is about to draw. A reel never decrypted here has only
 * the publisher's ThumbHash (`MediaRef.placeholder`), and an old reel without one a dark box.
 *
 * BOUNDED: {@link REEL_POSTER_MAX} JPEGs of a few tens of kB, least recently made revoked first.
 * Captures are deduplicated per media: a second ask while one runs is the same work.
 */
import { SvelteMap } from 'svelte/reactivity';
import { decodeFirstFrame, frameToJpeg, REEL_POSTER_LONG_EDGE } from './reelFirstFrame';

/** How many posters the session keeps: the viewer's neighbours and a short way back. */
export const REEL_POSTER_MAX = 8;

/** The decode and encode, injectable for tests. */
export type FrameCapture = (video: Blob) => Promise<Blob | null>;

const defaultCapture: FrameCapture = async (video) => {
  const canvas = await decodeFirstFrame(video, REEL_POSTER_LONG_EDGE);
  return canvas ? frameToJpeg(canvas) : null;
};

/** mediaId -> object URL of its first frame; insertion order is the eviction order. */
const posters = new SvelteMap<string, string>();
/** Captures in flight, by mediaId. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
const inFlight = new Map<string, Promise<void>>();

/** The first frame of `mediaId` this session has decoded, as a URL, or `null`. Reactive. */
export function reelPosterUrl(mediaId: string): string | null {
  return posters.get(mediaId) ?? null;
}

/**
 * Decodes the first frame of `mediaId` from `videoUrl` (a decrypted blob URL from the media pool)
 * and keeps it. Does nothing when the poster exists or is being made. Never throws.
 */
export function captureReelPoster(
  mediaId: string,
  videoUrl: string,
  capture: FrameCapture = defaultCapture
): Promise<void> {
  if (posters.has(mediaId)) return Promise.resolve();
  const running = inFlight.get(mediaId);
  if (running) return running;
  const started = performance.now();
  const work = (async () => {
    try {
      const video = await (await fetch(videoUrl)).blob();
      const jpeg = await capture(video);
      if (!jpeg) {
        console.warn(
          `[reel-poster] ${mediaId}: no frame decoded - the slide keeps its placeholder`
        );
        return;
      }
      keep(mediaId, URL.createObjectURL(jpeg));
      console.debug(
        `[reel-poster] ${mediaId}: first frame kept, ${jpeg.size} bytes in ${Math.round(performance.now() - started)} ms`
      );
    } catch (err) {
      console.warn(`[reel-poster] ${mediaId}: capture failed`, err);
    } finally {
      inFlight.delete(mediaId);
    }
  })();
  inFlight.set(mediaId, work);
  return work;
}

function keep(mediaId: string, url: string): void {
  posters.set(mediaId, url);
  while (posters.size > REEL_POSTER_MAX) {
    const [oldest, oldUrl] = posters.entries().next().value as [string, string];
    posters.delete(oldest);
    URL.revokeObjectURL(oldUrl);
    console.debug(`[reel-poster] ${oldest}: evicted (cap ${REEL_POSTER_MAX})`);
  }
}

/** Test seam: forgets every poster. */
export function resetReelPostersForTest(): void {
  for (const url of posters.values()) URL.revokeObjectURL(url);
  posters.clear();
  inFlight.clear();
}
