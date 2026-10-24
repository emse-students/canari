/**
 * DeviceKeyVault - stores the user's device key (deviceKeyB64) in an AES-GCM encrypted blob so that:
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

import { isHardwareHeldDeviceKey } from '$lib/crypto/hardwareHeldKey';

const VAULT_KEY_KEY = 'canari_device_key_vault_key'; // random wrap key (b64), shared by every slot
const PERSIST_FLAG_KEY = 'canari_device_key_persist'; // localStorage - user opted into "stay signed in"

/**
 * One slot per ACCOUNT: `canari_device_key_vault:v2:<userId>`, holding `iv:ciphertext` (b64).
 *
 * THE VAULT NAMES THE ACCOUNT IT BELONGS TO, AND A SIGN-IN AS ANYONE ELSE NEVER SEES IT. Until
 * 2026-10-14 there was ONE slot and nothing in it said whose key it was, and a sign-out leaves the
 * vault in place on purpose ("Rester connecte"). So account B signing in on an install where A had
 * ticked it took the vault path with A's key and was never asked for its PIN: on the web B's store
 * was sealed under A's key, and on a phone A's key opened the per-install `mls.bin`, whose credential
 * names A - the `mismatch` branch then ROTATED the device identity and overwrote A's local state
 * ([auth](../../../../docs/wiki/frontend/modules/auth.md)).
 *
 * The account is recorded twice, on purpose: in the slot NAME, so a read finds its own slot without
 * decrypting anyone else's, and as the AES-GCM additional data, so a blob copied under another
 * account's name does not open - the label cannot be edited without the tag noticing.
 */
const SLOT_PREFIX = 'canari_device_key_vault:v2:';

/**
 * The single slot written by every build before 2026-10-14, which names NO account. Read only for
 * the migration ({@link loadDeviceKey}); never written again.
 */
const UNLABELLED_VAULT_BLOB_KEY = 'canari_device_key_vault';

// ── Legacy storage keys (pre-Phase5), only ever cleared ──────────────────────
const LEGACY_VAULT_KEY_KEY = 'canari_pin_vault_key';
const LEGACY_VAULT_BLOB_KEY = 'canari_pin_vault';

/** The storage key of `userId`'s slot. */
function slotKey(userId: string): string {
  return `${SLOT_PREFIX}${userId}`;
}

/** The AES-GCM additional data that binds a slot's ciphertext to the account it names. */
function slotAad(userId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(slotKey(userId));
}

/**
 * What {@link loadDeviceKey} found for an account.
 *
 * `ownerProven` is FALSE only for a key read from the unlabelled slot an older build wrote: nothing
 * says whose it is, so the login that uses it must prove the account by the state it opens and must
 * not destroy anything on the way (`MlsInitOptions.vaultOwnerUnproven`).
 */
export interface VaultedDeviceKey {
  deviceKeyB64: string;
  ownerProven: boolean;
}

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
 * Encrypts `deviceKeyB64` with AES-GCM (256-bit key) into `userId`'s slot of the currently selected
 * store (session- or local-scoped per {@link isDeviceKeyPersistenceEnabled}), bound to that account
 * by the additional data, so it is never written to persistent storage in plaintext and never
 * handed to a sign-in as anybody else.
 *
 * Another account's slot is left exactly as it was: each account unlocks with its own key.
 *
 * A HARDWARE-HELD KEY IS NEVER VAULTED (2026-10-22). On a phone the at-rest key lives in the platform
 * keystore; a copy here would sit in the WebView's files beside its own wrap key, which is exactly
 * the copy holding the key in hardware removes. The refusal is the one seam every vault write goes
 * through - the login, a PIN change, the "stay signed in" switch, a biometric disable - and "stay
 * signed in" on such a phone reads the keystore instead (`nativeStorageLoginImpl`).
 */
export async function saveDeviceKey(userId: string, deviceKeyB64: string): Promise<void> {
  if (isHardwareHeldDeviceKey(deviceKeyB64)) {
    console.info('[VAULT] the device key is hardware-held - not copied into the vault');
    return;
  }
  const key = await getOrCreateWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(deviceKeyB64);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: slotAad(userId) },
    key,
    encoded
  );

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  vaultStore().setItem(slotKey(userId), `${ivB64}:${cipherB64}`);
}

/**
 * Decrypts one stored blob, or returns `null` - after clearing it and saying why when it is there
 * and will not open.
 *
 * `aad` is the account binding of a labelled slot, `undefined` for the unlabelled slot an older
 * build wrote (it was sealed with none).
 */
async function openBlob(
  storageKey: string,
  aad: Uint8Array<ArrayBuffer> | undefined,
  clear: () => void
): Promise<string | null> {
  const blob = vaultStore().getItem(storageKey);
  if (!blob) return null;

  const colonIdx = blob.indexOf(':');
  if (colonIdx === -1) {
    // NOT "absent": a blob with no separator can never decrypt, so returning null in silence left
    // it in place to fail the same way on every later load, for ever, with nothing said once.
    console.warn(
      `[VAULT] the stored device key (${storageKey}) is malformed (no iv separator) - clearing it; this device will ask for its PIN`
    );
    clear();
    return null;
  }

  // READ THE WRAP KEY, NEVER MINT ONE, and this is the line that makes the two failures below
  // tellable apart. `getOrCreateWrapKey` GENERATES and STORES a fresh key when none is present,
  // which is right for a save and wrong here twice: it is a write on a read path, and the new key
  // destroys the one fact that separates "the wrap key is gone" from "the blob was altered" -
  // afterwards both arrive at the same failed decrypt. That is why the old `catch` could NAME two
  // causes (`tampered blob, key rotated`) and distinguish neither, on the one path in this file
  // where the difference is a security signal rather than a detail.
  const wrapped = vaultStore().getItem(VAULT_KEY_KEY);
  if (!wrapped) {
    console.warn(
      `[VAULT] a device key blob is stored (${storageKey}) but its wrap key is gone - clearing it; this device will ask for its PIN. ` +
        'Ordinary after a storage clear or a persistence-mode switch, and NOT evidence of tampering'
    );
    clear();
    return null;
  }

  const ivB64 = blob.slice(0, colonIdx);
  const cipherB64 = blob.slice(colonIdx + 1);

  try {
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    const cipher = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));
    const raw = Uint8Array.from(atob(wrapped), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv },
      key,
      cipher
    );
    return new TextDecoder().decode(plain);
  } catch (e) {
    // THE WRAP KEY WAS THERE AND THE BLOB STILL DID NOT OPEN. Everything ordinary was excluded
    // above, so this line accuses: an AEAD tag that does not verify under a key that IS present
    // means the ciphertext, the iv, the key - or, for a labelled slot, the account it is filed
    // under - was altered after it was written.
    console.warn(
      `[VAULT] the stored device key (${storageKey}) did not decrypt under a wrap key that IS present - clearing it; ` +
        `this device will ask for its PIN. The blob, its iv, its account label or the key has been altered since it was written: ` +
        `${String(e)}`
    );
    clear();
    return null;
  }
}

/**
 * Returns the device key vaulted for `userId`, or `null` when this account has none here.
 *
 * Exactly one source answers, chosen by what is STORED, never by a failure:
 *
 * - **`userId`'s own slot**, when it exists - `ownerProven: true`. A slot that does not open is
 *   cleared and `null` is returned; nothing else is consulted.
 * - **Otherwise the unlabelled slot of an older build** - `ownerProven: false`. It may be this
 *   account's or that of an account that signed in before it, and only the login can tell: the key
 *   must open a saved state whose credential names this account (`vaultOwnerUnproven`). It is not
 *   cleared on this account's behalf - it may be someone else's, and it is theirs to lose.
 * - **Otherwise `null`**, including when other accounts hold slots: they are theirs, left alone.
 */
export async function loadDeviceKey(userId: string): Promise<VaultedDeviceKey | null> {
  if (vaultStore().getItem(slotKey(userId)) !== null) {
    const own = await openBlob(slotKey(userId), slotAad(userId), () => clearDeviceKey(userId));
    return own === null ? null : { deviceKeyB64: own, ownerProven: true };
  }
  const unlabelled = await openBlob(
    UNLABELLED_VAULT_BLOB_KEY,
    undefined,
    forgetUnlabelledDeviceKey
  );
  if (unlabelled === null) return null;
  console.log(
    `[VAULT] no slot for ${userId.slice(0, 8)} - offering the UNLABELLED vault of an older build; the login must prove whose it is`
  );
  return { deviceKeyB64: unlabelled, ownerProven: false };
}

/**
 * Removes the unlabelled slot an older build wrote.
 *
 * Called once its owner is PROVEN - a login on its key opened a saved state naming the account,
 * whose own slot now holds the key - and when a blob that will never open is found. Never on the
 * strength of a sign-in that merely did not match: the slot may be another account's, and refusing
 * it is all such a sign-in is entitled to.
 */
export function forgetUnlabelledDeviceKey(): void {
  sessionStorage.removeItem(UNLABELLED_VAULT_BLOB_KEY);
  localStorage.removeItem(UNLABELLED_VAULT_BLOB_KEY);
}

/**
 * After a SUCCESSFUL login of `userId` with `deviceKeyB64`, removes the unlabelled slot of an older
 * build when - and only when - it holds that very key. Returns whether it did.
 *
 * WHY THE KEY IS THE PROOF. A device key is derived from the account id, its PIN and its salt, so
 * two accounts never share one: an unlabelled slot that decrypts to the key this account has just
 * unlocked with IS this account's, whichever path the login took (the unlabelled slot itself, its
 * own slot, the PIN, the keystore). One that holds any other key may be another account's that
 * nobody has proven yet, and it is kept for that account - the slot is offered to whoever signs in,
 * and only its owner may retire it. Without this, an account that unlocked by its PIN or its own
 * slot left its old unlabelled copy behind for ever, offered to every other account that signed in.
 */
export async function retireUnlabelledDeviceKeyIfOwnedBy(
  userId: string,
  deviceKeyB64: string
): Promise<boolean> {
  if (vaultStore().getItem(UNLABELLED_VAULT_BLOB_KEY) === null) return false;
  const held = await openBlob(UNLABELLED_VAULT_BLOB_KEY, undefined, forgetUnlabelledDeviceKey);
  if (held === null) return false;
  if (held !== deviceKeyB64) {
    console.log(
      `[VAULT] the unlabelled vault holds another key than ${userId.slice(0, 8)}'s - kept for the account it belongs to`
    );
    return false;
  }
  forgetUnlabelledDeviceKey();
  console.log(
    `[VAULT] the unlabelled vault held ${userId.slice(0, 8)}'s own key - retired after its successful login`
  );
  return true;
}

/**
 * Switches the device key persistence mode ("stay signed in"). Wipes every vault from BOTH stores
 * first (so no stale copy is left behind in the area being left), records the new preference,
 * then re-saves the signed-in account's key into the newly selected store when provided. Another
 * account's slot is dropped with the rest: that account unlocks once with its PIN.
 *
 * Pass the signed-in account and its in-memory device key to migrate an active session
 * immediately (e.g. toggling from Settings); pass `null` to only set the flag before a login whose
 * own `saveDeviceKey` will populate the correct store (e.g. the PIN-modal checkbox).
 *
 * A `null` call that does NOT change the mode changes nothing. The PIN modal makes one on every
 * submit, and wiping there erased every other account's slot each time somebody typed a PIN: A's
 * "stay signed in" did not survive B's sign-in on the same install, which is what one slot per
 * account exists to keep.
 */
export async function setDeviceKeyPersistence(
  enabled: boolean,
  current: { userId: string; deviceKeyB64: string } | null
): Promise<void> {
  if (current === null && isDeviceKeyPersistenceEnabled() === enabled) {
    console.debug(`[VAULT] persistence already ${enabled ? 'on' : 'off'} - every slot kept`);
    return;
  }
  clearDeviceKeyAndWrapKey();
  try {
    localStorage.setItem(PERSIST_FLAG_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore quota / private-mode errors - falls back to the session default.
  }
  if (current) await saveDeviceKey(current.userId, current.deviceKeyB64);
}

/**
 * Removes `userId`'s encrypted device key from both stores and keeps the wrap key. Touches no
 * other account's slot and not the unlabelled one, which may be somebody else's.
 */
export function clearDeviceKey(userId: string): void {
  sessionStorage.removeItem(slotKey(userId));
  localStorage.removeItem(slotKey(userId));
}

/** Every labelled slot key held in `store`. */
function slotKeysIn(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(SLOT_PREFIX)) keys.push(k);
  }
  return keys;
}

/**
 * Drops EVERY account's blob, the unlabelled one and the wrapping key from both stores: a
 * device-wide erasure (a revoked device, a key compromise, a persistence-mode switch, biometric
 * enrolment moving the key into the platform keystore).
 */
export function clearDeviceKeyAndWrapKey(): void {
  for (const store of [sessionStorage, localStorage]) {
    for (const k of slotKeysIn(store)) store.removeItem(k);
    store.removeItem(UNLABELLED_VAULT_BLOB_KEY);
    store.removeItem(VAULT_KEY_KEY);
    // Also clean up legacy keys during migration.
    store.removeItem(LEGACY_VAULT_BLOB_KEY);
    store.removeItem(LEGACY_VAULT_KEY_KEY);
  }
}
