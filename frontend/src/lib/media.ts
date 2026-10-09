/**
 * media.ts - Client-side media encryption / upload / download
 *
 * Security model
 * ──────────────
 * The media service stores ONLY opaque ciphertext blobs.  The decryption key
 * is never sent to or stored on the server.  Instead it is embedded inside the
 * MLS-encrypted application message, so:
 *
 *  - Only group members can decrypt the content.
 *  - The key inherits MLS forward secrecy and group membership control.
 *  - Key rotation is handled naturally by MLS epoch changes.
 *  - Works identically for 1-to-1 chats (2-member group) and multi-party groups.
 *
 * Encryption scheme: AES-256-GCM (via SubtleCrypto - no extra dependency)
 *   - 256-bit random CEK (Content Encryption Key) per file
 *   - 96-bit random IV per file
 *   - Authentication tag is appended by SubtleCrypto automatically (16 bytes)
 *
 * Wire format embedded in the MLS message (JSON string):
 * {
 *   "type":     "image" | "video" | "file",
 *   "mediaId":  string,          // opaque server-side id
 *   "key":      string,          // hex-encoded 32-byte CEK
 *   "iv":       string,          // hex-encoded 12-byte IV
 *   "mimeType": string,
 *   "size":     number,          // original (plaintext) file size in bytes
 *   "fileName": string | undefined,
 *   "voiceNote": true | undefined, // recorded here, not picked from disk
 *   "encoding": "segmented-v1" | undefined // absent = ONE AES-GCM block (mediaSegmented.ts)
 * }
 *
 * Messages that do NOT match this shape are treated as plain text (backward compat).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaType = 'image' | 'video' | 'audio' | 'file';

/**
 * Which retention the media service applies to an uploaded object. The server stores ciphertext
 * and has no way to tell surfaces apart, which is why the caller says so.
 *
 * The media service's idle sweep is an ALLOWLIST: it deletes `'ephemeral'` and nothing else.
 * - `'ephemeral'` - chat and channel media, deleted once nobody has opened them for the window.
 * - `'archive'` - the feed (a post, a post comment, an avatar): a permanent row cites the object.
 * - `'association'` - an association's vault document: kept for ever, and it survives the
 *   uploader's account deletion because it belongs to the association.
 * - `'reel'` - a CanaReels video: kept by the idle sweep, deleted with its reel 30 days after
 *   publication by social-service's reel worker, which claims the blob at publication
 *   ([reels (server)](docs/wiki/services/reels.md)).
 * - `'chat-reel'` - a CanaReel sent in a conversation: deleted by AGE, 30 days after upload, and
 *   counted against the member's 500 MB a day. Naming it can only SHORTEN an object's life, which
 *   is why the client may set it ([media-service](docs/wiki/services/media-service.md)).
 *
 * An object with no class is KEPT. It used to be the other way round, and an association vault
 * document - uploaded with no class - was swept on production in 2026-09.
 */
export type MediaRetentionClass = 'ephemeral' | 'archive' | 'association' | 'reel' | 'chat-reel';

export interface MediaRef {
  type: MediaType;
  /** Opaque identifier returned by the media service upload endpoint. */
  mediaId: string;
  /** Hex-encoded 32-byte AES-256-GCM Content Encryption Key. */
  key: string;
  /** Hex-encoded 12-byte IV / nonce. */
  iv: string;
  mimeType: string;
  /** Plaintext file size in bytes (for progress / display). */
  size: number;
  fileName?: string;
  /** Display width in px (after compression), used to reserve layout before decrypt. */
  width?: number;
  /** Display height in px (after compression), used to reserve layout before decrypt. */
  height?: number;
  /**
   * A ThumbHash of the picture, base64 (`MediaMsg.placeholder`), painted in the reserved box while
   * the blob downloads. Made by the SENDER (`mediaPlaceholder.ts`): the server holds ciphertext and
   * can make no preview. Absent on every ref before 2026-10-02 and on non-visual media.
   */
  placeholder?: string;
  /**
   * Recorded by the composer's microphone rather than picked from disk.
   *
   * **DECLARED BY THE SENDER, BECAUSE NOTHING DOWNSTREAM CAN TELL.** A voice note and an imported
   * `.m4a` are the same bytes with the same mime type; the recorder's `vocal_<ts>` file name is a
   * distinction carried in prose, and `isAudioFile` in `ChatComposer` already refuses to read it
   * for exactly that reason. `type` stays `'audio'` either way - this says how the audio was
   * produced, not what it is.
   *
   * Absent on every message sent before 2026-09-17, and absent is NOT "imported": it is unknown,
   * and those messages keep the behaviour they have always had.
   */
  voiceNote?: boolean;
  /**
   * How the blob is sealed, DECLARED BY THE WRITER because the bytes cannot say it unambiguously.
   *
   * Absent: ONE AES-GCM operation under `iv`, the format of every ref written before CanaReels R2,
   * readable for ever. `'segmented-v1'`: the STREAM construction of `mediaSegmented.ts`, which a
   * reader can decrypt and play segment by segment. The reader is chosen from this field before a
   * byte is read, never by trying one format and then the other. Any OTHER value was written by a
   * newer client and is refused by the reader rather than guessed at, which is why the type is a
   * string and not just the one value this client writes.
   */
  encoding?: string;
  /**
   * What the media is FOR, DECLARED BY THE SENDER (`MediaMsg.intent`): `'reel-message'` is a CanaReel
   * sent in a conversation - drawn as a tile and played in the reel viewer, never as a chat video.
   * Absent is an ordinary attachment, and so is any proto value this client does not know: a newer
   * intent must degrade to "a video", never to an error
   * ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md)).
   */
  intent?: MediaIntent;
  /** Declared length in milliseconds (`MediaMsg.duration_ms`), drawn on the tile before a fetch. */
  durationMs?: number;
  /**
   * When the blob is expected to be gone, epoch milliseconds (`MediaMsg.expires_at_ms`). A DISPLAY
   * HINT that lets the tile draw its tombstone without a request: the server's clock is the
   * authority and a 410 is the truth.
   */
  expiresAtMs?: number;
}

/** The intents a client can name; see {@link MediaRef.intent}. */
export type MediaIntent = 'reel-message';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface CompressedImage {
  file: File;
  width: number;
  height: number;
}

/** File staged for send with optional display dimensions (images). */
export interface PendingMediaFile {
  file: File;
  width?: number;
  height?: number;
  /** See {@link MediaRef.placeholder}. */
  placeholder?: string;
  /** Set only by the voice recorder's own send path - see {@link MediaRef.voiceNote}. */
  voiceNote?: boolean;
}

/** Per-context presets - higher quality, less aggressive resize. */
export const IMAGE_COMPRESS_PRESETS = {
  chat: { maxWidth: 2560, maxHeight: 2560, quality: 0.92 },
  post: { maxWidth: 2048, maxHeight: 2048, quality: 0.92 },
  comment: { maxWidth: 1280, maxHeight: 1280, quality: 0.9 },
} as const;

/** Below this threshold, keep the original if no resizing is needed. */
const SKIP_REENCODE_UNDER_BYTES = 2 * 1024 * 1024;

/** Only accept the WebP version if it is at least 15% smaller than the original. */
const MIN_SIZE_SAVINGS_RATIO = 0.85;

import { encryptMediaBuffer } from '$lib/mediaCrypto';
import { canvasToBlob } from '$lib/utils/canvasBlob';
import {
  SEGMENTED_MEDIA_ENCODING,
  SEGMENTED_MEDIA_WRITER_ENABLED,
  encryptSegmentedMedia,
  segmentedCiphertextLength,
  writesSegmented,
} from '$lib/mediaSegmented';
import { refresh, SessionExpiredError } from '$lib/stores/auth';
import { uploadRefusalFrom } from '$lib/utils/mediaErrors';
import {
  GATEWAY_MAX_BODY_BYTES,
  MEDIA_REQUEST_BODY_BUDGET_BYTES,
  requestBodyBytes,
} from '$lib/utils/mediaRequestLimits';
import { prepareVideoForUpload, type PrepareVideoOptions } from '$lib/video/prepareVideoForUpload';
import { acquireDecryptedMediaBlobUrl, acquireRawMediaBlobUrl } from '$lib/utils/mediaBlobCache';
import { mediaUrl } from '$lib/utils/apiUrl';
import { xhrUpload, type XhrUploadOptions, type UploadProgress } from '$lib/utils/uploadXhr';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `fetch` for an UPLOAD: one 401 renews the access token and repeats the request ONCE.
 *
 * `authToken` is handed in by the caller, taken before an encryption that can last long enough for
 * a 15-minute token to expire, so a 401 here usually means "stale copy", not "no session" - and a
 * web client that read it as the second used to end up signed out (9 `POST /api/media/upload` 401
 * in 30 h of production, each followed by a logout and a sign-in). Only a 401 AFTER a refresh may
 * end the session, and `refresh()` is single-flight, so a burst of uploads shares ONE renewal.
 *
 * Throws what `refresh()` throws (dead cookie, refused, unreachable) unchanged, and
 * `SessionExpiredError` when a freshly minted token is refused too. Any other status is returned
 * for the caller to type as a `MediaUploadError`. The bodies (`FormData`, `Blob`) are re-readable,
 * so the retry resends the same bytes.
 *
 * @param url       Absolute upload URL.
 * @param build     Builds the request init for a token (headers + body).
 * @param authToken The token the caller holds.
 * @param transport When given, the request goes through {@link xhrUpload} instead of `fetch`, which
 *                  is the only way to see its progress, cancel it and bound it by silence. The 401
 *                  retry is the same on both, and a retry reports its progress from zero again.
 */
async function fetchUpload(
  url: string,
  build: (token: string) => RequestInit,
  authToken: string,
  transport?: XhrUploadOptions
): Promise<Response> {
  const where = url.replace(/^https?:\/\/[^/]+/, '');
  const send = (token: string): Promise<Response> => {
    const init = build(token);
    // A BODY THE HOST'S WAF WOULD DROP IS NEVER SENT: it answers a 403 HTML page after the whole
    // body has left, which used to read as a failure to retry for ever. Reaching this line means a
    // caller built a request that does not respect the budget - a defect of ours, said loudly.
    const bytes = requestBodyBytes(init.body);
    if (bytes > GATEWAY_MAX_BODY_BYTES) {
      throw new Error(
        `[media] refusing to send ${bytes} body bytes to ${where}: over the ${GATEWAY_MAX_BODY_BYTES}-byte gateway limit`
      );
    }
    return transport
      ? xhrUpload(
          url,
          {
            method: init.method,
            headers: init.headers as Record<string, string> | undefined,
            body: init.body as FormData | Blob | string | null | undefined,
          },
          transport
        )
      : fetch(url, init);
  };
  const res = await send(authToken);
  if (res.status !== 401) return res;
  console.warn(`[media] 401 on ${where} - refreshing the token and retrying once`);
  let fresh: string;
  try {
    fresh = await refresh();
  } catch (e) {
    const cause = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.warn(`[media] refresh failed on ${where} - ${cause}`);
    throw e;
  }
  const retry = await send(fresh);
  console.log(`[media] ${retry.status} on ${where} (retry after refresh)`);
  if (retry.status === 401) {
    console.warn(`[media] double 401 on ${where} - session invalid`);
    throw new SessionExpiredError();
  }
  return retry;
}

/**
 * Compress an image file using canvas.
 *
 * @param file The original image file
 * @param maxWidth Maximum width (default: 2560)
 * @param maxHeight Maximum height (default: 2560)
 * @param quality WebP quality 0-1 (default: 0.92)
 * @returns Compressed file (or original) with final display dimensions
 */
export async function readImageDimensions(file: File): Promise<ImageDimensions | null> {
  if (!file.type.startsWith('image/')) return null;

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (width > 0 && height > 0) resolve({ width, height });
      else resolve(null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

/**
 * What a post uploads for one picked file, and the size it is drawn at: a picture compressed with
 * the `post` preset and its final size, a video RE-ENCODED on the device (`prepareVideoForUpload`,
 * decision C3) with its frame size, anything else as it is with no size. One implementation for
 * the composer and the editor, which each carried a copy that knew only pictures.
 *
 * WHY A POST RECORDS A VIDEO'S SIZE (Mi 9T, 2026-09-29): only images carried `width`/`height`, so
 * the feed reserved every video at the default 4:3 and drew a phone's vertical clip as a narrow
 * strip with a grey band under it. The size now comes from the encoder's own output, rotation
 * already applied.
 *
 * @param video The bounds, progress and cancel for a video; ignored for anything else.
 * @throws {VideoPrepareError} when a video cannot be prepared - typed, so the screen names why.
 */
export async function preparePostMedia(
  file: File,
  video: PrepareVideoOptions = {}
): Promise<{ file: File; dims?: ImageDimensions }> {
  if (file.type.startsWith('image/')) {
    const { maxWidth, maxHeight, quality } = IMAGE_COMPRESS_PRESETS.post;
    const compressed = await compressImage(file, maxWidth, maxHeight, quality);
    return { file: compressed.file, dims: { width: compressed.width, height: compressed.height } };
  }
  if (file.type.startsWith('video/')) {
    const prepared = await prepareVideoForUpload(file, video);
    return { file: prepared.file, dims: { width: prepared.width, height: prepared.height } };
  }
  return { file };
}

/**
 * Reasons `compressImage` can hand back the ORIGINAL file. Several of them ship megabytes.
 *
 * Measured 2026-08-11 (WP-STORAGE-1): a 3840x2400 photograph through this compressor costs
 * **245 KB** on average, while the five largest objects on production are 4.15 to 7.86 MB - 16 to
 * 32 times that. So a large object is never a compressed image; it came through one of these
 * branches, or it is a video, which is not compressed at all. Until now they all returned
 * silently, which is why the question "what IS that 7.86 MB blob" had no answer anywhere.
 */
type PassthroughReason =
  | 'not-an-image'
  | 'animated-or-vector' // GIF/SVG: re-encoding drops the animation
  | 'no-canvas-context'
  | 'already-small' // under the skip threshold and no resize needed - the expected cheap path
  | 'encode-produced-nothing'
  | 'webp-not-smaller' // an already-optimised JPEG can beat WebP
  | 'decode-failed' // HEIC and anything else this engine cannot decode
  | 'threw';

/** Logs every non-trivial passthrough with its cost, so a large upload is attributable later. */
function keepOriginal(
  reason: PassthroughReason,
  file: File,
  dims: ImageDimensions
): CompressedImage {
  // The two expected paths are not worth a line each; the rest are how big objects get in.
  if (reason !== 'already-small' && reason !== 'not-an-image') {
    console.warn(
      `[media] uploading the original (${reason}): ${file.type || 'unknown'}, ` +
        `${(file.size / 1024 / 1024).toFixed(2)} MB`
    );
  }
  return { file, width: dims.width, height: dims.height };
}

export async function compressImage(
  file: File,
  maxWidth: number = IMAGE_COMPRESS_PRESETS.chat.maxWidth,
  maxHeight: number = IMAGE_COMPRESS_PRESETS.chat.maxHeight,
  quality: number = IMAGE_COMPRESS_PRESETS.chat.quality
): Promise<CompressedImage> {
  if (!file.type.startsWith('image/')) {
    return keepOriginal('not-an-image', file, { width: 0, height: 0 });
  }

  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    const dims = await readImageDimensions(file);
    return keepOriginal('animated-or-vector', file, {
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
    });
  }

  try {
    return await new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        void readImageDimensions(file).then((dims) =>
          resolve(
            keepOriginal('no-canvas-context', file, {
              width: dims?.width ?? 0,
              height: dims?.height ?? 0,
            })
          )
        );
        return;
      }

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }

        const outWidth = width;
        const outHeight = height;
        const needsResize = width !== img.naturalWidth || height !== img.naturalHeight;

        if (!needsResize && file.size < SKIP_REENCODE_UNDER_BYTES) {
          resolve(keepOriginal('already-small', file, { width: outWidth, height: outHeight }));
          return;
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(img, 0, 0, width, height);

        const outputType = 'image/webp';
        // Synchronous: `toBlob` waits ~4 s on the Android WebView (utils/canvasBlob.ts).
        const blob = canvasToBlob(canvas, outputType, quality);
        if (!blob) {
          resolve(
            keepOriginal('encode-produced-nothing', file, {
              width: outWidth,
              height: outHeight,
            })
          );
          return;
        }

        const worthReplacing =
          blob.size <= file.size * MIN_SIZE_SAVINGS_RATIO || (needsResize && blob.size < file.size);

        if (worthReplacing) {
          resolve({
            file: new File([blob], file.name, { type: outputType, lastModified: Date.now() }),
            width: outWidth,
            height: outHeight,
          });
        } else {
          resolve(keepOriginal('webp-not-smaller', file, { width: outWidth, height: outHeight }));
        }
      };

      // HEIC lands here on any engine that cannot decode it - i.e. a full-size phone photo
      // uploaded untouched. The dimensions probe uses the same decoder and will fail too.
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        void readImageDimensions(file).then((dims) =>
          resolve(
            keepOriginal('decode-failed', file, {
              width: dims?.width ?? 0,
              height: dims?.height ?? 0,
            })
          )
        );
      };
      img.src = objectUrl;
    });
  } catch (error) {
    console.warn('Image compression failed:', error);
    const dims = await readImageDimensions(file);
    return keepOriginal('threw', file, { width: dims?.width ?? 0, height: dims?.height ?? 0 });
  }
}

/**
 * Parse a message content string.
 * Returns the MediaRef if it is a media message, or null if it is plain text.
 */
export function parseMediaMessage(content: string): MediaRef | null {
  if (!content.startsWith('{')) return null;
  try {
    const obj = JSON.parse(content);
    // __media sentinel is required to prevent crafted JSON text from being
    // misinterpreted as a media attachment.
    if (
      obj.__media === true &&
      (obj.type === 'image' ||
        obj.type === 'video' ||
        obj.type === 'audio' ||
        obj.type === 'file') &&
      typeof obj.mediaId === 'string' &&
      typeof obj.key === 'string' &&
      typeof obj.iv === 'string'
    ) {
      return obj as MediaRef;
    }
  } catch {
    // Not JSON - treat as plain text
  }
  return null;
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

/**
 * What encryption adds to a file before the server measures it: the AES-GCM authentication tag.
 *
 * The server's ceiling is applied to the CIPHERTEXT, and the client picks a PLAINTEXT file, so the
 * two are not comparing the same bytes. The IV is not part of the difference - it travels beside the
 * blob in the `MediaRef`, never inside it - which leaves exactly the 16-byte tag `crypto.subtle`
 * appends. A file of `maxBytes` therefore does NOT fit, and `maxBytes - 16` is the largest that
 * does: the boundary the two numbers used to disagree about, now written down once.
 */
export const MEDIA_CIPHERTEXT_OVERHEAD_BYTES = 16;

/**
 * What encryption adds to a file of `maxBytes` in the WORST format this client writes.
 *
 * A segmented blob (`mediaSegmented.ts`) carries a 20-byte header and one tag per megabyte - about
 * 820 bytes at 50 MB - so once the writer is on, a file within that margin of the ceiling would be
 * refused by the server after its upload. The ceiling is compared against the larger overhead for
 * every file, which costs a picture under a kilobyte of a 50 MB allowance: nothing a display at
 * megabyte granularity can show. While the writer is off this is exactly the GCM tag, as before.
 */
function worstCaseOverheadBytes(maxBytes: number): number {
  if (!SEGMENTED_MEDIA_WRITER_ENABLED) return MEDIA_CIPHERTEXT_OVERHEAD_BYTES;
  return segmentedCiphertextLength(maxBytes) - maxBytes;
}

/**
 * THE UPLOAD CEILING, ASKED OF THE SERVER ONCE PER PAGE, because it is the server's number.
 *
 * It used to be `VITE_MEDIA_MAX_SIZE_MB`, inlined at BUILD time. Nothing in CI ever wrote that
 * variable - only `scripts/setup-env.sh`, on a developer's machine - so every shipped build refused
 * at the code default of 100 MB while every server has run at 50, and 50 MB of a 90 MB video went
 * up the wire before anybody said no (measured 2026-09-24). A build-time value could not have been
 * the fix either: an installed APK carries whatever it was built with, and nothing keeps that in
 * step with the box it talks to.
 *
 * Module-level, so a page pays for it once however many `MediaService` instances it makes, and the
 * PROMISE is cached rather than the value, so two concurrent pickers make one request. Keyed by
 * base URL because that is what the answer is about: an instance pointed at another origin is
 * asking a different server, and sharing one entry between them would answer the wrong box.
 */
const ceilings = new Map<string, Promise<{ maxBytes: number; maxPlaintextBytes: number } | null>>();

/**
 * Client-side media operations: encrypt-then-upload and download-then-decrypt.
 * The decryption key (CEK) is never transmitted to or stored on the server - it is embedded inside
 * the MLS-encrypted application message so only group members can decrypt the attachment.
 */
export class MediaService {
  private readonly baseUrl: string;

  /**
   * @param baseUrl Optional override for the media service base URL. Defaults to {@link mediaUrl}.
   */
  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? mediaUrl()).replace(/\/$/, '');
  }

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  /**
   * This server's upload ceiling, or `null` when it could not be asked.
   *
   * `null` is not a fallback ceiling and must never be turned into one - it is the absence of an
   * OPTIMISATION. The refusal that matters is the server's 413; this number exists only so a member
   * is told before the bytes go up rather than after. When it cannot be had, the upload proceeds and
   * the server decides, which is what happens on every path anyway.
   *
   * TWO NUMBERS, BECAUSE THEY ANSWER TWO QUESTIONS. `maxPlaintextBytes` is what a file is COMPARED
   * against - the server measures ciphertext, so the tag has to come off. `maxBytes` is what the
   * member is TOLD, because the ceiling they were given is 50 MB and announcing "49 Mo" would be
   * wrong by a whole megabyte of files that do fit. The two disagree only over the last 16 bytes,
   * which no display at megabyte granularity can show anyway.
   */
  async uploadLimits(): Promise<{ maxBytes: number; maxPlaintextBytes: number } | null> {
    const cached = ceilings.get(this.baseUrl);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/media/limits`);
        if (!res.ok) {
          console.warn(`[media] GET /media/limits answered ${res.status} - no client-side ceiling`);
          return null;
        }
        const { maxBytes } = (await res.json()) as { maxBytes?: unknown };
        if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
          console.warn(`[media] /media/limits gave no usable maxBytes - no client-side ceiling`);
          return null;
        }
        return { maxBytes, maxPlaintextBytes: maxBytes - worstCaseOverheadBytes(maxBytes) };
      } catch (e) {
        console.warn(`[media] /media/limits unreachable - no client-side ceiling`, e);
        return null;
      }
    })();
    ceilings.set(this.baseUrl, pending);
    return pending;
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /**
   * Gives a staged legacy chunk session back to the server (`DELETE /media/upload/chunk/:id`).
   * Best effort by design: the caller is already failing and must not wait on, or be changed by,
   * this call; the server's 24 h sweep remains the backstop. Every outcome is logged.
   */
  private releaseChunkSession(uploadId: string, authToken: string): void {
    fetch(`${this.baseUrl}/api/media/upload/chunk/${uploadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
      keepalive: true,
    })
      .then((res) =>
        console.debug(`[media] released chunk session ${uploadId}: HTTP ${res.status}`)
      )
      .catch((e) => console.warn(`[media] could not release chunk session ${uploadId}`, e));
  }

  /**
   * Encrypt `file` client-side and upload the ciphertext to the media service.
   *
   * @param file           The raw File object selected by the user.
   * @param authToken      JWT token sent in the Authorization header.
   * @param dimensions     Intrinsic width/height, so a feed can reserve the box before it lands.
   * @param retentionClass Which retention the object gets. The server holds only ciphertext and
   *                       cannot tell a post photo from a chat photo, so the surface says it here,
   *                       where it is already known. REQUIRED, so no new call site can forget it:
   *                       `'ephemeral'` (chat) is the only class the idle sweep may take.
   * @param transport      Optional progress sink, cancel signal and stall guard (see
   *                       {@link xhrUpload}). Without it the body goes through `fetch`, which can
   *                       report nothing until the answer arrives - every surface that shows a
   *                       bubble for the upload passes it.
   * @returns              A `MediaRef` ready to be JSON-serialised and embedded
   *                       inside the MLS application message.
   */
  async encryptAndUpload(
    file: File,
    authToken: string,
    dimensions: Partial<ImageDimensions> | undefined,
    retentionClass: MediaRetentionClass,
    transport?: XhrUploadOptions
  ): Promise<MediaRef> {
    const plaintext = await file.arrayBuffer();
    // THE FORMAT IS DECIDED HERE AND DECLARED IN THE REF - see `SEGMENTED_MEDIA_WRITER_ENABLED`,
    // off in the reader release, for when it may be turned on.
    const segmented = writesSegmented(file.type);
    console.debug(
      `[media] encryptAndUpload: ${file.type || 'unknown'}, ${file.size} bytes, ${segmented ? 'segmented' : 'single block'}`
    );
    const { ciphertext, keyHex, ivHex } = segmented
      ? await encryptSegmentedMedia(plaintext)
      : await encryptMediaBuffer(plaintext);

    // 3. Upload the encrypted blob (server stores opaque bytes, no key)
    // ONE REQUEST BODY NEVER EXCEEDS THE HOST WAF'S LIMIT (10 MiB, measured 2026-10-10): the budget is
    // the single-request ceiling AND the chunk size, so anything bigger takes the chunked route.
    const CHUNK_SIZE = MEDIA_REQUEST_BODY_BUDGET_BYTES;
    let mediaId: string;

    if (ciphertext.byteLength > CHUNK_SIZE) {
      // Chunked upload for anything over the per-request budget
      // 3.1 Initialize chunked upload
      const initRes = await fetchUpload(
        `${this.baseUrl}/api/media/upload/chunk/init`,
        (t) => ({ method: 'POST', headers: { Authorization: `Bearer ${t}` } }),
        authToken,
        transport && { ...transport, onProgress: undefined }
      );
      if (!initRes.ok) {
        throw await uploadRefusalFrom(initRes, 'chunked upload init failed');
      }
      const { uploadId } = await initRes.json();

      // Whatever ends this attempt before the object exists (a cancel, a refusal, a stall, a lost
      // session) leaves staged bytes that the NEXT attempt, under a new uploadId, never reuses:
      // release them, best effort, without delaying the failure.
      try {
        // 3.2 Upload chunks
        const totalChunks = Math.ceil(ciphertext.byteLength / CHUNK_SIZE);
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, ciphertext.byteLength);
          const chunk = ciphertext.slice(start, end);
          const chunkFormData = new FormData();
          chunkFormData.append(
            'chunk',
            new Blob([chunk], { type: 'application/octet-stream' }),
            'chunk'
          );

          const chunkRes = await fetchUpload(
            `${this.baseUrl}/api/media/upload/chunk/${uploadId}`,
            (t) => ({
              method: 'POST',
              headers: { Authorization: `Bearer ${t}` },
              body: chunkFormData,
            }),
            authToken,
            // Progress is the WHOLE blob's, so a chunk reports from where the previous one ended.
            transport && {
              ...transport,
              onProgress: (p: UploadProgress) =>
                transport.onProgress?.({ loaded: start + p.loaded, total: ciphertext.byteLength }),
            }
          );
          if (!chunkRes.ok) {
            throw await uploadRefusalFrom(
              chunkRes,
              `chunk upload failed at chunk ${i + 1}/${totalChunks}`,
              { sessionLost: chunkRes.status === 404 }
            );
          }
        }

        // 3.3 Complete chunked upload
        const completeRes = await fetchUpload(
          `${this.baseUrl}/api/media/upload/chunk/${uploadId}/complete`,
          (t) => ({
            method: 'POST',
            headers: {
              Authorization: `Bearer ${t}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ retentionClass }),
          }),
          authToken,
          transport && { ...transport, onProgress: undefined }
        );
        if (!completeRes.ok) {
          throw await uploadRefusalFrom(completeRes, 'chunked upload complete failed', {
            sessionLost: completeRes.status === 404,
          });
        }
        const completeData = await completeRes.json();
        mediaId = completeData.mediaId;
      } catch (err) {
        this.releaseChunkSession(uploadId, authToken);
        throw err;
      }
    } else {
      // Standard single-request upload
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([ciphertext], { type: 'application/octet-stream' }),
        'encrypted'
      );
      // A plain text part alongside the blob. Multer parses the whole body before the handler
      // runs, so it reaches `@Body()` whichever order the parts are in.
      formData.append('retentionClass', retentionClass);

      const res = await fetchUpload(
        `${this.baseUrl}/api/media/upload`,
        (t) => ({ method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData }),
        authToken,
        transport
      );

      if (!res.ok) {
        throw await uploadRefusalFrom(res, 'media upload failed');
      }

      const data = await res.json();
      mediaId = data.mediaId;
    }

    if (typeof mediaId !== 'string') {
      throw new Error('Media service returned no mediaId');
    }

    // 4. Return the reference - the key is only here, never on the server
    const type = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'file';

    const width =
      dimensions?.width && dimensions.width > 0 ? Math.round(dimensions.width) : undefined;
    const height =
      dimensions?.height && dimensions.height > 0 ? Math.round(dimensions.height) : undefined;

    return {
      type,
      mediaId,
      key: keyHex,
      iv: ivHex,
      mimeType: file.type,
      size: file.size,
      fileName: file.name,
      ...(width && height ? { width, height } : {}),
      ...(segmented ? { encoding: SEGMENTED_MEDIA_ENCODING } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * Download the encrypted blob and decrypt it client-side.
   *
   * The bearer token is resolved per request inside the blob cache, so a long-lived view never
   * downloads with the token it was mounted with.
   *
   * Concurrency is capped by `mediaRequestGate`, so a view that mounts sixty rows at once asks
   * for three at a time rather than starving the request the reader is actually waiting for.
   *
   * @param ref        The `MediaRef` extracted from the MLS message.
   * @param signal     Abandons the request WHILE IT IS STILL QUEUED - a row scrolled past never
   *                   asks at all. A download already started runs to completion, because the
   *                   fetch behind it is shared with every other holder of the same object.
   * @returns          A cached object URL (`blob:…`). Call
   *                   `releaseDecryptedMediaBlobUrl(ref)` when the element unmounts.
   */
  async downloadAndDecrypt(ref: MediaRef, signal?: AbortSignal): Promise<string> {
    return acquireDecryptedMediaBlobUrl(ref, this.baseUrl, signal);
  }

  // -------------------------------------------------------------------------
  // Raw (unencrypted) upload / download - for group & community avatars
  // -------------------------------------------------------------------------

  /**
   * Upload a group/community avatar to the media service as a PUBLIC asset (no client-side
   * encryption; JPEG, PNG or WebP, which the server resizes to 512px WebP).
   *
   * Public because the invite card, the link preview and the SEO head show this image to someone
   * with no session, through `GET /api/media/public/:id` - which refuses anything not stored as a
   * public asset. The same flag exempts it from the idle sweep, which is what a durable row
   * pointing at it needs: a quiet group's avatar must not disappear one day.
   *
   * @param file        The image File selected by the user.
   * @param authToken   JWT token.
   * @returns           The opaque `mediaId` from the server.
   */
  async uploadRaw(file: File, authToken: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const res = await fetchUpload(
      `${this.baseUrl}/api/media/upload/public`,
      (t) => ({ method: 'POST', headers: { Authorization: `Bearer ${t}` }, body: formData }),
      authToken
    );

    if (!res.ok) {
      throw await uploadRefusalFrom(res, 'avatar upload failed');
    }

    const data = await res.json();
    if (typeof data.mediaId !== 'string') throw new Error('Media service returned no mediaId');
    return data.mediaId;
  }

  /**
   * Download a raw (unencrypted) blob from the media service and return an
   * object URL for use in an `<img>` element.
   *
   * Call `releaseRawMediaBlobUrl(mediaId)` when the element unmounts.
   *
   * @param mediaId    The opaque identifier returned by `uploadRaw`.
   * @param signal     Abandons the request while it is still queued.
   */
  async downloadRaw(mediaId: string, signal?: AbortSignal): Promise<string> {
    return acquireRawMediaBlobUrl(mediaId, this.baseUrl, signal);
  }
}
