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

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptData(
  data: any,
  pin: string
): Promise<{ iv: Uint8Array; salt: Uint8Array; cipherText: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
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
  const key = await deriveKey(pin, salt);
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
