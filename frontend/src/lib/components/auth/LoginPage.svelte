<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { startOidcLogin, hasStoredSession, getToken } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';
  import { isTauriRuntime } from '$lib/utils/openExternal';
  import {
    getAppVersionCheck,
    isBelowMinClientVersion,
    refreshAppVersionCheck,
  } from '$lib/stores/appVersionCheck.svelte';
  import { m } from '$lib/paraglide/messages';

  // ─── État de l'authentification ─────────────────────────────────────────────
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

  // ─── Utilitaires ────────────────────────────────────────────────────────────
  function getSafeReturnTarget(): string {
    const target = requestedReturnTo?.startsWith('/') ? requestedReturnTo : '/posts';
    // Évite les boucles de redirection vers la page de login elle-même
    if (target === '/login' || target.startsWith('/login?')) return '/posts';
    return target;
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────
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

    // 1. Récupération sécurisée de l'URL de retour
    try {
      const url = new URL(window.location.href);
      requestedReturnTo = url.searchParams.get('returnTo') ?? '';
    } catch {
      requestedReturnTo = '';
    }

    // 2. Vérification unifiée de la session et de la biométrie
    const initAuth = async () => {
      await refreshAppVersionCheck();
      if (isBelowMinClientVersion()) return;

      const isTauri = isTauriRuntime();

      // Vérification biométrique spécifique à Tauri
      if (isTauri) {
        try {
          biometricAvailable = await BiometricService.isAvailable();
        } catch {
          biometricAvailable = false;
        }
      }

      // Vérification de session unifiée (Tauri + Web)
      if (await hasStoredSession()) {
        try {
          await getToken();
          const target = getSafeReturnTarget();
          const current = window.location.pathname + window.location.search;

          // On ne redirige que si on n'est pas déjà sur la bonne page
          if (target !== current) {
            await goto(target, { replaceState: true });
          }
        } catch {
          // Le token est expiré ou invalide : on reste sur la page pour se reconnecter
          console.debug('Session invalide, re-connexion requise.');
        }
      }
    };

    void initAuth();

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  });

  // ─── Gestionnaires d'événements ───────────────────────────────────────────
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
      // Le navigateur navigue vers Authentik - pas besoin de réinitialiser isLoggingIn
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
      isLoggingIn = false;
    }
  }

  async function resetAll() {
    // Nettoyage IndexedDB uniquement pour les utilisateurs Web
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
        console.warn('Erreur lors du nettoyage de la base de données:', e);
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

    // Nettoyage complet du stockage local
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
  loginDisabled={loginDisabled}
  onLogin={handleLogin}
  onReset={resetAll}
/>
