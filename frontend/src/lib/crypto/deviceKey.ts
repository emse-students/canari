/**
 * Device key derivation: turns the user's PIN into the 32-byte `deviceKeyB64` that seals
 * every at-rest secret on this device (`mls.bin` via ChaCha20-Poly1305, local messages and
 * outbox entries via AES-256-GCM).
 *
 * This module is the SINGLE source of the device key. Nothing else may invent one, and the
 * raw PIN must never be used as a key: consumers expect exactly 32 bytes of base64, which a
 * human-typed PIN can never be.
 *
 * ## Domain separation from the PIN verifier
 *
 * `computePinVerifier` (`$lib/utils/chat/auth`) derives a value from the SAME PIN and the
 * SAME server-issued salt, and sends it to the server. Deriving the device key with those
 * inputs unchanged would hand the server a copy of the key that decrypts the user's local
 * state, collapsing the whole at-rest guarantee. The two derivations are therefore separated
 * by a distinct, versioned salt prefix AND a distinct iteration count.
 *
 * ## Why PBKDF2 and not Argon2id
 *
 * PBKDF2-SHA256 is available through WebCrypto in all three runtimes (browser, Tauri desktop
 * webview, Android/iOS webview) with no WASM initialisation and no native FFI, so web and
 * native derive byte-identical keys from one implementation. Argon2id would be stronger per
 * unit of work, but reaching it here would mean a WASM round-trip on the login critical path
 * plus a second, native implementation to keep in sync -- two chances for the platforms to
 * disagree on a key that must match exactly or the user loses their history.
 */

/**
 * Salt prefix. Bump the version suffix if the derivation parameters ever change: the derived
 * key seals `mls.bin`, so a silent change would render every existing local state unreadable.
 */
const DEVICE_KEY_DOMAIN = 'canari-device-key-v1';

/**
 * PBKDF2 iteration count (OWASP 2023 floor for PBKDF2-SHA256). Deliberately different from
 * the 100k used by `computePinVerifier` so the two derivations cannot collide even if the
 * salt separation were ever weakened.
 */
const DEVICE_KEY_ITERATIONS = 310_000;

/** Length of the derived key. 32 bytes = AES-256-GCM and ChaCha20-Poly1305 key size. */
const DEVICE_KEY_BYTES = 32;

/**
 * Derives this device's `deviceKeyB64` from the user's PIN.
 *
 * Deterministic: the same `(userId, pin, serverSalt)` always yields the same key, which is
 * what lets a device re-derive its key at every login without storing the PIN, and lets the
 * PIN-recovery flow reconstruct the old key to decrypt state sealed before a PIN rotation.
 *
 * @param userId     Account id, mixed into the salt so two accounts sharing a PIN on the same
 *                   device never derive the same key.
 * @param pin        The user's plaintext PIN. Never persisted, never leaves this call.
 * @param serverSalt Per-user random salt from `GET /api/mls/security/pin-salt/:userId`.
 * @returns Base64 encoding of 32 raw bytes, ready for `encryptData` / `decode_base64_to_32_bytes`.
 */
export async function deriveDeviceKeyB64(
  userId: string,
  pin: string,
  serverSalt: string
): Promise<string> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(`${DEVICE_KEY_DOMAIN}|${serverSalt}|${userId}`),
      iterations: DEVICE_KEY_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    DEVICE_KEY_BYTES * 8
  );
  return bytesToBase64(new Uint8Array(bits));
}

/**
 * True when `value` is base64 that decodes to exactly {@link DEVICE_KEY_BYTES} bytes.
 *
 * Used as a guard on every boundary where a device key enters from storage or from another
 * layer, so a stale vault entry (older builds persisted the raw PIN here) is rejected up
 * front instead of surfacing as an opaque `atob` or `importKey` failure deep in the crypto
 * stack.
 */
export function isValidDeviceKeyB64(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return atob(value).length === DEVICE_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Base64-encodes raw bytes without blowing the call stack on large inputs. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
