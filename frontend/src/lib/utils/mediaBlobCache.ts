import type { MediaRef } from '$lib/media';
import { decryptMediaBuffer } from '$lib/mediaCrypto';
import { BlobUrlPool } from './blobUrlPool';

const CIPHER_CACHE_NAME = 'canari-media-ciphertext-v1';

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
 * Fetches encrypted media bytes, using the Cache API when available so ciphertext
 * survives page reloads without hitting the network again.
 */
async function fetchCiphertext(
  mediaId: string,
  authToken: string,
  baseUrl: string
): Promise<ArrayBuffer> {
  const cacheKey = cipherCacheKey(baseUrl, mediaId);

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CIPHER_CACHE_NAME);
      const hit = await cache.match(cacheKey);
      if (hit) {
        const buf = await hit.arrayBuffer();
        if (buf.byteLength > 0) return buf;
      }
    } catch {
      // Cache API unavailable or read failed - fall through to network.
    }
  }

  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
    {
      headers: { Authorization: `Bearer ${authToken}` },
    }
  );

  if (!res.ok) {
    if (res.status === 410) throw new Error('MEDIA_PURGED_BY_RETENTION');
    throw new Error(`Media download failed: ${res.status} ${res.statusText}`);
  }

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

async function loadDecryptedBlobUrl(
  ref: MediaRef,
  authToken: string,
  baseUrl: string
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
    const ciphertext = await fetchCiphertext(ref.mediaId, authToken, baseUrl);
    const plaintext = await decryptMediaBuffer(ciphertext, ref.key, ref.iv);
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
  authToken: string,
  baseUrl: string
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
    const res = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/media/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${authToken}` } }
    );
    if (!res.ok) {
      if (res.status === 410) throw new Error('MEDIA_PURGED_BY_RETENTION');
      throw new Error(`Avatar download failed: ${res.status}`);
    }
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
 */
export async function acquireDecryptedMediaBlobUrl(
  ref: MediaRef,
  authToken: string,
  baseUrl: string
): Promise<string> {
  return loadDecryptedBlobUrl(ref, authToken, baseUrl);
}

/** Releases a decrypted media blob URL acquired via {@link acquireDecryptedMediaBlobUrl}. */
export function releaseDecryptedMediaBlobUrl(ref: MediaRef): void {
  decryptedPool.release(decryptedKey(ref));
}

/**
 * Returns a blob URL for raw (unencrypted) media such as group avatars.
 */
export async function acquireRawMediaBlobUrl(
  mediaId: string,
  authToken: string,
  baseUrl: string
): Promise<string> {
  return loadRawBlobUrl(mediaId, authToken, baseUrl);
}

/** Releases a raw media blob URL acquired via {@link acquireRawMediaBlobUrl}. */
export function releaseRawMediaBlobUrl(mediaId: string): void {
  rawPool.release(mediaId);
}
