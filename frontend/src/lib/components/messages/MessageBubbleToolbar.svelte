<script lang="ts">
  import { Reply, Forward, Smile, Pencil, Trash2, Pin, PinOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /** Quick-reaction emojis shown inline in the web hover toolbar (mirrors mobile). */
  const QUICK_EMOJIS = ['❤️', '😂', '😮', '😢', '👍', '😡'] as const;

  interface Props {
    /** When true, positions the toolbar on the right side. */
    isOwn: boolean;
    /** When true, hides reply and edit/delete actions. */
    isDeleted: boolean;
    /** When true, hides the edit action (media messages cannot be edited). */
    hasMedia: boolean;
    /** When true, keeps the toolbar fully visible (emoji picker is open). */
    showEmojiPicker: boolean;
    /** Called when the reply button is clicked. Omit to hide the button. */
    onReply?: () => void;
    /** Called when the forward button is clicked. Omit to hide the button. */
    onForward?: () => void;
    /** Called when a quick-reaction emoji is clicked. Omit to hide the strip. */
    onReact?: (emoji: string) => void;
    /** Emojis the current user already reacted with (highlights them in the strip). */
    userReactions?: string[];
    /** Called when the "more reactions" (+) button is clicked. Omit to hide the button. */
    onToggleEmojiPicker?: () => void;
    /** Whether the message is pinned (toggles the pin/unpin icon + tooltip). */
    pinned?: boolean;
    /** Called when the pin/unpin button is clicked. Omit to hide the button. */
    onPin?: () => void;
    /** Called when the edit button is clicked. Omit to hide the button. */
    onEdit?: () => void;
    /** Called when the delete button is clicked. Omit to hide the button. */
    onDelete?: () => void;
    /**
     * Whether the viewer may delete OTHER members' messages here - the `channel.moderate`
     * permission in a community channel. Only widens delete; editing someone else's message
     * is never moderation.
     */
    canModerate?: boolean;
  }

  let {
    isOwn,
    isDeleted,
    hasMedia,
    showEmojiPicker,
    onReply,
    onForward,
    onReact,
    userReactions = [],
    onToggleEmojiPicker,
    pinned = false,
    onPin,
    onEdit,
    onDelete,
    canModerate = false,
  }: Props = $props();
</script>

<!--
  ANCHORED ABOVE THE BUBBLE, ON ITS OUTER EDGE - never beside it.

  It used to sit `right-full` / `left-full`, i.e. entirely OUTSIDE the bubble, horizontally, with
  nothing bounding it by the message pane. The strip is a fixed ~383 px and a bubble can be any
  width, so it fitted only while `paneWidth - bubbleWidth >= toolbarWidth`. Measured on 2026-08-15
  at a 958 px window: the strip was laid out 69 px INTO the sidebar, and `elementFromPoint` at the
  heart button's own centre returned a conversation row - so a click aimed at a reaction did not
  merely miss, it switched conversation. Reported by a user as "the end is unreachable when the
  window is half the screen"; the threshold is not a window width, which is why it read as
  intermittent - a long message overflowed where a short one did not.

  Aligning it to the bubble's OUTER edge and letting it extend inward removes the bubble width from
  the condition entirely: it can only overflow if the strip is wider than the PANE, which no message
  can cause. That is why this is a placement change and not a breakpoint - a breakpoint would answer
  a question about the viewport, and the question was never about the viewport.

  ITS COST, MEASURED RATHER THAN ASSUMED: drawn above the bubble, the strip is clipped by the
  scroller for whichever row sits within ~46 px of the pane's top edge - about one row at a time,
  and it comes back with the smallest scroll. The candidate was measured in the live page before
  being written here: a middle row fits with zero overflow on either side, the topmost visible row
  loses the strip entirely. That is a worse-looking trade than it is: the old placement delivered a
  reaction click to the conversation list, and this one delays a control by one scroll wheel notch.

  IT IS A DESKTOP SURFACE ONLY - `hidden md:flex`, with no mobile mode at all. There used to be a
  `forceVisible` branch that showed this same strip on a long press, BESIDE the action sheet a long
  press already opens: two panels for one gesture, one of them a hover affordance on a device with
  no hover. Reported by the user, who could see both at once. The sheet is the mobile answer, this
  is the desktop one, and neither needs to know about the other.
-->
<div
  class="absolute {isOwn
    ? 'bottom-full mb-1 right-0'
    : 'bottom-full mb-1 left-0'} whitespace-nowrap opacity-0 {showEmojiPicker
    ? 'opacity-100'
    : 'group-hover:opacity-100'} transition-opacity duration-200 hidden md:flex flex-row items-center gap-0.5 rounded-full bg-white/90 dark:bg-black/70 backdrop-blur-xl border border-black/5 dark:border-white/10 shadow-lg px-2 py-1.5 z-10 text-text-muted"
>
  <!-- Quick reactions (web): the same set as mobile, hidden in mobile long-press mode where
       MessageMobileActions already shows its own reaction strip. -->
  {#if !isDeleted && onReact}
    {#each QUICK_EMOJIS as emoji (emoji)}
      {@const isActive = userReactions.includes(emoji)}
      <button
        onclick={(e) => {
          e.stopPropagation();
          onReact?.(emoji);
        }}
        class="w-7 h-7 rounded-full text-base leading-none flex items-center justify-center transition-transform hover:scale-125 active:scale-95 {isActive
          ? 'bg-amber-400/20 ring-1 ring-amber-400'
          : 'hover:bg-black/5 dark:hover:bg-white/10'}"
        aria-label={m.msg_react_with_emoji({ emoji })}
        aria-pressed={isActive}
        title={m.msg_react_with_emoji({ emoji })}
      >
        {emoji}
      </button>
    {/each}
    <div class="mx-0.5 self-stretch w-px bg-black/10 dark:bg-white/10"></div>
  {/if}
  {#if !isDeleted && onReply}
    <button
      onclick={() => onReply?.()}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
      aria-label={m.msg_reply_label()}
      title={m.msg_reply_label()}
    >
      <Reply size={16} />
    </button>
  {/if}
  {#if !isDeleted && onForward}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onForward?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
      aria-label={m.msg_forward_label()}
      title={m.msg_forward_label()}
    >
      <Forward size={16} />
    </button>
  {/if}
  {#if onToggleEmojiPicker}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onToggleEmojiPicker?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500 transition-colors"
      aria-label={onReact ? m.msg_more_reactions_label() : m.msg_react_label()}
      title={onReact ? m.msg_more_reactions_label() : m.msg_react_label()}
    >
      <Smile size={16} />
    </button>
  {/if}
  {#if !isDeleted && onPin}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onPin?.();
      }}
      class="p-1.5 rounded-full transition-colors {pinned
        ? 'text-amber-500'
        : 'hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500'}"
      aria-label={pinned ? m.msg_unpin_label() : m.msg_pin_label()}
      title={pinned ? m.msg_unpin_label() : m.msg_pin_label()}
    >
      {#if pinned}<PinOff size={16} />{:else}<Pin size={16} />{/if}
    </button>
  {/if}
  {#if !isDeleted && isOwn && !hasMedia && onEdit}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onEdit?.();
      }}
      class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-blue-500 transition-colors"
      aria-label={m.common_edit_label()}
      title={m.common_edit_label()}
    >
      <Pencil size={16} />
    </button>
  {/if}
  {#if !isDeleted && (isOwn || canModerate) && onDelete}
    <button
      onclick={(e) => {
        e.stopPropagation();
        onDelete?.();
      }}
      class="p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors"
      aria-label={m.common_delete_button()}
      title={m.common_delete_button()}
    >
      <Trash2 size={16} />
    </button>
  {/if}
</div>
