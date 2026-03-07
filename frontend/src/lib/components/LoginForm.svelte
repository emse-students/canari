<script lang="ts">
  import { fade, slide } from "svelte/transition";

  interface Props {
    userId: string;
    pin: string;
    isLoggingIn: boolean;
    loginError: string;
    onUserIdChange: (value: string) => void;
    onPinChange: (value: string) => void;
    onLogin: () => void;
    onReset: () => void;
  }

  let {
    userId,
    pin,
    isLoggingIn,
    loginError,
    onUserIdChange,
    onPinChange,
    onLogin,
    onReset,
  }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !isLoggingIn) {
      onLogin();
    }
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-cn-bg" in:fade>
  <div class="bg-white w-full max-w-sm p-12 rounded-3xl shadow-lg text-center">
    <!-- Logo -->
    <div class="mb-10">
      <div
        class="w-20 h-20 bg-cn-dark text-cn-yellow rounded-3xl flex items-center justify-center mx-auto mb-6"
      >
        <img
          src="/favicon.png"
          alt="Canari Logo"
          class="w-3/5 h-3/5 object-contain"
        />
      </div>
      <h1 class="text-4xl font-black text-cn-dark tracking-tight">Canari</h1>
      <p class="text-text-muted text-base mt-2">
        Mines Saint-Étienne
      </p>
    </div>

    <!-- Form -->
    <div class="space-y-5">
      <div class="text-left">
        <label for="uid" class="block text-sm font-bold text-cn-dark mb-2"
          >Nom d'utilisateur</label
        >
        <input
          id="uid"
          type="text"
          value={userId}
          oninput={(e) => onUserIdChange(e.currentTarget.value)}
          onkeydown={handleKeydown}
          placeholder=""
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base bg-cn-bg outline-none transition-all focus:border-cn-yellow focus:bg-white focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
      </div>

      <div class="text-left">
        <label for="pin" class="block text-sm font-bold text-cn-dark mb-2"
          >PIN Cryptographique</label
        >
        <input
          id="pin"
          type="password"
          value={pin}
          oninput={(e) => onPinChange(e.currentTarget.value)}
          onkeydown={handleKeydown}
          placeholder="••••"
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base bg-cn-bg outline-none transition-all focus:border-cn-yellow focus:bg-white focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
      </div>

      <button
        onclick={onLogin}
        disabled={isLoggingIn}
        class="w-full py-4 bg-cn-yellow text-cn-dark rounded-2xl font-extrabold text-lg transition-all hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-70 disabled:cursor-wait mt-2"
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
