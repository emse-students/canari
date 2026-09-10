<script lang="ts">
  import { MessageCircle, FaceSlightlySmiling } from '@lucide/svelte';
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

<!--
  THE PICKER IS ANCHORED TO THE ROW, NOT TO THE BUTTON INSIDE IT, and that is the whole fix.

  Measured on a 393px viewport, 2026-09-09, before this change: the popover's box ran from x=37 to
  x=398 - **five pixels past the right edge of the screen** - because its cap was
  `max-w-[min(100vw-2rem,32rem)]`, a width measured against the VIEWPORT while the element was
  positioned against a button already 37px in. A cap that does not know where its element starts
  cannot keep it on screen.

  Worse, the cap was not the binding constraint. The eight reactions came to **488px of content in a
  359px box**: 129px - the last two, Canari and Marteau - reachable only by a horizontal scroll
  nothing announced. Each one was 54.5 x 72px because it stacked its NAME under the emoji.

  So it follows the reference (user, 2026-09-09: *"barre de reaction trop large pour l'ecran voir
  facebook (web & mobile)"*): one compact pill, emoji only, the name carried by `title` and
  `aria-label` where a pointer and a screen reader can both reach it. `left-5 right-5` pins it to the
  row's content box on a phone, so the eight share whatever width the card has and the bar can never
  be wider than the thing it belongs to; from 640px up it shrinks back to its own content.
-->
<div class="border-cn-border/40 relative flex items-center gap-2 border-b px-5 py-3">
  <button
    type="button"
    onclick={onToggleReactionPicker}
    class="flex items-center gap-1.5 rounded-lg px-3 py-2 transition-colors {userReaction
      ? 'bg-cn-yellow/15 text-cn-dark'
      : 'text-text-muted hover:bg-(--cn-surface)'}"
    aria-label={m.post_reacter()}
    aria-expanded={showReactionPicker}
  >
    {#if userReaction}
      <span class="text-lg">{reactionList.find((r) => r.type === userReaction)?.emoji ?? '😊'}</span
      >
      <span class="text-sm font-medium">{userReaction}</span>
    {:else}
      <FaceSlightlySmiling size={20} />
      <span class="text-sm">{m.post_react()}</span>
    {/if}
  </button>

  <button
    type="button"
    onclick={onCommentClick}
    class="text-text-muted flex items-center gap-1.5 rounded-lg px-3 py-2 transition-colors hover:bg-(--cn-surface)"
    aria-label={m.post_commenter()}
  >
    <MessageCircle size={20} />
    <span class="text-sm">{commentCount ? commentCount : m.post_commenter()}</span>
  </button>

  {#if showReactionPicker}
    <div
      class="border-cn-border absolute right-5 bottom-full left-5 z-50 mb-2 flex items-center gap-0.5 rounded-full border bg-(--cn-surface) p-1 shadow-lg sm:right-auto sm:gap-1 sm:p-1.5"
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
