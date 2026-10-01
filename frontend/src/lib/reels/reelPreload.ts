/**
 * THE NEXT REEL'S VIDEO, FETCHED AND DECRYPTED WHILE THE CURRENT ONE PLAYS (C7).
 *
 * A preload holds the decrypted blob in the app's media cache (`mediaBlobCache.ts`), so that when the
 * reel becomes the current one its `PostMedia` takes the WARM path and draws the first frame at once.
 * It mounts no `<video>`: an element would count as an open viewer and claim playback from the reel
 * being watched (`followVideoSound`).
 *
 * NO TWO DOWNLOADS OF ONE REEL. When the reel becomes current BEFORE its preload has finished, the
 * preload is ABORTED rather than left to race the player's own fetch (which streams a segmented video
 * as it arrives) - so a reel is fetched by the preload or by the player, never by both at once. When
 * it has finished, its hold is released: the player retained the same cached URL first, and the pool
 * keeps an unheld URL for minutes anyway.
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

/** One reel's preload: started at once, ended by {@link ReelPreload.stop}. */
export class ReelPreload {
  readonly #ref: MediaRef;
  readonly #cache: ReelPreloadCache;
  readonly #abort = new AbortController();
  #held = false;
  #stopped = false;

  constructor(ref: MediaRef, cache: ReelPreloadCache = defaultCache) {
    this.#ref = ref;
    this.#cache = cache;
    console.debug(`[reel-preload] ${ref.mediaId}: start`);
    cache
      .acquire(ref, mediaUrl(), this.#abort.signal)
      .then(() => {
        if (this.#stopped) {
          // Finished in the same turn it was stopped: give the hold straight back.
          cache.release(ref);
          return;
        }
        this.#held = true;
        console.debug(`[reel-preload] ${ref.mediaId}: ready`);
      })
      .catch((err: unknown) => {
        if (this.#abort.signal.aborted) {
          console.debug(`[reel-preload] ${ref.mediaId}: aborted`);
          return;
        }
        // The player will try again for itself and show the failure; this only loses the head start.
        console.warn(`[reel-preload] ${ref.mediaId}: failed`, err);
      });
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
