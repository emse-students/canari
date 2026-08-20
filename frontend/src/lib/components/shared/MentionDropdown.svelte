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
    class="absolute right-0 bottom-full left-0 z-50 mb-1 max-h-48 overflow-auto rounded-xl border border-black/10 bg-white/95 shadow-xl backdrop-blur-sm dark:border-white/10 dark:bg-gray-900/95"
  >
    {#each suggestions as user, i (user.id)}
      <li>
        <button
          type="button"
          class="w-full px-4 py-2 text-left text-sm transition-colors first:rounded-t-xl last:rounded-b-xl {i ===
          selectedIdx
            ? 'bg-amber-100/60 dark:bg-amber-900/30'
            : 'hover:bg-amber-50 dark:hover:bg-amber-900/20'}"
          onmousedown={(e) => {
            e.preventDefault();
            onSelect(user);
          }}
        >
          <span class="mr-0.5 font-bold text-amber-600 dark:text-amber-400">@</span><span
            class="text-text-main font-medium">{user.displayName || user.id}</span
          >
        </button>
      </li>
    {/each}
  </ul>
{/if}
