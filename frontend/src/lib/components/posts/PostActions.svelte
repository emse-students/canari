<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import type { Snippet } from 'svelte';
  import { MessageCircle, FaceSlightlySmiling } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { reactionTypeToLabel } from '$lib/posts/reactions';
  import { longPress } from '$lib/actions/longPress';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { Log } from '$lib/utils/Log';
  import Button from '$lib/components/ui/Button.svelte';

  /** Props for the PostActions bar (reaction picker + comment button + the reaction tally). */
  interface Props {
    /** The emoji type the current user has reacted with, or null if no reaction. */
    userReaction: string | null;
    /** Whether the emoji reaction picker popover is currently open. */
    showReactionPicker: boolean;
    /** Full list of available reaction types with their emoji. */
    reactionList: ReadonlyArray<{ type: string; emoji: string }>;
    /**
     * ONE TAP on the reaction button (owner, 2026-11-09, Facebook's rule): the caller likes the post,
     * or takes the reader's reaction back when they already have one.
     */
    onQuickReact: () => void;
    /** A long press, the context menu or the labelled assistive button asks for the picker. */
    onOpenReactionPicker: () => void;
    /** The picker was dismissed without a choice (Escape, a tap elsewhere). */
    onCloseReactionPicker: () => void;
    /** Called when the user selects an emoji from the picker. */
    onReactionSelect: (reactionType: string) => void;
    /** Total number of comments (top-level + replies). */
    commentCount?: number;
    /**
     * Called when the user clicks the Comment button to toggle the comment section. ABSENT when the
     * post's comments are withheld from its reader (owner, 2026-11-04): no button, no count.
     */
    onCommentClick?: () => void;
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
    onQuickReact,
    onOpenReactionPicker,
    onCloseReactionPicker,
    onReactionSelect,
    commentCount,
    onCommentClick,
    reactionSummary,
  }: Props = $props();

  /**
   * One shape for both controls, so the row reads as a pair rather than two sizes.
   *
   * The reacted state paints NO background. It used to fill an amber box behind the glyph, which on
   * a dark theme is a 45 x 44 slab of colour saying what the glyph beside it already said: a reader
   * who has reacted sees THEIR emoji there instead of the neutral smiley, and a second signal for
   * the same fact only competes with the post.
   */
  const ACTION =
    'flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500';

  let reactButton = $state<HTMLElement | null>(null);

  /** The picker is opened by a hold, a context menu, ArrowUp or the assistive button. */
  function openPicker(via: string) {
    Log.d('PostActions', `reaction picker opened via ${via}`);
    onOpenReactionPicker();
  }

  function onReactKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      openPicker('ArrowUp');
    }
  }

  function onPickerKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !showReactionPicker) return;
    onCloseReactionPicker();
    reactButton?.focus();
  }
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

  NO RULE UNDER THE ROW, AND TIGHTER INSETS (user, 2026-10-01, Mi 9T). Its `border-b` drew a line
  that, with the comment section's own `border-t` under it, was two hairlines one pixel apart, and a
  line closing the card's last row when the section is shut. The section's top border is the one
  separator that means something. The first glyph now starts on the text column - `px-2` here plus
  a 20 px icon centred in a 44 px target lands it at 20 px, the post text's `px-5` - and the two
  buttons touch instead of floating 4 px apart; each target stays 44 px.
-->
<svelte:window onkeydown={onPickerKeydown} />

<div class="relative flex items-center px-2">
  <!--
    ONE TAP LIKES, A HOLD CHOOSES (owner, 2026-11-09, audit S2: Facebook's rule). The smiley used to
    open the picker, so the commonest reaction cost two taps. `longPress` is the shared hold: a press
    that travels past its slop is a SCROLL and never opens anything (the feed is scrolled by touch
    from this very bar), and the click ending a hold is swallowed so opening the picker never also
    likes. A tap on the reader's own reaction takes it back; a hold while reacted opens the picker to
    change it. The assistive ways: the context menu (Menu key, Shift+F10), ArrowUp, and the
    screen-reader-only button below, so the picker never depends on a gesture.
  -->
  <button
    type="button"
    bind:this={reactButton}
    onclick={onQuickReact}
    onkeydown={onReactKeydown}
    use:longPress={{
      onHold: () => openPicker('hold'),
      onContextMenu: () => openPicker('contextmenu'),
    }}
    class="{ACTION} text-text-muted touch-manipulation select-none hover:bg-(--cn-surface)"
    aria-label={userReaction ? reactionTypeToLabel(userReaction) : m.post_react()}
    title={m.post_react_hold_hint()}
    aria-expanded={showReactionPicker}
    aria-pressed={userReaction != null}
    data-post-react
  >
    {#if userReaction}
      <span class="text-lg" aria-hidden="true"
        ><EmojiText text={reactionList.find((r) => r.type === userReaction)?.emoji ?? '😊'} /></span
      >
    {:else}
      <FaceSlightlySmiling size={20} />
    {/if}
  </button>
  <Button
    variant="ghost"
    onclick={() => openPicker('assistive button')}
    class="sr-only focus:not-sr-only"
    aria-label={m.post_reacter()}
    data-post-react-picker-open
  />

  {#if onCommentClick}
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
  {/if}

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
      use:clickOutside={{
        enabled: true,
        callback: onCloseReactionPicker,
        ignore: () => reactButton,
      }}
    >
      {#each reactionList as reaction (reaction.type)}
        <button
          type="button"
          onclick={() => onReactionSelect(reaction.type)}
          class="flex h-11 min-w-0 flex-1 items-center justify-center rounded-full text-2xl leading-none transition-transform hover:scale-110 active:scale-95 sm:w-11 sm:flex-none {userReaction ===
          reaction.type
            ? 'bg-cn-yellow/20 ring-cn-yellow ring-2'
            : ''}"
          title={reactionTypeToLabel(reaction.type)}
          aria-label={reactionTypeToLabel(reaction.type)}
          aria-pressed={userReaction === reaction.type}
        >
          <!-- The name is on the button, so the glyph itself is decoration and must not be read twice. -->
          <span aria-hidden="true"><EmojiText text={reaction.emoji} /></span>
        </button>
      {/each}
    </div>
  {/if}
</div>
