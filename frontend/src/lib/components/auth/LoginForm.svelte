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
    /** Called when the user clicks the password test login button (store review). */
    onPasswordLogin: () => void;
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
    onPasswordLogin,
    onReset,
  }: Props = $props();
</script>

<div
  class="flex min-h-dvh items-start justify-center overflow-y-auto bg-transparent px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,var(--safe-area-inset-bottom,0px))] md:items-center"
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
    class="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-10 text-center shadow-2xl dark:border-white/10 dark:bg-zinc-900"
  >
    <!-- Logo -->
    <div class="mb-10">
      <div
        class="bg-cn-ink mx-auto mb-6 flex h-24 w-24 transform items-center justify-center rounded-[32px] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.3)] transition-transform duration-300 hover:scale-105"
      >
        <img
          src="/favicon.png"
          alt="Canari Logo"
          class="h-2/3 w-2/3 object-contain drop-shadow-md"
        />
      </div>
      <h1 class="font-brand text-text-main text-5xl font-bold tracking-wide drop-shadow-sm">
        Canari
      </h1>
      <p class="text-text-muted mt-3 text-base font-medium">{m.auth_brand_subtitle()}</p>
    </div>

    <!-- OIDC Login Button -->
    <div class="space-y-5">
      {#if maintenanceNotice}
        <div
          role="status"
          class="rounded-xl border border-amber-500/25 bg-amber-500/15 px-4 py-3 text-sm font-medium text-amber-700 backdrop-blur-md dark:text-amber-300"
        >
          {maintenanceNotice}
        </div>
      {/if}

      <button
        onclick={onLogin}
        disabled={isLoggingIn || loginDisabled}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 w-full rounded-2xl py-4 text-lg font-extrabold shadow-lg transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:cursor-wait disabled:opacity-70"
      >
        {#if isLoggingIn}
          <span class="inline-flex items-center gap-2">
            <span
              class="border-cn-ink/20 border-t-cn-ink inline-block h-4 w-4 animate-spin rounded-full border-2"
            ></span>
            {m.auth_redirecting()}
          </span>
        {:else}
          {m.auth_sign_in()}
        {/if}
      </button>

      <p class="text-text-muted text-xs">{m.auth_secure_login()}</p>

      {#if loginError}
        <div
          role="alert"
          aria-live="assertive"
          class="mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500 backdrop-blur-md dark:text-red-400"
          transition:slide
        >
          {loginError}
        </div>
      {/if}

      <!--
        Discreet secondary actions: rarely used by end users, so styled as
        low-emphasis text links (like device reset) to keep the primary
        OIDC button the clear focal point.
      -->
      <div class="text-text-muted mt-8 flex flex-col items-center gap-2.5 text-xs">
        <button
          type="button"
          onclick={onPasswordLogin}
          disabled={isLoggingIn || loginDisabled}
          class="hover:text-text-main underline transition-colors disabled:cursor-wait disabled:opacity-70"
        >
          {m.auth_test_login_password()}
        </button>
        <button
          type="button"
          onclick={onReset}
          class="underline transition-colors hover:text-red-500"
        >
          {m.auth_reset_device()}
        </button>
      </div>

      <div class="text-text-muted mt-6 flex justify-center gap-4 text-xs">
        <a href="/legal/privacy" class="hover:text-cn-yellow transition-colors"
          >{m.auth_privacy()}</a
        >
        <span>·</span>
        <a href="/legal/cgu" class="hover:text-cn-yellow transition-colors">{m.auth_terms()}</a>
      </div>
    </div>
  </div>
</div>
