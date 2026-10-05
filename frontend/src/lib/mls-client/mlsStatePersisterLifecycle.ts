import type { MlsStatePersister } from './mlsStatePersister';
import { onAppForegroundChange } from '$lib/utils/appForeground';

let lifecycleInstalled = false;
let visibilityHandler: (() => void) | null = null;
let pageHideHandler: (() => void) | null = null;
let foregroundUnsubscribe: (() => void) | null = null;

/**
 * Installs backgrounding hooks that flush an encrypted MLS checkpoint.
 * `visibilitychange` covers tab hide; `pagehide` covers navigation / bfcache on mobile.
 *
 * AND THE NATIVE FOREGROUND EDGE, because on a phone neither of those fires when the app is sent
 * to the background: a backgrounded Android WebView keeps reporting `visible` (measured, see
 * `appForeground.ts`), and backgrounding is exactly where the OS may kill the process without
 * warning. The activity's own `canari:foreground` event is the honest trigger; it is a no-op on
 * every runtime that does not emit it, so web and desktop keep their behaviour exactly.
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
  foregroundUnsubscribe = onAppForegroundChange((foreground) => {
    if (foreground) return;
    console.debug('[MLS] app sent to the background - flushing the encrypted checkpoint');
    void persister.flushEncrypted();
  });
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
  foregroundUnsubscribe?.();
  foregroundUnsubscribe = null;

  lifecycleInstalled = false;
  visibilityHandler = null;
  pageHideHandler = null;
}
