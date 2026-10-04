/**
 * TEST-ONLY: Graine v2's Ed25519 half on WebCrypto, for the unit tests of everything above the
 * engine seam. Production never imports this - WebCrypto Ed25519 is missing from the WebViews a
 * phone ships, which is why `mls-core` answers the seam there (channel-encryption section 21.2).
 * Ed25519 is deterministic, so this and the Rust engine produce the SAME bytes, which the shared
 * vectors in `graineV2.test.ts` and `mobile/graine.rs` assert.
 */
import type { GraineSignatureEngine } from '$lib/crypto/graineV2';

const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function importSecret(secret: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array([...PKCS8_ED25519_PREFIX, ...secret]),
    { name: 'Ed25519' },
    extractable,
    ['sign']
  );
}

/** The engine seam, answered by WebCrypto. */
export const webCryptoEngine: GraineSignatureEngine = {
  async newSessionKeyPair() {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    return { secret, publicKey: await ed25519PublicKeyOf(secret) };
  },
  async signWithSessionKey(secret, message) {
    const key = await importSecret(secret, false);
    return new Uint8Array(await crypto.subtle.sign('Ed25519', key, message as BufferSource));
  },
  async verifySignature(publicKey, message, signature) {
    if (publicKey.length !== 32) return 'malformed-public-key';
    if (signature.length !== 64) return 'malformed-signature';
    const key = await crypto.subtle.importKey(
      'raw',
      publicKey as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'Ed25519',
      key,
      signature as BufferSource,
      message as BufferSource
    );
    return ok ? 'valid' : 'invalid';
  },
};

/** The 32-byte public key of a 32-byte Ed25519 secret, read back through a JWK export. */
export async function ed25519PublicKeyOf(secret: Uint8Array): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey('jwk', await importSecret(secret, true));
  const b64 = String(jwk.x).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) =>
    c.charCodeAt(0)
  );
}
