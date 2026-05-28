/**
 * Client-side encryption/decryption for the association document vault.
 *
 * Model: the server stores a per-association `documentVaultKey` (hex 32 bytes).
 * The client derives a per-document CEK (Content Encryption Key) via HKDF and
 * then encrypts/decrypts blobs with AES-256-GCM. The server only stores the
 * encrypted ciphertext and never sees plaintext - same model as channel keys.
 */

const HKDF_INFO = new TextEncoder().encode('doc-vault');

/**
 * Derives the AES-256-GCM content encryption key for a single document.
 * @param vaultKeyHex - 64-char hex string returned by `GET /api/associations/:id/vault-key`.
 * @param docId - UUID of the document (used as the HKDF salt).
 */
export async function deriveDocumentCek(vaultKeyHex: string, docId: string): Promise<CryptoKey> {
  const vaultKeyBytes = hexToBytes(vaultKeyHex);
  const saltBytes = new TextEncoder().encode(docId);

  const baseKey = await crypto.subtle.importKey('raw', vaultKeyBytes, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: HKDF_INFO },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a file buffer with AES-256-GCM.
 * @returns The 12-byte IV and the ciphertext (IV is prepended to the blob for storage).
 */
export async function encryptDocument(
  key: CryptoKey,
  buffer: ArrayBuffer
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buffer);
  return { iv, ciphertext };
}

/**
 * Decrypts an AES-256-GCM ciphertext.
 * @param key - The CEK derived by `deriveDocumentCek`.
 * @param iv - The 12-byte IV that was used during encryption.
 * @param ciphertext - The encrypted bytes (without the prepended IV).
 */
export async function decryptDocument(
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: ArrayBuffer
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}

/**
 * Packages the IV + ciphertext into a single ArrayBuffer for upload:
 * [4 bytes: ivLength=12][12 bytes: IV][N bytes: ciphertext].
 * This lets the download handler split IV from ciphertext without extra metadata.
 */
export function packEncryptedBlob(
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: ArrayBuffer
): ArrayBuffer {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, iv.byteLength, false);
  const out = new Uint8Array(4 + iv.byteLength + ciphertext.byteLength);
  out.set(header, 0);
  out.set(iv, 4);
  out.set(new Uint8Array(ciphertext), 4 + iv.byteLength);
  return out.buffer;
}

/**
 * Splits a packed blob (produced by `packEncryptedBlob`) back into IV + ciphertext.
 */
export function unpackEncryptedBlob(packed: ArrayBuffer): {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
} {
  const view = new DataView(packed);
  const ivLength = view.getUint32(0, false);
  const iv = new Uint8Array(packed, 4, ivLength);
  const ciphertext = packed.slice(4 + ivLength);
  return { iv, ciphertext };
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
