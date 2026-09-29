/**
 * TEST-ONLY: Graine v1's seal. No client writes v1 since WP-G2-5 (channel-encryption section 21) -
 * every session a device mints is v2 - but the v1 READER stays while v1 rows exist
 * (`legacy-compatibility.md`), and its tests need v1 rows to read. Production never imports this.
 */
import { deriveMessageKey, type GraineSealed } from '$lib/crypto/graine';
import { GRAINE_NONCE_BYTES } from '$lib/crypto/graineConstants';
import { toBase64 } from '$lib/utils/hex';

/** Seals `plaintext` as message `index` of a v1 session, exactly as a v1 client did. */
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
