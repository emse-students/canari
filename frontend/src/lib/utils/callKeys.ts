/**
 * The media keys of a 1:1 call, one PER DIRECTION, and the additional data each frame is bound to.
 *
 * WHY TWO KEYS. Until 2026-10-18 one exported secret encrypted both parties' frames. With random
 * 96-bit IVs drawn on two devices under one key, the nonce space is shared by both directions, and
 * a frame could be reflected back to its own sender and still decrypt. Each direction now has its
 * own key, exported from the conversation's MLS group with the call id and the SENDER'S ROLE as
 * context: the caller encrypts with the `caller` key and decrypts with the `callee` key, and the
 * callee the reverse. A reflected frame fails, and the two directions never share a nonce space.
 *
 * WHY AAD. Every frame is bound to its media kind, so an audio frame cannot be replayed into the
 * video track (or the reverse) and still authenticate.
 */

/** The MLS exporter label of call media keys; `v2` is the per-direction derivation. */
export const CALL_MEDIA_EXPORT_LABEL = 'mls-webrtc-media-v2';

/** Which side of the call this device is: the one that rang, or the one that answered. */
export type CallRole = 'caller' | 'callee';

/** The raw 32-byte keys this device encrypts with (`send`) and decrypts with (`receive`). */
export type CallKeys = { send: Uint8Array; receive: Uint8Array };

/** The exporter a call key is read from: `IMlsService.exportSecret`, narrowed to what is used. */
export type ExportSecret = (
  groupId: string,
  label: string,
  context: Uint8Array,
  length: number
) => Promise<Uint8Array>;

/** The exporter context of the key a `sender` encrypts with, in the call `callId`. */
export function directionContext(callId: string, sender: CallRole): Uint8Array {
  return new TextEncoder().encode(`${callId}|${sender}`);
}

/**
 * Exports both direction keys of a call from the conversation's MLS group and orders them for
 * `role`. Both ends export the SAME two secrets; only which one they send with differs.
 */
export async function deriveCallKeys(
  exportSecret: ExportSecret,
  groupId: string,
  callId: string,
  role: CallRole
): Promise<CallKeys> {
  const [caller, callee] = await Promise.all(
    (['caller', 'callee'] as const).map(async (sender) =>
      Uint8Array.from(
        await exportSecret(groupId, CALL_MEDIA_EXPORT_LABEL, directionContext(callId, sender), 32)
      )
    )
  );
  return role === 'caller' ? { send: caller, receive: callee } : { send: callee, receive: caller };
}

/**
 * A log-safe fingerprint of a key: the first 4 bytes of its SHA-256, hex. Two exported logs can
 * be compared (one side's `send` against the other's `receive`) without a byte of key material
 * ever reaching a log.
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource));
  return Array.from(digest.slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The additional authenticated data of a frame of `kind`: binds it to its track's media kind. */
export function frameAad(kind: 'audio' | 'video'): Uint8Array {
  return new TextEncoder().encode(`canari-call-v2|${kind}`);
}

/**
 * How many decrypt failures, with NOT ONE frame decrypted, prove the two ends hold different
 * keys. A matching key decrypts the very first frame; a mismatched one fails every frame (audio
 * runs at 50 frames a second), so this count is reached within seconds and never by a working
 * call. A count, not a clock.
 */
export const DECRYPT_MISMATCH_FAILURES = 100;
