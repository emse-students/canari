<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { LoaderCircle, AlertTriangle, KeyRound } from '@lucide/svelte';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Called with the current and new PIN when the form passes local validation. */
    onSubmit: (currentPin: string, newPin: string) => void;
    /** Called when the user dismisses the modal. */
    onClose: () => void;
    /** Error message set by the parent (e.g. wrong current PIN); shown below the form. */
    externalError?: string;
    /** Whether a change attempt is in progress; disables inputs and shows a spinner. */
    isLoading?: boolean;
    /**
     * 'change' (default): a logged-in user rotates their PIN.
     * 'recover': the PIN was changed on another device - the user types their OLD PIN
     * (to decrypt this device) plus the NEW account PIN to recover their messages.
     */
    variant?: 'change' | 'recover';
  }

  let {
    open,
    onSubmit,
    onClose,
    externalError = '',
    isLoading = false,
    variant = 'change',
  }: Props = $props();

  const isRecover = $derived(variant === 'recover');
  const title = $derived(isRecover ? 'Récupérer mes messages' : 'Changer mon PIN');
  const currentLabel = $derived(isRecover ? 'Ancien PIN (de cet appareil)' : 'PIN actuel');
  const newLabel = $derived(isRecover ? 'Nouveau PIN (du compte)' : 'Nouveau PIN');
  const submitLabel = $derived(isRecover ? 'Récupérer mes messages' : 'Changer mon PIN');

  let currentPin = $state('');
  let newPin = $state('');
  let confirmPin = $state('');
  let internalError = $state('');

  // Reset the form whenever the modal is (re)opened so stale input never lingers.
  $effect(() => {
    if (open) {
      currentPin = '';
      newPin = '';
      confirmPin = '';
      internalError = '';
    }
  });

  const displayError = $derived(externalError || internalError);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const cur = currentPin.trim();
    const next = newPin.trim();
    const confirm = confirmPin.trim();
    if (!cur || !next || !confirm) {
      internalError = 'Veuillez remplir tous les champs.';
      return;
    }
    if (next.length < 4) {
      internalError = 'Le nouveau PIN doit contenir au moins 4 caractères.';
      return;
    }
    if (next !== confirm) {
      internalError = 'Le nouveau PIN et sa confirmation ne correspondent pas.';
      return;
    }
    if (next === cur) {
      internalError = isRecover
        ? 'Le nouveau PIN doit être différent de l’ancien.'
        : 'Le nouveau PIN doit être différent de l’actuel.';
      return;
    }
    internalError = '';
    onSubmit(cur, next);
  }

  const inputClass =
    'w-full rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 px-4 py-3 text-center text-lg tracking-[0.3em] font-mono focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/30 focus:outline-none transition-all placeholder:tracking-normal placeholder:text-text-muted/50 disabled:opacity-50';
</script>

<Modal {open} {title} {onClose}>
  <form onsubmit={handleSubmit} class="space-y-5 p-1">
    <div class="rounded-xl border border-cn-yellow/30 bg-cn-yellow/10 px-4 py-3">
      {#if isRecover}
        <p class="text-sm text-text-muted leading-relaxed">
          Votre PIN a été changé sur un autre appareil. Entrez votre
          <strong class="text-text-main">ancien PIN</strong> (qui déchiffre cet appareil) puis votre
          <strong class="text-text-main">nouveau PIN</strong> pour récupérer tous vos messages sans rien
          perdre.
        </p>
      {:else}
        <p class="text-sm text-text-muted leading-relaxed">
          Le PIN chiffre tous vos messages et n’est <strong class="text-text-main"
            >jamais transmis au serveur</strong
          >. Après le changement, vos
          <strong class="text-text-main">autres appareils devront se reconnecter</strong> avec le nouveau
          PIN (l’empreinte digitale sera à ré-enregistrer).
        </p>
      {/if}
    </div>

    <div class="space-y-2">
      <label for="current-pin" class="block text-xs font-bold text-text-muted px-1"
        >{currentLabel}</label
      >
      <input
        id="current-pin"
        type="password"
        autocomplete="current-password"
        bind:value={currentPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    <div class="space-y-2">
      <label for="new-pin" class="block text-xs font-bold text-text-muted px-1">{newLabel}</label>
      <input
        id="new-pin"
        type="password"
        autocomplete="new-password"
        bind:value={newPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    <div class="space-y-2">
      <label for="confirm-pin" class="block text-xs font-bold text-text-muted px-1"
        >Confirmer le nouveau PIN</label
      >
      <input
        id="confirm-pin"
        type="password"
        autocomplete="new-password"
        bind:value={confirmPin}
        oninput={() => (internalError = '')}
        disabled={isLoading}
        placeholder="••••••"
        class={inputClass}
      />
    </div>

    {#if displayError}
      <p class="text-sm text-red-500 font-medium flex items-center gap-2 px-1">
        <AlertTriangle size={16} class="shrink-0" />
        {displayError}
      </p>
    {/if}

    <button
      type="submit"
      disabled={isLoading}
      class="w-full py-3.5 bg-cn-yellow text-[#151B2C] rounded-xl font-extrabold text-sm hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-cn-yellow/20 transition-all flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:translate-y-0"
    >
      {#if isLoading}
        <LoaderCircle size={16} class="animate-spin" />
        {isRecover ? 'Récupération en cours…' : 'Changement en cours…'}
      {:else}
        <KeyRound size={16} strokeWidth={2.5} />
        {submitLabel}
      {/if}
    </button>
  </form>
</Modal>
