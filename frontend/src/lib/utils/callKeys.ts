/**
 * The media keys of a 1:1 call - ONE PER DIRECTION - and the fingerprint the log carries of them.
 *
 * WHY TWO KEYS (the review of #1997, ported in 2026-10-21). One exported secret used to encrypt both
 * parties' frames, so the two devices drew their random 96-bit IVs in ONE nonce space, and a frame
 * reflected back to its own sender still decrypted. Each direction now has its own key, exported
 * from the conversation's MLS group with the call id and the SENDER'S ROLE as context: the caller
 * encrypts with the `caller` key and decrypts with the `callee` key, the callee the reverse. The
 * call id is bound by the export itself, so another call's frames never open either.
 *
 * WIRE: the label is `mls-webrtc-media-v2`; a build that still exports `mls-webrtc-media` (one key)
 * cannot talk to this one. Calls are dev builds only, so no shim exists
 * (docs/wiki/legacy-compatibility.md).
 */

/** The MLS exporter label of call media keys; `v2` is the per-direction derivation. */
export const CALL_MEDIA_EXPORT_LABEL = 'mls-webrtc-media-v2';

/** Which side of the call this device is: the one that rang, or the one that answered. */
export type CallRole = 'caller' | 'callee';

/** The raw 32-byte keys this device encrypts with (`send`) and decrypts with (`receive`). */
export interface CallKeys {
  send: Uint8Array;
  receive: Uint8Array;
}

/** The exporter a call key is read from: `IMlsService.exportSecret`, narrowed to what is used. */
export type ExportSecret = (
  groupId: string,
  label: string,
  context: Uint8Array,
  length: number
) => Promise<Uint8Array>;

/** The exporter context of the key `sender` encrypts with in the call `callId`: `<callId>|<role>`. */
export function directionContext(callId: string, sender: CallRole): Uint8Array {
  return new TextEncoder().encode(`${callId}|${sender}`);
}

/**
 * Exports both direction keys of a call from the conversation's MLS group and orders them for
 * `role`. Both ends export the SAME two secrets; only which one they send with differs. Two ends at
 * different MLS epochs export different secrets: that is the mismatch the worker's `undecryptable`
 * report makes visible (`CallService.onUndecryptable`).
 */
export async function deriveCallKeys(
  exportSecret: ExportSecret,
  groupId: string,
  callId: string,
  role: CallRole
): Promise<CallKeys> {
  // One after the other, each copied the moment it arrives: an exporter that hands back a buffer it
  // reuses could otherwise overwrite the first key with the second before either is copied. The
  // exporter's own buffer is then zeroed, so the key lives in exactly one place this module owns
  // (both `exportSecret` implementations hand back a fresh copy, never a view of WASM memory).
  const exportFor = async (sender: CallRole) => {
    const exported = await exportSecret(
      groupId,
      CALL_MEDIA_EXPORT_LABEL,
      directionContext(callId, sender),
      32
    );
    const key = Uint8Array.from(exported);
    exported.fill(0);
    return key;
  };
  const caller = await exportFor('caller');
  const callee = await exportFor('callee');
  return role === 'caller' ? { send: caller, receive: callee } : { send: callee, receive: caller };
}

/** Bytes of the SHA-256 digest a fingerprint keeps: enough to compare two logs, nothing to attack. */
const FINGERPRINT_BYTES = 4;

/**
 * A log-safe fingerprint of a call's media key: the first 4 bytes of its SHA-256, in hex.
 *
 * WHY A HASH. The call log used to print the first 4 bytes of the KEY ITSELF, and the in-app log
 * is exported by users and pasted into reports - so key material left the device in plain text
 * (owed by the review of #1997, docs/wiki/frontend/modules/calls.md). Two devices' exported logs
 * still compare - one side's `send_fp` equals the other's `recv_fp` exactly when they agree - and a
 * fingerprint reveals nothing of the key.
 *
 * The hex is spelled here rather than imported from `utils/hex.ts`, whose module drags the device
 * key gate and the MLS state store into anything that imports it.
 */
export async function keyFingerprint(key: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', key as BufferSource));
  return Array.from(digest.slice(0, FINGERPRINT_BYTES), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}
