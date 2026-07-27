<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    startOidcLogin,
    hasStoredSession,
    getToken,
    PASSWORD_LOGIN_FLOW_SLUG,
  } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import {
    getAppVersionCheck,
    isBelowMinClientVersion,
    refreshAppVersionCheck,
  } from '$lib/stores/appVersionCheck.svelte';
  import { m } from '$lib/paraglide/messages';

  // ─── Auth state ─────────────────────────────────────────────────────────────
  let isLoggingIn = $state(false);
  let loginError = $state('');
  let biometricAvailable = $state(false);
  let requestedReturnTo = '';

  const platformInfo = $derived(getAppVersionCheck());
  const loginDisabled = $derived(isBelowMinClientVersion());
  const maintenanceNotice = $derived.by(() => {
    if (!platformInfo?.maintenance.enabled) return null;
    return platformInfo.maintenance.message || m.auth_maintenance_default();
  });

  /** Key holding the last auto-redirect target and its timestamp, for the loop breaker. */
  const LAST_AUTO_REDIRECT_KEY = 'canari_login_auto_redirect';
  /** A second bounce to the same target within this window is treated as a loop. */
  const AUTO_REDIRECT_LOOP_WINDOW_MS = 5000;

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function getSafeReturnTarget(): string {
    const target = requestedReturnTo?.startsWith('/') ? requestedReturnTo : '/posts';
    // Prevent redirect loops back to the login page.
    if (target === '/login' || target.startsWith('/login?')) return '/posts';
    return target;
  }

  /**
   * Loop breaker for the silent post-session redirect.
   *
   * A page can send the user here because ITS notion of "signed in" is unmet while the OIDC
   * session this page checks is perfectly valid - the two never converge, and the pair spins
   * at roughly one full round trip per second, each one burning a token refresh. Refusing the
   * second identical bounce inside a short window leaves the user on /login, where the sign-in
   * button and the reset action are both reachable.
   *
   * Only the automatic redirect is throttled; an explicit sign-in still honours returnTo.
   */
  function shouldAutoRedirectTo(target: string): boolean {
    try {
      const raw = sessionStorage.getItem(LAST_AUTO_REDIRECT_KEY);
      const now = Date.now();
      if (raw) {
        const { target: last, at } = JSON.parse(raw) as { target: string; at: number };
        if (last === target && now - at < AUTO_REDIRECT_LOOP_WINDOW_MS) {
          sessionStorage.removeItem(LAST_AUTO_REDIRECT_KEY);
          console.warn(`[auth] redirect loop to ${target} broken - staying on /login`);
          loginError = m.auth_redirect_loop_blocked();
          return false;
        }
      }
      sessionStorage.setItem(LAST_AUTO_REDIRECT_KEY, JSON.stringify({ target, at: now }));
    } catch {
      // sessionStorage unavailable (private mode): fall through and redirect as before.
    }
    return true;
  }

  // ─── Initialization ──────────────────────────────────────────────────────────
  onMount(() => {
    void refreshAppVersionCheck();

    // Reset isLoggingIn when the user returns to the page (e.g. after a failed
    // navigation to Authentik or after a biometric prompt).
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        isLoggingIn = false;
        void refreshAppVersionCheck();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    // 1. Safely extract the return URL from query params.
    try {
      const url = new URL(window.location.href);
      requestedReturnTo = url.searchParams.get('returnTo') ?? '';
    } catch {
      requestedReturnTo = '';
    }

    // 2. Unified session + biometric check.
    const initAuth = async () => {
      await refreshAppVersionCheck();
      if (isBelowMinClientVersion()) return;

      const isTauri = isTauriRuntime();

      // Biometric check is Tauri-only.
      if (isTauri) {
        try {
          biometricAvailable = await BiometricService.isAvailable();
        } catch {
          biometricAvailable = false;
        }
      }

      // Session check (Tauri + Web).
      if (await hasStoredSession()) {
        try {
          await getToken();
          const target = getSafeReturnTarget();
          const current = window.location.pathname + window.location.search;

          // Only redirect when not already on the target page, and never twice in a row to a
          // target that just bounced back here.
          if (target !== current && shouldAutoRedirectTo(target)) {
            await goto(target, { replaceState: true });
          }
        } catch {
          // Token expired or invalid: stay on login so the user can re-authenticate.
          console.debug('Session expired or invalid, re-login required.');
        }
      }
    };

    void initAuth();

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  });

  // ─── Event handlers ────────────────────────────────────────────────────────
  async function handleLogin() {
    loginError = '';
    await refreshAppVersionCheck();
    if (isBelowMinClientVersion()) {
      loginError = m.auth_update_required({ version: platformInfo?.minClientVersion ?? '?' });
      return;
    }
    isLoggingIn = true;
    try {
      startOidcLogin(getSafeReturnTarget());
      // The browser navigates to Authentik - no need to reset isLoggingIn.
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
      isLoggingIn = false;
    }
  }

  async function handlePasswordLogin() {
    loginError = '';
    await refreshAppVersionCheck();
    if (isBelowMinClientVersion()) {
      loginError = m.auth_update_required({ version: platformInfo?.minClientVersion ?? '?' });
      return;
    }
    isLoggingIn = true;
    try {
      await startOidcLogin(getSafeReturnTarget(), { flowSlug: PASSWORD_LOGIN_FLOW_SLUG });
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
      isLoggingIn = false;
    }
  }

  async function resetAll() {
    // IndexedDB cleanup is web-only (Tauri uses native app data instead).
    if (!isTauriRuntime()) {
      try {
        if (indexedDB.databases) {
          const allDbs = await indexedDB.databases();
          const deletePromises = allDbs
            .filter((db) => db.name?.startsWith('CanariDB'))
            .map((db) => {
              return new Promise<void>((resolve) => {
                if (!db.name) return resolve();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              });
            });
          await Promise.all(deletePromises);
        }
      } catch (e) {
        console.warn('Error clearing IndexedDB databases:', e);
      }
    } else {
      const { invoke } = await import('@tauri-apps/api/core');

      await invoke('delete_mls_state');

      await import('$lib/services/biometric').then(({ BiometricService }) =>
        BiometricService.disable()
      );

      // Delete all .db files in the Tauri app data directory
      await invoke('clear_app_data');
    }

    // Clear all browser storage.
    localStorage.clear();
    sessionStorage.clear();
    loginError = '';
  }
</script>

<LoginForm
  {isLoggingIn}
  {loginError}
  {biometricAvailable}
  {maintenanceNotice}
  {loginDisabled}
  onLogin={handleLogin}
  onPasswordLogin={handlePasswordLogin}
  onReset={resetAll}
/>
