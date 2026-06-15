import type { MlsStatePersister } from './mlsStatePersister';

let lifecycleInstalled = false;
let visibilityHandler: (() => void) | null = null;
let pageHideHandler: (() => void) | null = null;

/**
 * Installs backgrounding hooks that flush an encrypted MLS checkpoint.
 * `visibilitychange` covers tab hide; `pagehide` covers navigation / bfcache on mobile.
 */
export function installMlsStatePersisterLifecycle(persister: MlsStatePersister): void {
  if (lifecycleInstalled || typeof document === 'undefined') return;
  lifecycleInstalled = true;

  visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      void persister.flushEncrypted();
    }
  };
  pageHideHandler = () => {
    void persister.flushEncrypted();
  };

  document.addEventListener('visibilitychange', visibilityHandler, { passive: true });
  window.addEventListener('pagehide', pageHideHandler, { capture: true });
}

/** Removes lifecycle hooks on logout. Idempotent. */
export function uninstallMlsStatePersisterLifecycle(): void {
  if (!lifecycleInstalled || typeof document === 'undefined') return;

  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  if (pageHideHandler) {
    window.removeEventListener('pagehide', pageHideHandler, { capture: true });
  }

  lifecycleInstalled = false;
  visibilityHandler = null;
  pageHideHandler = null;
}
