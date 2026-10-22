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
 * What the checks below need of the MLS service, so a test needs no client.
 *
 * ONLY KEYS THIS DEVICE TRUSTS: the author device's leaf in the current tree, which MLS
 * authenticated, then the keys this device PINNED for it on first sight (`pinnedSignatureKeys`, the
 * key-binding work - `null` when it never pinned that device). A key the SERVER publishes is never
 * enough - a server can list a key for a device that never existed, or drop a real one - so it can
 * neither verify a proof nor accuse one.
 */
export interface AuthorKeySource {
  memberSignatureKey(groupId: string, identity: string): Promise<Uint8Array | null>;
  pinnedSignatureKeys(userId: string, deviceId: string): Promise<Uint8Array[] | null>;
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
      /** Which trusted key proved it: the author's leaf in the tree, or a key pinned for it. */
      source: 'tree' | 'pinned';
    }
  | { kind: 'forged'; why: string }
  | { kind: 'unproven'; why: string };

/**
 * Checks a relayed proof: decodes it, finds the author device's TRUSTED key and verifies the
 * signature over the descriptor of the group the proof NAMES (`recorded.group`).
 *
 * - `forged`: the proof is malformed, or names no group or device. A key that fails to verify does
 *   NOT accuse: the current tree may be a re-Welcome's, and a pin not anchored may be server-served.
 * - `unproven`: no trusted key verifies it - none exists (a ghost device, or one met before
 *   pinning), or the ones known may not accuse. That says nothing about the proof, and the caller
 *   treats it as unsigned.
 *
 * A proof that verifies in ANOTHER group is `verified` with that group, and whether it may stand for
 * a message of this conversation is the caller's decision.
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
  const message = decodeBody(body);
  if (!message) return { kind: 'forged', why: 'the signed bytes are not a message' };

  const descriptor = await authorDescriptor(group, author, body);
  const engine = mls.graineSignatureEngine();
  const verifiesUnder = async (key: Uint8Array): Promise<boolean> =>
    (await engine.verifySignature(key, descriptor, proof.signature)) === 'valid';
  const verified = (source: 'tree' | 'pinned'): AuthorshipCheck => ({
    kind: 'verified',
    author,
    authorUserId,
    message,
    group,
    source,
  });

  const treeKey = await mls.memberSignatureKey(treeGroupId, author);
  if (treeKey && (await verifiesUnder(treeKey))) return verified('tree');
  // Pinned under the user id as MLS names it (the author string keeps the sender's casing).
  const pins = (await mls.pinnedSignatureKeys(author.slice(0, sep), author.slice(sep + 1))) ?? [];
  for (const pin of pins) {
    if (await verifiesUnder(pin)) return verified('pinned');
  }
  if (pins.length === 0 && !treeKey) {
    return {
      kind: 'unproven',
      why: `${author} has no leaf in the tree and no pin - no trusted key`,
    };
  }
  // NO KEY HERE MAY ACCUSE. The current tree may be a re-Welcome's, holding a leaf the author did not
  // sign this message with, and the proof names no epoch to tie it to the tree it was sent in; and no
  // pin is known to be ANCHORED (first seen in an authenticated tree rather than re-taken by a heal),
  // so each may be a server-served key. Only an anchored pin may accuse, once the pin source says so.
  return {
    kind: 'unproven',
    why: `the signature verifies under none of ${author}'s ${pins.length + (treeKey ? 1 : 0)} known key(s) (tree, unanchored pins) - none may accuse`,
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
