<script lang="ts">
  import { fade, slide } from 'svelte/transition';

  interface Props {
    userId: string;
    pin: string;
    isLoggingIn: boolean;
    loginError: string;
    biometricAvailable: boolean;
    onUserIdChange: (value: string) => void;
    onPinChange: (value: string) => void;
    onLogin: () => void;
    onBiometricLogin: () => void;
    onReset: () => void;
  }

  let {
    userId,
    pin,
    isLoggingIn,
    loginError,
    biometricAvailable,
    onUserIdChange,
    onPinChange,
    onLogin,
    onBiometricLogin,
    onReset,
  }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !isLoggingIn) {
      onLogin();
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-transparent px-4" in:fade>
  <div
    class="w-full max-w-sm p-10 rounded-3xl text-center border border-cn-border shadow-[0_24px_70px_rgba(0,0,0,0.35)]"
    style="background: color-mix(in srgb, var(--cn-surface) 88%, transparent); backdrop-filter: blur(12px);"
  >
    <!-- Logo -->
    <div class="mb-10">
      <div
        class="w-20 h-20 text-cn-yellow rounded-3xl flex items-center justify-center mx-auto mb-6"
        style="background-color: #101827;"
      >
        <img src="/favicon.png" alt="Canari Logo" class="w-3/5 h-3/5 object-contain" />
      </div>
      <h1 class="text-4xl font-black text-text-main tracking-tight">Canari</h1>
      <p class="text-text-muted text-base mt-2">Mines Saint-Étienne</p>
    </div>

    <!-- Form -->
    <div class="space-y-5">
      <div class="text-left">
        <label for="uid" class="block text-sm font-bold text-cn-dark mb-2">Nom d'utilisateur</label>
        <input
          id="uid"
          type="text"
          value={userId}
          oninput={(e) => onUserIdChange(e.currentTarget.value)}
          onkeydown={handleKeydown}
          placeholder=""
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
      </div>

      <div class="text-left">
        <label for="pin" class="block text-sm font-bold text-cn-dark mb-2">PIN</label>
        <input
          id="pin"
          type="password"
          value={pin}
          oninput={(e) => onPinChange(e.currentTarget.value)}
          onkeydown={handleKeydown}
          placeholder="••••"
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
      </div>

      {#if biometricAvailable}
        <button
          onclick={onBiometricLogin}
          disabled={isLoggingIn}
          class="w-full py-4 bg-cn-yellow text-cn-dark rounded-2xl font-extrabold text-lg transition-all hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70 disabled:cursor-wait mt-2 flex items-center justify-center gap-2"
        >
          {#if isLoggingIn}
            <span class="inline-flex items-center gap-2">
              <span
                class="inline-block w-4 h-4 border-2 border-cn-dark/20 border-t-cn-dark rounded-full animate-spin"
              ></span>
              Démarrage...
            </span>
          {:else}
            <!-- fingerprint icon -->
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 10a2 2 0 0 0-2 2c0 1.02.5 1.93 1.27 2.49" />
              <path d="M12 2a10 10 0 0 1 9.39 6.52" />
              <path d="M12 22C6.48 22 2 17.52 2 12" />
              <path d="M4.93 4.93a10 10 0 0 0-.93 3" />
              <path d="M19.07 4.93A10 10 0 0 1 22 12" />
              <path d="M15.36 17.12A5 5 0 0 1 7 14" />
              <path d="M12 7a5 5 0 0 1 4.9 4" />
            </svg>
            Déverrouiller avec l'empreinte
          {/if}
        </button>
        <div class="flex items-center gap-3 my-1">
          <div class="flex-1 h-px bg-cn-border"></div>
          <span class="text-xs text-text-muted">ou entrer le PIN</span>
          <div class="flex-1 h-px bg-cn-border"></div>
        </div>
      {/if}

      <button
        onclick={onLogin}
        disabled={isLoggingIn}
        class="w-full py-4 {biometricAvailable
          ? 'bg-cn-surface border-2 border-cn-border text-text-main hover:border-cn-yellow'
          : 'bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover'} rounded-2xl font-extrabold text-lg transition-all hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70 disabled:cursor-wait mt-2"
      >
        {#if isLoggingIn}
          <span class="inline-flex items-center gap-2">
            <span
              class="inline-block w-4 h-4 border-2 border-cn-dark/20 border-t-cn-dark rounded-full animate-spin"
            ></span>
            Démarrage...
          </span>
        {:else}
          Se connecter
        {/if}
      </button>

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
