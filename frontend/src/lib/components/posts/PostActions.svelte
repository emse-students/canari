<script lang="ts">
  import { MessageCircle, Smile } from 'lucide-svelte';

  interface Props {
    userReaction: string | null;
    showReactionPicker: boolean;
    reactionList: Array<{ type: string; emoji: string; icon: string }>;
    onToggleReactionPicker: () => void;
    onReactionSelect: (reactionType: string) => void;
    onCommentClick: () => void;
  }

  let {
    userReaction,
    showReactionPicker,
    reactionList,
    onToggleReactionPicker,
    onReactionSelect,
    onCommentClick,
  }: Props = $props();
</script>

<div class="flex items-center gap-2 px-5 py-3 border-b border-cn-border/40">
  <div class="relative">
    <button
      type="button"
      onclick={onToggleReactionPicker}
      class="flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors {userReaction
        ? 'bg-cn-yellow/15 text-cn-dark'
        : 'text-text-muted hover:bg-[var(--cn-surface)]'}"
      aria-label="Ajouter une réaction"
    >
      {#if userReaction}
        <span class="text-lg"
          >{reactionList.find((r) => r.type === userReaction)?.emoji ?? '😊'}</span
        >
        <span class="text-sm font-medium">{userReaction}</span>
      {:else}
        <Smile size={20} />
        <span class="text-sm">Réagir</span>
      {/if}
    </button>

    {#if showReactionPicker}
      <div
        class="absolute bottom-full left-0 mb-2 bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-lg p-2 flex gap-1 z-10"
      >
        {#each reactionList as reaction (reaction.type)}
          <button
            type="button"
            onclick={() => onReactionSelect(reaction.type)}
            class="flex flex-col items-center gap-1 p-2 rounded-lg transition-all hover:bg-cn-yellow/20 {userReaction ===
            reaction.type
              ? 'ring-2 ring-cn-yellow'
              : ''}"
            title={reaction.type}
          >
            <span class="text-2xl">{reaction.emoji}</span>
            <span class="text-[0.6rem] font-bold text-text-muted">{reaction.type}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <button
    type="button"
    onclick={onCommentClick}
    class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-text-muted hover:bg-[var(--cn-surface)] transition-colors"
    aria-label="Commenter"
  >
    <MessageCircle size={20} />
    <span class="text-sm">Commenter</span>
  </button>
</div>
