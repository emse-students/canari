// Device-key-based encryption using the Web Crypto API (AES-256-GCM).
// Works on both web and Tauri without any WASM initialisation.
//
// Blob format:
//   iv (12 bytes) || ciphertext (variable)
//
// The deviceKeyB64 (base64-encoded 32-byte key derived once from the user's
// PIN by `$lib/crypto/deviceKey.ts`, PBKDF2-SHA256) is imported directly as an
// AES-GCM CryptoKey, eliminating any per-message derivation. No salt is needed
// — the key itself is the secret, and each message gets a fresh random 12-byte
// IV/nonce.

// Session-level key cache keyed by deviceKeyB64.  The base64 → CryptoKey
// import is performed once per session instead of once per message.
const deviceKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Import a base64-encoded 32-byte key as a non-extractable AES-256-GCM
 * CryptoKey.  Results are cached in memory by deviceKeyB64 so that the
 * import is performed only once for the lifetime of the page.
 */
async function importDeviceKey(deviceKeyB64: string): Promise<CryptoKey> {
  const cached = deviceKeyCache.get(deviceKeyB64);
  if (cached) return cached;
  const promise = (async () => {
    const keyBytes = Uint8Array.from(atob(deviceKeyB64), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  })();
  deviceKeyCache.set(deviceKeyB64, promise);
  return promise;
}

/**
 * Encrypt `data` with the given device key (base64-encoded 32 bytes).
 *
 * Returns the 12-byte IV and the AES-256-GCM ciphertext (which includes the
 * 16-byte authentication tag).
 */
export async function encryptData(
  data: unknown,
  deviceKeyB64: string
): Promise<{ iv: Uint8Array; cipherText: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importDeviceKey(deviceKeyB64);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv, cipherText: new Uint8Array(cipherBuf) };
}

/**
 * Decrypt a ciphertext blob produced by {@link encryptData}.
 *
 * Throws with "Decryption failed. Wrong device key?" if the authentication
 * tag does not verify (wrong key or data corruption).
 */
export async function decryptData(
  cipherText: Uint8Array,
  iv: Uint8Array,
  deviceKeyB64: string
): Promise<unknown> {
  const key = await importDeviceKey(deviceKeyB64);
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipherText)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new Error('Decryption failed. Wrong device key?');
  }
}
