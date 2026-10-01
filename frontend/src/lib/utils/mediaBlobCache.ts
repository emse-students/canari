import type { MediaRef } from '$lib/media';
import { decryptMediaBuffer } from '$lib/mediaCrypto';
import {
  SEGMENTED_MEDIA_ENCODING,
  SegmentedMediaError,
  decryptSegmentedMediaBuffer,
} from '$lib/mediaSegmented';
import { getToken } from '$lib/stores/auth';
import { BlobUrlPool } from './blobUrlPool';
import {
  MediaDecryptError,
  MediaDownloadError,
  MediaNotFoundError,
  MediaPurgedError,
  MediaUnreachableError,
} from './mediaErrors';
import { noteMediaCacheHit } from './mediaTouch';
import { mediaRequestGate } from './requestGate';

/** Exported so `deviceStorage.ts` can measure/clear it without duplicating the literal. */
export const CIPHER_CACHE_NAME = 'canari-media-ciphertext-v1';

const decryptedPool = new BlobUrlPool();
const rawPool = new BlobUrlPool();
const inflightDecrypted = new Map<string, Promise<string>>();
const inflightRaw = new Map<string, Promise<string>>();

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
 */
async function fetchMediaObject(
  mediaId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<Response> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`;
  const res = await mediaRequestGate.run(async () => {
    const headers = { Authorization: `Bearer ${await getToken()}` };
    try {
      return await fetch(url, { headers });
    } catch (err) {
      throw new MediaUnreachableError(err);
    }
  }, signal);
  if (res.ok) return res;
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
  signal?: AbortSignal
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
  const res = await fetchMediaObject(mediaId, baseUrl, signal);
  const ciphertext = await res.arrayBuffer();

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

async function loadDecryptedBlobUrl(
  ref: MediaRef,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const key = decryptedKey(ref);
  const cached = decryptedPool.tryRetain(key);
  if (cached) return cached;

  const pending = inflightDecrypted.get(key);
  if (pending) {
    const url = await pending;
    return decryptedPool.tryRetain(key) ?? url;
  }

  const promise = (async () => {
    const ciphertext = await fetchCiphertext(ref.mediaId, baseUrl, signal);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await decryptByEncoding(ref, ciphertext);
    } catch (err) {
      // A cached copy that will never decrypt would answer every retry the same way: the retry
      // the reader is offered must download the object again, not re-read the damaged one. A
      // segmented blob refused for what it holds (`SegmentedMediaError`) is the same cause.
      await evictCiphertext(ref.mediaId, baseUrl);
      throw new MediaDecryptError(err);
    }
    const blobUrl = URL.createObjectURL(new Blob([plaintext], { type: ref.mimeType }));
    decryptedPool.retain(key, blobUrl);
    return blobUrl;
  })();

  inflightDecrypted.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightDecrypted.delete(key);
  }
}

async function loadRawBlobUrl(
  mediaId: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const key = mediaId;
  const cached = rawPool.tryRetain(key);
  if (cached) return cached;

  const pending = inflightRaw.get(key);
  if (pending) {
    const url = await pending;
    return rawPool.tryRetain(key) ?? url;
  }

  const promise = (async () => {
    const res = await fetchMediaObject(mediaId, baseUrl, signal);
    const blobUrl = URL.createObjectURL(await res.blob());
    rawPool.retain(key, blobUrl);
    return blobUrl;
  })();

  inflightRaw.set(key, promise);
  try {
    return await promise;
  } finally {
    inflightRaw.delete(key);
  }
}

/**
 * Returns a blob URL for decrypted post/chat media, reusing cached ciphertext and
 * decrypted blobs when possible.
 *
 * @param signal Drops the request from `mediaRequestGate`'s queue if it has not started yet.
 */
export async function acquireDecryptedMediaBlobUrl(
  ref: MediaRef,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> {
  return loadDecryptedBlobUrl(ref, baseUrl, signal);
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
  decryptedPool.retain(key, blobUrl);
  return blobUrl;
}

/** Releases a decrypted media blob URL acquired via {@link acquireDecryptedMediaBlobUrl}. */
export function releaseDecryptedMediaBlobUrl(ref: MediaRef): void {
  decryptedPool.release(decryptedKey(ref));
}

/**
 * Returns a blob URL for raw (unencrypted) media such as group avatars.
 *
 * @param signal Drops the request from `mediaRequestGate`'s queue if it has not started yet.
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
