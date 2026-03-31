<script lang="ts">
  import { fade, slide } from 'svelte/transition';

  interface Props {
    isLoggingIn: boolean;
    loginError: string;
    biometricAvailable: boolean;
    isDev?: boolean;
    onLogin: () => void;
    onDevLogin?: () => void;
    onReset: () => void;
  }

  let {
    isLoggingIn,
    loginError,
    biometricAvailable,
    isDev = false,
    onLogin,
    onDevLogin,
    onReset,
  }: Props = $props();
</script>

<div
  class="min-h-dvh overflow-y-auto flex items-start md:items-center justify-center bg-transparent px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]"
  in:fade
>
  <div
    class="w-full max-w-sm p-10 rounded-3xl text-center border border-cn-border shadow-[0_24px_70px_rgba(0,0,0,0.35)]"
    style="background: color-mix(in srgb, var(--cn-surface) 88%, transparent); backdrop-filter: blur(12px);"
  >
    <!-- Logo -->
    <div class="mb-10">
      <div
        class="w-24 h-24 rounded-[32px] bg-gradient-to-br from-cn-yellow to-cn-yellow-hover shadow-lg border border-black/10 dark:border-white/10 flex items-center justify-center mx-auto mb-6 transform hover:scale-105 transition-transform duration-300"
      >
        <img
          src="/favicon.png"
          alt="Canari Logo"
          class="w-2/3 h-2/3 object-contain drop-shadow-md"
        />
      </div>
      <h1 class="text-5xl font-brand font-bold text-text-main tracking-wide">Canari</h1>
      <p class="text-text-muted text-base mt-3 font-medium">Mines Saint-Étienne</p>
    </div>

    <!-- OIDC Login Button -->
    <div class="space-y-5">
      <button
        onclick={onLogin}
        disabled={isLoggingIn}
        class="w-full py-4 bg-cn-yellow text-cn-dark rounded-2xl font-extrabold text-lg transition-all hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70 disabled:cursor-wait"
      >
        {#if isLoggingIn}
          <span class="inline-flex items-center gap-2">
            <span
              class="inline-block w-4 h-4 border-2 border-cn-dark/20 border-t-cn-dark rounded-full animate-spin"
            ></span>
            Redirection…
          </span>
        {:else}
          Se connecter
        {/if}
      </button>

      <p class="text-xs text-text-muted">Connexion sécurisée via votre compte Mines</p>

      {#if isDev && onDevLogin}
        <button
          onclick={onDevLogin}
          disabled={isLoggingIn}
          class="w-full py-3 bg-zinc-700 text-white rounded-2xl font-bold text-sm transition-all hover:bg-zinc-600 disabled:opacity-70 disabled:cursor-wait"
        >
          Dev Login (no Authentik)
        </button>
      {/if}

      {#if loginError}
        <div
          class="bg-red-50 text-red-500 px-4 py-3 rounded-xl text-sm font-medium border border-red-200 mt-6"
          transition:slide
        >
          {loginError}
        </div>
      {/if}

      <button
        onclick={onReset}
        class="text-text-muted text-xs mt-6 underline hover:text-red-500 transition-colors"
      >
        Réinitialiser l'appareil
      </button>
    </div>
  </div>
</div>
