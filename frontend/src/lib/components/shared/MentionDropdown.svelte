<script lang="ts">
  import type { MentionUser } from '$lib/composables/useMentionAutocomplete.svelte';

  interface Props {
    open: boolean;
    suggestions: MentionUser[];
    selectedIdx: number;
    onSelect: (user: MentionUser) => void;
  }

  let { open, suggestions, selectedIdx, onSelect }: Props = $props();
</script>

{#if open && suggestions.length > 0}
  <ul
    class="absolute bottom-full mb-1 left-0 right-0 z-50 bg-white/95 dark:bg-gray-900/95 border border-black/10 dark:border-white/10 rounded-xl shadow-xl max-h-48 overflow-auto backdrop-blur-sm"
  >
    {#each suggestions as user, i (user.id)}
      <li>
        <button
          type="button"
          class="w-full px-4 py-2 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl {i === selectedIdx
            ? 'bg-amber-100/60 dark:bg-amber-900/30'
            : 'hover:bg-amber-50 dark:hover:bg-amber-900/20'}"
          onmousedown={(e) => {
            e.preventDefault();
            onSelect(user);
          }}
        >
          <span class="font-bold text-amber-600 dark:text-amber-400 mr-0.5">@</span><span
            class="font-medium text-text-main">{user.displayName || user.id}</span
          >
        </button>
      </li>
    {/each}
  </ul>
{/if}
