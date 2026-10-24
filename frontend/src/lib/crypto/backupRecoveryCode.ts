/**
 * The recovery code that seals a `.canari` backup (user decision 2026-10-22: backups get their own
 * secret, the PIN stays short).
 *
 * WHY NOT THE DEVICE KEY ANY MORE. A backup used to be sealed under the device key. That key was
 * derived from the PIN, so a backup file left in a cloud drive was a 4-digit problem for whoever
 * held the server's data; and on a phone the key is now random and never leaves the hardware
 * keystore, so it could not open a backup on any other device at all. A backup is now sealed under a
 * key derived from a 128-bit random code - ONE per device, generated at its first export and kept
 * sealed under the device key (`deviceRecoveryCode.ts`).
 *
 * 128 bits needs no slow key stretching: there is nothing to grind. HKDF-SHA256 over the code bytes,
 * salted per file, is the whole derivation. The code is written in Crockford base32 (no I, L, O, U),
 * 26 characters in groups of four - typed back case-insensitively, `I`/`L` read as `1` and `O` as `0`.
 */

/** Crockford's base32 alphabet. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes of entropy in a code. */
export const RECOVERY_CODE_BYTES = 16;

/** Characters in a code: ceil(128 / 5). */
const CODE_CHARS = 26;

/** HKDF `info` - versioned with the file format it serves. */
const BACKUP_KEY_INFO = 'canari-backup-recovery-v3';

/** A fresh code, as raw bytes. */
export function generateRecoveryCodeBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
}

/** `bytes` written as the code the user keeps: 26 characters, `XXXX-XXXX-...-XX`. */
export function formatRecoveryCode(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_CODE_BYTES) throw new Error('a recovery code is 16 bytes');
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let chars = '';
  for (let i = 0; i < CODE_CHARS; i += 1) {
    chars = ALPHABET[Number(value & 31n)] + chars;
    value >>= 5n;
  }
  return chars.match(/.{1,4}/g)!.join('-');
}

/**
 * The bytes of a typed code, or `null` when it is not one: wrong length, a character outside the
 * alphabet, or a value wider than 128 bits. Separators and case are ignored.
 */
export function parseRecoveryCode(typed: string): Uint8Array | null {
  const cleaned = typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== CODE_CHARS) return null;
  let value = 0n;
  for (const c of cleaned) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) return null;
    value = (value << 5n) | BigInt(digit);
  }
  if (value >> 128n !== 0n) return null;
  const out = new Uint8Array(RECOVERY_CODE_BYTES);
  for (let i = RECOVERY_CODE_BYTES - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 255n);
    value >>= 8n;
  }
  return out;
}

/**
 * The 32-byte key sealing a backup, as base64 (the shape `sealBytes` / `openSealedBytes` take).
 * HKDF-SHA256(code, salt, info): the salt is random per file and stored in its header.
 */
export async function deriveBackupKeyB64(code: Uint8Array, salt: Uint8Array): Promise<string> {
  const ikm = await crypto.subtle.importKey('raw', new Uint8Array(code), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(salt),
      info: new TextEncoder().encode(BACKUP_KEY_INFO),
    },
    ikm,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

/**
 * A check value of a device key, carried in a backup so an import can tell whether the MLS state in
 * it was sealed under THIS device's key - without the file carrying the key. 128 bits of HKDF output
 * reveal nothing of a 256-bit key.
 */
export async function deviceKeyCheckValue(deviceKeyB64: string): Promise<string> {
  const raw = Uint8Array.from(atob(deviceKeyB64), (c) => c.charCodeAt(0));
  const ikm = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('canari-backup-device-key-check-v1'),
    },
    ikm,
    128
  );
  return bytesToBase64(new Uint8Array(bits));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
