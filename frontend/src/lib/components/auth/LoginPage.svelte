<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    startOidcLogin,
    hasStoredSession,
    getToken,
    devLogin,
    devRoutesEnabled,
  } from '$lib/stores/auth';
  import { BiometricService } from '$lib/services/biometric';
  import LoginForm from './LoginForm.svelte';

  // ─── État de l'authentification ─────────────────────────────────────────────
  let isLoggingIn = $state(false);
  let loginError = $state('');
  let biometricAvailable = $state(false);
  let requestedReturnTo = '';
  let devId = $state('');

  const isDev = devRoutesEnabled();

  // ─── Utilitaires ────────────────────────────────────────────────────────────
  function getSafeReturnTarget(): string {
    const target = requestedReturnTo?.startsWith('/') ? requestedReturnTo : '/posts';
    // Évite les boucles de redirection vers la page de login elle-même
    if (target === '/login' || target.startsWith('/login?')) return '/posts';
    return target;
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────
  onMount(() => {
    // 1. Récupération sécurisée de l'URL de retour
    try {
      const url = new URL(window.location.href);
      requestedReturnTo = url.searchParams.get('returnTo') ?? '';
    } catch {
      requestedReturnTo = '';
    }

    // 2. Vérification unifiée de la session et de la biométrie
    const initAuth = async () => {
      const isTauri = '__TAURI_INTERNALS__' in window;

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
  });

  // ─── Gestionnaires d'événements ───────────────────────────────────────────
  async function handleLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      await startOidcLogin(getSafeReturnTarget());
      // Le navigateur (ou la webview) navigue vers la suite — pas besoin de réinitialiser isLoggingIn
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
      isLoggingIn = false;
    }
  }

  async function handleDevLogin() {
    loginError = '';
    isLoggingIn = true;
    try {
      await devLogin(devId || undefined);
      await goto(getSafeReturnTarget(), { replaceState: true });
    } catch (e: unknown) {
      loginError = e instanceof Error ? e.message : String(e);
    } finally {
      isLoggingIn = false;
    }
  }

  async function resetAll() {
    // Nettoyage IndexedDB uniquement pour les utilisateurs Web
    if (!('__TAURI_INTERNALS__' in window)) {
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
  {isDev}
  bind:devId
  onLogin={handleLogin}
  onDevLogin={handleDevLogin}
  onReset={resetAll}
/>
