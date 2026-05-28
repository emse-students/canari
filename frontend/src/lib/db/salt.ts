// ---------------------------------------------------------------------------
// Encryption salt helper – shared by IndexedDbStorage and SqliteStorage.
// ---------------------------------------------------------------------------

/**
 * Returns a stable 16-byte AES salt for the given storage identifier,
 * creating and persisting it on first call.  All messages for a given user
 * are encrypted with the same salt so the PBKDF2 key can be cached in memory
 * across the entire session (see encryption.ts).
 */
export function getOrCreateEncryptionSalt(storageId: string): Uint8Array {
  const lsKey = `canari_enc_salt:${storageId}`;
  const stored = localStorage.getItem(lsKey);
  if (stored) {
    try {
      return Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    } catch {
      // corrupted entry - fall through to regenerate
    }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    localStorage.setItem(lsKey, btoa(Array.from(salt, (b) => String.fromCharCode(b)).join('')));
  } catch {
    // localStorage quota exceeded - graceful degradation: per-message random salt (no cache)
  }
  return salt;
}
