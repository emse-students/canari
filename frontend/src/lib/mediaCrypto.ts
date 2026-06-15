/**
 * AES-256-GCM media encryption (SubtleCrypto).
 * Shared by MediaService and benchmarks - same path as production uploads.
 */

export function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexDecode(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array((hex.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)));
}

export async function generateMediaCek(): Promise<{ cryptoKey: CryptoKey; keyHex: string }> {
  const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const raw = await crypto.subtle.exportKey('raw', cryptoKey);
  return { cryptoKey, keyHex: hexEncode(new Uint8Array(raw)) };
}

export function generateMediaIv(): { iv: Uint8Array<ArrayBuffer>; ivHex: string } {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return { iv, ivHex: hexEncode(iv) };
}

export async function importMediaCek(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexDecode(keyHex),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

export interface EncryptedMediaPayload {
  ciphertext: ArrayBuffer;
  keyHex: string;
  ivHex: string;
}

/** Encrypt plaintext bytes (identical to encryptAndUpload step 1-2). */
export async function encryptMediaBuffer(plaintext: ArrayBuffer): Promise<EncryptedMediaPayload> {
  const { cryptoKey, keyHex } = await generateMediaCek();
  const { iv, ivHex } = generateMediaIv();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext);
  return { ciphertext, keyHex, ivHex };
}

/** Decrypt ciphertext bytes (identical to downloadAndDecrypt crypto step). */
export async function decryptMediaBuffer(
  ciphertext: ArrayBuffer,
  keyHex: string,
  ivHex: string
): Promise<ArrayBuffer> {
  const cryptoKey = await importMediaCek(keyHex);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexDecode(ivHex) }, cryptoKey, ciphertext);
}
