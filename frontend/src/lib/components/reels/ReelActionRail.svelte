<script lang="ts">
  /**
   * THE CANAREELS RAIL, AS INSTAGRAM'S REELS DRAW IT (user, 2026-10-19): a column of three actions
   * on the right of the page, each an icon over its number - the heart, the comments, the send.
   * Observed on the Mi 9T the same day (docs/wiki/frontend/modules/reels.md, "Instagram
   * reference"): the column's centre ~30 dp from the right edge, one action every ~65 dp, the
   * number under its icon, the whole column anchored to the bottom just above the caption's line.
   *
   * It only DRAWS and REPORTS: what a tap does is the viewer's (`ReelViewer`) - the heart is the
   * card's reaction path (`posts/postReaction.ts`), the comments open the post's own thread in a
   * sheet, the send is the post menu's share (`posts/sharePost.ts`). `data-no-double-tap` keeps
   * the column out of the double tap that likes the reel (PR #2113): a tap here acts at once.
   */
  import { Heart, MessageCircle, Send } from '@lucide/svelte';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { compactCount } from '$lib/reels/reelRail';
  import { DOUBLE_TAP_REACTION } from '$lib/posts/postReaction';
  import { reactionTypeToEmoji, reactionTypeToLabel } from '$lib/posts/reactions';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';

  interface Props {
    /**
     * The reader's own reaction on the post, or null. "J'aime" fills the heart; ANY OTHER KIND IS
     * DRAWN AS ITSELF in the heart's place (lead's decision, 2026-10-19), so a tap that takes it
     * back never removes a reaction the rail did not show.
     */
    readerReaction: string | null;
    /** Every reaction on the post. */
    reactionCount: number;
    /** The comments the post carries, replies included - the card's own count. */
    commentCount: number;
    onHeart: () => void;
    onComments: () => void;
    onSend: () => void;
  }

  let { readerReaction, reactionCount, commentCount, onHeart, onComments, onSend }: Props =
    $props();

  const reacted = $derived(readerReaction !== null);
  /** The reader's emoji when their reaction is not the heart. */
  const otherEmoji = $derived(
    readerReaction && readerReaction !== DOUBLE_TAP_REACTION
      ? reactionTypeToEmoji(readerReaction)
      : null
  );

  const locale = getLocale();
</script>

<!-- A COLUMN DRAWN OVER THE PICTURE: icons and numbers carry a drop shadow (`drop-shadow-md`) so
     white still reads on a white sky, as Instagram's do. 44 px targets (`ui-icon-button`). -->
<div
  class="pointer-events-auto flex flex-col items-center gap-2 text-white"
  role="group"
  aria-label={m.reels_rail_label()}
  data-reel-rail
  data-no-double-tap
>
  <div class="flex flex-col items-center">
    <button
      type="button"
      class="ui-icon-button rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-pressed={reacted}
      aria-label={otherEmoji && readerReaction
        ? m.reels_rail_mine({ count: reactionCount, reaction: reactionTypeToLabel(readerReaction) })
        : m.reels_rail_like({ count: reactionCount })}
      onclick={onHeart}
      data-reel-rail-heart
    >
      {#if otherEmoji}
        <span class="text-2xl leading-none drop-shadow-md" aria-hidden="true" data-reel-rail-emoji
          ><EmojiText text={otherEmoji} /></span
        >
      {:else}
        <Heart
          size={30}
          strokeWidth={2}
          class="drop-shadow-md {reacted ? 'fill-red-500 text-red-500' : ''}"
          aria-hidden="true"
        />
      {/if}
    </button>
    <span class="text-xs font-semibold drop-shadow-md" aria-hidden="true"
      >{compactCount(reactionCount, locale)}</span
    >
  </div>

  <div class="flex flex-col items-center">
    <button
      type="button"
      class="ui-icon-button rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-haspopup="dialog"
      aria-label={m.reels_rail_comments({ count: commentCount })}
      onclick={onComments}
      data-reel-rail-comments
    >
      <MessageCircle size={30} strokeWidth={2} class="drop-shadow-md" aria-hidden="true" />
    </button>
    <span class="text-xs font-semibold drop-shadow-md" aria-hidden="true"
      >{compactCount(commentCount, locale)}</span
    >
  </div>

  <button
    type="button"
    class="ui-icon-button rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    aria-label={m.post_share_label()}
    title={m.post_share_label()}
    onclick={onSend}
    data-reel-rail-send
  >
    <Send size={28} strokeWidth={2} class="drop-shadow-md" aria-hidden="true" />
  </button>
</div>
