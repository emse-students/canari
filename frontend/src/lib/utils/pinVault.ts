/**
 * PinVault - stores the user's device key (deviceKeyB64) in an AES-GCM encrypted blob so that:
 *
 * 1. The device key is never written to disk in plaintext.
 * 2. Even if someone reads the storage area they only see ciphertext; the
 *    wrapping key lives under a separate storage key.
 *
 * Two lifetimes, selected by the user's "stay signed in" preference:
 *
 * - DEFAULT (opt-out): both the wrap key and the blob live in `sessionStorage`,
 *   so they are wiped when the browser tab/session closes. The device key never
 *   survives a browser restart in any directly readable form.
 * - "STAY SIGNED IN" (opt-in via {@link setDeviceKeyPersistence}): both move to
 *   `localStorage`, so the device key survives a browser restart. This is a deliberate
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
 * keystore and call clearDeviceKeyAndWrapKey() after successful biometric enrolment.
 */

const VAULT_KEY_KEY = 'canari_device_key_vault_key'; // random wrap key (b64)
const VAULT_BLOB_KEY = 'canari_device_key_vault'; // iv:ciphertext (b64)
const PERSIST_FLAG_KEY = 'canari_device_key_persist'; // localStorage - user opted into "stay signed in"

// ── Legacy storage keys (pre-Phase5) ─────────────────────────────────────────
const LEGACY_VAULT_KEY_KEY = 'canari_pin_vault_key';
const LEGACY_VAULT_BLOB_KEY = 'canari_pin_vault';
const LEGACY_PERSIST_FLAG_KEY = 'canari_pin_persist';

/**
 * Whether the user opted into persisting the device key across browser restarts
 * ("stay signed in"). Persisted in `localStorage` so it survives a restart
 * itself; defaults to false (the secure session-scoped behaviour).
 */
export function isDeviceKeyPersistenceEnabled(): boolean {
  try {
    return localStorage.getItem(PERSIST_FLAG_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Selects the storage backend for the device key vault based on the persistence
 * preference: `localStorage` when "stay signed in" is on, `sessionStorage`
 * otherwise. Both the wrap key and the blob always live in the same area.
 */
function vaultStore(): Storage {
  return isDeviceKeyPersistenceEnabled() ? localStorage : sessionStorage;
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
 * Encrypts `deviceKeyB64` with AES-GCM (256-bit key) and stores the result in the
 * currently selected store (session- or local-scoped per {@link isDeviceKeyPersistenceEnabled}),
 * so it is available without ever being written to persistent storage in plaintext.
 */
export async function saveDeviceKey(deviceKeyB64: string): Promise<void> {
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(deviceKeyB64);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  vaultStore().setItem(VAULT_BLOB_KEY, `${ivB64}:${cipherB64}`);
}

/**
 * Decrypts and returns the device key previously saved with `saveDeviceKey`, or `null` if
 * nothing is stored or decryption fails (e.g. the wrap key was rotated or the
 * blob was tampered with). On failure the stored blob is cleared automatically.
 */
export async function loadDeviceKey(): Promise<string | null> {
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
    clearDeviceKey();
    return null;
  }
}

/**
 * Switches the device key persistence mode ("stay signed in"). Wipes any existing vault
 * from BOTH stores first (so no stale copy is left behind), records the new
 * preference, then re-saves `deviceKeyB64` into the newly selected store when provided.
 *
 * Pass the in-memory device key to migrate an active session immediately (e.g. toggling
 * from Settings); pass `null` to only set the flag before a login whose own
 * `saveDeviceKey` will populate the correct store (e.g. the PIN-modal checkbox).
 */
export async function setDeviceKeyPersistence(
  enabled: boolean,
  deviceKeyB64: string | null
): Promise<void> {
  clearDeviceKeyAndWrapKey();
  try {
    localStorage.setItem(PERSIST_FLAG_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore quota / private-mode errors - falls back to the session default.
  }
  if (deviceKeyB64) await saveDeviceKey(deviceKeyB64);
}

/** Removes the encrypted device key blob from both stores, but keeps the wrap key intact. */
export function clearDeviceKey(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
  localStorage.removeItem(VAULT_BLOB_KEY);
  // Also clean up legacy keys during migration.
  sessionStorage.removeItem(LEGACY_VAULT_BLOB_KEY);
  localStorage.removeItem(LEGACY_VAULT_BLOB_KEY);
}

/** Drop both the blob and the wrapping key from both stores (e.g. on logout or key compromise). */
export function clearDeviceKeyAndWrapKey(): void {
  sessionStorage.removeItem(VAULT_BLOB_KEY);
  sessionStorage.removeItem(VAULT_KEY_KEY);
  localStorage.removeItem(VAULT_BLOB_KEY);
  localStorage.removeItem(VAULT_KEY_KEY);
  // Also clean up legacy keys during migration.
  sessionStorage.removeItem(LEGACY_VAULT_BLOB_KEY);
  sessionStorage.removeItem(LEGACY_VAULT_KEY_KEY);
  localStorage.removeItem(LEGACY_VAULT_BLOB_KEY);
  localStorage.removeItem(LEGACY_VAULT_KEY_KEY);
}

// ── Deprecated aliases (Phase 5 migration — kept for backward compatibility) ──

/**
 * @deprecated Use {@link saveDeviceKey} instead.
 */
export async function savePin(pin: string): Promise<void> {
  return saveDeviceKey(pin);
}

/**
 * @deprecated Use {@link loadDeviceKey} instead.
 */
export async function loadPin(): Promise<string | null> {
  // Try the new key first, then fall back to the legacy key for migration.
  const fromNew = await loadDeviceKey();
  if (fromNew) return fromNew;

  // Legacy migration: try reading from the old storage key.
  try {
    const legacyStore = isDeviceKeyPersistenceEnabled() ? localStorage : sessionStorage;
    const blob = legacyStore.getItem(LEGACY_VAULT_BLOB_KEY);
    if (!blob) return null;

    const colonIdx = blob.indexOf(':');
    if (colonIdx === -1) return null;

    const ivB64 = blob.slice(0, colonIdx);
    const cipherB64 = blob.slice(colonIdx + 1);

    // Try with the legacy wrap key first.
    const legacyKeyRaw = legacyStore.getItem(LEGACY_VAULT_KEY_KEY);
    if (legacyKeyRaw) {
      try {
        const raw = Uint8Array.from(atob(legacyKeyRaw), (c) => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
          'decrypt',
        ]);
        const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
        const cipher = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
        const legacyPin = new TextDecoder().decode(plain);
        // Migrate: the legacy vault contained a PIN; re-derive deviceKeyB64 elsewhere.
        // For now just return the legacy PIN so callers handle it.
        return legacyPin;
      } catch {
        // Legacy decryption failed — clean up.
      }
    }

    // Clean up legacy blob.
    legacyStore.removeItem(LEGACY_VAULT_BLOB_KEY);
    legacyStore.removeItem(LEGACY_VAULT_KEY_KEY);
    return null;
  } catch {
    return null;
  }
}

/**
 * @deprecated Use {@link clearDeviceKey} instead.
 */
export function clearPin(): void {
  clearDeviceKey();
}

/**
 * @deprecated Use {@link clearDeviceKeyAndWrapKey} instead.
 */
export function clearPinAndKey(): void {
  clearDeviceKeyAndWrapKey();
}

/**
 * @deprecated Use {@link isDeviceKeyPersistenceEnabled} instead.
 */
export function isPinPersistenceEnabled(): boolean {
  // Check both legacy and new flags.
  try {
    if (localStorage.getItem(PERSIST_FLAG_KEY) === 'true') return true;
    if (localStorage.getItem(LEGACY_PERSIST_FLAG_KEY) === 'true') return true;
  } catch {
    // ignore
  }
  return false;
}

/**
 * @deprecated Use {@link setDeviceKeyPersistence} instead.
 */
export async function setPinPersistence(enabled: boolean, pin: string | null): Promise<void> {
  return setDeviceKeyPersistence(enabled, pin);
}
