/**
 * What every encrypted call frame is BOUND to, shared by the page and the E2E worker (2026-10-21).
 *
 * This module imports nothing: `workers/encryption.worker.ts` loads it, and a worker bundle must not
 * pull the page's modules (IndexedDB, MLS) behind it.
 *
 * WHY THE KIND IS AUTHENTICATED. Each direction of a call has its own key (`utils/callKeys.ts`), so
 * a frame cannot be reflected to its sender or read under another call. Within one direction both
 * kinds share that key, so the frame's kind is bound too: an audio frame offered to the video
 * receiver (or the reverse) does not authenticate. The VP8 clear header of a video frame
 * (`utils/callVideoFrame.ts`) stays bound as before, after the kind.
 *
 * WHY THE PAGE NAMES THE KIND. The worker used to read a frame's kind from its class NAME
 * (`RTCEncodedVideoFrame`), an engine detail. Now that the kind decides authentication, it comes
 * from the page, which knows the track, in each transform's options; a transform without one
 * forwards nothing.
 */

import type { CallMediaKind } from './callE2eReport';

/** Prefix of every frame's additional data: the wire format's version, then the frame's kind. */
export const CALL_FRAME_AAD_PREFIX = 'canari-call-v2|';

/**
 * The AES-GCM additional data of a frame: `canari-call-v2|<kind>` followed by the bytes the frame
 * keeps in clear (none for audio, the VP8 payload header for video). Unambiguous without a length:
 * both kinds are five characters, and the header's length is read from its own first byte.
 */
export function frameAad(kind: CallMediaKind, clearHeader: Uint8Array): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode(`${CALL_FRAME_AAD_PREFIX}${kind}`);
  const aad = new Uint8Array(label.byteLength + clearHeader.byteLength);
  aad.set(label, 0);
  aad.set(clearHeader, label.byteLength);
  return aad;
}

/** Narrows a track's `kind` to a call media kind, or `null` for anything else. */
export function callMediaKind(kind: unknown): CallMediaKind | null {
  return kind === 'audio' || kind === 'video' ? kind : null;
}

/** What the page hands each `RTCRtpScriptTransform`, read back by the worker. */
export interface CallTransformOptions {
  side: 'sender' | 'receiver';
  /** The track's kind, authenticated in every frame (see the module comment). */
  kind: CallMediaKind;
  /** The peer connection the transform belongs to (`CallService.transformEpoch`). */
  epoch: number;
}

/**
 * How many decrypt FAILURES of one receiver transform, with not one frame it decrypted, the worker
 * reports as `undecryptable`. A matching key opens the very first frame, and a receiver with the
 * wrong key fails every one (50 audio frames a second), so a working call never reaches this count
 * and a mismatched one reaches it in about two seconds. A count, not a clock.
 */
export const DECRYPT_MISMATCH_FAILURES = 100;
