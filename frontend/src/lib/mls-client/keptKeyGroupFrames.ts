/**
 * KEY-GROUP FRAMES DECRYPTED AND NOT HANDLED YET, KEPT INSIDE THE MLS STATE (mls-desync-prevention
 * section 11).
 *
 * A key-group frame's generation is spent at decrypt, and its handler (the seed store) runs after.
 * A handler that threw used to leave the frame unacknowledged on the argument that redelivery would
 * recover it - but the redelivered bytes met a spent generation, were refused as `secret-reuse`,
 * acknowledged as unreadable for good and counted as a NETWORK loss. The seed was gone from this
 * device until a peer answered a seed request.
 *
 * So the plaintext is kept until its handler succeeds:
 *
 * - **written by the state**, in the same mutation that spends the generation
 *   (`process_incoming_message_kept` in `mls-core/src/app_ledgers.rs`): every export of the state
 *   holds both or neither, on the web (one synchronous WASM call) and on native (one manager-lock
 *   section). This module only mirrors the value into the document's view and removes it;
 * - **keyed by the frame**: `kept-frame:<group>:<fingerprint>`, the fingerprint the seen ledgers
 *   already use ({@link frameFingerprint}), so a redelivery of the same bytes finds it;
 * - **deleted when handled** (or found unhandleable for good), staged into the next checkpoint;
 * - **sealed like the ratchets**, since it lives in the same document (the device key seals it, a PIN
 *   change re-seals it, a device wipe deletes it).
 *
 * WHAT BOUNDS IT IS A PROOF, NOT A CLOCK. An entry exists only between a decrypt and the handler's
 * success; a frame is acknowledged only once its entry is gone, so every entry names a frame the
 * server still queues (or one whose acknowledgement raced a kill, which the start-up sweep
 * re-handles). And the bytes are bounded before anything is decrypted: a frame is opened only while
 * {@link roomToKeep} says the kept set can take it, so the set never passes
 * {@link KEPT_FRAMES_BYTE_BUDGET} - which `seenLedgerBounds.ts` subtracts from what the seen ledgers
 * may take, keeping the whole within `APP_LEDGERS_BYTE_BUDGET`.
 */
import { toBase64, fromBase64 } from '$lib/utils/hex';
import {
  STATE_LEDGER,
  noteStateLedgerHeldByState,
  readStateLedger,
  stageStateLedger,
  stateLedgerKeys,
} from './stateLedgers';

/**
 * The CBOR header of one text string in the state, at most (the unit `seenLedgerBounds.ts` and
 * `mls-core` count per key and per value).
 */
const CBOR_STRING_HEADER_BYTES = 5;

/**
 * What a kept frame costs on top of its base64 plaintext, at most: its key (a group id and a
 * fingerprint), the JSON around the value, the verified sender (`userId:deviceId`) and both CBOR
 * headers. Generous on purpose - an estimate under the truth is the one direction that could pass
 * the budget.
 */
const KEPT_FRAME_OVERHEAD_BYTES = 512;

/** Bytes of the base64 of `n` bytes, padded. */
function base64Bytes(n: number): number {
  return 4 * Math.ceil(n / 3);
}

/**
 * The most the kept frames may weigh in the MLS state. Sized so that ONE frame of the largest kind
 * an honest client sends - a seed-bundle page, `GRAINE_BUNDLE_PAGE_MAX_BYTES` of plaintext,
 * whose ciphertext adds well under a kilobyte - always fits an empty set, with room beside it for
 * the small frames (a seed, a request) that arrive around it.
 */
export const KEPT_FRAMES_BYTE_BUDGET = 384 * 1024;

/** A frame kept in the state: who MLS verified sent it, and what it decrypted to. */
export interface KeptKeyGroupFrame {
  groupId: string;
  fingerprint: string;
  /** The credential MLS verified the frame against (`userId:deviceId`); null when unreadable. */
  verifiedSender: string | null;
  plaintext: Uint8Array;
}

/**
 * The value a kept frame is stored as - THE SAME STRING `mls-core` writes (`KeptFrame`, field order
 * `sender` then `plaintext`, standard padded base64), so the view and the state never disagree about
 * a key's weight. `kept_key_group_frame.rs` pins the Rust half against this shape.
 */
export function keptFrameValue(verifiedSender: string | null, plaintext: Uint8Array): string {
  return JSON.stringify({ sender: verifiedSender, plaintext: toBase64(plaintext) });
}

/** The ledger key a frame of `groupId` with this fingerprint is kept under. */
export function keptFrameKey(groupId: string, fingerprint: string): string {
  return STATE_LEDGER.keptFrame(groupId, fingerprint);
}

/**
 * Mirrors into the document's view the value the state just kept under `key`, so this module reads
 * it back and weighs it without asking the client. Called by each platform's decrypt, right after
 * the call that kept it.
 */
export function noteFrameKept(
  userId: string,
  key: string,
  verifiedSender: string | null,
  plaintext: Uint8Array
): void {
  noteStateLedgerHeldByState(userId, key, keptFrameValue(verifiedSender, plaintext));
}

/**
 * The frame kept under this fingerprint, `null` when none is, or `'corrupt'` for a value that does
 * not parse - which no writer of this build produces, so the caller treats it as unhandleable for
 * good and says so at error.
 */
export function readKeptFrame(
  userId: string,
  groupId: string,
  fingerprint: string
): KeptKeyGroupFrame | 'corrupt' | null {
  const raw = readStateLedger(userId, keptFrameKey(groupId, fingerprint));
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as { sender?: unknown; plaintext?: unknown };
    if (typeof parsed.plaintext !== 'string') return 'corrupt';
    if (parsed.sender !== null && typeof parsed.sender !== 'string') return 'corrupt';
    return {
      groupId,
      fingerprint,
      verifiedSender: parsed.sender,
      plaintext: fromBase64(parsed.plaintext),
    };
  } catch {
    return 'corrupt';
  }
}

/**
 * Every frame the state keeps, as `{ groupId, fingerprint }`. The fingerprint holds one colon
 * (`length:hash`), so it is the LAST two segments of the key and the group id is the rest.
 */
export function keptFrameIds(userId: string): { groupId: string; fingerprint: string }[] {
  const ids: { groupId: string; fingerprint: string }[] = [];
  for (const key of stateLedgerKeys(userId, STATE_LEDGER.keptFramePrefix)) {
    const parts = key.slice(STATE_LEDGER.keptFramePrefix.length).split(':');
    if (parts.length < 3) {
      console.error(`[GRAINE] a kept frame's key does not name a group and a frame: ${key}`);
      continue;
    }
    ids.push({
      groupId: parts.slice(0, -2).join(':'),
      fingerprint: parts.slice(-2).join(':'),
    });
  }
  return ids;
}

/** What the kept frames weigh in the state, as `APP_LEDGERS_BYTE_BUDGET` counts it. */
export function keptFramesBytes(userId: string): number {
  let total = 0;
  for (const key of stateLedgerKeys(userId, STATE_LEDGER.keptFramePrefix)) {
    const value = readStateLedger(userId, key) ?? '';
    // Both are ASCII (ids, a fingerprint, JSON, base64), so the length is the byte count.
    total += key.length + value.length + 2 * CBOR_STRING_HEADER_BYTES;
  }
  return total;
}

/**
 * Whether a frame of `ciphertextBytes` may be decrypted now, decided BEFORE its generation is spent:
 *
 * - `room`: the kept set can take its plaintext (bounded above by the ciphertext);
 * - `full`: it cannot while other frames are kept - left unacknowledged, it is redelivered behind
 *   them, and their handling frees the room;
 * - `too-large`: it could not fit even an EMPTY set. It is opened WITHOUT keeping: a commit (a bulk
 *   add) may be that large and carries no plaintext; an application frame that large comes from no
 *   honest client (`BaseMlsService.distributionGroup.test.ts` holds the largest bundle page under the
 *   budget) and is unhandleable for good.
 */
export function roomToKeep(userId: string, ciphertextBytes: number): 'room' | 'full' | 'too-large' {
  const needs = base64Bytes(ciphertextBytes) + KEPT_FRAME_OVERHEAD_BYTES;
  if (needs > KEPT_FRAMES_BYTE_BUDGET) return 'too-large';
  return keptFramesBytes(userId) + needs > KEPT_FRAMES_BYTE_BUDGET ? 'full' : 'room';
}

/** Forgets a kept frame: its handler succeeded, or it can never succeed. Written by the next checkpoint. */
export function forgetKeptFrame(userId: string, groupId: string, fingerprint: string): void {
  stageStateLedger(userId, keptFrameKey(groupId, fingerprint), null);
}

/**
 * Thrown by a key-group frame handler that can NEVER succeed on this plaintext - a payload that does
 * not decode, today. Classified at the throw: the route forgets the kept frame, acknowledges it and
 * says so at error, and never counts it as a network loss (`noteKeyGroupFrameLost`) - nothing was
 * lost in transit, the sender sent something this build cannot use.
 */
export class UnhandleableFrameError extends Error {
  constructor(readonly reason: string) {
    super(`unhandleable key-group frame: ${reason}`);
    this.name = 'UnhandleableFrameError';
  }
}
