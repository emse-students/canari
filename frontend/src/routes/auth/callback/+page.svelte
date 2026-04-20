<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { handleOidcCallback, getOidcReturnTo } from '$lib/stores/auth';

  let error = $state('');
  let status = $state('Authentification en cours…');

  async function processCallback(code: string, state: string) {
    try {
      status = "Échange du code d'autorisation…";
      await handleOidcCallback(code, state);
      status = 'Connexion réussie ! Redirection…';
      const returnTo = getOidcReturnTo();
      await goto(returnTo, { replaceState: true });
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);

    // ── Tauri desktop mode : attente d'un deep link canari://auth/callback ─
    const platform = (import.meta.env.TAURI_ENV_PLATFORM as string | undefined) ?? '';
    if (
      params.get('tauri') === '1' &&
      '__TAURI_INTERNALS__' in window &&
      platform !== 'android' &&
      platform !== 'ios'
    ) {
      status = 'En attente de la réponse du navigateur…';
      try {
        const { onOpenUrl, getCurrent, register } = await import('@tauri-apps/plugin-deep-link');

        // Ensure the canari:// scheme is registered with the OS (needed in dev mode
        // on Linux where no .desktop file is bundled).
        try {
          await register('canari');
        } catch {
          /* already registered or unsupported */
        }

        // Handle the case where the app was opened/focused by the deep link
        const current = await getCurrent();
        if (current && current.length > 0) {
          const url = new URL(current[0]);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const authError = url.searchParams.get('error');
          if (authError) {
            error = `Authentik a refusé la connexion : ${url.searchParams.get('error_description') || authError}`;
            return;
          }
          if (code && state) {
            await processCallback(code, state);
            return;
          }
        }

        // Otherwise wait for the deep link event while the app is already running
        const unlisten = await onOpenUrl(async (urls: string[]) => {
          unlisten();
          const raw = urls[0];
          try {
            const url = new URL(raw);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const authError = url.searchParams.get('error');
            if (authError) {
              error = `Authentik a refusé la connexion : ${url.searchParams.get('error_description') || authError}`;
              return;
            }
            if (!code || !state) {
              error = 'Paramètres manquants dans la redirection Authentik.';
              return;
            }
            await processCallback(code, state);
          } catch {
            error = `URL de callback invalide : ${raw}`;
          }
        });
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : String(e);
      }
      return;
    }

    // ── Mode navigateur standard : paramètres dans l'URL ────────────────────
    const code = params.get('code');
    const state = params.get('state');
    const authError = params.get('error');

    if (authError) {
      error = `Authentik a refusé la connexion : ${params.get('error_description') || authError}`;
      return;
    }

    if (!code || !state) {
      error = 'Paramètres manquants dans la redirection Authentik.';
      return;
    }

    await processCallback(code, state);
  });
</script>

<div class="min-h-dvh flex items-center justify-center px-4">
  <div
    class="w-full max-w-sm p-10 rounded-3xl text-center border border-cn-border shadow-lg"
    style="background: color-mix(in srgb, var(--cn-surface) 88%, transparent); backdrop-filter: blur(12px);"
  >
    {#if error}
      <div class="space-y-4">
        <div class="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto">
          <span class="text-red-600 text-2xl">✗</span>
        </div>
        <h2 class="text-lg font-bold text-text-main">Échec de la connexion</h2>
        <p class="text-sm text-red-600">{error}</p>
        <button
          onclick={() => goto('/login', { replaceState: true })}
          class="mt-4 px-6 py-3 bg-cn-yellow text-cn-dark rounded-2xl font-bold hover:bg-cn-yellow-hover transition-all"
        >
          Réessayer
        </button>
      </div>
    {:else}
      <div class="space-y-4">
        <div
          class="w-16 h-16 rounded-full bg-cn-yellow/20 flex items-center justify-center mx-auto"
        >
          <span
            class="inline-block w-6 h-6 border-3 border-cn-dark/20 border-t-cn-dark rounded-full animate-spin"
          ></span>
        </div>
        <p class="text-sm font-medium text-text-muted">{status}</p>
      </div>
    {/if}
  </div>
</div>
