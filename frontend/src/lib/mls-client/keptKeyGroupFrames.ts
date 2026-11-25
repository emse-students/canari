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
 * - **deleted when handled** (or found unhandleable for good, or its group left), staged into the
 *   next checkpoint;
 * - **sealed like the ratchets**, since it lives in the same document (the device key seals it, a PIN
 *   change re-seals it, a device wipe deletes it).
 *
 * WHAT BOUNDS IT IS A PROOF, NOT A CLOCK. An entry exists only between a decrypt and the handler's
 * success; a frame is acknowledged only once its entry is gone, so every entry names a frame the
 * server still queues (or one whose acknowledgement raced a kill, which the start-up sweep
 * re-handles). And the bytes are bounded before anything is decrypted, in two layers:
 *
 * - **one frame per group**, of at most {@link KEPT_FRAME_MAX_BYTES} (the group's share): a group
 *   keeping a frame decrypts nothing more until it is forgotten (`BaseMlsService.routeDistributionFrame`,
 *   which is also what keeps a group's frames in server order). A community whose handler fails for
 *   good holds one share, never more;
 * - **two shares in all** ({@link KEPT_FRAMES_BYTE_BUDGET}): {@link roomToKeep} opens a frame only
 *   while the set can take it. One group failing for good leaves a whole share to the others, so it
 *   can never stop them; only two failing together on frames near the share can hold back a third
 *   group's largest frame. The seen ledgers take what the kept frames leave of
 *   `APP_LEDGERS_BYTE_BUDGET` (`seenLedgerBounds.ts`), so the whole stays within it.
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
 * fingerprint), the JSON around the value, the verified sender (`userId:deviceId`), the failure count
 * and both CBOR headers. Generous on purpose - an estimate under the truth is the one direction that
 * could pass the budget.
 */
const KEPT_FRAME_OVERHEAD_BYTES = 512;

/** Bytes of the base64 of `n` bytes, padded. */
function base64Bytes(n: number): number {
  return 4 * Math.ceil(n / 3);
}

/**
 * The most ONE kept frame may weigh - a group's share, since a group keeps one at a time. Sized so the
 * largest frame an honest client sends - a seed-bundle page, `GRAINE_BUNDLE_PAGE_MAX_BYTES` of
 * plaintext, whose ciphertext adds well under a kilobyte - always fits.
 */
export const KEPT_FRAME_MAX_BYTES = 384 * 1024;

/**
 * The most the kept frames may weigh in the MLS state, all groups together: two shares, so one group
 * failing for good never leaves another without room for its largest frame.
 */
export const KEPT_FRAMES_BYTE_BUDGET = 2 * KEPT_FRAME_MAX_BYTES;

/**
 * Failed runs of a kept frame's handler from which its line accuses at error rather than warn: one or
 * two are a store that hiccupped, a third is a handler that does not succeed on this plaintext.
 */
export const KEPT_FRAME_FAILURES_ACCUSED = 3;

/** A frame kept in the state: who MLS verified sent it, and what it decrypted to. */
export interface KeptKeyGroupFrame {
  groupId: string;
  fingerprint: string;
  /** The credential MLS verified the frame against (`userId:deviceId`); null when unreadable. */
  verifiedSender: string | null;
  plaintext: Uint8Array;
  /** How many runs of its handler failed - durable, so the count survives a restart. */
  failures: number;
}

/**
 * The value a kept frame is stored as - THE SAME STRING `mls-core` writes (`KeptFrame`, field order
 * `sender` then `plaintext`, standard padded base64), so the view and the state never disagree about
 * a key's weight. `kept_key_group_frame.rs` and `app_ledgers.rs` pin the Rust half against this shape.
 *
 * `failures` is written only by this module, once a run of the handler failed
 * ({@link noteKeptFrameFailed}); absent, it is zero, which is what the state writes.
 */
export function keptFrameValue(
  verifiedSender: string | null,
  plaintext: Uint8Array,
  failures = 0
): string {
  return JSON.stringify({
    sender: verifiedSender,
    plaintext: toBase64(plaintext),
    ...(failures > 0 ? { failures } : {}),
  });
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
    const parsed = JSON.parse(raw) as { sender?: unknown; plaintext?: unknown; failures?: unknown };
    if (typeof parsed.plaintext !== 'string') return 'corrupt';
    if (parsed.sender !== null && typeof parsed.sender !== 'string') return 'corrupt';
    const failures = parsed.failures ?? 0;
    if (typeof failures !== 'number' || !Number.isSafeInteger(failures) || failures < 0) {
      return 'corrupt';
    }
    return {
      groupId,
      fingerprint,
      verifiedSender: parsed.sender,
      plaintext: fromBase64(parsed.plaintext),
      failures,
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

/** The fingerprints of the frames the state keeps for one group (one at most, in server order). */
export function keptFramesOfGroup(userId: string, groupId: string): string[] {
  return keptFrameIds(userId)
    .filter((id) => id.groupId === groupId)
    .map((id) => id.fingerprint);
}

/** What one kept entry weighs in the state, as `APP_LEDGERS_BYTE_BUDGET` counts it. */
function keptEntryBytes(userId: string, key: string): number {
  const value = readStateLedger(userId, key) ?? '';
  // Both are ASCII (ids, a fingerprint, JSON, base64), so the length is the byte count.
  return key.length + value.length + 2 * CBOR_STRING_HEADER_BYTES;
}

/** What the kept frames weigh in the state, as `APP_LEDGERS_BYTE_BUDGET` counts it. */
export function keptFramesBytes(userId: string): number {
  let total = 0;
  for (const key of stateLedgerKeys(userId, STATE_LEDGER.keptFramePrefix)) {
    total += keptEntryBytes(userId, key);
  }
  return total;
}

/**
 * What one group keeps, for a log line: `none`, or how many frames, their failed runs and the bytes
 * they hold - the evidence a seed request or a held frame needs to tell "a handler failing here"
 * from "a frame lost on the way".
 */
export function describeKeptFrames(userId: string, groupId: string): string {
  const fingerprints = keptFramesOfGroup(userId, groupId);
  if (fingerprints.length === 0) return 'none';
  let failures = 0;
  let bytes = 0;
  for (const fingerprint of fingerprints) {
    const kept = readKeptFrame(userId, groupId, fingerprint);
    if (kept !== null && kept !== 'corrupt') failures += kept.failures;
    bytes += keptEntryBytes(userId, keptFrameKey(groupId, fingerprint));
  }
  return `${fingerprints.length} frame(s), ${failures} failed run(s), ${bytes} bytes`;
}

/**
 * Every group holding kept frames, each described as {@link describeKeptFrames} does - what the
 * "budget full" line names, so "A and B hold the room C waits for" is read from the log.
 */
export function describeKeptFramesByGroup(userId: string): string {
  const groups = [...new Set(keptFrameIds(userId).map((id) => id.groupId))];
  if (groups.length === 0) return 'none';
  return groups.map((g) => `${g.slice(0, 8)}: ${describeKeptFrames(userId, g)}`).join('; ');
}

/** The bytes keeping a frame of `ciphertextBytes` costs, at most (its plaintext is no larger). */
export function keptFrameNeeds(ciphertextBytes: number): number {
  return base64Bytes(ciphertextBytes) + KEPT_FRAME_OVERHEAD_BYTES;
}

/**
 * Whether a frame of `ciphertextBytes` may be decrypted now, decided BEFORE its generation is spent:
 *
 * - `room`: the kept set can take its plaintext (bounded above by the ciphertext);
 * - `full`: it cannot while other frames are kept - left unacknowledged, it is redelivered behind
 *   them, and their handling frees the room;
 * - `too-large`: it passes a group's share ({@link KEPT_FRAME_MAX_BYTES}). It is opened WITHOUT
 *   keeping: a commit (a bulk add) may be that large and carries no plaintext; an application frame
 *   that large comes from no honest client (`BaseMlsService.distributionGroup.test.ts` holds the
 *   largest bundle page under the share) and is unhandleable for good.
 *
 * The group's own share needs no check here: the route opens nothing for a group that already keeps
 * a frame.
 */
export function roomToKeep(userId: string, ciphertextBytes: number): 'room' | 'full' | 'too-large' {
  const needs = keptFrameNeeds(ciphertextBytes);
  if (needs > KEPT_FRAME_MAX_BYTES) return 'too-large';
  return keptFramesBytes(userId) + needs > KEPT_FRAMES_BYTE_BUDGET ? 'full' : 'room';
}

/** Forgets a kept frame: its handler succeeded, or it can never succeed. Written by the next checkpoint. */
export function forgetKeptFrame(userId: string, groupId: string, fingerprint: string): void {
  stageStateLedger(userId, keptFrameKey(groupId, fingerprint), null);
}

/**
 * Forgets every frame kept for `groupId`: the group is left, so nothing will ever handle them.
 *
 * @returns how many were forgotten
 */
export function forgetKeptFramesOfGroup(userId: string, groupId: string): number {
  const fingerprints = keptFramesOfGroup(userId, groupId);
  for (const fingerprint of fingerprints) forgetKeptFrame(userId, groupId, fingerprint);
  return fingerprints.length;
}

/**
 * Counts one more failed run of a kept frame's handler, IN THE KEPT VALUE - durable state, so a
 * handler that fails on every start is seen failing for the third time on the third start, which no
 * in-memory count could say. Written by the next checkpoint.
 *
 * @returns the failed runs so far, this one included; 0 when the frame is not (or no longer) kept
 */
export function noteKeptFrameFailed(userId: string, groupId: string, fingerprint: string): number {
  const kept = readKeptFrame(userId, groupId, fingerprint);
  if (kept === null || kept === 'corrupt') return 0;
  const failures = kept.failures + 1;
  stageStateLedger(
    userId,
    keptFrameKey(groupId, fingerprint),
    keptFrameValue(kept.verifiedSender, kept.plaintext, failures)
  );
  return failures;
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
