<script lang="ts">
  interface Props {
    groupedReactions: Record<string, string[]>;
    isOwn?: boolean;
    onReactionClick?: (emoji: string) => void;
  }

  let { groupedReactions = {}, isOwn = false, onReactionClick }: Props = $props();
</script>

{#if Object.keys(groupedReactions).length > 0}
  <div class="flex gap-1 flex-wrap mt-1 px-1 {isOwn ? 'justify-end' : 'justify-start'}">
    {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
      <button
        class="flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded-full text-xs transition-colors"
        onclick={() => onReactionClick?.(emoji)}
        title={users.join(', ')}
      >
        <span>{emoji}</span>
        <span class="text-gray-600">{users.length}</span>
      </button>
    {/each}
  </div>
{/if}

