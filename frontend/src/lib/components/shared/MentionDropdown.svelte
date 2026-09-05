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
        <!--
          WHO this row is, published rather than left to the rendered name. The list is filtered by a
          typed query, so several accounts routinely match one - two campaign accounts share a first
          word - and the only thing distinguishing them in the DOM was a display name that is chosen
          by the user, may repeat, and is what a reader is trying to resolve in the first place.
          `MENTION-2` picked the first row for "Canari", mentioned the SENDER, and the server
          correctly pushed to nobody: the check read that as the notification level being broken.
          Same fact and same one-attribute cost as `data-conversation-tile`.
        -->
        <button
          type="button"
          data-mention-suggestion={user.id}
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
