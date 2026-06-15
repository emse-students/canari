// ---------------------------------------------------------------------------
// Encryption salt helper - shared by IndexedDbStorage and SqliteStorage.
// ---------------------------------------------------------------------------

/**
 * Returns a stable 16-byte AES salt for the given storage identifier,
 * creating and persisting it on first call.  All messages for a given user
 * are encrypted with the same salt so the PBKDF2 key can be cached in memory
 * across the entire session (see encryption.ts).
 */
export function getOrCreateEncryptionSalt(storageId: string): Uint8Array {
  const lsKey = `canari_enc_salt:${storageId}`;
  const stored = localStorage.getItem(lsKey) ?? sessionStorage.getItem(lsKey);
  if (stored) {
    try {
      return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    } catch {
      // corrupted entry - fall through to regenerate
    }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoded = btoa(Array.from(salt, (b) => String.fromCharCode(b)).join(''));
  try {
    localStorage.setItem(lsKey, encoded);
    return salt;
  } catch {
    // localStorage quota exceeded or blocked - try sessionStorage as a session-scoped fallback.
    // Without a stable salt, PBKDF2 is re-derived on every message (~100× slower).
    console.warn(
      "[salt] localStorage indisponible - tentative sessionStorage. Chiffrement plus lent en cas d'échec."
    );
    try {
      sessionStorage.setItem(lsKey, encoded);
    } catch {
      // sessionStorage also unavailable - the random salt is returned as-is (per-message derivation).
    }
    return salt;
  }
}
