import type { MlsStatePersister } from './mlsStatePersister';
import { onAppForegroundChange } from '$lib/utils/appForeground';

/** The persister whose hooks are installed now; null when none are. */
let installedFor: MlsStatePersister | null = null;
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
 *
 * ONE SET OF HOOKS, FOR THE PERSISTER GIVEN. Installing for the persister already installed is a
 * no-op; installing for ANOTHER one replaces the hooks, because they would otherwise keep flushing
 * a previous session's client while the new session's state went unflushed on a backgrounding.
 */
export function installMlsStatePersisterLifecycle(persister: MlsStatePersister): void {
  if (typeof document === 'undefined' || installedFor === persister) return;
  if (installedFor) {
    console.debug('[MLS] persister lifecycle replaced - hooks of a previous session removed');
    uninstallMlsStatePersisterLifecycle();
  }
  installedFor = persister;

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

/**
 * Removes lifecycle hooks on logout. Idempotent.
 *
 * `owner` names the persister whose hooks are being removed: a sign-out removes them only after its
 * final flush, and the next session may have installed its own by then - those are left alone.
 * Without it (tests), whatever is installed is removed.
 */
export function uninstallMlsStatePersisterLifecycle(owner?: MlsStatePersister | null): void {
  if (!installedFor || typeof document === 'undefined') return;
  if (owner !== undefined && installedFor !== owner) {
    console.debug(
      '[MLS] persister lifecycle uninstall skipped - a newer session installed its own'
    );
    return;
  }

  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  if (pageHideHandler) {
    window.removeEventListener('pagehide', pageHideHandler, { capture: true });
  }
  foregroundUnsubscribe?.();
  foregroundUnsubscribe = null;

  installedFor = null;
  visibilityHandler = null;
  pageHideHandler = null;
}
