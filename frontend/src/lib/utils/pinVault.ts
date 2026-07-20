/**
 * PinVault - stores the user's PIN in an AES-GCM encrypted blob so that:
 *
 * 1. The PIN is never written to disk in plaintext.
 * 2. Even if someone reads the storage area they only see ciphertext; the
 *    wrapping key lives under a separate storage key.
 *
 * Two lifetimes, selected by the user's "stay signed in" preference:
 *
 * - DEFAULT (opt-out): both the wrap key and the blob live in `sessionStorage`,
 *   so they are wiped when the browser tab/session closes. The PIN never
 *   survives a browser restart in any directly readable form.
 * - "STAY SIGNED IN" (opt-in via {@link setPinPersistence}): both move to
 *   `localStorage`, so the PIN survives a browser restart. This is a deliberate
 *   security tradeoff the user explicitly enables: the encrypted blob AND its
 *   wrap key then persist on disk, so same-origin code (and anyone with disk +
 *   JS access) can unlock without re-entering the PIN.
 *
 * Threat model note: JavaScript on the same origin can always access both
 * storage areas, so this does NOT protect against XSS. The sessionStorage
 * default protects against storage inspection by a physical attacker with
 * filesystem access; the localStorage opt-in trades that away for convenience.
 *
 * On Tauri (mobile), callers should prefer the hardware-backed BiometricService
 * keystore and call PinVault.clearPinAndKey() after successful biometric enrolment.
 */

const VAULT_KEY_KEY = 'canari_pin_vault_key'; // random wrap key (b64)
const VAULT_BLOB_KEY = 'canari_pin_vault'; // iv:ciphertext (b64)
const PERSIST_FLAG_KEY = 'canari_pin_persist'; // localStorage - user opted into "stay signed in"

/**
 * Whether the user opted into persisting the PIN across browser restarts
 * ("stay signed in"). Persisted in `localStorage` so it survives a restart
 * itself; defaults to false (the secure session-scoped behaviour).
 */
export function isPinPersistenceEnabled(): boolean {
  try {
    return localStorage.getItem(PERSIST_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Selects the storage backend for the PIN vault based on the persistence
 * preference: `localStorage` when "stay signed in" is on, `sessionStorage`
 * otherwise. Both the wrap key and the blob always live in the same area.
 */
function vaultStore(): Storage {
  return isPinPersistenceEnabled() ? localStorage : sessionStorage;
}

async function getOrCreateWrapKey(): Promise<CryptoKey> {
  const store = vaultStore();
  const stored = store.getItem(VAULT_KEY_KEY);
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const exported = await crypto.subtle.exportKey('raw', key);
  store.setItem(VAULT_KEY_KEY, btoa(String.fromCharCode(...new Uint8Array(exported))));
  return key;
}

/**
 * Encrypts `pin` with AES-GCM (256-bit key) and stores the result in the
 * currently selected store (session- or local-scoped per {@link isPinPersistenceEnabled}),
 * so it is available without ever being written to persistent storage in plaintext.
 */
export async function savePin(pin: string): Promise<void> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(pin);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  vaultStore().setItem(VAULT_BLOB_KEY, `${ivB64}:${cipherB64}`);
}

/**
 * Decrypts and returns the PIN previously saved with `savePin`, or `null` if
 * nothing is stored or decryption fails (e.g. the wrap key was rotated or the
 * blob was tampered with). On failure the stored blob is cleared automatically.
 */
export async function loadPin(): Promise<string | null> {
  const blob = vaultStore().getItem(VAULT_BLOB_KEY);
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
    // Decryption failure (tampered blob, key rotated, etc.) - treat as absent.
    clearPin();
    return null;
  }
}

/**
 * Switches the PIN persistence mode ("stay signed in"). Wipes any existing vault
 * from BOTH stores first (so no stale copy is left behind), records the new
 * preference, then re-saves `pin` into the newly selected store when provided.
 *
 * Pass the in-memory PIN to migrate an active session immediately (e.g. toggling
 * from Settings); pass `null` to only set the flag before a login whose own
 * `savePin` will populate the correct store (e.g. the PIN-modal checkbox).
 */
export async function setPinPersistence(enabled: boolean, pin: string | null): Promise<void> {
  clearPinAndKey();
  try {
    localStorage.setItem(PERSIST_FLAG_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore quota / private-mode errors - falls back to the session default.
  }
  if (pin) await savePin(pin);
}

/** Removes the encrypted PIN blob from both stores, but keeps the wrap key intact. */
export function clearPin(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
  localStorage.removeItem(VAULT_BLOB_KEY);
}

/** Drop both the blob and the wrapping key from both stores (e.g. on logout or key compromise). */
export function clearPinAndKey(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
  sessionStorage.removeItem(VAULT_KEY_KEY);
  localStorage.removeItem(VAULT_BLOB_KEY);
  localStorage.removeItem(VAULT_KEY_KEY);
}
