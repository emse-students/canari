<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MessageCircle, FaceSlightlySmiling } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /** Props for the PostActions bar (reaction picker + comment button + the reaction tally). */
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
    /**
     * The tally of reactions already cast, rendered right-aligned on THIS row rather than on one of
     * its own. The caller owns it because the caller owns the post's reaction state; this component
     * only owns where it sits.
     */
    reactionSummary?: Snippet;
  }

  let {
    userReaction,
    showReactionPicker,
    reactionList,
    onToggleReactionPicker,
    onReactionSelect,
    commentCount,
    onCommentClick,
    reactionSummary,
  }: Props = $props();

  /** One shape for both controls, so the row reads as a pair rather than two sizes. */
  const ACTION =
    'flex h-11 items-center gap-1.5 rounded-lg px-3 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500';
</script>

<!--
  ONE ROW CARRIES BOTH THE CONTROLS AND THE TALLY, AND THAT IS A MEASUREMENT.

  It used to be two rows plus two words. Read on A1 (Mi 9T, 436 x 945 CSS px) on 2026-09-14, a post
  spent 65 px on this bar - two buttons labelled "J'adore" and "Commenter" - and another 49 px on a
  separate bordered row below it holding nothing but the reaction badges. Facebook's own feed, read
  on the same phone the same minute, spends 44 px on ALL of it: like / comment / send grouped hard
  left as bare icons, each count INSIDE the button it belongs to, and the reaction faces pinned to
  the right edge of that same 44 px row (x920-1050 of 1080). No tally row exists there at all.

  So the tally comes here as a snippet and the labels go: 114 px of chrome per post becomes 44, which
  is a fifth of a phone screen given back for every post on it. The words are not lost - they are on
  `aria-label` and `title`, where a screen reader and a pointer both still reach them, and the emoji
  the reader actually chose is a better label for their own reaction than its name was.

  THE PICKER IS ANCHORED TO THE ROW, NOT TO THE BUTTON INSIDE IT, and that is a separate fix worth
  keeping. Measured on a 393px viewport, 2026-09-09: the popover ran five pixels past the right edge
  of the screen because its cap was `max-w-[min(100vw-2rem,32rem)]` - a width measured against the
  VIEWPORT while the element was positioned against a button already 37px in. A cap that does not
  know where its element starts cannot keep it on screen. `left-3 right-3` pins it to this row's
  content box, so the eight share whatever width the card has and the bar can never be wider than the
  thing it belongs to; from 640px up it shrinks back to its own content.
-->
<div class="border-cn-border/40 relative flex items-center gap-1 border-b px-3">
  <button
    type="button"
    onclick={onToggleReactionPicker}
    class="{ACTION} {userReaction
      ? 'bg-cn-yellow/15 text-cn-dark'
      : 'text-text-muted hover:bg-(--cn-surface)'}"
    aria-label={m.post_reacter()}
    title={m.post_reacter()}
    aria-expanded={showReactionPicker}
  >
    {#if userReaction}
      <span class="text-lg" aria-hidden="true"
        >{reactionList.find((r) => r.type === userReaction)?.emoji ?? '😊'}</span
      >
    {:else}
      <FaceSlightlySmiling size={20} />
    {/if}
  </button>

  <button
    type="button"
    onclick={onCommentClick}
    class="{ACTION} text-text-muted hover:bg-(--cn-surface)"
    aria-label={m.post_commenter()}
    title={m.post_commenter()}
  >
    <MessageCircle size={20} />
    {#if commentCount}
      <span class="text-sm font-medium">{commentCount}</span>
    {/if}
  </button>

  {#if reactionSummary}
    <div class="ml-auto flex min-w-0 items-center">
      {@render reactionSummary()}
    </div>
  {/if}

  {#if showReactionPicker}
    <div
      class="border-cn-border absolute right-3 bottom-full left-3 z-50 mb-2 flex items-center gap-0.5 rounded-full border bg-(--cn-surface) p-1 shadow-lg sm:right-auto sm:gap-1 sm:p-1.5"
      role="group"
      aria-label={m.post_reacter()}
    >
      {#each reactionList as reaction (reaction.type)}
        <button
          type="button"
          onclick={() => onReactionSelect(reaction.type)}
          class="flex h-11 min-w-0 flex-1 items-center justify-center rounded-full text-2xl leading-none transition-transform hover:scale-110 active:scale-95 sm:w-11 sm:flex-none {userReaction ===
          reaction.type
            ? 'bg-cn-yellow/20 ring-cn-yellow ring-2'
            : ''}"
          title={reaction.type}
          aria-label={reaction.type}
          aria-pressed={userReaction === reaction.type}
        >
          <!-- The name is on the button, so the glyph itself is decoration and must not be read twice. -->
          <span aria-hidden="true">{reaction.emoji}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
