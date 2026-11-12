/**
 * THE NEXT PAGES OF THE REEL VIEWER, FETCHED AHEAD IN PARALLEL WITH THE ONE BEING WATCHED (owner,
 * 2026-11-11: on production 1.6.10, desktop, a fast link, wheel-scrolling the viewer showed a black
 * stage - sometimes a spinner - for about a second before most photos and videos).
 *
 * Measured on dev first (2026-11-11, `docs/wiki/frontend/modules/reels.md`): a page is black when
 * the reader reaches it before its bytes AND it has nothing to draw meanwhile - a reel published
 * without a first-frame ThumbHash, a photo (photos carried none). The single preload behind the
 * SETTLED reel could not keep up with a wheel: it starts only once the page on screen plays, and a
 * reel read whole takes seconds to arrive.
 *
 * WHAT IS FETCHED, per page ahead (its opening media - a carousel's remembered one):
 *
 * - a SEGMENTED video: its HEAD only (`mediaHeadStore.ts`, the header and its first segment), decoded at
 *   once into its sharp first frame (`reelPosters`). The player of that page then JOINS those bytes,
 *   streamed or read whole: nothing is fetched twice;
 * - a picture: the whole file (pictures are small), into the decrypted pool, where the page's
 *   `PostMedia` takes it warm;
 * - a single-block video: nothing - its one AES-GCM block cannot be read in part, so no head exists;
 *   the reel behind the settled one still preloads it whole (`ReelPreload`).
 *
 * HOW MANY: {@link REEL_AHEAD_FAST} pages on a link that keeps up with the media, {@link
 * REEL_AHEAD_SLOW} on one that does not - the verdict of #3333 (`linkIsSlow`, with its hysteresis)
 * on the session's measured rate (`sessionLinkRate`, the same samples as the streams) against the
 * media rate of the reel being watched. Never a clock.
 *
 * WHAT KEEPS THE WATCHED REEL FIRST: every byte fetched ahead goes through the gate's BACKGROUND
 * lane (`requestGate.ts`): behind every request for what is on screen, and never in the last free
 * slot.
 *
 * WHAT A FAST SCROLL LEAVES BEHIND: nothing. A page that is neither on screen nor among the next is
 * dropped at the very update that passed it - its head released (the last holder aborts it, queued
 * or on the wire), its picture's wait abandoned or its hold given back. The page that BECOMES the
 * one on screen keeps its fetch, so its player joins it rather than starting over.
 */
import { SEGMENTED_MEDIA_ENCODING } from '$lib/mediaSegmented';
import type { PostEntity, PostMediaRef } from '$lib/posts/api';
import { mediaUrl } from '$lib/utils/apiUrl';
import { sessionLinkRate } from '$lib/utils/linkRate';
import {
  acquireDecryptedMediaBlobUrl,
  releaseDecryptedMediaBlobUrl,
} from '$lib/utils/mediaBlobCache';
import { holdMediaHead, MEDIA_HEAD_SEGMENTS, type MediaHeadHold } from '$lib/utils/mediaHeadStore';
import { memoryRangeSource, openSegmentedMedia } from '$lib/utils/segmentedMediaReader';
import { linkIsSlow } from '$lib/utils/segmentedMediaStream';
import { segmentCiphertextRange } from '$lib/mediaSegmented';
import {
  fullScreenMediaKindOf,
  fullScreenMediaListOf,
  fullScreenPageOf,
  type FullScreenMediaKind,
} from './fullScreenPost';
import { captureReelPoster, reelPosterUrl } from './reelPosters.svelte';

/** Pages fetched ahead while the link keeps up with the media. */
export const REEL_AHEAD_FAST = 3;

/** Pages fetched ahead while it does not. */
export const REEL_AHEAD_SLOW = 1;

/** One page as the look-ahead sees it: the media it opens on. */
export interface AheadPage {
  postId: string;
  media: PostMediaRef;
  kind: FullScreenMediaKind;
  /** The reel's declared length (`post.durationMs`): with its size, the media's rate. */
  durationMs: number | null;
}

/** The page `post` opens on in the viewer (`mediaIndex`: a carousel's remembered media), or `null`. */
export function aheadPageOf(post: PostEntity, mediaIndex: number): AheadPage | null {
  const page = fullScreenPageOf(post);
  if (page === null || page === 'replay') return null;
  const list = fullScreenMediaListOf(post);
  const media = list[page === 'carousel' ? Math.min(Math.max(0, mediaIndex), list.length - 1) : 0];
  const kind = media ? fullScreenMediaKindOf(media) : null;
  if (!media || !kind) return null;
  return { postId: post.id, media, kind, durationMs: post.durationMs ?? null };
}

/**
 * The page on screen and the {@link REEL_AHEAD_FAST} pages after it that draw a media, read from a
 * viewer's list (`ReelList`): its posts, its index and each carousel's remembered media.
 */
export function aheadPagesOf(list: {
  reels: PostEntity[];
  index: number;
  mediaIndexById: Record<string, number>;
}): { current: AheadPage | null; next: AheadPage[] } {
  const pageAt = (i: number) => {
    const post = list.reels[i];
    return post ? aheadPageOf(post, list.mediaIndexById[post.id] ?? 0) : null;
  };
  const next: AheadPage[] = [];
  for (let i = list.index + 1; i < list.reels.length && next.length < REEL_AHEAD_FAST; i++) {
    const page = pageAt(i);
    if (page) next.push(page);
  }
  return { current: pageAt(list.index), next };
}

/** How many pages to fetch ahead for a link verdict. */
export function aheadCountFor(slow: boolean): number {
  return slow ? REEL_AHEAD_SLOW : REEL_AHEAD_FAST;
}

/** Bytes per second of a video page's media, or `null` when its length is not declared. */
function mediaRateOf(page: AheadPage | null | undefined): number | null {
  if (!page || page.kind !== 'video') return null;
  const ms = page.durationMs ?? page.media.durationMs ?? null;
  if (!ms || ms <= 0 || page.media.size <= 0) return null;
  return page.media.size / (ms / 1000);
}

/**
 * THE LOOK-AHEAD'S LINK VERDICT, kept for the session (the link is the session's, not a page's).
 * Unknown - nothing measured yet - counts as SLOW: the first page fetched ahead is one, and its own
 * read is the first sample.
 */
let lookAheadSlow = true;

/**
 * Brings the verdict up to date from the measured link and a reference media rate - the reel on
 * screen, else the first video ahead - and returns it. An unknown ratio keeps the last answer.
 */
export function lookAheadLinkSlow(
  referenceMediaBytesPerSecond: number | null,
  linkBytesPerSecond: number | null = sessionLinkRate.bytesPerSecond
): boolean {
  const ratio =
    linkBytesPerSecond && referenceMediaBytesPerSecond
      ? linkBytesPerSecond / referenceMediaBytesPerSecond
      : null;
  const next = linkIsSlow(ratio, lookAheadSlow);
  if (next !== lookAheadSlow) {
    console.debug(
      `[reel-ahead] link ${Math.round((linkBytesPerSecond ?? 0) / 1024)} KiB/s against media ${Math.round((referenceMediaBytesPerSecond ?? 0) / 1024)} KiB/s - ${next ? 'slow' : 'fast'}: ${aheadCountFor(next)} page(s) ahead`
    );
    lookAheadSlow = next;
  }
  return next;
}

/** Test seam: forgets the verdict (unknown, so slow). */
export function resetLookAheadForTest(): void {
  lookAheadSlow = true;
}

/** What the look-ahead does to the world - injectable for tests. */
export interface ReelAheadDeps {
  holdHead: (mediaId: string) => MediaHeadHold;
  acquirePicture: (ref: PostMediaRef, signal: AbortSignal) => Promise<string>;
  releasePicture: (ref: PostMediaRef) => void;
  /** Decodes a head's first frame and keeps it as the page's poster. */
  keepFirstFrame: (ref: PostMediaRef, head: Uint8Array<ArrayBuffer>) => Promise<void>;
  /** Whether the page already has its sharp first frame. */
  hasFirstFrame: (mediaId: string) => boolean;
}

/**
 * The decrypted part of a head that holds whole segments: segment 0 and the next ones that fit, as
 * a prefix of the file - what a first frame is decoded from.
 */
export async function decryptHead(
  ref: Pick<PostMediaRef, 'key' | 'iv' | 'mimeType'>,
  head: Uint8Array<ArrayBuffer>
): Promise<Blob> {
  const reader = await openSegmentedMedia(memoryRangeSource(head), ref.key, ref.iv);
  const parts: ArrayBuffer[] = [];
  const count = Math.min(reader.segmentCount, MEDIA_HEAD_SEGMENTS);
  for (let i = 0; i < count; i++) {
    const [, end] = segmentCiphertextRange(reader.header, i);
    if (end > head.byteLength) break;
    parts.push(await reader.readSegment(i));
  }
  return new Blob(parts, { type: ref.mimeType });
}

const defaultDeps: ReelAheadDeps = {
  holdHead: (mediaId) => holdMediaHead(mediaId, mediaUrl()),
  acquirePicture: (ref, signal) =>
    acquireDecryptedMediaBlobUrl(ref, mediaUrl(), signal, 'background'),
  releasePicture: releaseDecryptedMediaBlobUrl,
  keepFirstFrame: async (ref, head) => {
    const prefix = await decryptHead(ref, head);
    await captureReelPoster(ref.mediaId, prefix);
  },
  hasFirstFrame: (mediaId) => reelPosterUrl(mediaId) !== null,
};

/** One page's fetch ahead. */
interface AheadEntry {
  stop(): void;
}

/** The look-ahead of one open viewer. */
export class ReelAhead {
  readonly #deps: ReelAheadDeps;
  /** By mediaId: what is being fetched ahead, or held for the page on screen. */
  readonly #entries = new Map<string, AheadEntry>();
  #current: AheadPage | null = null;
  #next: AheadPage[] = [];
  /** First-frame decodes run one at a time: three at once would be three decoders beside the player. */
  #decodes: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(deps: ReelAheadDeps = defaultDeps) {
    this.#deps = deps;
  }

  /**
   * The page on screen and the pages after it, in order (as many as {@link REEL_AHEAD_FAST}). The
   * page on screen keeps a fetch it already has - its player joins it - but none is started for it.
   */
  update(current: AheadPage | null, next: AheadPage[]): void {
    if (this.#stopped) return;
    this.#current = current;
    this.#next = next;
    this.#plan();
  }

  /** How many pages are being fetched or held: the tests' and the log's count. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether `mediaId` is being fetched or held. */
  holds(mediaId: string): boolean {
    return this.#entries.has(mediaId);
  }

  /** Ends every fetch - the viewer closed. Idempotent. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const [mediaId, entry] of this.#entries) {
      entry.stop();
      console.debug(`[reel-ahead] ${mediaId}: dropped (viewer closed)`);
    }
    this.#entries.clear();
  }

  #plan(): void {
    const reference =
      mediaRateOf(this.#current) ?? mediaRateOf(this.#next.find((p) => p.kind === 'video'));
    const count = aheadCountFor(lookAheadLinkSlow(reference));
    const wanted = this.#next.slice(0, count);
    const keep = new Set(wanted.map((p) => p.media.mediaId));
    if (this.#current) keep.add(this.#current.media.mediaId);
    for (const [mediaId, entry] of this.#entries) {
      if (keep.has(mediaId)) continue;
      entry.stop();
      this.#entries.delete(mediaId);
      console.debug(`[reel-ahead] ${mediaId}: dropped (passed, or no longer ahead)`);
    }
    for (const page of wanted) {
      if (this.#entries.has(page.media.mediaId)) continue;
      const entry = this.#start(page);
      if (entry) this.#entries.set(page.media.mediaId, entry);
    }
  }

  #start(page: AheadPage): AheadEntry | null {
    const ref = page.media;
    if (page.kind === 'photo') return this.#startPicture(ref);
    if (ref.encoding !== SEGMENTED_MEDIA_ENCODING) {
      // One AES-GCM block: no part of it can be read before the whole. Said once per page.
      console.debug(`[reel-ahead] ${ref.mediaId}: a single-block video has no head to fetch`);
      return null;
    }
    return this.#startHead(ref);
  }

  #startPicture(ref: PostMediaRef): AheadEntry {
    const abort = new AbortController();
    let held = false;
    let stopped = false;
    console.debug(`[reel-ahead] ${ref.mediaId}: picture`);
    this.#deps
      .acquirePicture(ref, abort.signal)
      .then(() => {
        if (stopped) {
          this.#deps.releasePicture(ref);
          return;
        }
        held = true;
        console.debug(`[reel-ahead] ${ref.mediaId}: picture in`);
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        // The page will ask for itself and show its own failure; only the head start is lost.
        console.warn(`[reel-ahead] ${ref.mediaId}: picture not fetched ahead`, err);
      });
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (held) this.#deps.releasePicture(ref);
        else abort.abort();
      },
    };
  }

  #startHead(ref: PostMediaRef): AheadEntry {
    const head = this.#deps.holdHead(ref.mediaId);
    let stopped = false;
    console.debug(`[reel-ahead] ${ref.mediaId}: head`);
    head.bytes
      .then((bytes) => {
        if (stopped || this.#stopped) return;
        console.debug(`[reel-ahead] ${ref.mediaId}: head in, ${bytes.byteLength} bytes`);
        // A sample landed: the verdict may have changed, and with it how many pages are wanted.
        this.#plan();
        if (this.#deps.hasFirstFrame(ref.mediaId)) return;
        this.#decodes = this.#decodes.then(async () => {
          if (stopped || this.#deps.hasFirstFrame(ref.mediaId)) return;
          try {
            await this.#deps.keepFirstFrame(ref, bytes);
          } catch (err) {
            // A head that does not decrypt is the player's to report when the page is reached.
            console.warn(`[reel-ahead] ${ref.mediaId}: no first frame from its head`, err);
          }
        });
      })
      .catch((err: unknown) => {
        if (stopped) return;
        console.warn(`[reel-ahead] ${ref.mediaId}: head not fetched`, err);
      });
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        head.release();
      },
    };
  }
}
