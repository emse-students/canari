<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import { tick } from 'svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Current value of the community name input. */
    communityName: string;
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback fired when the community name input changes. */
    onNameChange: (value: string) => void;
    /** Callback to submit the new community creation form. */
    onSubmit: () => void;
  }

  let { open, communityName, onClose, onNameChange, onSubmit }: Props = $props();
  let nameInput: HTMLInputElement | undefined;

  $effect(() => {
    if (!open) return;
    void tick().then(() => nameInput?.focus());
  });
</script>

<Modal {open} {onClose} title={m.chat_modal_community_name_label()}>
  <div class="space-y-4 pt-2">
    <div>
      <label for="new-community-name" class="text-text-main mb-1 block text-sm font-medium"
        >{m.chat_modal_community_name_label()}</label
      >
      <input
        bind:this={nameInput}
        id="new-community-name"
        type="text"
        value={communityName}
        oninput={(e) => onNameChange((e.target as HTMLInputElement).value)}
        placeholder={m.chat_modal_community_name_placeholder()}
        class="bg-cn-surface w-full rounded-xl border border-white/60 px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-amber-400/45 dark:border-white/10"
        onkeydown={(e) => e.key === 'Enter' && onSubmit()}
      />
    </div>
    <p class="text-text-muted px-4 text-center text-xs">
      {m.chat_modal_community_description()}
    </p>
    <button
      onclick={onSubmit}
      disabled={!communityName.trim()}
      class="text-cn-ink w-full rounded-xl bg-amber-500 py-2.5 font-semibold transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {m.chat_modal_create_community_button()}
    </button>
  </div>
</Modal>
