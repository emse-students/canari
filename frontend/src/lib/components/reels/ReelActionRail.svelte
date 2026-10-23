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
  import type { Snippet } from 'svelte';
  import { Heart, MessageCircle, Send, Volume2, VolumeX } from '@lucide/svelte';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { compactCount } from '$lib/reels/reelRail';
  import { DOUBLE_TAP_REACTION } from '$lib/posts/postReaction';
  import { REACTIONS, reactionTypeToEmoji, reactionTypeToLabel } from '$lib/posts/reactions';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';

  interface Props {
    /**
     * The reader's own reaction on the post, or null. "J'aime" fills the heart; ANY OTHER KIND IS
     * DRAWN AS ITSELF in the heart's place (lead's decision, 2026-10-19), so a tap that takes it
     * back never removes a reaction the rail did not show.
     */
    readerReaction?: string | null;
    /** Every reaction on the post. */
    reactionCount?: number;
    /** The comments the post carries, replies included - the card's own count. */
    commentCount?: number;
    /**
     * The three social actions. ABSENT - a conversation's reel, which is not a post - only the
     * tools below are drawn.
     */
    onHeart?: () => void;
    onComments?: () => void;
    onSend?: () => void;
    /**
     * The reel's own tools, under the send (user, 2026-10-23): the save (`ReelSaveButton`, the
     * caller's) and then THE SOUND, drawn here when `sound` is set. Not on a photo page.
     */
    tools?: Snippet;
    /** Draws the sound button, the app's one answer (`videoSound`), under `tools`. */
    sound?: boolean;
  }

  let {
    readerReaction = null,
    reactionCount = 0,
    commentCount = 0,
    onHeart,
    onComments,
    onSend,
    tools,
    sound = false,
  }: Props = $props();

  const social = $derived(!!onHeart && !!onComments && !!onSend);

  const reacted = $derived(readerReaction !== null);
  /**
   * What the heart is called: "J'aime" with none or with the heart, the reader's own reaction by
   * name otherwise - and, for a kind this client does not know (a newer server's), a neutral "your
   * reaction", never "J'aime" (`reactionTypeToLabel` falls back to it).
   */
  const heartLabel = $derived.by(() => {
    if (!readerReaction || readerReaction === DOUBLE_TAP_REACTION) {
      return m.reels_rail_like({ count: reactionCount });
    }
    if (!REACTIONS.some((r) => r.type === readerReaction)) {
      return m.reels_rail_mine_unknown({ count: reactionCount });
    }
    return m.reels_rail_mine({
      count: reactionCount,
      reaction: reactionTypeToLabel(readerReaction),
    });
  });

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
  {#if social}
    <div class="flex flex-col items-center">
      <button
        type="button"
        class="ui-icon-button rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-pressed={reacted}
        aria-label={heartLabel}
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
  {/if}

  {@render tools?.()}

  {#if sound}
    <button
      type="button"
      class="ui-icon-button rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={m.video_sound_label()}
      title={m.video_sound_label()}
      aria-pressed={!videoSound.muted}
      onclick={() => videoSound.toggle()}
      data-reel-rail-sound
    >
      {#if videoSound.muted}
        <VolumeX size={26} strokeWidth={2} class="drop-shadow-md" aria-hidden="true" />
      {:else}
        <Volume2 size={26} strokeWidth={2} class="drop-shadow-md" aria-hidden="true" />
      {/if}
    </button>
  {/if}
</div>
