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
 * Open a sealed payload under `deviceKeyB64` and return its plaintext BYTES, or `null` when the
 * AES-GCM tag does not verify under that key.
 *
 * The bytes, not the parsed value, because the one caller re-seals them as they are
 * ({@link sealBytes}): a parse and re-stringify would be a rewrite of the payload, not a re-seal. A
 * `null` and not a throw because the caller's question is WHICH key a row is under, and a tag that
 * fails is one of the two answers, not an error.
 */
export async function openSealedBytes(
  cipherText: Uint8Array,
  iv: Uint8Array,
  deviceKeyB64: string
): Promise<Uint8Array | null> {
  const key = await importDeviceKey(deviceKeyB64);
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipherText)
    );
    return new Uint8Array(plainBuf);
  } catch {
    return null;
  }
}

/** Seal plaintext bytes under `deviceKeyB64` with a fresh IV - the inverse of {@link openSealedBytes}. */
export async function sealBytes(
  plaintext: Uint8Array,
  deviceKeyB64: string
): Promise<{ iv: Uint8Array; cipherText: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importDeviceKey(deviceKeyB64);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new Uint8Array(plaintext)
  );
  return { iv, cipherText: new Uint8Array(cipherBuf) };
}

/**
 * THE BYTES CANNOT BE READ WITH THIS KEY, AND NEVER WILL BE: the AES-GCM tag did not verify (another
 * key, or corrupted bytes: WebCrypto's `OperationError`) or the plaintext is not the JSON this module
 * writes (`SyntaxError`). Those two only - anything else the engine throws may pass and is rethrown
 * as it is. A type, so a caller can tell this permanent answer from a failure that may pass without
 * reading a message.
 */
export class PayloadUnreadableError extends Error {
  constructor() {
    super('Decryption failed. Wrong device key?');
    this.name = 'PayloadUnreadableError';
  }
}

/**
 * Decrypt a ciphertext blob produced by {@link encryptData}.
 *
 * Throws {@link PayloadUnreadableError} if the authentication tag does not verify (wrong key or
 * data corruption) or the plaintext is not JSON; anything else (the key import, an engine failure)
 * propagates as is.
 */
export async function decryptData(
  cipherText: Uint8Array,
  iv: Uint8Array,
  deviceKeyB64: string
): Promise<unknown> {
  const key = await importDeviceKey(deviceKeyB64);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipherText)
    );
  } catch (e) {
    // `OperationError` is WebCrypto's answer for a tag that does not verify - the bytes and this key
    // do not belong together, and never will. Read off the error's NAME, not `instanceof`: the
    // DOMException class differs between realms (a test DOM, a worker), the name does not.
    if ((e as { name?: unknown } | null)?.name === 'OperationError') {
      throw new PayloadUnreadableError();
    }
    throw e;
  }
  try {
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch (e) {
    if (e instanceof SyntaxError) throw new PayloadUnreadableError();
    throw e;
  }
}
