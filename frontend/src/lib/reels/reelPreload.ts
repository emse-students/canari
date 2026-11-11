/**
 * THE NEXT REEL'S VIDEO, FETCHED AND DECRYPTED WHILE THE CURRENT ONE PLAYS (C7).
 *
 * A preload holds the decrypted blob in the app's media cache (`mediaBlobCache.ts`), so that when the
 * reel becomes the current one its `PostMedia` takes the WARM path and draws the first frame at once.
 * It mounts no `<video>`: an element would count as an open viewer and claim playback from the reel
 * being watched (`followVideoSound`).
 *
 * HAND-OVER AT THE SWIPE. `stop()` releases the preload's HOLD on the shared load
 * (`mediaBlobCache.ts`), it does not cancel bytes already on the wire: a request that has left the
 * gate's queue stays joinable, so the player's whole-blob read of the same reel joins it and loses
 * nothing. A STREAMED segmented video opens its own fetch (`openSegmentedStream`) instead, so the
 * preload's partial bytes are dropped there - but its HEAD, fetched ahead by the viewer
 * (`reelAhead.ts`), is joined by both: this preload asks only for the rest of the file, and the
 * stream reads its first segments from it. A preload that has finished has its hold given back;
 * the player retained the same cached URL first, and the pool keeps an unheld URL for minutes anyway.
 */
import {
  acquireDecryptedMediaBlobUrl,
  releaseDecryptedMediaBlobUrl,
} from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';
import type { MediaRef } from '$lib/media';

/** The cache's two operations, injectable for tests. */
export interface ReelPreloadCache {
  acquire: (ref: MediaRef, baseUrl: string, signal: AbortSignal) => Promise<string>;
  release: (ref: MediaRef) => void;
}

const defaultCache: ReelPreloadCache = {
  acquire: acquireDecryptedMediaBlobUrl,
  release: releaseDecryptedMediaBlobUrl,
};

/**
 * The most a preload fetches of a video it cannot stream: the reel cap (about 28 MB of ciphertext,
 * what a reel of the 90 s cap weighs). A FEED VIDEO is not prepared into a reel (owner, 2026-11-06:
 * a post of one video is drawn as a reel page) and may be hundreds of MB; fetching it whole for a
 * slide the reader may never reach would cost more than the head start is worth, so it loads when
 * its slide becomes active.
 */
export const REEL_PRELOAD_MAX_BYTES = 28 * 1024 * 1024;

/** Whether the next slide's video is worth fetching ahead: it streams (segmented), or it is reel-sized. */
export function worthPreloading(ref: Pick<MediaRef, 'encoding' | 'size'>): boolean {
  return ref.encoding === 'segmented-v1' || ref.size <= REEL_PRELOAD_MAX_BYTES;
}

/**
 * Where a preload had got when it was last looked at - read by the reel's outcome line when the
 * reel becomes current (`reelViewOutcome.ts`): `ready` means the player takes the warm path,
 * `in-flight` that it joins (whole read) or races (stream) a download already running.
 */
export type ReelPreloadState = 'in-flight' | 'ready' | 'failed';

/** One reel's preload: started at once, ended by {@link ReelPreload.stop}. */
export class ReelPreload {
  readonly #ref: MediaRef;
  readonly #cache: ReelPreloadCache;
  readonly #abort = new AbortController();
  #held = false;
  #stopped = false;
  /** Set before a stop only: a stop freezes it, so it answers "how far had it got when handed over". */
  #state: ReelPreloadState = 'in-flight';

  /**
   * @param onReady called with the decrypted URL once the video is in the cache - the slide decodes
   *   its first frame from it (`reelPosters.svelte.ts`), so the swipe lands on that frame.
   */
  constructor(
    ref: MediaRef,
    cache: ReelPreloadCache = defaultCache,
    onReady?: (url: string) => void
  ) {
    this.#ref = ref;
    this.#cache = cache;
    console.debug(`[reel-preload] ${ref.mediaId}: start`);
    cache
      .acquire(ref, mediaUrl(), this.#abort.signal)
      .then((url) => {
        if (this.#stopped) {
          // Finished in the same turn it was stopped: give the hold straight back.
          cache.release(ref);
          return;
        }
        this.#held = true;
        this.#state = 'ready';
        console.debug(`[reel-preload] ${ref.mediaId}: ready`);
        onReady?.(url);
      })
      .catch((err: unknown) => {
        if (this.#abort.signal.aborted) {
          console.debug(`[reel-preload] ${ref.mediaId}: aborted`);
          return;
        }
        if (!this.#stopped) this.#state = 'failed';
        // The player will try again for itself and show the failure; this only loses the head start.
        console.warn(`[reel-preload] ${ref.mediaId}: failed`, err);
      });
  }

  /** How far the preload had got - frozen at {@link stop}. */
  get state(): ReelPreloadState {
    return this.#state;
  }

  /** Whether the video is in the cache, decrypted. */
  get ready(): boolean {
    return this.#held;
  }

  /** Aborts an unfinished preload, or gives back a finished one's hold. Idempotent. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#held) {
      this.#held = false;
      this.#cache.release(this.#ref);
    } else {
      this.#abort.abort();
    }
  }
}
