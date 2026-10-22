/**
 * Restored history carries each message's original author signature.
 *
 * MLS proves who sent a frame while the frame is live. A `history_bundle` re-sends messages long
 * after that, and any member writes one - so until this module a member could hand a newcomer a
 * message "from" anybody. Since this change every application frame carries its author's signature
 * INSIDE the plaintext (`mls-core/src/authorship.rs` appends it, as `AppMessage` field 14), a device
 * keeps the exact bytes and the proof beside the message, and a bundle relays both. The receiver
 * checks the proof against the author's key and derives the message from the signed bytes, never
 * from the relayer's word.
 *
 * What is signed: `lp("canari-mls-author-v1") lp(groupId) lp(author) lp(SHA-256(body))`, with `body`
 * the exact `AppMessage` bytes the author sent - which hold the message id, the author's timestamp
 * and the content - and `author` its `userId:deviceId`. The group id stops a proof being replayed
 * into another conversation. The key is the device's MLS credential key, the one Graine v2's
 * endorsement uses, and the descriptor shares Graine v2's length-prefixed encoding ({@link Writer}).
 *
 * Protocol: `docs/wiki/protocols/history-reconciliation.md`, "Restored history carries its author's
 * signature". The shared vector in `messageAuthorship.test.ts` and `mls-core/tests/authored_frames.rs`
 * holds the two implementations together.
 */

import protobuf from 'protobufjs/minimal.js';
import { canari } from '$lib/proto/canari.js';
import { Writer, type GraineSignatureEngine } from '$lib/crypto/graineV2';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';

/** The label opening every descriptor - distinct from every Graine label. */
export const AUTHOR_DESCRIPTOR_LABEL = 'canari-mls-author-v1';
/** `AppMessage` field number of the proof (`libs/proto/canari.proto`). */
export const AUTHOR_PROOF_FIELD = 14;
/** The only proof layout this build reads. */
export const AUTHOR_PROOF_VERSION = 1;

/**
 * A message's proof as a device keeps it and a bundle relays it: the exact bytes the author signed
 * and the encoded `AuthorProof`, both base64. Kept in the sealed row payload, never in clear.
 */
export interface RecordedAuthorship {
  body: string;
  proof: string;
  /**
   * The MLS group the proof was signed in. Kept because a row can MOVE between conversations (a DM
   * duplicate merged, a re-key), and the descriptor binds the group: checked under the conversation
   * that holds it now, a moved row's honest proof would read as a forgery.
   */
  group: string;
}

/**
 * Where a device's signature keys come from when a PIN exists for it.
 *
 * DEFINED HERE, IMPLEMENTED BY THE KEY-PINNING WORK: when it answers a list, that list is the only
 * set of keys a proof may verify under - a pin is authoritative, so a server that publishes another
 * key for the device cannot make a forged proof pass. `null` means "no pin for this device", and
 * the tree and the server's published keys are asked instead.
 */
export interface PinnedSignatureKeys {
  keysFor(userId: string, deviceId: string): Promise<Uint8Array[] | null>;
}

let pinnedKeys: PinnedSignatureKeys | null = null;

/** Installs the pinned-key source (the key-pinning work calls this once at start). */
export function setPinnedSignatureKeys(source: PinnedSignatureKeys | null): void {
  pinnedKeys = source;
}

/** What the checks below need of the MLS service - three calls, so a test needs no client. */
export interface AuthorKeySource {
  memberSignatureKey(groupId: string, identity: string): Promise<Uint8Array | null>;
  fetchDeviceSignatureKeys(userId: string, deviceId: string): Promise<DeviceSignatureKeys>;
  graineSignatureEngine(): GraineSignatureEngine;
}

/** The bytes an author signs for `body` in `groupId`. */
export async function authorDescriptor(
  groupId: string,
  author: string,
  body: Uint8Array
): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body as BufferSource));
  const out = new Writer();
  out.field(utf8(AUTHOR_DESCRIPTOR_LABEL));
  out.field(utf8(groupId));
  out.field(utf8(author));
  out.field(digest);
  return out.bytes();
}

/**
 * Splits a decrypted plaintext into the body the author signed and the encoded proof appended as its
 * LAST field - the mirror of `split_author_proof` in Rust. `null` for a plaintext with no proof
 * (an older sender), or one that is not protobuf.
 */
export function splitAuthorProof(
  plaintext: Uint8Array
): { body: Uint8Array; proof: Uint8Array } | null {
  const reader = protobuf.Reader.create(plaintext);
  let lastStart = -1;
  let lastTag = -1;
  try {
    while (reader.pos < reader.len) {
      const start = reader.pos;
      const tag = reader.uint32();
      reader.skipType(tag & 7);
      lastStart = start;
      lastTag = tag;
    }
  } catch {
    return null;
  }
  if (lastStart < 0 || lastTag !== ((AUTHOR_PROOF_FIELD << 3) | 2)) return null;
  const tail = protobuf.Reader.create(plaintext.subarray(lastStart));
  tail.uint32();
  return { body: plaintext.slice(0, lastStart), proof: tail.bytes() };
}

/**
 * The proof of a frame THIS DEVICE JUST DECRYPTED, to keep beside its message - or `undefined` when
 * the frame carried none. mls-core leaves a proof in the plaintext only when it verified it against
 * the leaf MLS authenticated the frame with (it strips and accuses otherwise), so nothing is checked
 * again here. Never call this on bytes that did not come out of an MLS decrypt.
 */
export function recordAuthorship(
  decrypted: Uint8Array,
  groupId: string
): RecordedAuthorship | undefined {
  const split = splitAuthorProof(decrypted);
  if (!split) return undefined;
  return { body: toBase64(split.body), proof: toBase64(split.proof), group: groupId };
}

/** The proof of a frame THIS DEVICE SENT: the bytes it encrypted and the proof mls-core returned. */
export function recordOwnAuthorship(
  body: Uint8Array,
  proof: Uint8Array,
  groupId: string
): RecordedAuthorship {
  return { body: toBase64(body), proof: toBase64(proof), group: groupId };
}

/**
 * The server's published keys per device, asked once a session: a bundle of N messages from one
 * author would otherwise fetch the same answer N times. Only an ANSWER is kept - an unreachable
 * server is asked again by the next proof.
 */
const publishedKeys = new Map<string, Uint8Array[]>();

/** Forgets the cached published keys (sign-out, and tests). */
export function resetPublishedAuthorKeys(): void {
  publishedKeys.clear();
}

async function publishedKeysFor(
  mls: AuthorKeySource,
  userId: string,
  deviceId: string
): Promise<DeviceSignatureKeys> {
  const key = `${userId}:${deviceId}`;
  const cached = publishedKeys.get(key);
  if (cached) return { kind: 'keys', keys: cached };
  const answer = await mls.fetchDeviceSignatureKeys(userId, deviceId);
  if (answer.kind === 'keys') publishedKeys.set(key, answer.keys);
  return answer;
}

/** What checking a relayed proof established. */
export type AuthorshipCheck =
  | {
      kind: 'verified';
      /** `userId:deviceId` that signed, lower-cased user. */
      author: string;
      authorUserId: string;
      /** The decoded body - the message as its author sent it. */
      message: canari.AppMessage;
      /** The group the proof was signed in - the CALLER compares it with the conversation. */
      group: string;
      /** Which keys proved it: a pin, the group's tree or the server's published keys. */
      source: 'pinned' | 'tree' | 'server';
    }
  | { kind: 'forged'; why: string }
  | { kind: 'unanswered'; why: string };

/**
 * Checks a relayed proof: decodes it, resolves the author device's keys and verifies the signature
 * over the descriptor of the group the proof NAMES (`recorded.group`). `forged` is a proof that is
 * malformed, names no group or device, or verifies under none of the author's keys; `unanswered` is
 * a device that has left the tree and whose published keys could not be fetched, which says nothing
 * about the proof. A proof that verifies in ANOTHER group is `verified` with that group, and whether
 * it may stand for a message of this conversation is the caller's decision.
 *
 * Keys: a pin when one exists (authoritative - nothing else is tried), otherwise the device's leaf in
 * `treeGroupId`'s tree, then the keys the server published for it - because a DM's history outlives
 * a device's leaf, and a proof signed under a key the device has since replaced is still its proof.
 */
export async function checkRecordedAuthorship(
  mls: AuthorKeySource,
  treeGroupId: string,
  recorded: RecordedAuthorship
): Promise<AuthorshipCheck> {
  const group = typeof recorded.group === 'string' ? recorded.group : '';
  if (!group) return { kind: 'forged', why: 'the proof names no group' };
  let body: Uint8Array;
  let proof: canari.AuthorProof;
  try {
    body = fromBase64(recorded.body);
    proof = canari.AuthorProof.decode(fromBase64(recorded.proof));
  } catch (e) {
    return { kind: 'forged', why: `the proof does not decode (${String(e).slice(0, 80)})` };
  }
  if (proof.version !== AUTHOR_PROOF_VERSION) {
    return { kind: 'forged', why: `unknown proof version ${proof.version}` };
  }
  const author = proof.author ?? '';
  const sep = author.indexOf(':');
  if (sep <= 0 || sep === author.length - 1) {
    return { kind: 'forged', why: 'the proof names no device' };
  }
  const authorUserId = author.slice(0, sep).toLowerCase();
  const deviceId = author.slice(sep + 1);
  const message = decodeBody(body);
  if (!message) return { kind: 'forged', why: 'the signed bytes are not a message' };

  const descriptor = await authorDescriptor(group, author, body);
  const engine = mls.graineSignatureEngine();
  const verifiesUnder = async (keys: Uint8Array[]): Promise<boolean> => {
    for (const key of keys) {
      if ((await engine.verifySignature(key, descriptor, proof.signature)) === 'valid') return true;
    }
    return false;
  };
  const verified = (source: 'pinned' | 'tree' | 'server'): AuthorshipCheck => ({
    kind: 'verified',
    author,
    authorUserId,
    message,
    group,
    source,
  });

  const pinned = pinnedKeys ? await pinnedKeys.keysFor(authorUserId, deviceId) : null;
  if (pinned) {
    if (await verifiesUnder(pinned)) return verified('pinned');
    return {
      kind: 'forged',
      why: `the signature verifies under none of ${author}'s ${pinned.length} pinned key(s)`,
    };
  }
  const treeKey = await mls.memberSignatureKey(treeGroupId, author);
  if (treeKey && (await verifiesUnder([treeKey]))) return verified('tree');
  const published = await publishedKeysFor(mls, authorUserId, deviceId);
  if (published.kind === 'unanswered') {
    // A tree key that does not verify is not yet an accusation: the device may have signed under a
    // key it has since replaced, and only the server's list could say so.
    return {
      kind: 'unanswered',
      why: `${author}'s published keys are unreachable (${published.detail})`,
    };
  }
  if (await verifiesUnder(published.keys)) return verified('server');
  const tried = published.keys.length + (treeKey ? 1 : 0);
  if (tried === 0) return { kind: 'forged', why: `${author} has no signature key anywhere` };
  return {
    kind: 'forged',
    why: `the signature verifies under none of ${author}'s ${tried} key(s) (tree and server)`,
  };
}

function decodeBody(body: Uint8Array): canari.AppMessage | null {
  try {
    return canari.AppMessage.decode(body);
  } catch {
    return null;
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
