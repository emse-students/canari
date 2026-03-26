<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import { tick } from 'svelte';

  interface Props {
    open: boolean;
    communityName: string;
    onClose: () => void;
    onNameChange: (value: string) => void;
    onSubmit: () => void;
  }

  let { open, communityName, onClose, onNameChange, onSubmit }: Props = $props();
  let nameInput: HTMLInputElement | undefined;

  $effect(() => {
    if (!open) return;
    void tick().then(() => nameInput?.focus());
  });
</script>

<Modal {open} {onClose} title="Créer une communauté">
  <div class="space-y-4 pt-2">
    <div>
      <label for="new-community-name" class="block text-sm font-medium text-text-main mb-1"
        >Nom de l'association ou du groupe</label
      >
      <input
        bind:this={nameInput}
        id="new-community-name"
        type="text"
        value={communityName}
        oninput={(e) => onNameChange((e.target as HTMLInputElement).value)}
        placeholder="ex: BDE 2026"
        class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        onkeydown={(e) => e.key === 'Enter' && onSubmit()}
      />
    </div>
    <p class="text-xs text-text-muted text-center px-4">
      En créant une communauté, vous disposerez d'un espace privé pour organiser vos canaux et
      administrer vos membres.
    </p>
    <button
      onclick={onSubmit}
      disabled={!communityName.trim()}
      class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      Créer la communauté
    </button>
  </div>
</Modal>
