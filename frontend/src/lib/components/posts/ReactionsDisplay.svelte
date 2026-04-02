<script lang="ts">
  interface Props {
    reactionCounts: Record<string, number>;
    userReaction: string | null;
    reactionList: Array<{ type: string; emoji: string; icon: string }>;
    onReactionClick: (reactionType: string) => void;
  }

  let { reactionCounts, userReaction, reactionList, onReactionClick }: Props = $props();
</script>

{#if Object.keys(reactionCounts).length > 0}
  <div class="px-5 py-2 border-b border-cn-border/40 flex flex-wrap gap-2">
    {#each Object.entries(reactionCounts) as [reactionType, count] (reactionType)}
      {@const reaction = reactionList.find((r) => r.type === reactionType)}
      <button
        type="button"
        onclick={() => onReactionClick(reactionType)}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all {userReaction ===
        reactionType
          ? 'bg-cn-yellow/20 ring-1 ring-cn-yellow'
          : 'bg-[var(--cn-surface)] hover:bg-cn-yellow/10'}"
        title={`${reactionType}: ${count}`}
      >
        <span class="text-lg">{reaction?.emoji ?? '😊'}</span>
        <span class="text-sm font-bold text-text-main">{count}</span>
      </button>
    {/each}
  </div>
{/if}
