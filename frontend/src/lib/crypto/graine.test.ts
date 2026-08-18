import { describe, expect, it } from 'vitest';
import {
  GraineInputError,
  deriveMessageKeyBytes,
  newGraineSeed,
  newGraineSessionId,
  openWithGraine,
  sealWithGraine,
} from './graine';
import { toBase64 } from '$lib/utils/hex';

/**
 * Graine's derivation is a WIRE FORMAT, not an implementation detail: the browser seals a message
 * and Rust re-derives the same key to decrypt a push before any WebView runs. A test that only
 * checked seal-then-open would pass with the label reworded, the index endianness flipped or the
 * session id dropped from the derivation - and every one of those breaks the other side silently.
 *
 * So the vectors below are the contract. They were produced with Node's own `crypto.hkdfSync`,
 * independently of the implementation under test, from
 * `HKDF-SHA256(ikm = seed, salt = utf8(sessionId), info = utf8("canari-graine-v1") || be32(index))`.
 * Changing any of them is a protocol change and must land in the native decoder in the same commit.
 */
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

const VECTORS: Array<{ sessionId: string; index: number; keyB64: string }> = [
  { sessionId: 'test-session', index: 0, keyB64: 'go/kAahuKrCvwB4CquM4zrgRTQyH2+WlHLNQjSB2VKA=' },
  { sessionId: 'test-session', index: 7, keyB64: 'Pnqk2gdQBRQe4p2hXM+vPGNQwHh0Ukc8tcRTnq1fcNw=' },
  // Same seed, same index, different session: the id is bound in, so a seed replayed under another
  // session id yields different keys and its messages simply fail to open.
  { sessionId: 'other-session', index: 0, keyB64: 'n5USTdC3HUsFjhOOwUcw23nwoWgJbl7A6f/EJOToaFQ=' },
  // The top of the uint32 range, which is what fixes the index at four bytes rather than a decimal
  // string whose length would vary.
  {
    sessionId: 'test-session',
    index: 0xffffffff,
    keyB64: 'f/0pgQZqn8yiwLK3UiG2D6O1RrIqFp+BMeonMygzsIs=',
  },
];

describe('graine derivation', () => {
  it.each(VECTORS)('matches the vector for $sessionId at index $index', async (vector) => {
    const bytes = await deriveMessageKeyBytes(SEED, vector.sessionId, vector.index);
    expect(toBase64(bytes)).toBe(vector.keyB64);
  });

  it('gives every index its own key', async () => {
    // What the forward ratchet would have bought is bought here: one message key opens exactly one
    // message, and only the SEED opens the session - which is the thing rotation bounds.
    const keys = await Promise.all(
      [0, 1, 2, 99].map((i) => deriveMessageKeyBytes(SEED, 'session', i).then(toBase64))
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses input that cannot produce a key, before touching any crypto', async () => {
    await expect(deriveMessageKeyBytes(new Uint8Array(16), 'session', 0)).rejects.toBeInstanceOf(
      GraineInputError
    );
    await expect(deriveMessageKeyBytes(SEED, '', 0)).rejects.toBeInstanceOf(GraineInputError);
    await expect(deriveMessageKeyBytes(SEED, 'session', -1)).rejects.toBeInstanceOf(
      GraineInputError
    );
    await expect(deriveMessageKeyBytes(SEED, 'session', 1.5)).rejects.toBeInstanceOf(
      GraineInputError
    );
    await expect(deriveMessageKeyBytes(SEED, 'session', 0x1_0000_0000)).rejects.toBeInstanceOf(
      GraineInputError
    );
  });
});

describe('graine seal and open', () => {
  const plaintext = new TextEncoder().encode('je suis en bas');

  it('round-trips a message', async () => {
    const seed = newGraineSeed();
    const sessionId = newGraineSessionId();
    const sealed = await sealWithGraine(seed, sessionId, 3, plaintext);
    const opened = await openWithGraine(seed, sessionId, 3, sealed);
    expect(new TextDecoder().decode(opened)).toBe('je suis en bas');
  });

  it('uses a fresh nonce per message, so an identical plaintext seals differently', async () => {
    // A nonce derived from the public index would repeat the instant a seed were reused across
    // sessions, which is GCM's one catastrophic failure. Twelve random bytes cost twelve bytes.
    const seed = newGraineSeed();
    const sessionId = newGraineSessionId();
    const a = await sealWithGraine(seed, sessionId, 0, plaintext);
    const b = await sealWithGraine(seed, sessionId, 0, plaintext);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects the wrong index, the wrong session and a tampered ciphertext', async () => {
    // Rejecting rather than returning null is the point: a caller that read any of these as "no
    // message" would render an unreadable channel as an empty one, which are different facts.
    const seed = newGraineSeed();
    const sessionId = newGraineSessionId();
    const sealed = await sealWithGraine(seed, sessionId, 5, plaintext);

    await expect(openWithGraine(seed, sessionId, 6, sealed)).rejects.toBeTruthy();
    await expect(openWithGraine(seed, newGraineSessionId(), 5, sealed)).rejects.toBeTruthy();

    const flipped = { ...sealed, ciphertext: flipFirstBase64Byte(sealed.ciphertext) };
    await expect(openWithGraine(seed, sessionId, 5, flipped)).rejects.toBeTruthy();
  });

  it('mints session ids that are unique and safe as a bare map key', async () => {
    // The native mirror stores these as plain JSON keys and as part of a file path, so anything
    // outside base64url would need escaping on three platforms.
    const ids = Array.from({ length: 64 }, () => newGraineSessionId());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/** Flips one bit of the first byte, keeping the value valid base64 of the same length. */
function flipFirstBase64Byte(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[0] ^= 0x01;
  return toBase64(bytes);
}
