/**
 * Best-effort detection of ephemeral / private browsing where local storage may
 * be unavailable or cleared when the session ends.
 *
 * Do **not** use `navigator.storage.persisted()` for this: it reports whether the
 * site was granted durable storage, which is `false` by default in normal browsing
 * until `storage.persist()` succeeds - not whether the user is in incognito.
 */
export async function isLikelyPrivateBrowsing(): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  try {
    const key = '__canari_storage_probe';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
  } catch {
    return true;
  }

  if (typeof indexedDB === 'undefined') return false;

  return new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => resolve(false), 500);
    const req = indexedDB.open('__canari_storage_probe', 1);
    req.onerror = () => {
      window.clearTimeout(timeout);
      resolve(true);
    };
    req.onsuccess = () => {
      window.clearTimeout(timeout);
      req.result.close();
      void indexedDB.deleteDatabase('__canari_storage_probe');
      resolve(false);
    };
  });
}
