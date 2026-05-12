<script lang="ts">
  import { MessageCircle, Smile } from 'lucide-svelte';

  /** Props for the PostActions bar (reaction picker + comment button). */
  interface Props {
    /** The emoji type the current user has reacted with, or null if no reaction. */
    userReaction: string | null;
    /** Whether the emoji reaction picker popover is currently open. */
    showReactionPicker: boolean;
    /** Full list of available reaction types with emoji and icon name. */
    reactionList: Array<{ type: string; emoji: string; icon: string }>;
    /** Called when the user clicks the reaction button to open or close the picker. */
    onToggleReactionPicker: () => void;
    /** Called when the user selects an emoji from the picker. */
    onReactionSelect: (reactionType: string) => void;
    /** Called when the user clicks the Comment button to toggle the comment section. */
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
