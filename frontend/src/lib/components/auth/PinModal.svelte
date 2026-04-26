<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { LoaderCircle, Fingerprint } from 'lucide-svelte';

  interface Props {
    open: boolean;
    onSubmit: (pin: string) => void;
    onClose?: () => void;
    onBiometricRequest?: () => void;
    showBiometricButton?: boolean;
    externalError?: string;
    isLoading?: boolean;
  }

  let {
    open,
    onSubmit,
    onClose,
    onBiometricRequest,
    showBiometricButton = false,
    externalError = '',
    isLoading = false,
  }: Props = $props();

  let pin = $state('');
  let internalError = $state('');

  $effect(() => {
    if (externalError) internalError = '';
  });

  const displayError = $derived(externalError || internalError);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const trimmed = pin.trim();
    if (!trimmed) {
      internalError = 'Veuillez entrer votre PIN.';
      return;
    }
    internalError = '';
    onSubmit(trimmed);
  }
</script>

<Modal {open} title="PIN de chiffrement" onClose={onClose ?? (() => {})}>
  <form onsubmit={handleSubmit} class="space-y-6 p-1">
    <p class="text-sm text-text-muted leading-relaxed text-center">
      Entrez votre PIN pour déverrouiller le chiffrement de bout en bout. Ce PIN est le même sur
      tous vos appareils.
    </p>

    {#if showBiometricButton && onBiometricRequest}
      <button
        type="button"
        onclick={onBiometricRequest}
        disabled={isLoading}
        class="w-full py-3 flex items-center justify-center gap-2 rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 text-sm font-semibold text-text-main hover:bg-white/10 dark:hover:bg-black/30 transition-all disabled:opacity-50"
      >
        <Fingerprint size={18} />
        Utiliser l'empreinte digitale
      </button>

      <div class="flex items-center gap-3">
        <hr class="flex-1 border-cn-border/40" />
        <span class="text-xs text-text-muted">ou entrez votre PIN</span>
        <hr class="flex-1 border-cn-border/40" />
      </div>
    {/if}

    <div class="space-y-2">
      <label for="encryption-pin" class="sr-only">Code PIN</label>
      <input
        id="encryption-pin"
        type="password"
        inputmode="numeric"
        autocomplete="current-password"
        bind:value={pin}
        oninput={() => {
          internalError = '';
        }}
        disabled={isLoading}
        placeholder="••••••"
        class="w-full rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 px-4 py-3.5 text-center text-2xl tracking-[0.4em] font-mono focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/30 focus:outline-none transition-all placeholder:tracking-normal placeholder:text-text-muted/50 disabled:opacity-50"
      />

      {#if displayError}
        <p class="text-sm text-red-500 font-medium text-center">{displayError}</p>
      {/if}
    </div>

    <button
      type="submit"
      disabled={isLoading}
      class="w-full py-3.5 bg-cn-yellow text-[#151B2C] rounded-xl font-extrabold text-sm hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-cn-yellow/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:translate-y-0"
    >
      {#if isLoading}
        <LoaderCircle size={16} class="animate-spin" />
        Vérification...
      {:else}
        Déverrouiller
      {/if}
    </button>
  </form>
</Modal>
