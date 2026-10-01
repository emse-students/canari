/**
 * SEGMENTED MEDIA ENCRYPTION - a file sealed in ~1 MB pieces, each with its own tag, so a reader can
 * decrypt and play the first piece before the last one has arrived (CanaReels R2).
 *
 * # Why a second format
 *
 * The single-block format (`mediaCrypto.ts`) is ONE AES-GCM operation under ONE IV, and GCM's tag
 * closes the file: not one byte of it may be trusted before the last byte is in hand, so nothing can
 * play before the download ends. Cutting the file into independently authenticated segments is what
 * lets a reader verify and use segment 0 while segment 1 is still on the wire.
 *
 * # The construction - STREAM
 *
 * Hoang, Reyhanitabar, Rogaway and Vizar, *Online Authenticated-Encryption and its Nonce-Reuse
 * Misuse-Resistance* (CRYPTO 2015), section 7: the "STREAM" construction, the one Tink's
 * `AesGcmHkdfStreaming` and age's payload format instantiate. Segment `i` is sealed under the
 * file's key with the nonce
 *
 * ```
 * nonce_i = prefix (7 bytes) || be32(i) || lastFlag (1 byte: 0x00, or 0x01 on the final segment)
 * ```
 *
 * where `prefix` is the first seven bytes of the 12-byte random IV the `MediaRef` already carries.
 * Binding the INDEX into the nonce is what makes a REORDERED or DUPLICATED segment fail its tag;
 * binding the LAST flag is what makes a TRUNCATED file fail - a file cut after segment `k` presents
 * a segment `k` sealed with flag 0, which never verifies as a final one. Every segment also takes
 * the header below as its AES-GCM additional data, so a header edited in transit (a different
 * segment size, a different length) fails every segment rather than misplacing them.
 *
 * Uniqueness of the nonce needs no counter across files: the CEK is minted fresh for every file
 * (`generateMediaCek`), so a nonce only has to be unique WITHIN one file, which the index guarantees.
 *
 * # The bytes
 *
 * ```
 * header (20) = "CANARIM" (7) || version 0x01 (1) || be32(segmentPlaintextBytes) || be64(plaintextLength)
 * blob        = header || seal(segment 0) || seal(segment 1) || ... || seal(segment n-1)
 * seal(s)     = AES-256-GCM(CEK, nonce_i, s, aad = header) = ciphertext(|s|) || tag (16)
 * ```
 *
 * Every segment holds `segmentPlaintextBytes` of plaintext except the last, which holds the rest -
 * between 1 byte and a full segment, and exactly 0 bytes only for an empty file (one empty segment).
 *
 * # Why the REF decides the format, and the header only confirms it
 *
 * A legacy blob is raw GCM ciphertext: random bytes. Asking the BYTES "are you segmented" would make
 * the answer a 2^-64 coincidence and a misread blob a confusing failure. The `MediaRef` already
 * travels inside the authenticated message (MLS, a Graine row, a post row), so it carries the format
 * as a fact - `encoding: 'segmented-v1'`, absent on every ref written before it - and the reader is
 * chosen from that field BEFORE a byte is read. A header that then disagrees is refused with a typed
 * error, never re-read as legacy: that retry would be a fallback. See channel-encryption section 21
 * and the state blob's framing (`mls-core/src/state_blob.rs`) for the same read-first, write-later
 * order this format ships in.
 */

import { generateMediaCek, generateMediaIv, hexDecode, importMediaCek } from '$lib/mediaCrypto';

/** The value a `MediaRef.encoding` carries for this format. Absent means single-block (legacy). */
export const SEGMENTED_MEDIA_ENCODING = 'segmented-v1' as const;

/** Every encoding a ref may name besides the legacy single block (which names none). */
export type MediaEncoding = typeof SEGMENTED_MEDIA_ENCODING;

/**
 * THE WRITER FLIP - `false` IN THE READER RELEASE, AND THAT IS THE WHOLE OF THIS RELEASE'S SAFETY.
 *
 * A client older than the reader, handed a segmented blob, decrypts it as ONE GCM block: the header
 * and every tag are fed in as ciphertext, the final tag fails, and the member sees a broken video
 * that their own phone, not the sender's, is at fault for. So this ships in two releases, as Graine
 * v2 (channel-encryption section 21) and the state blob's framing did:
 *
 * 1. THIS release reads the format everywhere it is read (web and both app shells, which embed the
 *    same frontend) and writes nothing in it.
 * 2. The flip to `true` is ONE line, and it may land only when ALL of these hold:
 *    - `minClientVersion` (the box's `/version`) is at or above the release carrying this reader,
 *      so no client that cannot read a segmented blob is still allowed to connect;
 *    - BOTH stores serve that version - measured with `bun tools/play-vitals/vitals.mjs` and the App
 *      Store, never inferred from a date;
 *    - the media-service serving the estate answers `206` to a `Range` request (shipped with this
 *      reader, `media.controller.ts`), since the streaming reader refuses a `200`.
 *
 * Only VIDEO is segmented even then ({@link writesSegmented}): a picture is shown whole anyway, and
 * the readers that only ever open pictures - the native push thumbnail and the post link preview -
 * then never meet the format (both also refuse it by the ref's field, never by failing on it).
 */
export const SEGMENTED_MEDIA_WRITER_ENABLED = false;

/** `"CANARIM"`: the format's magic, seven ASCII bytes. */
export const SEGMENTED_MEDIA_MAGIC = new Uint8Array([0x43, 0x41, 0x4e, 0x41, 0x52, 0x49, 0x4d]);

/** The only version of the header that exists. Any other is refused by name, never guessed at. */
export const SEGMENTED_MEDIA_VERSION = 1;

/** Magic (7) + version (1) + be32 segment size (4) + be64 plaintext length (8). */
export const SEGMENTED_MEDIA_HEADER_BYTES = 20;

/** Plaintext bytes per segment as the writer cuts them: 1 MiB. */
export const SEGMENTED_MEDIA_SEGMENT_BYTES = 1024 * 1024;

/**
 * The bounds a READER accepts for a segment size, since the header is read before anything is
 * authenticated: a header naming a 4 GB segment would otherwise size a single allocation.
 */
const MIN_SEGMENT_BYTES = 4 * 1024;
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

/** AES-GCM tag length - appended to every segment by WebCrypto. */
export const SEGMENT_TAG_BYTES = 16;

/** How many leading bytes of the ref's 12-byte IV form the nonce prefix (STREAM's `prefix`). */
const NONCE_PREFIX_BYTES = 7;

/** Why a segmented blob was refused. One code per cause, so no caller ever reads the message. */
export type SegmentedMediaFault =
  /** The ref names an encoding this client does not know - a NEWER client wrote it. */
  | 'encoding'
  /** The blob is shorter than its own header. */
  | 'header-short'
  /** The first seven bytes are not `CANARIM`: the ref says segmented, the bytes do not. */
  | 'magic'
  /** A header version this client does not know - a NEWER client wrote it. */
  | 'version'
  /** A segment size outside the bounds a reader will allocate. */
  | 'segment-size'
  /** The blob's length is not the one its header announces - truncated, or extended. */
  | 'length'
  /** A segment's tag did not verify: altered, reordered, moved, or a false final segment. */
  | 'segment-auth'
  /** The ref's IV is not 12 bytes. */
  | 'iv';

/**
 * A segmented blob that cannot be read, classified where it was found to be wrong.
 *
 * A FAULT, never a transport failure: the bytes arrived and are not what the ref promised. So it is
 * reported once at ERROR by its reader and never retried - another download returns the same bytes.
 */
export class SegmentedMediaError extends Error {
  /**
   * @param fault        The cause, as a code.
   * @param segmentIndex The segment that failed, for `segment-auth`.
   */
  constructor(
    readonly fault: SegmentedMediaFault,
    message: string,
    readonly segmentIndex?: number
  ) {
    super(message);
    this.name = 'SegmentedMediaError';
  }
}

/** True when a rejection is a segmented blob refused for what it holds. */
export function isSegmentedMediaError(err: unknown): err is SegmentedMediaError {
  return err instanceof SegmentedMediaError;
}

/** What a header says, parsed - the layout every offset below is computed from. */
export interface SegmentedMediaHeader {
  /** The 20 header bytes themselves: every segment's additional data. */
  bytes: Uint8Array<ArrayBuffer>;
  segmentPlaintextBytes: number;
  plaintextLength: number;
  /** Always at least one: an empty file is one empty final segment. */
  segmentCount: number;
  /** Header plus every sealed segment: the exact length of the stored blob. */
  ciphertextLength: number;
}

/**
 * Whether a file of this type is written segmented. `false` for everything while
 * {@link SEGMENTED_MEDIA_WRITER_ENABLED} is off, and only ever `true` for video.
 *
 * @param mimeType The picked file's type.
 */
export function writesSegmented(mimeType: string): boolean {
  return SEGMENTED_MEDIA_WRITER_ENABLED && mimeType.startsWith('video/');
}

/** Number of segments a plaintext of this length is cut into. */
function segmentCountFor(plaintextLength: number, segmentBytes: number): number {
  return Math.max(1, Math.ceil(plaintextLength / segmentBytes));
}

/**
 * The stored length of a segmented blob holding `plaintextLength` bytes: the header plus one tag
 * per segment. What the upload ceiling has to subtract when the writer is on.
 *
 * @param plaintextLength The file's size.
 * @param segmentBytes    The segment size (the writer's default when omitted).
 */
export function segmentedCiphertextLength(
  plaintextLength: number,
  segmentBytes: number = SEGMENTED_MEDIA_SEGMENT_BYTES
): number {
  return (
    SEGMENTED_MEDIA_HEADER_BYTES +
    plaintextLength +
    segmentCountFor(plaintextLength, segmentBytes) * SEGMENT_TAG_BYTES
  );
}

/** Builds the 20 header bytes. */
export function encodeSegmentedHeader(
  segmentPlaintextBytes: number,
  plaintextLength: number
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(SEGMENTED_MEDIA_HEADER_BYTES);
  bytes.set(SEGMENTED_MEDIA_MAGIC, 0);
  bytes[7] = SEGMENTED_MEDIA_VERSION;
  const view = new DataView(bytes.buffer);
  view.setUint32(8, segmentPlaintextBytes);
  view.setBigUint64(12, BigInt(plaintextLength));
  return bytes;
}

/**
 * Reads a header, refusing anything this client cannot vouch for. Nothing here is authenticated
 * yet - the header is every segment's additional data, so a forged one is caught by the first
 * segment's tag - which is why the sizes are BOUNDED before anything is allocated from them.
 *
 * @param prefix At least the first {@link SEGMENTED_MEDIA_HEADER_BYTES} bytes of the blob.
 * @throws {SegmentedMediaError} `header-short`, `magic`, `version` or `segment-size`.
 */
export function parseSegmentedHeader(prefix: Uint8Array): SegmentedMediaHeader {
  if (prefix.byteLength < SEGMENTED_MEDIA_HEADER_BYTES) {
    throw new SegmentedMediaError(
      'header-short',
      `segmented media: ${prefix.byteLength} bytes, shorter than its ${SEGMENTED_MEDIA_HEADER_BYTES}-byte header`
    );
  }
  for (let i = 0; i < SEGMENTED_MEDIA_MAGIC.length; i++) {
    if (prefix[i] !== SEGMENTED_MEDIA_MAGIC[i]) {
      throw new SegmentedMediaError('magic', 'segmented media: the header magic is not CANARIM');
    }
  }
  if (prefix[7] !== SEGMENTED_MEDIA_VERSION) {
    throw new SegmentedMediaError(
      'version',
      `segmented media: header version ${prefix[7]} is unknown to this client`
    );
  }
  const bytes = new Uint8Array(prefix.slice(0, SEGMENTED_MEDIA_HEADER_BYTES));
  const view = new DataView(bytes.buffer);
  const segmentPlaintextBytes = view.getUint32(8);
  const plaintextLengthBig = view.getBigUint64(12);
  if (segmentPlaintextBytes < MIN_SEGMENT_BYTES || segmentPlaintextBytes > MAX_SEGMENT_BYTES) {
    throw new SegmentedMediaError(
      'segment-size',
      `segmented media: segment size ${segmentPlaintextBytes} is outside [${MIN_SEGMENT_BYTES}, ${MAX_SEGMENT_BYTES}]`
    );
  }
  if (plaintextLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SegmentedMediaError('length', 'segmented media: plaintext length is not addressable');
  }
  const plaintextLength = Number(plaintextLengthBig);
  return {
    bytes,
    segmentPlaintextBytes,
    plaintextLength,
    segmentCount: segmentCountFor(plaintextLength, segmentPlaintextBytes),
    ciphertextLength: segmentedCiphertextLength(plaintextLength, segmentPlaintextBytes),
  };
}

/**
 * Where segment `index` sits in the stored blob, as `[start, endExclusive)` byte offsets - what a
 * ranged read asks for. Every segment but the last is the same size, so this is arithmetic.
 */
export function segmentCiphertextRange(
  header: SegmentedMediaHeader,
  index: number
): [number, number] {
  const sealed = header.segmentPlaintextBytes + SEGMENT_TAG_BYTES;
  const start = SEGMENTED_MEDIA_HEADER_BYTES + index * sealed;
  const plainStart = index * header.segmentPlaintextBytes;
  const plainLen = Math.min(header.segmentPlaintextBytes, header.plaintextLength - plainStart);
  return [start, start + Math.max(0, plainLen) + SEGMENT_TAG_BYTES];
}

/**
 * The segment holding plaintext byte `offset` - how a seek lands on the one segment it needs.
 * An offset at or past the end lands on the final segment.
 */
export function segmentIndexForPlaintextOffset(
  header: SegmentedMediaHeader,
  offset: number
): number {
  const index = Math.floor(Math.max(0, offset) / header.segmentPlaintextBytes);
  return Math.min(index, header.segmentCount - 1);
}

/**
 * STREAM's per-segment nonce: the IV's first seven bytes, the big-endian index, the final flag.
 *
 * @param baseIv The ref's 12-byte IV.
 * @param index  The segment's position, from 0.
 * @param last   Whether it is the final segment.
 */
export function segmentNonce(
  baseIv: Uint8Array,
  index: number,
  last: boolean
): Uint8Array<ArrayBuffer> {
  if (baseIv.byteLength !== 12) {
    throw new SegmentedMediaError(
      'iv',
      `segmented media: IV is ${baseIv.byteLength} bytes, not 12`
    );
  }
  const nonce = new Uint8Array(12);
  nonce.set(baseIv.subarray(0, NONCE_PREFIX_BYTES), 0);
  new DataView(nonce.buffer).setUint32(NONCE_PREFIX_BYTES, index);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** What the writer hands the upload: the blob, and the key and IV the ref will carry. */
export interface SegmentedEncryptedMedia {
  ciphertext: ArrayBuffer;
  keyHex: string;
  ivHex: string;
}

/**
 * THE WRITER: seals `plaintext` as a segmented blob under a fresh CEK and IV.
 *
 * Production calls it only through {@link writesSegmented}; the tests call it directly, which is
 * what proves the reader against the format rather than against itself.
 *
 * @param plaintext    The file's bytes.
 * @param segmentBytes The segment size - the default except in tests that need several segments
 *                     out of a few kilobytes.
 */
export async function encryptSegmentedMedia(
  plaintext: ArrayBuffer,
  segmentBytes: number = SEGMENTED_MEDIA_SEGMENT_BYTES
): Promise<SegmentedEncryptedMedia> {
  const { cryptoKey, keyHex } = await generateMediaCek();
  const { iv, ivHex } = generateMediaIv();
  const header = encodeSegmentedHeader(segmentBytes, plaintext.byteLength);
  const count = segmentCountFor(plaintext.byteLength, segmentBytes);
  console.debug(
    `[media-seg] encrypt: ${plaintext.byteLength} bytes in ${count} segment(s) of ${segmentBytes}`
  );

  const out = new Uint8Array(segmentedCiphertextLength(plaintext.byteLength, segmentBytes));
  out.set(header, 0);
  let offset = SEGMENTED_MEDIA_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const segment = plaintext.slice(
      i * segmentBytes,
      Math.min((i + 1) * segmentBytes, plaintext.byteLength)
    );
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: segmentNonce(iv, i, i === count - 1), additionalData: header },
      cryptoKey,
      segment
    );
    out.set(new Uint8Array(sealed), offset);
    offset += sealed.byteLength;
  }
  return { ciphertext: out.buffer, keyHex, ivHex };
}

/**
 * Opens ONE sealed segment.
 *
 * WebCrypto answers a tag that does not verify with an `OperationError` and nothing else, so the
 * refusal is CLASSIFIED HERE, at the throw, into a {@link SegmentedMediaError} carrying the index -
 * no caller ever has to read a DOMException's message to learn that the bytes were wrong.
 *
 * @param key     The imported CEK.
 * @param baseIv  The ref's IV.
 * @param header  The parsed header (its bytes are the additional data).
 * @param index   Which segment `sealed` claims to be.
 * @param sealed  Exactly that segment's bytes, tag included.
 * @throws {SegmentedMediaError} `segment-auth` when the tag does not verify.
 */
export async function openSegment(
  key: CryptoKey,
  baseIv: Uint8Array,
  header: SegmentedMediaHeader,
  index: number,
  sealed: Uint8Array<ArrayBuffer>
): Promise<ArrayBuffer> {
  const last = index === header.segmentCount - 1;
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: segmentNonce(baseIv, index, last), additionalData: header.bytes },
      key,
      sealed
    );
  } catch (e) {
    if (isSegmentedMediaError(e)) throw e;
    console.error(
      `[media-seg] segment ${index}/${header.segmentCount} refused: its tag did not verify`
    );
    throw new SegmentedMediaError(
      'segment-auth',
      `segmented media: segment ${index} of ${header.segmentCount} did not authenticate`,
      index
    );
  }
}

/** The CEK and IV of a ref, ready for {@link openSegment}. */
export async function importSegmentedKey(
  keyHex: string,
  ivHex: string
): Promise<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer> }> {
  const iv = hexDecode(ivHex);
  if (iv.byteLength !== 12) {
    throw new SegmentedMediaError('iv', `segmented media: IV is ${iv.byteLength} bytes, not 12`);
  }
  return { key: await importMediaCek(keyHex), iv };
}

/**
 * Decrypts a WHOLE segmented blob held in memory - the path every non-streaming surface takes (a
 * picture, a download, the lightbox, a blob read back from the ciphertext cache).
 *
 * The blob's length must be EXACTLY what its header announces: shorter is a truncation, longer is
 * bytes nobody sealed, and both are refused before a segment is opened.
 *
 * @param onSegment Called with each verified plaintext segment in order, so a caller can hand them
 *                  on as they come instead of waiting for the whole.
 * @throws {SegmentedMediaError} for any header, length or segment fault.
 */
export async function decryptSegmentedMediaBuffer(
  ciphertext: ArrayBuffer,
  keyHex: string,
  ivHex: string,
  onSegment?: (plaintext: ArrayBuffer, index: number) => void
): Promise<ArrayBuffer> {
  const all = new Uint8Array(ciphertext);
  const header = parseSegmentedHeader(all);
  if (all.byteLength !== header.ciphertextLength) {
    console.error(
      `[media-seg] blob is ${all.byteLength} bytes, header announces ${header.ciphertextLength}`
    );
    throw new SegmentedMediaError(
      'length',
      `segmented media: ${all.byteLength} bytes where the header announces ${header.ciphertextLength}`
    );
  }
  const { key, iv } = await importSegmentedKey(keyHex, ivHex);
  const out = new Uint8Array(header.plaintextLength);
  for (let i = 0; i < header.segmentCount; i++) {
    const [start, end] = segmentCiphertextRange(header, i);
    const plain = await openSegment(key, iv, header, i, all.slice(start, end));
    out.set(new Uint8Array(plain), i * header.segmentPlaintextBytes);
    onSegment?.(plain, i);
  }
  return out.buffer;
}
