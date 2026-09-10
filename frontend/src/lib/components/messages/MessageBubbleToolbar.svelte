<script lang="ts">
  import {
    Reply,
    Forward,
    FaceSlightlySmilingPlus,
    Pencil,
    Trash2,
    Pin,
    PinOff,
    Ellipsis,
    Plus,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { QUICK_REACTION_EMOJIS } from '$lib/utils/chat/messageActions';

  interface Props {
    /** When true, positions the toolbar on the left of the bubble (own messages hug the right). */
    isOwn: boolean;
    /** When true, hides reply and edit/delete actions. */
    isDeleted: boolean;
    /** When true, hides the edit action (media messages cannot be edited). */
    hasMedia: boolean;
    /** When true, keeps the toolbar fully visible (the full emoji picker is open). */
    showEmojiPicker: boolean;
    /** Called when the reply button is clicked. Omit to hide the button. */
    onReply?: () => void;
    /** Called when the forward button is clicked. Omit to hide the button. */
    onForward?: () => void;
    /** Called when a quick-reaction emoji is clicked. Omit to hide the reaction button. */
    onReact?: (emoji: string) => void;
    /** Emojis the current user already reacted with (highlights them in the quick bar). */
    userReactions?: string[];
    /** Called when the "+" inside the quick bar is clicked. Omit to hide it. */
    onToggleEmojiPicker?: () => void;
    /** Whether the message is pinned (toggles the pin/unpin icon + tooltip). */
    pinned?: boolean;
    /** Called when the pin/unpin button is clicked. Omit to hide the item. */
    onPin?: () => void;
    /** Called when the edit button is clicked. Omit to hide the item. */
    onEdit?: () => void;
    /** Called when the delete button is clicked. Omit to hide the item. */
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

  /** The quick-reaction bar, opened by the smiley. Closed by a pick, by Escape, or by the menu. */
  let quickOpen = $state(false);
  /** The overflow menu, opened by the ellipsis. Mutually exclusive with the quick bar. */
  let menuOpen = $state(false);

  const canEdit = $derived(!isDeleted && isOwn && !hasMedia && !!onEdit);
  const canDelete = $derived(!isDeleted && (isOwn || canModerate) && !!onDelete);
  const hasMenu = $derived(!!onForward || !!onPin || canEdit || canDelete);

  /**
   * The strip stays put while either popover is open, otherwise it follows the row's hover.
   * `showEmojiPicker` is the parent's full picker, which is anchored to this same message.
   */
  const pinnedOpen = $derived(quickOpen || menuOpen || showEmojiPicker);

  function closeAll() {
    quickOpen = false;
    menuOpen = false;
  }

  /**
   * WHICH SIDE OF THE BUBBLE A POPOVER OPENS ON, AND WHY IT IS NOT ALWAYS ABOVE.
   *
   * Both popovers used to be `bottom-full` unconditionally. On a message near the top of the thread
   * that puts them off the top of the screen and `.chat-messages-scroll` - `overflow-y: auto` - cuts
   * them off. Measured on 2026-09-09 at 958px, on the first visible bubble: the overflow menu
   * rendered at `top: -153px`, `bottom: -1px`, entirely above the viewport, and the user's report of
   * it was a screenshot of the sliver that survived. It reads as a layering fault and it is not one:
   * the menu wins every hit-test it is given, it is simply not on screen.
   *
   * THE ROOM IS MEASURED AGAINST THE SCROLLER, NOT THE VIEWPORT, because the scroller is what clips.
   * A popover anchored to the bubble also travels with it for free, which a portalled one would not:
   * that would need scroll tracking, and an anchor that can drift is a second defect in place of
   * this one. `MessageMobileActions` is portalled for the opposite reason - it is `inset-0` and
   * anchored to nothing.
   *
   * `null` means NOT YET MEASURED, and the popover is invisible for that one frame rather than
   * painted in the wrong place and moved. A flip the reader can see is worse than a frame they
   * cannot.
   */
  let placement = $state<'above' | 'below' | null>(null);
  let anchorEl = $state<HTMLDivElement | undefined>();
  let popoverEl = $state<HTMLDivElement | undefined>();

  $effect(() => {
    if (!quickOpen && !menuOpen) {
      placement = null;
      return;
    }
    const popover = popoverEl;
    const anchor = anchorEl;
    if (!popover || !anchor) return;

    const clipper = anchor.closest('.chat-messages-scroll') ?? anchor.offsetParent;
    const bounds = clipper?.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    // GAP is the `mb-2`/`mt-2` below, in pixels: the popover needs its own height plus that margin.
    const needed = popover.offsetHeight + 8;
    if (!bounds) {
      placement = 'above';
      return;
    }
    const roomAbove = box.top - bounds.top;
    // Above unless it does not fit AND below is roomier - so a thread too short for either side
    // keeps the reference's placement instead of flipping to an equally clipped one.
    placement = roomAbove >= needed || roomAbove >= bounds.bottom - box.bottom ? 'above' : 'below';
  });

  /** The two anchoring classes, plus the one frame before the measurement exists. */
  const placementClass = $derived(
    placement === null
      ? 'bottom-full mb-2 invisible'
      : placement === 'below'
        ? 'top-full mt-2'
        : 'bottom-full mb-2'
  );
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && (quickOpen || menuOpen)) {
      e.stopPropagation();
      closeAll();
    }
  }}
/>

<!--
  THREE BUTTONS BESIDE THE BUBBLE, NOT ONE STRIP ABOVE IT.

  This used to be a single wide bar - six emojis plus every action - fading in ABOVE the message over
  200ms. Two things were wrong with it, both reported by the user. It overlapped the message above
  whenever the hovered one was not the last of its group, because a bar that hangs over the top edge
  has nowhere else to go in a tight run of bubbles. And it made "what can I do here" a wall of eight
  controls appearing at once.

  The measured reference does it differently: three 28px circles, transparent, adjacent, OUTSIDE the
  bubble on the side away from the edge and centred on its middle - so they occupy the empty gutter
  the thread always has, never a neighbour. Order from the bubble outward is react, reply, more, so
  the commonest action is nearest the thumb travelling from the message. Everything rarer lives
  behind the ellipsis, and the six emojis appear only once the smiley is pressed.

  INSTANT, deliberately (user, 2026-09-08). The reference reveals these with no transition at all;
  a 200ms fade on something that tracks the pointer reads as lag, because by the time it has
  finished the pointer has usually moved on.
-->
<div
  bind:this={anchorEl}
  use:clickOutside={{ enabled: quickOpen || menuOpen, callback: closeAll }}
  class="pointer-events-none absolute inset-0 hidden md:block"
>
  <!--
    The STRIP is positioned against the bubble, which is what `inset-0` on the wrapper buys: this box
    is the bubble's own rectangle, so `left-full` puts the strip in the gutter beside it.

    THE POPOVERS ARE POSITIONED AGAINST THE STRIP, and they are its children for that reason. They
    were the bubble's until 2026-09-09, which put the reaction pill above the bubble's LEFT edge
    while the smiley that opens it sat in the gutter on the right - the user's report was exactly
    that: *"la barre de smiley devrait apparaitre au niveau du bouton smiley+"*.

    ANCHORING TO THE STRIP HAD BEEN TRIED ON 2026-09-08 AND REVERTED, because it laid the pill
    "entirely in the gutter, 292px to the left of the message". That attempt kept the bubble's SIDE,
    and the side has to mirror when the anchor changes: the strip sits in the gutter, so a popover
    must extend back INWARD over the message, away from the edge. For a peer message the strip is on
    the right, so the popover's right edge pins to it (`right-0`) and it grows leftward; for an own
    message the strip is on the left and it is `left-0`. Keeping `right-0` for an own message is what
    sent 292px of pill into the gutter, and it is the one line that made the idea look wrong.

    The strip REVERSES for an own message rather than being written twice: react has to be the button
    nearest the bubble, which is the row's last child on the right and its first on the left.
  -->
  <div
    data-message-toolbar
    class="pointer-events-auto absolute top-1/2 z-10 flex -translate-y-1/2 flex-row items-center {isOwn
      ? 'right-full mr-1 flex-row-reverse'
      : 'left-full ml-1'} {pinnedOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
  >
    {#if !isDeleted && onReact}
      <button
        onclick={(e) => {
          e.stopPropagation();
          menuOpen = false;
          quickOpen = !quickOpen;
        }}
        class="ui-icon-button ui-icon-button--sm text-text-muted hover:text-text-main rounded-full hover:bg-black/5 dark:hover:bg-white/10"
        aria-label={m.msg_react_label()}
        aria-expanded={quickOpen}
        title={m.msg_react_label()}
      >
        <FaceSlightlySmilingPlus size={16} />
      </button>
    {/if}

    {#if !isDeleted && onReply}
      <button
        onclick={(e) => {
          e.stopPropagation();
          closeAll();
          onReply?.();
        }}
        class="ui-icon-button ui-icon-button--sm text-text-muted hover:text-text-main rounded-full hover:bg-black/5 dark:hover:bg-white/10"
        aria-label={m.msg_reply_label()}
        title={m.msg_reply_label()}
      >
        <Reply size={16} />
      </button>
    {/if}

    {#if hasMenu}
      <button
        onclick={(e) => {
          e.stopPropagation();
          quickOpen = false;
          menuOpen = !menuOpen;
        }}
        class="ui-icon-button ui-icon-button--sm text-text-muted hover:text-text-main rounded-full hover:bg-black/5 dark:hover:bg-white/10"
        aria-label={m.msg_more_actions_label()}
        aria-expanded={menuOpen}
        title={m.msg_more_actions_label()}
      >
        <Ellipsis size={16} />
      </button>
    {/if}

    <!--
      THE QUICK BAR. Measured: a 24px-radius pill on the app background, 8px/12px of padding, six
      emojis and then the button that opens the full picker. It hangs above the strip rather than
      above the bubble, so it clears the neighbouring message for the same reason the strip does.
    -->
    {#if quickOpen && onReact}
      <div
        bind:this={popoverEl}
        class="bg-cn-popover pointer-events-auto absolute z-20 {placementClass} flex flex-row items-center gap-0.5 rounded-2xl px-3 py-2 shadow-lg {isOwn
          ? 'left-0'
          : 'right-0'}"
        role="group"
        aria-label={m.msg_react_label()}
      >
        {#each QUICK_REACTION_EMOJIS as emoji (emoji)}
          {@const isActive = userReactions.includes(emoji)}
          <button
            onclick={(e) => {
              e.stopPropagation();
              onReact?.(emoji);
              closeAll();
            }}
            class="flex h-9 w-9 items-center justify-center rounded-full text-xl leading-none transition-transform hover:scale-125 active:scale-95 {isActive
              ? 'bg-cn-yellow/20 ring-cn-yellow ring-1'
              : 'hover:bg-black/5 dark:hover:bg-white/10'}"
            aria-label={m.msg_react_with_emoji({ emoji })}
            aria-pressed={isActive}
            title={m.msg_react_with_emoji({ emoji })}
          >
            {emoji}
          </button>
        {/each}
        {#if onToggleEmojiPicker}
          <button
            onclick={(e) => {
              e.stopPropagation();
              quickOpen = false;
              onToggleEmojiPicker?.();
            }}
            class="text-text-muted hover:text-text-main flex h-9 w-9 items-center justify-center rounded-full bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/20"
            aria-label={m.msg_more_reactions_label()}
            title={m.msg_more_reactions_label()}
          >
            <Plus size={18} />
          </button>
        {/if}
      </div>
    {/if}

    <!-- The overflow menu: everything that is not react or reply. -->
    {#if menuOpen}
      <div
        bind:this={popoverEl}
        class="bg-cn-popover pointer-events-auto absolute z-20 {placementClass} flex min-w-44 flex-col rounded-xl py-1 shadow-lg {isOwn
          ? 'left-0'
          : 'right-0'}"
        role="menu"
      >
        {#if onForward}
          <button
            role="menuitem"
            onclick={(e) => {
              e.stopPropagation();
              closeAll();
              onForward?.();
            }}
            class="text-text-main flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Forward size={16} />
            {m.msg_forward_label()}
          </button>
        {/if}
        {#if onPin}
          <button
            role="menuitem"
            onclick={(e) => {
              e.stopPropagation();
              closeAll();
              onPin?.();
            }}
            class="text-text-main flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            {#if pinned}
              <PinOff size={16} />
              {m.msg_unpin_label()}
            {:else}
              <Pin size={16} />
              {m.msg_pin_label()}
            {/if}
          </button>
        {/if}
        {#if canEdit}
          <button
            role="menuitem"
            onclick={(e) => {
              e.stopPropagation();
              closeAll();
              onEdit?.();
            }}
            class="text-text-main flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
          >
            <Pencil size={16} />
            {m.common_edit_label()}
          </button>
        {/if}
        {#if canDelete}
          <button
            role="menuitem"
            onclick={(e) => {
              e.stopPropagation();
              closeAll();
              onDelete?.();
            }}
            class="text-red-err flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-red-500/10"
          >
            <Trash2 size={16} />
            {m.common_delete_button()}
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>
