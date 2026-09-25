<script lang="ts">
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  /**
   * A QUOTED MESSAGE IS A SECOND BUBBLE STACKED FLUSH ABOVE THE REPLY, NOT A STRIP INSIDE IT.
   *
   * It was a strip inside until 2026-09-22 - a left-barred `bg-black/5` block with the author's
   * name in bold, sharing the reply's background and its padding box. The user asked for the
   * reference's treatment (*"Pour l'UI des reponses dans les conversations, Messenger fait un truc
   * joli. Tu peux regarder et imiter ?"*), and it is a different construction, not a restyling.
   *
   * MEASURED on Messenger 579.0.0.61.91, Mi 9T, 1080px wide at x2.75 density, on the SAME thread in
   * both themes so the two readings differ only by the theme:
   *
   * | | dark | light |
   * | --- | --- | --- |
   * | thread ground | #000000 | #ffffff |
   * | reply bubble | rgb(51,51,52) | rgb(242,244,247) |
   * | quote bubble | rgb(31,31,31) | rgb(247,248,250) |
   * | quote fill as a fraction of the bubble, over the ground | 31/51 = 0.61 | 8/13 = 0.62 |
   * | quote text | rgb(176,179,184) | rgb(101,104,108) |
   * | reply text | rgb(255,255,255) | rgb(0,0,0) |
   *
   * TWO THINGS FALL OUT OF THAT TABLE AND THEY ARE WHY THIS IS CHEAP TO BUILD HERE.
   *
   * **The quote fill is an OPACITY, not a colour.** The same ~62% of the bubble over the thread
   * ground explains both themes, although one recedes toward black and the other toward white. So
   * it needs no token and no hex: `bg-bubble-in/65` and `bg-bubble-out/65`. The 65 rather than the
   * measured 60-62 is the one deliberate departure, and it is forced by this app's own palette:
   * Canari's outgoing bubble is `--cn-yellow` carrying DARK text, where the reference's is blue
   * carrying white. Receding a saturated yellow toward black drags it toward the ink on top of it,
   * and at 60% the dark-theme outgoing pair measures 4.45:1 - a hair under AA for body text, which
   * this is. 65% is inside the measurement's own spread (0.61 and 0.62 were the two readings) and
   * puts the worst of the four cases at 5.2:1. The other three are 4.6 or better.
   *
   * **The quote text is already in this repository.** The reference's two values are rgb(176,179,184)
   * and rgb(101,104,108); `--text-muted` here is `#b0b3b8` and `#65686c`, which is the same pair
   * exactly - both were measured from the same reference, years apart, and landed on the same
   * numbers. So an incoming quote is `text-text-muted` at full strength, not a dimmed body colour.
   *
   * THE NAME MOVED OUT OF THE QUOTE AND INTO A CAPTION ROW. The reference does not repeat the
   * author inside the quote; it writes one small muted line above the pair saying who answered
   * whom - "Leon vous a repondu" - with a reply-arrow glyph, and that line is inset to the BUBBLE'S
   * TEXT left edge rather than to the bubble's own edge (measured: arrow at x=165, quote text at
   * x=160, quote bubble at x=129). Four phrasings cover it, because the caption is the only place
   * that says who is answering whom and it must not lie in the self-reply or third-party cases.
   *
   * THE QUOTED AUTHOR'S PROFILE LINK IS GONE, deliberately. It was an `<a>` nested inside the
   * quote's `<button>` - invalid markup, and the reference has no such link either: the whole quote
   * is one target that jumps to the original message, whose own avatar opens the profile. The
   * affordance survives one hop away and the component no longer needs the author's id at all.
   */
  import { CornerUpLeft } from '@lucide/svelte';
  import { shortenReplyPreview, getBubbleShapeClass } from '$lib/utils/chat/messageDisplay';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** ID of the quoted message, used for scroll-to navigation. */
    replyId?: string;
    /** Pre-resolved display name of the quoted message's author. */
    displayName: string;
    /** Raw content of the quoted message (will be shortened automatically). */
    content: string;
    /** True when the REPLY (not the quote) is the reader's own message. Decides side and palette. */
    isOwn: boolean;
    /** Pre-resolved display name of the author of the reply, named only when it is not the reader. */
    replierDisplayName: string;
    /** True when the quoted message is the reader's own. */
    quotedIsReader: boolean;
    /** Called when the user clicks the quote to navigate to the original message. */
    onNavigateToMessage?: (id: string) => void;
  }

  let {
    replyId,
    displayName,
    content,
    isOwn,
    replierDisplayName,
    quotedIsReader,
    onNavigateToMessage,
  }: Props = $props();

  const previewText = $derived(shortenReplyPreview(content));

  /**
   * Who answered whom, in one line. The reader is always "vous", on whichever side they appear, so
   * the four branches are the four ways the pair (author of the reply, author of the quote) can
   * relate to them - and the third-party case is the only one that has to name two people.
   */
  const caption = $derived(
    isOwn
      ? quotedIsReader
        ? m.msg_reply_caption_you_to_self()
        : m.msg_reply_caption_you_to_other({ name: displayName })
      : quotedIsReader
        ? m.msg_reply_caption_other_to_you({ name: replierDisplayName })
        : m.msg_reply_caption_other_to_other({
            replier: replierDisplayName,
            name: displayName,
          })
  );
</script>

<!--
  `items-end`/`items-start` rather than `text-right`: the quote is content-sized, so the side it
  hugs is a flex decision, and the caption must hug the same one.
-->
<div class="flex w-full flex-col {isOwn ? 'items-end' : 'items-start'}">
  <!--
    `px-3` matches the bubble's own horizontal padding, which is what puts the arrow on the quoted
    text's left edge rather than on the bubble's - the measured inset in the reference. `mb-1` is
    the 23px the reference leaves between the caption's descenders and the quote's top edge.
  -->
  <div class="text-text-muted mb-1 flex max-w-full items-center gap-1 px-3 text-xs">
    <CornerUpLeft size={13} class="shrink-0" aria-hidden="true" />
    <span class="truncate"><EmojiText text={caption} /></span>
  </div>

  <!--
    NO MARGIN UNDER THIS BUTTON. The reference shares a pixel row between the quote's bottom edge
    and the reply's top edge, and the two square corners at that seam only read as one stacked
    shape while nothing separates them - see `stackedQuotePosition`, which puts the reply's matching
    tail on the facing corner.
  -->
  <button
    type="button"
    class="{getBubbleShapeClass(
      'start',
      isOwn
    )} max-w-full cursor-pointer px-3 py-2 text-left text-sm transition-opacity hover:opacity-80 {isOwn
      ? 'bg-bubble-out/65 text-bubble-out-text'
      : 'bg-bubble-in/65 text-text-muted'}"
    onclick={(e) => {
      e.stopPropagation();
      if (replyId) onNavigateToMessage?.(replyId);
    }}
    title={m.msg_go_to_quoted_message_label()}
    aria-label={m.msg_go_to_quoted_message_label()}
  >
    <span class="block truncate"><EmojiText text={previewText} /></span>
  </button>
</div>
