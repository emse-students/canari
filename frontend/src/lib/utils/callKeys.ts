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
 *
 * GROUP CALLS - ONE KEY PER SENDER (WP-GC1, 2026-11-13). A mesh (and later the relay leg) carries N
 * senders, so a direction no longer names a sender: each participant's key is exported with the
 * SENDER'S USER ID as context (`<callId>|<userId>`) under its own label, `mls-webrtc-media-group-v1`.
 * A device encrypts with its own key and holds one receive key per other participant
 * (`deriveGroupCallKeys`, `deriveSenderKey` for one who joins later). The 1:1 call is NOT the N=2
 * case of it on purpose: its two keys keep the v2 label and the role context above, so a 1:1 call
 * between a client of before 1.7.0 and one of after derives the same two keys and no shim is needed;
 * a group call is offered only to clients that carry this module (`group_calls_mode`,
 * docs/wiki/frontend/modules/calls.md). The two labels never meet: no context of one is a context
 * of the other, and the label is part of the export.
 *
 * WHAT A GROUP KEY DOES NOT PROVE. Every member of the conversation can export every member's key -
 * the exporter secret is shared by the group - so a frame that opens under Bob's key was sealed by a
 * member, not necessarily by Bob. The same holds for the 1:1 roles; the call's E2E claim is "no
 * one outside the conversation", never "this exact member".
 */

/** The MLS exporter label of call media keys; `v2` is the per-direction derivation. */
export const CALL_MEDIA_EXPORT_LABEL = 'mls-webrtc-media-v2';

/** The MLS exporter label of GROUP call media keys: one key per sender, keyed by its user id. */
export const CALL_GROUP_MEDIA_EXPORT_LABEL = 'mls-webrtc-media-group-v1';

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
 * The exporter context of the key the participant `senderUserId` encrypts with in the GROUP call
 * `callId`: `<callId>|<userId>`, the user id lowercased so two ends that spell it differently agree.
 */
export function senderContext(callId: string, senderUserId: string): Uint8Array {
  return new TextEncoder().encode(`${callId}|${senderUserId.toLowerCase()}`);
}

/**
 * Exports one 32-byte key and returns a copy this module owns, the exporter's buffer zeroed: an
 * exporter that hands back a buffer it reuses could otherwise overwrite one key with the next before
 * it is copied, and the key then lives in exactly one place.
 */
async function exportKey(
  exportSecret: ExportSecret,
  groupId: string,
  label: string,
  context: Uint8Array
): Promise<Uint8Array> {
  const exported = await exportSecret(groupId, label, context, 32);
  const key = Uint8Array.from(exported);
  exported.fill(0);
  return key;
}

/**
 * The key the participant `senderUserId` encrypts with in the group call `callId`: what this device
 * SENDS with when it is its own id, what it OPENS that participant's frames with otherwise. Used for
 * a participant who arrives after the call's keys were derived (`deriveGroupCallKeys`).
 */
export function deriveSenderKey(
  exportSecret: ExportSecret,
  groupId: string,
  callId: string,
  senderUserId: string
): Promise<Uint8Array> {
  return exportKey(
    exportSecret,
    groupId,
    CALL_GROUP_MEDIA_EXPORT_LABEL,
    senderContext(callId, senderUserId)
  );
}

/** A group call's keys on one device: its own send key and one receive key per other participant. */
export interface GroupCallKeys {
  send: Uint8Array;
  /** Keyed by the participant's user id, lowercased - the id the signalling names it by. */
  receive: Map<string, Uint8Array>;
}

/**
 * Exports this device's send key and a receive key for each of `peerUserIds` (this user excluded,
 * duplicates once). One after the other, as `deriveCallKeys` does; every key is a copy this module
 * owns. Two ends at different MLS epochs export different keys - the same mismatch the worker's
 * `undecryptable` report makes visible in a 1:1 call.
 */
export async function deriveGroupCallKeys(
  exportSecret: ExportSecret,
  groupId: string,
  callId: string,
  selfUserId: string,
  peerUserIds: Iterable<string>
): Promise<GroupCallKeys> {
  const self = selfUserId.toLowerCase();
  const send = await deriveSenderKey(exportSecret, groupId, callId, self);
  const receive = new Map<string, Uint8Array>();
  for (const raw of peerUserIds) {
    const peer = raw.toLowerCase();
    if (peer === self || receive.has(peer)) continue;
    receive.set(peer, await deriveSenderKey(exportSecret, groupId, callId, peer));
  }
  return { send, receive };
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
  // One after the other, each copied the moment it arrives (`exportKey`).
  const exportFor = (sender: CallRole) =>
    exportKey(exportSecret, groupId, CALL_MEDIA_EXPORT_LABEL, directionContext(callId, sender));
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
