import type { HistorySealEngine } from '$lib/crypto/historySeal';

/**
 * A stand-in for `mls-core/src/history_seal.rs` with the SAME refusals and no cryptography, for the
 * tests of the code around the seal: an answer opens only with the secret of the key it was sealed
 * to and only under the AAD it was bound to, and is refused with the engine's code otherwise. The
 * real engine is held to the same contract by `historySeal.wasm.test.ts` and the Rust tests.
 *
 * The "public key" is the secret reversed, and a sealed answer is `public || be32(aad length) ||
 * aad || plaintext` - readable on purpose, so a test can see what was sealed.
 */
export function fakeHistorySealEngine(): HistorySealEngine {
  const publicOf = (secret: Uint8Array) => Uint8Array.from(secret).reverse();
  const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    async newAnswerKeyPair() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      return { secret, publicKey: publicOf(secret) };
    },
    async seal(publicKey, aad, plaintext) {
      if (publicKey.length !== 32) throw 'malformed-public-key';
      const out = new Uint8Array(32 + 4 + aad.length + plaintext.length);
      out.set(publicKey, 0);
      new DataView(out.buffer).setUint32(32, aad.length);
      out.set(aad, 36);
      out.set(plaintext, 36 + aad.length);
      return out;
    },
    async open(secret, aad, sealed) {
      if (secret.length !== 32) throw 'malformed-secret-key';
      if (sealed.length < 36) throw 'malformed-sealed';
      const aadLength = new DataView(sealed.buffer, sealed.byteOffset).getUint32(32);
      if (
        !equal(sealed.subarray(0, 32), publicOf(secret)) ||
        !equal(sealed.subarray(36, 36 + aadLength), aad)
      ) {
        throw 'refused';
      }
      return sealed.slice(36 + aadLength);
    },
  };
}
