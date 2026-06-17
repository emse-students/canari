/**
 * Client-side encryption/decryption for the association document vault.
 *
 * Model: the server stores a per-association `documentVaultKey` (hex 32 bytes).
 * The client derives a per-document CEK (Content Encryption Key) via HKDF and
 * then encrypts/decrypts blobs with AES-256-GCM. The server only stores the
 * encrypted ciphertext and never sees plaintext - same model as channel keys.
 */

const HKDF_INFO = new TextEncoder().encode('doc-vault');
const HKDF_INFO_PW = new TextEncoder().encode('doc-vault-pw');
/** PBKDF2 work factor for password-protected documents (OWASP 2023 baseline). */
const PBKDF2_ITERATIONS = 210_000;

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
 * Derives the CEK for a password-protected document.
 *
 * CEK = HKDF(vaultKey || PBKDF2(password, pwSalt), salt=docId, info="doc-vault-pw").
 * Decryption therefore requires BOTH the server-held vault key AND the password,
 * which the server never sees. This is what keeps a secret document closed even to
 * a BDE super-admin who legitimately holds the vault key. A lost password is
 * unrecoverable by design.
 *
 * @param vaultKeyHex - hex vault key from `GET /api/associations/:id/vault-key`.
 * @param docId - per-document salt (same value used by `deriveDocumentCek`).
 * @param password - the user-supplied secret, never transmitted.
 * @param pwSaltHex - hex PBKDF2 salt stored alongside the document.
 */
export async function deriveDocumentCekWithPassword(
  vaultKeyHex: string,
  docId: string,
  password: string,
  pwSaltHex: string
): Promise<CryptoKey> {
  const vaultKeyBytes = hexToBytes(vaultKeyHex);
  const pwSaltBytes = hexToBytes(pwSaltHex);

  const pwImport = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const pwBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: pwSaltBytes, iterations: PBKDF2_ITERATIONS },
    pwImport,
    256
  );

  const baseMaterial = new Uint8Array(vaultKeyBytes.length + 32);
  baseMaterial.set(vaultKeyBytes, 0);
  baseMaterial.set(new Uint8Array(pwBits), vaultKeyBytes.length);

  const baseKey = await crypto.subtle.importKey('raw', baseMaterial, 'HKDF', false, ['deriveKey']);
  const saltBytes = new TextEncoder().encode(docId);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: HKDF_INFO_PW },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Generates a random 16-byte PBKDF2 salt, hex-encoded. */
export function randomPwSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Parses the metadata markers stored in a document's `description` field.
 * Format: `[s:<cekSalt>]` optionally followed by `[pw:<pwSaltHex>]` for
 * password-protected documents.
 */
export function parseVaultMarkers(description: string | null | undefined): {
  cekSalt: string | null;
  pwSalt: string | null;
} {
  const cekSalt = description?.match(/^\[s:([^\]]+)\]/)?.[1] ?? null;
  const pwSalt = description?.match(/\[pw:([0-9a-f]+)\]/)?.[1] ?? null;
  return { cekSalt, pwSalt };
}

/** Builds the `description` marker string from a CEK salt and optional password salt. */
export function buildVaultMarkers(cekSalt: string, pwSalt?: string | null): string {
  return `[s:${cekSalt}]${pwSalt ? `[pw:${pwSalt}]` : ''}`;
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
