export function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const B64_PREFIX = 'b64:';

// ── IndexedDB storage for MLS state ──────────────────────────────────────────
// IndexedDB has no meaningful size limit (typically GBs), unlike localStorage
// which is capped at ~5 MB. The MLS state blob grows with group count and
// prekey pool size, so we store it as raw binary here.

// Separate DB from the message/conversation DB to avoid version conflicts
const IDB_NAME = `CanariDBMls_`;
const IDB_STORE = 'state';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openMlsDb(userId: string): Promise<IDBDatabase> {
  if (!_dbPromise) {
    _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME + userId, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        _dbPromise = null;
        reject(req.error);
      };
    });
  }
  return _dbPromise;
}

/**
 * Persist the MLS state blob for `userId` in IndexedDB.
 * Stores raw bytes — no base64 overhead.
 */
export async function saveMlsState(userId: string, bytes: Uint8Array): Promise<void> {
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // Ensure native .bin file is written — fail fast so callers can handle errors.
      await invoke('save_mls_state', { data: Array.from(bytes) });
      return;
    } catch (e) {
      console.warn('[MLS] save_mls_state failed:', e);
      throw e;
    }
  }

  const db = await openMlsDb(userId);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, 'mls_autosave');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load the MLS state blob for `userId` from IndexedDB.
 *
 * Includes a one-time migration: if the key is absent in IDB but present in
 * localStorage (old format), the data is migrated automatically and the
 * localStorage entry is removed.
 */
export async function loadMlsState(userId: string): Promise<Uint8Array | null> {
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<number[] | null>('load_mls_state');
      if (res && Array.isArray(res) && res.length > 0) return Uint8Array.from(res);
      return null;
    } catch (e) {
      console.warn('[MLS] load_mls_state failed:', e);
      return null;
    }
  }

  const db = await openMlsDb(userId);
  const idbResult = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get('mls_autosave');
    req.onsuccess = () => resolve((req.result as Uint8Array) ?? null);
    req.onerror = () => reject(req.error);
  });
  if (idbResult) return idbResult;

  // Migration path: read legacy localStorage entry, move it to IDB, erase from localStorage.
  const saved = localStorage.getItem('mls_autosave_' + userId);
  if (!saved) return null;
  const bytes = saved.startsWith(B64_PREFIX)
    ? fromBase64(saved.slice(B64_PREFIX.length))
    : fromHex(saved);
  await saveMlsState(userId, bytes);
  localStorage.removeItem('mls_autosave_' + userId);
  return bytes;
}

/** Remove the MLS state for `userId` from IndexedDB (and legacy localStorage). */
export async function removeMlsState(userId: string): Promise<void> {
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__;
  // Remove legacy localStorage entry always
  try {
    localStorage.removeItem('mls_autosave_' + userId);
  } catch {
    /* ignore */
  }

  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_mls_state');
    } catch (e) {
      console.warn('[MLS] delete_mls_state failed:', e);
    }
    return;
  }

  const db = await openMlsDb(userId);
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete('mls_autosave');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns the MLS state as hex for backup file format (backward-compatible). */
export async function exportMlsStateAsHex(userId: string): Promise<string | undefined> {
  const bytes = await loadMlsState(userId);
  return bytes ? toHex(bytes) : undefined;
}
