<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { Search, Forward } from '@lucide/svelte';
  import { generateAvatarColor, getInitials } from '$lib/utils/avatar';
  import type { Conversation } from '$lib/types';

  interface Props {
    open: boolean;
    /** Conversations as [key, conversation] entries (key = conversation map key). */
    conversations: [string, Conversation][];
    /** Conversation key to exclude (the source conversation). */
    excludeKey?: string | null;
    onClose: () => void;
    /** Called with the target conversation key when the user picks a destination. */
    onSelect: (key: string, conversation: Conversation) => void;
  }

  let { open, conversations, excludeKey = null, onClose, onSelect }: Props = $props();

  let query = $state('');

  // Discussions seulement (DM + groupes), hors canaux et hors conversation source.
  const candidates = $derived(
    conversations
      .filter(
        ([key, c]) =>
          c.conversationType !== 'channel' && key !== excludeKey && (c.name?.trim()?.length ?? 0) > 0
      )
      .filter(([, c]) => c.name.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
  );

  function pick(key: string, c: Conversation) {
    onSelect(key, c);
    query = '';
  }
</script>

<Modal {open} title="Transférer à…" {onClose}>
  <div class="flex flex-col gap-3">
    <div class="relative">
      <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        type="text"
        bind:value={query}
        placeholder="Rechercher une discussion…"
        aria-label="Rechercher une discussion"
        class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] py-2.5 pl-9 pr-3 text-sm text-text-main outline-none focus:border-cn-yellow"
      />
    </div>

    <div class="-mx-1 flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto px-1">
      {#if candidates.length === 0}
        <p class="py-8 text-center text-sm text-text-muted">Aucune discussion trouvée.</p>
      {:else}
        {#each candidates as [key, c] (key)}
          <button
            type="button"
            onclick={() => pick(key, c)}
            class="flex items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
              style="background-color: {generateAvatarColor(c.name)}"
            >
              {getInitials(c.name)}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm font-semibold text-text-main">{c.name}</span>
            <Forward size={16} class="shrink-0 text-text-muted" />
          </button>
        {/each}
      {/if}
    </div>
  </div>
</Modal>
