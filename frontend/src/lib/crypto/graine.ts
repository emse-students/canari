/**
 * Graine: seed to message key, and the AES-GCM seal built on it.
 *
 * This module is deliberately PURE - no storage, no network, no clock, no singletons. It is the
 * piece that has to be provably right in isolation, so everything it needs arrives as an argument
 * and everything it produces is a return value. Session lifetime, rotation and distribution live
 * above it.
 *
 * Protocol, measurements and the alternatives it rules out:
 * `docs/wiki/protocols/channel-encryption.md`.
 */

import { fromBase64, toBase64 } from '$lib/utils/hex';
import {
  GRAINE_HKDF_INFO,
  GRAINE_MESSAGE_KEY_BYTES,
  GRAINE_NONCE_BYTES,
  GRAINE_SEED_BYTES,
} from '$lib/crypto/graineConstants';

/** Thrown when an argument cannot produce a key, before any crypto call is attempted. */
export class GraineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraineInputError';
  }
}

/**
 * A fresh 32-byte seed. One per (sender, channel, session); never derived from anything, because
 * the only thing that must be unguessable here is the seed itself.
 */
export function newGraineSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(GRAINE_SEED_BYTES));
}

/**
 * A fresh session id: 18 random bytes, base64url.
 *
 * Random rather than a counter, and therefore needing no coordination: **no two senders ever write
 * the same session namespace**, so there is nothing here for two devices to race over and no
 * election to hold. base64url so it is safe in a JSON key, a file name and a push payload without
 * escaping - which the native mirror relies on, since it reads this as a plain map key.
 */
export function newGraineSessionId(): string {
  const raw = crypto.getRandomValues(new Uint8Array(18));
  return toBase64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The key for message `index` of a session.
 *
 * **Derived from the seed rather than ratcheted forward, and that is a deliberate difference from
 * megolm.** A forward ratchet only computes index i from index i-1, so reading an arbitrary
 * message means either replaying from zero or keeping every intermediate state. Channel history is
 * served by REST, newest first, in whatever order the reader scrolls - so an arbitrary index has to
 * be cheap, and it is exactly the case a forward ratchet is worst at. What the ratchet would have
 * bought (a key recovered at index i does not open i-1) is bought here too: each index is an
 * independent HKDF output, so one message key opens exactly one message. Only the SEED opens the
 * session, which is the thing rotation bounds.
 *
 * The derivation binds the session id, so a seed replayed under a different session id yields
 * different keys and its messages simply fail to open. The id travels as the HKDF salt and the
 * index as fixed-width big-endian bytes in the info, which leaves no way for two different
 * (id, index) pairs to produce the same input - the ambiguity a concatenated string would have.
 */
export async function deriveMessageKey(
  seed: Uint8Array,
  sessionId: string,
  index: number
): Promise<CryptoKey> {
  const bits = await deriveMessageKeyBytes(seed, sessionId, index);
  return crypto.subtle.importKey(
    'raw',
    bits as BufferSource,
    { name: 'AES-GCM', length: GRAINE_MESSAGE_KEY_BYTES * 8 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * The raw bytes {@link deriveMessageKey} imports, exported for exactly two reasons and no others.
 *
 * A `CryptoKey` is non-extractable by design, which is right for every caller - and which would
 * make this derivation unpinnable by a test vector, so a reword of the info string or a change of
 * endianness would pass every test while silently breaking every other implementation. The native
 * push decoder is the other implementation: it re-derives these bytes in Rust before any WebView
 * runs, and the vectors in `graine.test.ts` are the contract the two sides are held to.
 *
 * Message code must call {@link deriveMessageKey} and never this.
 */
export async function deriveMessageKeyBytes(
  seed: Uint8Array,
  sessionId: string,
  index: number
): Promise<Uint8Array> {
  if (seed.length !== GRAINE_SEED_BYTES) {
    throw new GraineInputError(`Seed must be ${GRAINE_SEED_BYTES} bytes, got ${seed.length}`);
  }
  if (!sessionId) {
    throw new GraineInputError('Session id is required: it is bound into the derivation');
  }
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new GraineInputError(`Message index must be a uint32, got ${index}`);
  }

  const material = await crypto.subtle.importKey('raw', seed as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(sessionId) as BufferSource,
      info: messageKeyInfo(index) as BufferSource,
    },
    material,
    GRAINE_MESSAGE_KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** `"canari-graine-v1"` followed by the index as 4 big-endian bytes. Fixed width, so unambiguous. */
function messageKeyInfo(index: number): Uint8Array {
  const label = new TextEncoder().encode(GRAINE_HKDF_INFO);
  const info = new Uint8Array(label.length + 4);
  info.set(label, 0);
  new DataView(info.buffer).setUint32(label.length, index, false);
  return info;
}

/** A sealed message: what goes on the wire, base64 for a JSON body. */
export interface GraineSealed {
  ciphertext: string;
  nonce: string;
}

/**
 * Seals `plaintext` for message `index` of a session.
 *
 * A fresh random nonce per message rather than one derived from the index: the index is public and
 * a derived nonce would repeat the moment a seed were ever reused across sessions - the one
 * catastrophic failure mode of GCM. Twelve random bytes cost twelve bytes.
 */
export async function sealWithGraine(
  seed: Uint8Array,
  sessionId: string,
  index: number,
  plaintext: Uint8Array
): Promise<GraineSealed> {
  const key = await deriveMessageKey(seed, sessionId, index);
  const nonce = crypto.getRandomValues(new Uint8Array(GRAINE_NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    plaintext as BufferSource
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), nonce: toBase64(nonce) };
}

/**
 * Opens a message sealed by {@link sealWithGraine}.
 *
 * Rejects rather than returning null: a failure here means the seed, the session id or the index is
 * wrong, or the ciphertext was tampered with, and a caller that treated any of those as "no
 * message" would render an unreadable channel as an empty one - two different facts.
 */
export async function openWithGraine(
  seed: Uint8Array,
  sessionId: string,
  index: number,
  sealed: GraineSealed
): Promise<Uint8Array> {
  const key = await deriveMessageKey(seed, sessionId, index);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.nonce) as BufferSource },
    key,
    fromBase64(sealed.ciphertext) as BufferSource
  );
  return new Uint8Array(plaintext);
}
