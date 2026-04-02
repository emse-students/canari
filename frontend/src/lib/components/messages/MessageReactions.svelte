<script lang="ts">
  interface Props {
    groupedReactions: Record<string, string[]>;
    isOwn?: boolean;
    onReactionClick?: (emoji: string) => void;
  }

  let { groupedReactions = {}, isOwn = false, onReactionClick }: Props = $props();
</script>

{#if Object.keys(groupedReactions).length > 0}
  <div class="flex gap-1.5 flex-wrap mt-1.5 px-1 {isOwn ? 'justify-end' : 'justify-start'}">
    {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
      <button
        class="flex items-center gap-1 px-2.5 py-1 bg-[var(--cn-surface)]/80 hover:bg-[var(--cn-surface)] border border-cn-border/60 rounded-full text-sm transition-colors"
        onclick={() => onReactionClick?.(emoji)}
        title={users.join(', ')}
      >
        <span class="text-lg leading-none">{emoji}</span>
        <span class="text-xs font-semibold text-text-muted">{users.length}</span>
      </button>
    {/each}
  </div>
{/if}
