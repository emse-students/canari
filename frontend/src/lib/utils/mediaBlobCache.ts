import type { MediaRef } from '$lib/media';
import { decryptMediaBuffer } from '$lib/mediaCrypto';
import {
  SEGMENTED_MEDIA_ENCODING,
  SegmentedMediaError,
  decryptSegmentedMediaBuffer,
  isWrittenByNewerClient,
} from '$lib/mediaSegmented';
import { getToken } from '$lib/stores/auth';
import { BlobUrlPool } from './blobUrlPool';
import {
  MediaDecryptError,
  MediaDownloadError,
  MediaNotFoundError,
  MediaPurgedError,
  MediaUnreachableError,
  resolveMediaCredential,
} from './mediaErrors';
import { noteMediaCacheHit } from './mediaTouch';
import { GateRank, mediaRequestGate, type GateLane } from './requestGate';
import { declareMp4Duration, isMp4Type } from './mp4Duration';
import { joinMediaHead, readAfterHead } from './mediaHeadStore';

/** Exported so `deviceStorage.ts` can measure/clear it without duplicating the literal. */
export const CIPHER_CACHE_NAME = 'canari-media-ciphertext-v1';

const decryptedPool = new BlobUrlPool();
const rawPool = new BlobUrlPool();
const inflightDecrypted = new Map<string, SharedLoad>();
const inflightRaw = new Map<string, SharedLoad>();

/**
 * ONE DOWNLOAD, MANY HOLDERS - AND IT IS ABANDONED WHEN THE LAST ONE LEAVES, ON THE WIRE OR NOT.
 *
 * Every row that wants the same object joins the load already running for it. That load used to be
 * bound to the signal of whoever STARTED it, so when the starter was torn down while the request was
 * still queued (`mediaRequestGate`: abort means "never start"), the shared promise rejected with that
 * starter's `AbortError` - and every row that had joined in the meantime received it. A freshly sent
 * video hit this every time: the sent message is re-rendered right after its upload, the first
 * render's effect is torn down, the second joins, and it is handed the first one's abort, which the
 * bubble printed as "media not shown (other) ... The operation was aborted" with no thumbnail
 * (user, 2026-10-02, on every video uploaded in the chat).
 *
 * So the load owns its OWN `AbortController`, and each holder - the starter included - only counts.
 *
 * A LOAD NOBODY HOLDS IS STOPPED, ON THE WIRE TOO (lead decision, 2026-11-11, reversible; it
 * replaces "a load already on the wire stays joinable" of 2026-10-05). Measured on dev: a reader
 * wheeling through ten CanaReels of ~3 MB kept downloading every reel it had passed, so on a slow
 * link the reel being watched shared the link with ten it would never see. The request is now given
 * the load's signal, so the abort reaches `fetch` and its body, and the decision is taken ONCE THE
 * CURRENT TURN IS OVER (a microtask, an ordering - never a clock): a row re-rendered in the same
 * turn - torn down, mounted again, the 2026-10-05 case of a sent picture - joins before it is
 * decided, keeps the load and is served by the one request. A row arriving after the abort starts
 * afresh: the abandoned entry has left the map, and its bytes never reached the pool, so no URL it
 * minted can be handed out revoked.
 *
 * A holder with no signal never leaves, so a load it holds is never abandoned. A partial download
 * is never cached: the Cache API copy is written only from a body read to its end.
 */
interface SharedLoad {
  promise: Promise<string>;
  controller: AbortController;
  holders: number;
  /** The request has left the gate's queue: an abort stops it on the wire (said in the log). */
  started: boolean;
  /** The load has settled: there is nothing left to abandon. */
  settled: boolean;
  /** Its lane in the gate: a foreground holder joining a load fetched ahead raises it. */
  rank: GateRank;
}

/** Registers one more holder of `entry`; when the last one leaves, the load is abandoned. */
function holdSharedLoad(
  map: Map<string, SharedLoad>,
  key: string,
  entry: SharedLoad,
  signal?: AbortSignal
): void {
  entry.holders += 1;
  // A holder with no signal can never be abandoned, so the load it joined can never be either.
  if (!signal) return;
  const leave = () => {
    entry.holders -= 1;
    if (entry.holders > 0) return;
    // Decided once this turn is over: a holder joining in the same turn (a re-render) keeps it.
    queueMicrotask(() => {
      if (entry.holders > 0 || entry.settled) return;
      if (map.get(key) === entry) map.delete(key);
      // The media id only: a decrypted entry's key also carries the media's AES key and IV.
      const mediaId = key.split(':')[0];
      console.debug(
        `[mediaBlobCache] ${mediaId}: abandoned by its last holder - ${entry.started ? 'stopped on the wire' : 'stopped before its request started'}`
      );
      entry.controller.abort(signal.reason);
    });
  };
  if (signal.aborted) {
    leave();
    return;
  }
  signal.addEventListener('abort', leave, { once: true });
  // Once the load has settled there is nothing left to abandon.
  const settled = () => signal.removeEventListener('abort', leave);
  entry.promise.then(settled, settled);
}

/**
 * The one shape of a pooled, shared load - decrypted media and raw media alike.
 *
 * A warm pool entry answers at once; a load in flight is joined; otherwise `load` runs, given its
 * abort signal and a callback reporting that its request has left the queue. ITS RESULT IS POOLED
 * AND THE POOL'S ANSWER IS RETURNED: when the key is already held, `retain` keeps the URL on screen
 * and REVOKES the new one, so returning the new one would hand the caller a dead URL.
 */
async function sharedPooledLoad(
  pool: BlobUrlPool,
  map: Map<string, SharedLoad>,
  key: string,
  signal: AbortSignal | undefined,
  lane: GateLane,
  load: (signal: AbortSignal, onStart: () => void, rank: GateRank) => Promise<PooledBlob>
): Promise<string> {
  const cached = pool.tryRetain(key);
  if (cached) return cached;

  const pending = map.get(key);
  if (pending) {
    // A page fetched ahead that the reader has reached: its bytes are no longer background work.
    if (lane === 'foreground') pending.rank.promote();
    holdSharedLoad(map, key, pending, signal);
    const url = await pending.promise;
    return pool.tryRetain(key) ?? url;
  }

  const controller = new AbortController();
  const entry: SharedLoad = {
    promise: Promise.resolve(''),
    controller,
    holders: 0,
    started: false,
    settled: false,
    rank: new GateRank(lane),
  };
  entry.promise = (async () => {
    try {
      const { url, bytes } = await load(
        controller.signal,
        () => (entry.started = true),
        entry.rank
      );
      return pool.retain(key, url, bytes);
    } finally {
      entry.settled = true;
    }
  })();
  map.set(key, entry);
  holdSharedLoad(map, key, entry, signal);
  try {
    return await entry.promise;
  } finally {
    if (map.get(key) === entry) map.delete(key);
  }
}

/** A blob URL a load produced, and the blob's size - which the pool's byte cap counts. */
interface PooledBlob {
  url: string;
  bytes: number;
}

/** Mints the URL of `blob`, with the size the pool is told. */
function pooledBlob(blob: Blob): PooledBlob {
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

function decryptedKey(ref: MediaRef): string {
  return `${ref.mediaId}:${ref.key}:${ref.iv}`;
}

function cipherCacheKey(baseUrl: string, mediaId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/__cached__/media/${encodeURIComponent(mediaId)}`;
}

/**
 * GETs one media object through `mediaRequestGate` and TYPES every way it can fail, at the throw.
 *
 * A renderer has to say WHY a picture is missing - no network, gone, damaged - and it can only do
 * that if the failure arrives as a type (`mediaFailureCause` reads it). This used to throw a plain
 * `Error` holding the status in its message for everything but a 410, so every failure on screen
 * was the same "Impossible de charger le media" (user, 2026-10-01).
 *
 * Only the `fetch` itself is wrapped as unreachable: a request abandoned while still queued
 * rejects from the gate with its own `AbortError`, which the caller ignores and must keep seeing.
 *
 * @param onStart Called when the request leaves the gate's queue - the moment an abort stops counting.
 * @param options.from Asks only for the bytes from this offset on (`Range: bytes=N-`): the rest of a
 *   media whose head is already held (`mediaHeadStore.ts`). A `416` - the file ends exactly there -
 *   is then an answer, returned as is.
 * @param options.lane The gate's lane: `background` for a picture fetched ahead (`reelAhead.ts`), or
 *   the load's {@link GateRank}, which a foreground joiner raises.
 */
async function fetchMediaObject(
  mediaId: string,
  baseUrl: string,
  signal?: AbortSignal,
  onStart?: () => void,
  options: { from?: number; lane?: GateLane | GateRank } = {}
): Promise<Response> {
  const { from, lane } = options;
  const url = `${baseUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`;
  const res = await mediaRequestGate.run(
    async () => {
      // Out of the queue: from here the abort reaches the request itself (see `SharedLoad`).
      onStart?.();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await resolveMediaCredential(getToken)}`,
      };
      if (from !== undefined) headers.Range = `bytes=${from}-`;
      try {
        return await fetch(url, { headers, signal });
      } catch (err) {
        // An abandoned load is not an unreachable link: its own abort goes up unchanged.
        if (signal?.aborted) throw err;
        throw new MediaUnreachableError(err);
      }
    },
    signal,
    lane
  );
  if (res.ok) return res;
  if (from !== undefined && res.status === 416) return res;
  if (res.status === 410) throw new MediaPurgedError();
  if (res.status === 404) throw new MediaNotFoundError();
  throw new MediaDownloadError(res.status);
}

/** Drops a cached ciphertext, so the next attempt downloads it again instead of re-reading it. */
async function evictCiphertext(mediaId: string, baseUrl: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CIPHER_CACHE_NAME);
    await cache.delete(cipherCacheKey(baseUrl, mediaId));
  } catch (err) {
    console.warn('[mediaBlobCache] could not evict an undecryptable ciphertext', mediaId, err);
  }
}

/**
 * Drops a conversation reel's cached ciphertext once its tile is a tombstone (RC-6,
 * [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md) 3.3): the Cache API copy would
 * otherwise be "kept after the server forgot it", the very thing the tombstone says is gone - and
 * it would play a purged reel from the cache with no `410` ever asked. Idempotent; a cache that
 * cannot be opened is said, never thrown.
 */
export async function evictCachedReelCiphertext(mediaId: string, baseUrl: string): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CIPHER_CACHE_NAME);
    if (await cache.delete(cipherCacheKey(baseUrl, mediaId))) {
      console.debug(`[mediaBlobCache] ${mediaId}: a gone reel's cached ciphertext dropped`);
    }
  } catch (err) {
    console.warn("[mediaBlobCache] could not drop a gone reel's cached ciphertext", mediaId, err);
  }
}

/**
 * Fetches encrypted media bytes, using the Cache API when available so ciphertext
 * survives page reloads without hitting the network again.
 *
 * The bearer token is resolved HERE, per request, rather than taken from the caller: an access
 * token lives in memory for minutes, while the copy the chat session hands down its component
 * tree is captured once at login. A tab left open past that expiry kept rendering already-cached
 * media and 401'd on every newly received one - visible as an image that only appeared after a
 * reload. `getToken` refreshes silently when the token is within a minute of expiring.
 */
async function fetchCiphertext(
  mediaId: string,
  baseUrl: string,
  signal?: AbortSignal,
  onStart?: () => void,
  options: DownloadOptions = {}
): Promise<ArrayBuffer> {
  const cacheKey = cipherCacheKey(baseUrl, mediaId);

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CIPHER_CACHE_NAME);
      const hit = await cache.match(cacheKey);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (buf.byteLength > 0) {
          // The server's 30-day retention clock only ever saw DOWNLOADS, and this branch is
          // precisely the case where there is none - so without this report an object everyone
          // looks at daily expires on the same schedule as one nobody opens twice.
          noteMediaCacheHit(mediaId, baseUrl);
          return buf;
        }
      }
    } catch {
      // Cache API unavailable or read failed - fall through to network.
    }
  }

  // THE CACHE LOOKUP ABOVE IS FREE AND IS NOT GATED; ONLY THE BYTES ARE. An object already held
  // answers instantly whatever else is in flight, which is what makes the cap invisible to a
  // reader scrolling back through media they have seen.
  const ciphertext = await downloadCiphertext(mediaId, baseUrl, signal, onStart, options);

  if (typeof caches !== 'undefined' && ciphertext.byteLength > 0) {
    try {
      const cache = await caches.open(CIPHER_CACHE_NAME);
      await cache.put(
        cacheKey,
        new Response(ciphertext, { headers: { 'Content-Type': 'application/octet-stream' } })
      );
    } catch {
      // Best-effort cache write.
    }
  }

  return ciphertext;
}

/** How a ciphertext is downloaded. */
interface DownloadOptions {
  /** The ref is `segmented-v1`: a head fetched ahead may be joined. */
  segmented?: boolean;
  /** The load's rank in the gate ({@link GateRank}). */
  lane?: GateRank;
}

/**
 * The ciphertext from the network. A SEGMENTED media whose head the reel viewer fetched ahead
 * (`mediaHeadStore.ts`) joins that head - in flight or in - and asks only for the rest: the bytes
 * fetched ahead are never fetched again (owner, 2026-11-11).
 */
async function downloadCiphertext(
  mediaId: string,
  baseUrl: string,
  signal: AbortSignal | undefined,
  onStart: (() => void) | undefined,
  { segmented = false, lane }: DownloadOptions
): Promise<ArrayBuffer> {
  const whole = () => fetchMediaObject(mediaId, baseUrl, signal, onStart, { lane });
  // A read for the foreground raises the head it joins (`GateRank`); one fetched ahead does not.
  const head = segmented ? joinMediaHead(mediaId, lane?.lane ?? 'foreground') : null;
  if (!head) return (await whole()).arrayBuffer();
  console.debug(`[mediaBlobCache] ${mediaId}: joins the head fetched ahead, asks for the rest`);
  try {
    return await readAfterHead(
      head,
      (from) => fetchMediaObject(mediaId, baseUrl, signal, onStart, { from, lane }),
      whole,
      signal
    );
  } finally {
    head.release();
  }
}

/**
 * Decrypts a whole blob in the format its REF names - the one place the format is decided.
 *
 * The ref travels inside the authenticated message, so `encoding` is a fact the reader holds before
 * a byte is read; the bytes are never asked which format they are, and a segmented blob that fails
 * is never retried as a single block (`mediaSegmented.ts`, "Why the REF decides the format").
 * Absent `encoding` is every ref written before the segmented format, read as they always were - for
 * as long as such a ref exists, which is for ever.
 */
async function decryptByEncoding(ref: MediaRef, ciphertext: ArrayBuffer): Promise<ArrayBuffer> {
  if (ref.encoding === SEGMENTED_MEDIA_ENCODING) {
    console.debug(`[media] ${ref.mediaId}: segmented, ${ciphertext.byteLength} bytes`);
    return decryptSegmentedMediaBuffer(ciphertext, ref.key, ref.iv);
  }
  if (ref.encoding !== undefined) {
    // Never read as a single block: that would turn "written by a newer client" into "corrupt".
    console.error(`[media] ${ref.mediaId}: unknown encoding ${String(ref.encoding)} - refused`);
    throw new SegmentedMediaError('encoding', `media encoding ${String(ref.encoding)} is unknown`);
  }
  return decryptMediaBuffer(ciphertext, ref.key, ref.iv);
}

function loadDecryptedBlobUrl(
  ref: MediaRef,
  baseUrl: string,
  signal?: AbortSignal,
  lane?: GateLane
): Promise<string> {
  return sharedPooledLoad(
    decryptedPool,
    inflightDecrypted,
    decryptedKey(ref),
    signal,
    lane ?? 'foreground',
    async (loadSignal, onStart, rank) => {
      const ciphertext = await fetchCiphertext(ref.mediaId, baseUrl, loadSignal, onStart, {
        segmented: ref.encoding === SEGMENTED_MEDIA_ENCODING,
        lane: rank,
      });
      let plaintext: ArrayBuffer;
      try {
        plaintext = await decryptByEncoding(ref, ciphertext);
      } catch (err) {
        // An encoding or header version this client does not know was written by a NEWER client:
        // the bytes are fine, so they are kept, and the reader's typed error goes up unchanged
        // (`mediaFailureCause` reads it as 'other', never as damage).
        if (isWrittenByNewerClient(err)) throw err;
        // A cached copy that will never decrypt would answer every retry the same way: the retry
        // the reader is offered must download the object again, not re-read the damaged one. A
        // segmented blob refused for what it holds (a tag, a length) is the same cause.
        await evictCiphertext(ref.mediaId, baseUrl);
        throw new MediaDecryptError(err);
      }
      declareVideoDuration(ref, plaintext);
      return pooledBlob(new Blob([plaintext], { type: ref.mimeType }));
    }
  );
}

/**
 * A VIDEO UPLOADED BEFORE ITS WRITER DECLARED ITS LENGTH (`mp4Duration.ts`, owner 2026-11-10) is
 * given it here, in place, before the engine sees a byte: its `mvhd` said 0, so the player read
 * 0/Infinity and could not seek. Read from the file's own fragments - deterministic, no probe. A file
 * whose header already says it (every upload since the fix) is left as it is.
 */
export function declareVideoDuration(
  ref: Pick<MediaRef, 'mediaId' | 'mimeType' | 'type'>,
  plaintext: ArrayBuffer
): void {
  if (ref.type !== 'video' || !isMp4Type(ref.mimeType)) return;
  const outcome = declareMp4Duration(new Uint8Array(plaintext));
  if (outcome.kind === 'written') {
    // A file from before the writer's fix: expected while such files exist, counted by this line.
    console.info(
      `[media] ${ref.mediaId}: undeclared movie duration (${outcome.was} s) - ${outcome.seconds.toFixed(2)} s read from its fragments`
    );
  }
}

function loadRawBlobUrl(mediaId: string, baseUrl: string, signal?: AbortSignal): Promise<string> {
  return sharedPooledLoad(
    rawPool,
    inflightRaw,
    mediaId,
    signal,
    'foreground',
    async (loadSignal, onStart) => {
      const res = await fetchMediaObject(mediaId, baseUrl, loadSignal, onStart);
      return pooledBlob(await res.blob());
    }
  );
}

/**
 * Returns a blob URL for decrypted post/chat media, reusing cached ciphertext and
 * decrypted blobs when possible.
 *
 * @param signal This holder leaving: when it was the last, the load is abandoned - dropped from
 *   `mediaRequestGate`'s queue, or stopped on the wire (`SharedLoad`).
 * @param lane   The gate's lane: `background` for media fetched ahead of the reader. A load already
 *   running keeps the lane it started in.
 */
export async function acquireDecryptedMediaBlobUrl(
  ref: MediaRef,
  baseUrl: string,
  signal?: AbortSignal,
  lane?: GateLane
): Promise<string> {
  return loadDecryptedBlobUrl(ref, baseUrl, signal, lane);
}

/**
 * The decrypted blob URL when this media is ALREADY in memory, retained exactly as
 * {@link acquireDecryptedMediaBlobUrl} would - or `null`, and then nothing is held.
 *
 * WHY A SYNCHRONOUS ANSWER EXISTS: a feed rebuilt by a tab swipe holds every one of its media
 * decrypted, yet each card waited for its `nearViewport` observer - one frame after the first paint
 * - before asking, so the returning page drew its loading placeholders (the camera icon the user
 * called *"un logo bizarre"*, Mi 9T, 2026-09-29) over media it already had. Deferring exists to
 * spare the NETWORK; a blob in memory costs nothing, so the caller takes it at once.
 */
export function retainWarmDecryptedMediaBlobUrl(ref: MediaRef): string | null {
  return decryptedPool.tryRetain(decryptedKey(ref));
}

/**
 * Puts plaintext that was decrypted ELSEWHERE - a segmented stream that has appended its last
 * segment - into the same pool {@link acquireDecryptedMediaBlobUrl} serves, and retains it once for
 * the caller. The lightbox and the download then reuse it rather than fetching the file again.
 *
 * If the pool already holds this media, that URL is retained and returned and `blob` is dropped.
 */
export function adoptDecryptedMediaBlob(ref: MediaRef, blob: Blob): string {
  const key = decryptedKey(ref);
  const held = decryptedPool.tryRetain(key);
  if (held) return held;
  const blobUrl = URL.createObjectURL(blob);
  decryptedPool.retain(key, blobUrl, blob.size);
  return blobUrl;
}

/** Releases a decrypted media blob URL acquired via {@link acquireDecryptedMediaBlobUrl}. */
export function releaseDecryptedMediaBlobUrl(ref: MediaRef): void {
  decryptedPool.release(decryptedKey(ref));
}

/**
 * Returns a blob URL for raw (unencrypted) media such as group avatars.
 *
 * @param signal This holder leaving: when it was the last, the load is abandoned - dropped from
 *   `mediaRequestGate`'s queue, or stopped on the wire (`SharedLoad`).
 */
export async function acquireRawMediaBlobUrl(
  mediaId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> {
  return loadRawBlobUrl(mediaId, baseUrl, signal);
}

/** Releases a raw media blob URL acquired via {@link acquireRawMediaBlobUrl}. */
export function releaseRawMediaBlobUrl(mediaId: string): void {
  rawPool.release(mediaId);
}
