<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { startOidcLogin, hasStoredSession, getToken, devLogin } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';

  // ─── Auth state ──────────────────────────────────────────────────────────
  let isLoggingIn = $state(false);
  let loginError = $state('');
  let biometricAvailable = $state(false);
  let requestedReturnTo = '';

  function getSafeReturnTarget(): string {
    const target =
      requestedReturnTo && requestedReturnTo.startsWith('/') ? requestedReturnTo : '/chat';
    // Avoid redirect loops to the login page itself.
    if (target === '/login' || target.startsWith('/login?')) return '/chat';
    return target;
  }

  onMount(() => {
    try {
      const url = new URL(window.location.href);
      requestedReturnTo = url.searchParams.get('returnTo') ?? '';
    } catch {
      requestedReturnTo = '';
    }

    const isTauri = !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (isTauri) {
      void (async () => {
        const configured = await BiometricService.isConfigured();
        if (configured) {
          biometricAvailable = true;
          if (await hasStoredSession()) {
            try {
              await getToken();
              void goto(getSafeReturnTarget(), { replaceState: true });
            } catch {
              // Token expired — user needs to re-authenticate via OIDC
            }
          }
        }
      })();
    } else {
      void (async () => {
        if (await hasStoredSession()) {
          try {
            await getToken();
            const target = getSafeReturnTarget();
            const current = window.location.pathname + window.location.search;
            if (target !== current) {
              await goto(target, { replaceState: true });
            }
          } catch {
            // Refresh token invalid — stay on login page
          }
        }
      })();
    }
  });

  // ─── OIDC Login ───────────────────────────────────────────────────────────
  function handleLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      startOidcLogin(getSafeReturnTarget());
      // Browser navigates to Authentik — no need to reset isLoggingIn
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
      isLoggingIn = false;
    }
  }

  // ─── DEV Login (no Authentik) ─────────────────────────────────────────────
  const isDev = import.meta.env.DEV;

  async function handleDevLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      await devLogin();
      await goto(getSafeReturnTarget(), { replaceState: true });
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
    } finally {
      isLoggingIn = false;
    }
  }

  async function resetAll() {
    if (!(window as any).__TAURI_INTERNALS__) {
      const allDbs = await indexedDB.databases();
      await Promise.all(
        allDbs
          .filter((db) => db.name?.startsWith('CanariDB'))
          .map(
            (db) =>
              new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(db.name!);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              })
          )
      );
    }
    localStorage.clear();
    loginError = '';
  }
</script>

<LoginForm
  {isLoggingIn}
  {loginError}
  {biometricAvailable}
  {isDev}
  onLogin={handleLogin}
  onDevLogin={handleDevLogin}
  onReset={resetAll}
/>
