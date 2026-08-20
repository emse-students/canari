<script lang="ts">
  import { MessageCircle, Smile } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /** Props for the PostActions bar (reaction picker + comment button). */
  interface Props {
    /** The emoji type the current user has reacted with, or null if no reaction. */
    userReaction: string | null;
    /** Whether the emoji reaction picker popover is currently open. */
    showReactionPicker: boolean;
    /** Full list of available reaction types with their emoji. */
    reactionList: ReadonlyArray<{ type: string; emoji: string }>;
    /** Called when the user clicks the reaction button to open or close the picker. */
    onToggleReactionPicker: () => void;
    /** Called when the user selects an emoji from the picker. */
    onReactionSelect: (reactionType: string) => void;
    /** Total number of comments (top-level + replies). */
    commentCount?: number;
    /** Called when the user clicks the Comment button to toggle the comment section. */
    onCommentClick: () => void;
  }

  let {
    userReaction,
    showReactionPicker,
    reactionList,
    onToggleReactionPicker,
    onReactionSelect,
    commentCount,
    onCommentClick,
  }: Props = $props();
</script>

<div class="border-cn-border/40 flex items-center gap-2 border-b px-5 py-3">
  <div class="relative">
    <button
      type="button"
      onclick={onToggleReactionPicker}
      class="flex items-center gap-1.5 rounded-lg px-3 py-2 transition-colors {userReaction
        ? 'bg-cn-yellow/15 text-cn-dark'
        : 'text-text-muted hover:bg-(--cn-surface)'}"
      aria-label={m.post_reacter()}
    >
      {#if userReaction}
        <span class="text-lg"
          >{reactionList.find((r) => r.type === userReaction)?.emoji ?? '😊'}</span
        >
        <span class="text-sm font-medium">{userReaction}</span>
      {:else}
        <Smile size={20} />
        <span class="text-sm">{m.post_react()}</span>
      {/if}
    </button>

    {#if showReactionPicker}
      <div
        class="border-cn-border absolute bottom-full left-0 z-50 mb-2 flex max-w-[min(100vw-2rem,32rem)] gap-1 overflow-x-auto rounded-2xl border bg-(--cn-surface) p-2 shadow-lg"
      >
        {#each reactionList as reaction (reaction.type)}
          <button
            type="button"
            onclick={() => onReactionSelect(reaction.type)}
            class="hover:bg-cn-yellow/20 flex flex-col items-center gap-1 rounded-lg p-2 transition-all {userReaction ===
            reaction.type
              ? 'ring-cn-yellow ring-2'
              : ''}"
            title={reaction.type}
          >
            <span class="text-2xl">{reaction.emoji}</span>
            <span class="text-text-muted text-[0.6rem] font-bold">{reaction.type}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <button
    type="button"
    onclick={onCommentClick}
    class="text-text-muted flex items-center gap-1.5 rounded-lg px-3 py-2 transition-colors hover:bg-(--cn-surface)"
    aria-label={m.post_commenter()}
  >
    <MessageCircle size={20} />
    <span class="text-sm">{commentCount ? commentCount : m.post_commenter()}</span>
  </button>
</div>
