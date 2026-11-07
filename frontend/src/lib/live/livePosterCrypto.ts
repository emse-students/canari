/**
 * THE LIVE PREVIEW IMAGE SEAL, FORMAT v1 (owner, 2026-11-07) - what a broadcaster puts in
 * `PUT /api/lives/:id/poster` and what a feed card opens after `fetchLivePoster`.
 *
 * The segment seal's construction (`liveCrypto.ts`), with its own label so neither can be read as the
 * other:
 *
 *   sealed = iv(12) || ciphertext || tag(16)        AES-256-GCM under the live key, a fresh IV each
 *   plain  = ONE JPEG still frame, nothing else
 *   AAD    = ASCII "canari-live-poster-v1" || 0x00 || liveId (16 raw uuid bytes)
 *
 * No index in the AAD: a live has ONE current preview, named by the list, and its age is the
 * server's `posterAt` - so an older poster served in place of the newest is what the server could do
 * anyway (it holds the key, as for every segment), and nothing a viewer acts on depends on it.
 *
 * NEVER LOGS key material, plaintext or ciphertext bytes - lengths only.
 */
import { Log } from '$lib/utils/Log';
import { importLiveKey, uuidBytes } from './liveCrypto';

const TAG = 'LivePosterCrypto';
const FORMAT_LABEL = 'canari-live-poster-v1';
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A sealed preview that does not open: `malformed` (shorter than an IV and a tag) or `unauthentic`
 * (GCM refused it - wrong key, wrong live, another format, a changed byte). Typed at the throw: the
 * card draws no picture for it, and never branches on a message.
 */
export class LivePosterOpenError extends Error {
  readonly reason: 'malformed' | 'unauthentic';

  constructor(reason: 'malformed' | 'unauthentic', sealedBytes: number) {
    super(`live poster (${sealedBytes} bytes) did not open: ${reason}`);
    this.name = 'LivePosterOpenError';
    this.reason = reason;
  }
}

/** A programming error (no caller should pass these), so a RangeError. */
function checkArgs(keyHex: string, liveId: string): void {
  if (!KEY_HEX_RE.test(keyHex)) throw new RangeError('live key must be 64 hex characters');
  if (!UUID_RE.test(liveId)) throw new RangeError('live id must be a uuid');
}

/** The v1 AAD: label || 0x00 || the live id's 16 raw bytes. */
function buildAad(liveId: string): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(FORMAT_LABEL);
  const aad = new Uint8Array(label.length + 1 + 16);
  aad.set(label, 0);
  aad[label.length] = 0x00;
  aad.set(uuidBytes(liveId), label.length + 1);
  return aad;
}

/** Seals one JPEG frame for upload. Copies the input before the first await, as the segment seal. */
export async function sealLivePoster(
  keyHex: string,
  liveId: string,
  plain: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  const own = plain.slice();
  Log.d(TAG, { op: 'seal', plainBytes: own.byteLength });
  checkArgs(keyHex, liveId);
  const key = await importLiveKey(keyHex, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(liveId), tagLength: 128 },
      key,
      own
    )
  );
  const sealed = new Uint8Array(IV_BYTES + body.byteLength);
  sealed.set(iv, 0);
  sealed.set(body, IV_BYTES);
  return sealed;
}

/** Opens one sealed preview back to its JPEG bytes, or throws {@link LivePosterOpenError}. */
export async function openLivePoster(
  keyHex: string,
  liveId: string,
  sealed: Uint8Array | ArrayBuffer
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = sealed instanceof Uint8Array ? sealed.slice() : new Uint8Array(sealed.slice(0));
  checkArgs(keyHex, liveId);
  if (bytes.byteLength < IV_BYTES + GCM_TAG_BYTES) {
    Log.d(TAG, { op: 'open', refused: 'malformed', sealedBytes: bytes.byteLength });
    throw new LivePosterOpenError('malformed', bytes.byteLength);
  }
  const key = await importLiveKey(keyHex, 'decrypt');
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: buildAad(liveId),
        tagLength: 128,
      },
      key,
      bytes.subarray(IV_BYTES)
    );
    return new Uint8Array(plain);
  } catch (e) {
    Log.d(TAG, {
      op: 'open',
      refused: 'unauthentic',
      sealedBytes: bytes.byteLength,
      cause: e instanceof Error ? e.name : typeof e,
    });
    throw new LivePosterOpenError('unauthentic', bytes.byteLength);
  }
}
