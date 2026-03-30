<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { login, hasStoredSession, getToken } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';

  // ─── Auth state ──────────────────────────────────────────────────────────
  let userId = $state('');
  let pin = $state('');
  let isLoggingIn = $state(false);
  let loginError = $state('');
  let biometricAvailable = $state(false);
  let requestedReturnTo = '';

  function getSafeReturnTarget(): string {
    const target = requestedReturnTo && requestedReturnTo.startsWith('/') ? requestedReturnTo : '/chat';
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
          await handleBiometricLogin();
        }
      })();
    } else if (hasStoredSession()) {
      // Only auto-redirect when a refresh token is still usable and local chat creds exist.
      void (async () => {
        const savedUser = localStorage.getItem('canari_saved_user');
        const savedPin = localStorage.getItem('canari_saved_pin');
        if (!savedUser || !savedPin) return;

        try {
          await getToken();
          const target = getSafeReturnTarget();
          const current = window.location.pathname + window.location.search;
          if (target !== current) {
            await goto(target, { replaceState: true });
          }
        } catch {
          // Refresh token invalid or expired: stay on login page.
        }
      })();
    }
  });

  // ─── Login ────────────────────────────────────────────────────────────────
  // Authenticates with core-service using only the userId (dev phase).
  // The PIN is stored separately and used exclusively by the delivery service
  // to unlock the local MLS key package — it is NOT sent to the auth endpoint.

  async function handleLogin() {
    if (!userId.trim()) {
      loginError = "Veuillez saisir votre nom d'utilisateur.";
      return;
    }

    loginError = '';
    isLoggingIn = true;
    const uid = userId.trim().toLowerCase();

    try {
      await login(uid);

      // Persist userId and PIN (PIN only used by delivery/MLS layer, not for auth).
      localStorage.setItem('canari_saved_user', uid);
      if (pin.trim()) {
        localStorage.setItem('canari_saved_pin', pin.trim());
      }

      const target = getSafeReturnTarget();
      void goto(target, { replaceState: true });
    } catch (_e: unknown) {
      loginError = _e instanceof Error ? _e.message : String(_e);
    } finally {
      isLoggingIn = false;
    }
  }

  async function handleBiometricLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      const savedUser = localStorage.getItem('canari_saved_user');
      if (!savedUser) {
        loginError = 'Aucun utilisateur enregistré pour la biométrie.';
        return;
      }
      const retrieved = await BiometricService.authenticateAndGetSecret();
      if (!retrieved) {
        loginError =
          "L'authentification biométrique a échoué. Entrez votre identifiant manuellement.";
        return;
      }
      userId = savedUser;
      pin = retrieved;
      await handleLogin();
    } catch (e) {
      loginError = 'Échec de la biométrie. Entrez votre identifiant manuellement.';
      console.error(e);
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
    userId = '';
    pin = '';
    loginError = '';
  }
</script>

<LoginForm
  {userId}
  {pin}
  {isLoggingIn}
  {loginError}
  {biometricAvailable}
  onUserIdChange={(value) => (userId = value)}
  onPinChange={(value) => (pin = value)}
  onLogin={handleLogin}
  onBiometricLogin={handleBiometricLogin}
  onReset={resetAll}
/>
