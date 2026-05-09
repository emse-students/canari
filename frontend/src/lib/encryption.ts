// PIN-based encryption using the Web Crypto API (PBKDF2-HMAC-SHA256 + AES-256-GCM).
// Works on both web and Tauri without any WASM initialisation.
//
// Blob format (same layout as the previous WASM implementation):
//   salt (16 bytes) || iv (12 bytes) || ciphertext (variable)
//
// Note: switching from Argon2+ChaCha20 (WASM) to PBKDF2+AES-GCM breaks
// backward compatibility — db.ts bumps its schema version and drops all
// rows encrypted with the old format.

const PBKDF2_ITERATIONS = 100_000;

// Session-level key cache keyed by "pin:base64(salt)".
// When all messages share the same stable per-user salt (see db.ts), the key is
// derived exactly once per session instead of once per message.
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const saltB64 = btoa(Array.from(salt, (b) => String.fromCharCode(b)).join(''));
  const cacheKey = `${pin}:${saltB64}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const promise = (async () => {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(salt),
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  })();
  derivedKeyCache.set(cacheKey, promise);
  return promise;
}

/**
 * Encrypt `data` with the given PIN.
 *
 * Pass `stableSalt` (a per-user salt from localStorage) to reuse the cached
 * derived key across all messages in the same session.  When omitted, a fresh
 * random salt is generated (backward-compatible path for legacy callers).
 */
export async function encryptData(
  data: any,
  pin: string,
  stableSalt?: Uint8Array
): Promise<{ iv: Uint8Array; salt: Uint8Array; cipherText: Uint8Array }> {
  const salt = stableSalt ?? crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { salt, iv, cipherText: new Uint8Array(cipherBuf) };
}

export async function decryptData(
  cipherText: Uint8Array,
  iv: Uint8Array,
  salt: Uint8Array,
  pin: string
): Promise<any> {
  const key = await deriveKey(pin, salt); // cache hit for stable-salt messages
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipherText)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch {
    throw new Error('Decryption failed. Wrong PIN?');
  }
}
