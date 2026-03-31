<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';

  interface Props {
    open: boolean;
    onSubmit: (pin: string) => void;
  }

  let { open, onSubmit }: Props = $props();

  let pin = $state('');
  let error = $state('');

  function handleSubmit() {
    const trimmed = pin.trim();
    if (!trimmed) {
      error = 'Veuillez entrer votre PIN.';
      return;
    }
    error = '';
    onSubmit(trimmed);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
  }
</script>

<Modal {open} title="PIN de chiffrement" onClose={() => {}}>
  <div class="space-y-4 p-1">
    <p class="text-sm text-text-muted">
      Entrez votre PIN pour déverrouiller le chiffrement de bout en bout. Ce PIN est le même sur
      tous vos appareils.
    </p>

    {#if error}
      <p class="text-sm text-red-500 font-medium">{error}</p>
    {/if}

    <input
      type="password"
      inputmode="numeric"
      bind:value={pin}
      onkeydown={handleKeydown}
      placeholder="PIN"
      class="w-full rounded-xl border border-cn-border bg-transparent px-4 py-3 text-center text-lg tracking-[0.3em] font-mono focus:border-cn-yellow focus:outline-none"
    />

    <button
      onclick={handleSubmit}
      class="w-full py-3 bg-cn-yellow text-cn-dark rounded-xl font-bold text-sm hover:bg-cn-yellow-hover transition-all"
    >
      Déverrouiller
    </button>
  </div>
</Modal>
