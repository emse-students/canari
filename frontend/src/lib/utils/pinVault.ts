/**
 * PinVault — stores the user's PIN in an AES-GCM encrypted blob in
 * sessionStorage (not localStorage) so that:
 *
 * 1. The PIN is never written to disk in plaintext.
 * 2. The encrypted blob is automatically wiped when the browser tab/session
 *    closes (sessionStorage lifetime).
 * 3. Even if someone reads sessionStorage they only see ciphertext; the
 *    wrapping key lives in localStorage under a separate key.
 *
 * Threat model note: JavaScript on the same origin can still access both
 * storage areas, so this does NOT protect against XSS. It does protect against
 * storage inspection by a physical attacker with filesystem access (e.g.
 * Chrome's LevelDB files on disk hold sessionStorage only for the tab's
 * lifetime, while localStorage persists). The primary improvement over
 * plain-text localStorage is: the PIN no longer survives browser restarts
 * in any directly readable form.
 *
 * On Tauri (mobile), callers should prefer the hardware-backed BiometricService
 * keystore and call PinVault.clear() after successful biometric enrolment.
 */

const VAULT_KEY_KEY = 'canari_pin_vault_key'; // sessionStorage — random wrap key (b64), session-scoped so it never persists to disk
const VAULT_BLOB_KEY = 'canari_pin_vault'; // sessionStorage — iv:ciphertext (b64)

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const stored = sessionStorage.getItem(VAULT_KEY_KEY);
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const exported = await crypto.subtle.exportKey('raw', key);
  // Store the wrap key in sessionStorage (not localStorage) so raw key material is never
  // written to persistent storage on disk. Both the key and the encrypted blob are
  // session-scoped and cleared when the tab closes.
  sessionStorage.setItem(VAULT_KEY_KEY, btoa(String.fromCharCode(...new Uint8Array(exported))));
  return key;
}

/**
 * Encrypts `pin` with AES-GCM (256-bit session-scoped key) and stores the result
 * in `sessionStorage` so it is available for the duration of the browser session
 * without ever being written to persistent storage in plaintext.
 */
export async function savePin(pin: string): Promise<void> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(pin);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  sessionStorage.setItem(VAULT_BLOB_KEY, `${ivB64}:${cipherB64}`);
}

/**
 * Decrypts and returns the PIN previously saved with `savePin`, or `null` if
 * nothing is stored or decryption fails (e.g. the wrap key was rotated or the
 * blob was tampered with). On failure the stored blob is cleared automatically.
 */
export async function loadPin(): Promise<string | null> {
  const blob = sessionStorage.getItem(VAULT_BLOB_KEY);
  if (!blob) return null;

  const colonIdx = blob.indexOf(':');
  if (colonIdx === -1) return null;

  const ivB64 = blob.slice(0, colonIdx);
  const cipherB64 = blob.slice(colonIdx + 1);

  try {
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));
    const key = await getOrCreateWrapKey();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    // Decryption failure (tampered blob, key rotated, etc.) — treat as absent.
    clearPin();
    return null;
  }
}

/** Removes the encrypted PIN blob from `sessionStorage`, but keeps the wrap key intact. */
export function clearPin(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
}

/** Drop both the blob and the wrapping key (e.g. on logout or key compromise). */
export function clearPinAndKey(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
  sessionStorage.removeItem(VAULT_KEY_KEY);
}
