<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';

  interface Props {
    open: boolean;
    onSubmit: (pin: string) => void;
  }

  let { open, onSubmit }: Props = $props();

  let pin = $state('');
  let error = $state('');

  function handleSubmit(e: Event) {
    // Empêche le rechargement de la page par défaut du formulaire
    e.preventDefault();

    const trimmed = pin.trim();
    if (!trimmed) {
      error = 'Veuillez entrer votre PIN.';
      return;
    }

    error = '';
    onSubmit(trimmed);
    // Optionnel : réinitialiser le champ après soumission
    // pin = '';
  }
</script>

<Modal {open} title="PIN de chiffrement" onClose={() => {}}>
  <!-- Utilisation d'un vrai formulaire pour la gestion native de la touche Entrée/Go sur mobile -->
  <form onsubmit={handleSubmit} class="space-y-6 p-1">
    <p class="text-sm text-text-muted leading-relaxed text-center">
      Entrez votre PIN pour déverrouiller le chiffrement de bout en bout. Ce PIN est le même sur
      tous vos appareils.
    </p>

    <div class="space-y-2">
      <label for="encryption-pin" class="sr-only">Code PIN</label>
      <input
        id="encryption-pin"
        type="password"
        inputmode="numeric"
        autocomplete="current-password"
        bind:value={pin}
        oninput={() => error = ''}
        placeholder="••••••"
        class="w-full rounded-xl border border-cn-border/60 bg-white/5 dark:bg-black/20 px-4 py-3.5 text-center text-2xl tracking-[0.4em] font-mono focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/30 focus:outline-none transition-all placeholder:tracking-normal placeholder:text-text-muted/50"
      />

      {#if error}
        <p class="text-sm text-red-500 font-medium text-center animate-pulse">{error}</p>
      {/if}
    </div>

    <button
      type="submit"
      class="w-full py-3.5 bg-cn-yellow text-[#151B2C] rounded-xl font-extrabold text-sm hover:bg-cn-yellow-hover hover:-translate-y-0.5 active:translate-y-0 shadow-lg shadow-cn-yellow/20 transition-all"
    >
      Déverrouiller
    </button>
  </form>
</Modal>
