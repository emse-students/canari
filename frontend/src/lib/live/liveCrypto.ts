/**
 * THE LIVE SEGMENT SEAL, FORMAT v1 - what a broadcaster puts in `PUT /api/lives/:id/segments/:index`
 * and what a viewer opens after `fetchLiveSegment`.
 *
 * AES-256-GCM (WebCrypto, the media-CEK path of `$lib/mediaCrypto` - not WASM, which holds the MLS
 * group state only) with the live key, a fresh random 12-byte IV per segment:
 *
 *   sealed = iv(12) || ciphertext || tag(16)
 *   plain  = ONE self-contained fMP4 segment: the recorder's init (`ftyp` + `moov`), then ONE
 *            fragment (`moof` + `mdat`) - nothing else
 *   AAD    = ASCII "canari-live-v1" || 0x00 || liveId (16 raw uuid bytes) || index (u32 big-endian)
 *
 * The AAD binds a segment to its live, its index and the format version, so the storage, a cache or
 * a hostile path can neither replay it under another live, reorder it within one, nor have it read
 * as another format. Each segment is an independent object: no `segmented-v1` framing.
 * Reasoning and the owed review: docs/wiki/frontend/modules/live.md, "The segment seal format, v1".
 *
 * NEVER LOGS key material, plaintext or ciphertext bytes - an index and lengths only.
 */
import { hexDecode } from '$lib/mediaCrypto';
import { Log } from '$lib/utils/Log';

const TAG = 'LiveCrypto';

/** The format label at the head of the AAD; a v2 changes it, so a v1 segment never opens as v2. */
const FORMAT_LABEL = 'canari-live-v1';
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const UUID_BYTES = 16;
const MAX_INDEX = 0xffff_ffff;
const KEY_HEX_RE = /^[0-9a-f]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A sealed segment that does not open. `malformed`: too short to hold an IV and a tag.
 * `unauthentic`: GCM refused it - wrong key, wrong live, wrong index, wrong format version, or a
 * changed byte; GCM cannot tell those apart, and no caller should try.
 * Typed at the throw so a viewer branches on the class (skip the segment), never on a message.
 */
export class LiveSegmentOpenError extends Error {
  readonly reason: 'malformed' | 'unauthentic';
  readonly index: number;

  constructor(reason: 'malformed' | 'unauthentic', index: number, sealedBytes: number) {
    super(`live segment ${index} (${sealedBytes} bytes) did not open: ${reason}`);
    this.name = 'LiveSegmentOpenError';
    this.reason = reason;
    this.index = index;
  }
}

/** Refuses an argument no caller should ever pass - a programming error, so a RangeError. */
function checkArgs(keyHex: string, liveId: string, index: number): void {
  if (!KEY_HEX_RE.test(keyHex)) throw new RangeError('live key must be 64 hex characters');
  if (!UUID_RE.test(liveId)) throw new RangeError('live id must be a uuid');
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError(`live segment index out of u32 range: ${index}`);
  }
}

/** The v1 AAD: label || 0x00 || the uuid's 16 raw bytes || index as u32 big-endian. */
function buildAad(liveId: string, index: number): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(FORMAT_LABEL);
  const aad = new Uint8Array(label.length + 1 + UUID_BYTES + 4);
  aad.set(label, 0);
  aad[label.length] = 0x00;
  aad.set(hexDecode(liveId.replaceAll('-', '')), label.length + 1);
  new DataView(aad.buffer).setUint32(label.length + 1 + UUID_BYTES, index, false);
  return aad;
}

/** Imports the live key for one operation; non-extractable, so nothing can read it back out. */
function importLiveKey(keyHex: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexDecode(keyHex),
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/**
 * Seals one segment's fMP4 bytes for upload. Every call draws a fresh random IV, so sealing the
 * same bytes twice gives two different outputs (a retried upload re-sends the SAME sealed bytes,
 * which is what keeps the server's idempotent repeat idempotent - never re-seal on a retry).
 */
export async function sealLiveSegment(
  keyHex: string,
  liveId: string,
  index: number,
  plain: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  // Copied BEFORE the first await: a caller reusing its buffer while the seal runs must not change
  // what is sealed (the bytes read at the call are the bytes sealed).
  const own = plain.slice();
  Log.d(TAG, { op: 'seal', index, plainBytes: own.byteLength });
  checkArgs(keyHex, liveId, index);
  const key = await importLiveKey(keyHex, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: buildAad(liveId, index), tagLength: 128 },
      key,
      own
    )
  );
  const sealed = new Uint8Array(IV_BYTES + body.byteLength);
  sealed.set(iv, 0);
  sealed.set(body, IV_BYTES);
  return sealed;
}

/**
 * Opens one sealed segment back to its fMP4 bytes. Throws {@link LiveSegmentOpenError} for any
 * segment that is not exactly what the broadcaster sealed for THIS live and THIS index, and a
 * RangeError for an argument no caller should pass.
 */
export async function openLiveSegment(
  keyHex: string,
  liveId: string,
  index: number,
  sealed: Uint8Array | ArrayBuffer
): Promise<Uint8Array<ArrayBuffer>> {
  // Copied BEFORE the first await, for the same reason as the seal: the bytes read at the call are
  // the bytes opened, whatever the caller does with its buffer meanwhile.
  const bytes = sealed instanceof Uint8Array ? sealed.slice() : new Uint8Array(sealed.slice(0));
  Log.d(TAG, { op: 'open', index, sealedBytes: bytes.byteLength });
  checkArgs(keyHex, liveId, index);
  if (bytes.byteLength < IV_BYTES + GCM_TAG_BYTES) {
    Log.d(TAG, { op: 'open', index, refused: 'malformed', sealedBytes: bytes.byteLength });
    throw new LiveSegmentOpenError('malformed', index, bytes.byteLength);
  }
  const key = await importLiveKey(keyHex, 'decrypt');
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.subarray(0, IV_BYTES),
        additionalData: buildAad(liveId, index),
        tagLength: 128,
      },
      key,
      bytes.subarray(IV_BYTES)
    );
    return new Uint8Array(plain);
  } catch (e) {
    // WebCrypto's only failure here is an OperationError (the tag did not verify); the cause is
    // logged by class, never with any byte of the segment.
    Log.d(TAG, {
      op: 'open',
      index,
      refused: 'unauthentic',
      sealedBytes: bytes.byteLength,
      cause: e instanceof Error ? e.name : typeof e,
    });
    throw new LiveSegmentOpenError('unauthentic', index, bytes.byteLength);
  }
}
