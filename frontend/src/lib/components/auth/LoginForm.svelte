<script lang="ts">
  import { fade, slide } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether an OIDC or dev login request is in progress. */
    isLoggingIn: boolean;
    /** Error message to display below the login button; empty string hides it. */
    loginError: string;
    /** Whether biometric authentication is available on the current device. */
    biometricAvailable: boolean;
    /** Optional maintenance notice shown above the login button. */
    maintenanceNotice?: string | null;
    /** When true, the login button is disabled (e.g. client below min version). */
    loginDisabled?: boolean;
    /** Called when the user clicks the main OIDC login button. */
    onLogin: () => void;
    /** Called when the user clicks the device-reset link. */
    onReset: () => void;
  }

  let {
    isLoggingIn,
    loginError,
    biometricAvailable: _biometricAvailable,
    maintenanceNotice = null,
    loginDisabled = false,
    onLogin,
    onReset,
  }: Props = $props();
</script>

<div
  class="min-h-dvh overflow-y-auto flex items-start md:items-center justify-center bg-transparent px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]"
  in:fade
>
  <!--
    Effet Glassmorphism accentué :
    - Fond très transparent (bg-white/20 ou bg-black/40)
    - Flou arrière très fort (backdrop-blur-2xl)
    - Bordure blanche semi-transparente pour l'éclat du verre
    - Ombre diffuse (shadow-2xl)
  -->
  <div
    class="w-full max-w-sm p-10 rounded-3xl text-center shadow-2xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-zinc-900"
  >
    <!-- Logo -->
    <div class="mb-10">
      <div
        class="w-24 h-24 rounded-[32px] bg-[#151B2C] shadow-[0_8px_32px_rgba(0,0,0,0.3)] border border-white/10 flex items-center justify-center mx-auto mb-6 transform hover:scale-105 transition-transform duration-300"
      >
        <img
          src="/favicon.png"
          alt="Canari Logo"
          class="w-2/3 h-2/3 object-contain drop-shadow-md"
        />
      </div>
      <h1 class="text-5xl font-brand font-bold text-text-main tracking-wide drop-shadow-sm">
        Canari
      </h1>
      <p class="text-text-muted text-base mt-3 font-medium">{m.auth_brand_subtitle()}</p>
    </div>

    <!-- OIDC Login Button -->
    <div class="space-y-5">
      {#if maintenanceNotice}
        <div
          role="status"
          class="bg-amber-500/15 text-amber-700 dark:text-amber-300 px-4 py-3 rounded-xl text-sm font-medium border border-amber-500/25 backdrop-blur-md"
        >
          {maintenanceNotice}
        </div>
      {/if}

      <button
        onclick={onLogin}
        disabled={isLoggingIn || loginDisabled}
        class="w-full py-4 bg-cn-yellow text-[#151B2C] rounded-2xl font-extrabold text-lg transition-all hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-cn-yellow/20 disabled:opacity-70 disabled:cursor-wait"
      >
        {#if isLoggingIn}
          <span class="inline-flex items-center gap-2">
            <span
              class="inline-block w-4 h-4 border-2 border-[#151B2C]/20 border-t-[#151B2C] rounded-full animate-spin"
            ></span>
            {m.auth_redirecting()}
          </span>
        {:else}
          {m.auth_sign_in()}
        {/if}
      </button>

      <p class="text-xs text-text-muted">{m.auth_secure_login()}</p>

      {#if loginError}
        <div
          role="alert"
          aria-live="assertive"
          class="bg-red-500/10 text-red-500 dark:text-red-400 px-4 py-3 rounded-xl text-sm font-medium border border-red-500/20 backdrop-blur-md mt-6"
          transition:slide
        >
          {loginError}
        </div>
      {/if}

      <button
        onclick={onReset}
        class="text-text-muted text-xs mt-6 underline hover:text-red-500 transition-colors"
      >
        {m.auth_reset_device()}
      </button>

      <div class="flex justify-center gap-4 mt-4 text-xs text-text-muted">
        <a href="/legal/privacy" class="hover:text-cn-yellow transition-colors">{m.auth_privacy()}</a>
        <span>·</span>
        <a href="/legal/cgu" class="hover:text-cn-yellow transition-colors">{m.auth_terms()}</a>
      </div>
    </div>
  </div>
</div>
