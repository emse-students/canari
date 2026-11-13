<script lang="ts">
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import {
    Reply,
    Forward,
    Pencil,
    Trash2,
    FaceSlightlySmilingPlus,
    Copy,
    Share2,
    Pin,
    PinOff,
  } from '@lucide/svelte';
  import { fly, fade } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';
  import { QUICK_REACTION_EMOJIS } from '$lib/utils/chat/messageActions';
  import { sheetClearance, sheetRestingTop } from '$lib/utils/chat/sheetClearance';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { useOverlayLayer } from '$lib/utils/overlayLayer.svelte';

  /** Quick-reaction emojis shown in the strip (WhatsApp/Messenger style). */

  interface Props {
    /** Whether the radial action menu overlay is visible. */
    visible: boolean;
    /**
     * The bubble this sheet acts on, which the sheet must not cover.
     *
     * The opener knows which message it is; nothing in the DOM below this node says so. Same
     * reasoning as `MessageEmojiPicker`'s anchor, and for the same reason it is a prop rather than
     * a query: a portalled panel that hunts for its own subject finds whichever one matches.
     */
    anchor?: HTMLElement | null;
    /** When true, the message belongs to the current user (gates edit/delete). */
    isOwn?: boolean;
    /** When true, hides reply and edit actions (message has been deleted). */
    isDeleted?: boolean;
    /** When false, hides the reply button. */
    canReply?: boolean;
    /** When false, hides the react button. */
    canReact?: boolean;
    /** When false, hides the edit button. */
    canEdit?: boolean;
    /** When false, hides the delete button. */
    canDelete?: boolean;
    /** Emojis the current user has already reacted with (highlights them in the strip). */
    userReactions?: string[];
    /** Called when the user taps a quick emoji in the reaction strip. */
    onReactEmoji?: (emoji: string) => void;
    /** Called when the user taps the "+" button to open the full emoji picker. */
    onOpenFullPicker?: () => void;
    /** Called when the user taps the reply button. */
    onReply?: () => void;
    /** Called when the user taps the forward button. */
    onForward?: () => void;
    /** Called when the user taps the copy button. Hidden when undefined (e.g. media-only). */
    onCopy?: () => void;
    /**
     * Called when the user taps "Partager": the system share sheet on the message's text or its
     * attachment (`sharing/shareOut.ts`). Hidden when undefined - outside the phone apps.
     */
    onShare?: () => void;
    /** Whether the message is pinned (toggles the pin/unpin label + icon). */
    pinned?: boolean;
    /** Called when the user taps the pin/unpin button. Hidden when undefined. */
    onPin?: () => void;
    /** Called when the user taps the edit button. */
    onEdit?: () => void;
    /** Called when the user taps the delete button. */
    onDelete?: () => void;
    /** Called when the backdrop or center button is tapped to close the menu. */
    onClose?: () => void;
    /**
     * Whether the viewer may delete OTHER members' messages here - the `channel.moderate`
     * permission in a community channel. Only widens delete; editing someone else's message
     * is never moderation.
     */
    canModerate?: boolean;
  }

  let {
    visible = false,
    anchor = null,
    isOwn = false,
    isDeleted = false,
    canReply = true,
    canReact = true,
    canEdit = true,
    canDelete = true,
    userReactions = [],
    onReactEmoji,
    onOpenFullPicker,
    onReply,
    onForward,
    onCopy,
    onShare,
    pinned = false,
    onPin,
    onEdit,
    onDelete,
    onClose,
    canModerate = false,
  }: Props = $props();

  /** Registered while open: z-index by open order, the last opened on top (`utils/overlayStack.ts`). */
  const layer = useOverlayLayer(() => visible, 'MessageMobileActions');

  /** One entry of the action row; `tone` is the colour of a special action. */
  type SheetAction = {
    key: string;
    label: string;
    icon: typeof Reply;
    tone: string;
    run: () => void;
  };

  const NEUTRAL_TONE = 'text-text-main hover:bg-black/5 dark:hover:bg-white/5';

  /**
   * The actions this message offers, in display order. Every gate that used to wrap one button
   * lives here, so the row is data and a new action is one entry, not another hand-built button.
   */
  const actions = $derived.by<SheetAction[]>(() => {
    if (isDeleted) return [];
    const list: SheetAction[] = [];
    if (canReply)
      list.push({
        key: 'reply',
        label: m.msg_reply_label(),
        icon: Reply,
        tone: NEUTRAL_TONE,
        run: () => onReply?.(),
      });
    if (onForward)
      list.push({
        key: 'forward',
        label: m.msg_forward_label(),
        icon: Forward,
        tone: NEUTRAL_TONE,
        run: onForward,
      });
    if (onCopy)
      list.push({
        key: 'copy',
        label: m.msg_copy_label(),
        icon: Copy,
        tone: NEUTRAL_TONE,
        run: onCopy,
      });
    if (onShare)
      list.push({
        key: 'share',
        label: m.msg_share_label(),
        icon: Share2,
        tone: NEUTRAL_TONE,
        run: onShare,
      });
    if (onPin)
      list.push({
        key: 'pin',
        label: pinned ? m.msg_unpin_label() : m.msg_pin_label(),
        icon: pinned ? PinOff : Pin,
        tone: 'text-accent-text hover:bg-accent/10',
        run: onPin,
      });
    // A media message's edit is its caption's, so it is offered too (owner, 2026-11-11).
    if (isOwn && canEdit)
      list.push({
        key: 'edit',
        label: m.common_edit_label(),
        icon: Pencil,
        tone: 'text-blue-500 hover:bg-blue-500/10',
        run: () => onEdit?.(),
      });
    if ((isOwn || canModerate) && canDelete)
      list.push({
        key: 'delete',
        label: m.common_delete_button(),
        icon: Trash2,
        tone: 'text-red-500 hover:bg-red-500/10',
        run: () => onDelete?.(),
      });
    return list;
  });

  let sheetEl = $state<HTMLDivElement | undefined>();

  /**
   * THE SHEET IS A HISTORY ENTRY OF ITS OWN, so the system Back closes the sheet and nothing else.
   * It held none, so one Back popped the CONVERSATION's entry and closed both (Mi 9T, three-button
   * and gesture Back alike, 3 of 3, 2026-10-13). The scrim and a tapped action close it through the
   * owner's state; the entry left behind is a ghost `historyOverlayStack` crosses without costing a
   * Back.
   */
  bindHistoryOverlay(
    () => visible,
    () => onClose?.()
  );

  /**
   * LIFT THE THREAD SO THE SHEET IS NOT COVERING THE MESSAGE IT ACTS ON.
   *
   * The whole decision is in `sheetClearance`, with the reasoning and the A1 measurement; this
   * effect only feeds it what the DOM knows and applies the two numbers it returns. It runs on
   * `visible`, so closing the sheet runs the cleanup and the borrowed padding goes back - which
   * also returns the thread to where it was, with nobody having to remember a scroll position.
   *
   * The scroll is INSTANT, not smooth. A smooth scroll is a clock with a duration no standard
   * fixes, and one still running when the sheet closes would fight the cleanup for the same
   * `scrollTop`. The sheet is appearing over 220 ms at the same moment, so the lift is not a jump
   * anyone sees on its own.
   */
  $effect(() => {
    if (!visible) return;
    const sheet = sheetEl;
    const bubble = anchor;
    if (!sheet || !bubble) return;

    // The scroller is what clips the thread, and it is the same one the hover toolbar measures
    // against. Without it there is nothing to scroll and nothing to do.
    const scroller = bubble.closest<HTMLElement>('.chat-messages-scroll');
    const overlay = sheet.parentElement;
    if (!scroller || !overlay) return;

    const style = getComputedStyle(sheet);
    const bubbleBox = bubble.getBoundingClientRect();
    const { padBy, scrollBy } = sheetClearance({
      bubbleTop: bubbleBox.top,
      bubbleBottom: bubbleBox.bottom,
      sheetTop: sheetRestingTop(
        overlay.getBoundingClientRect().bottom,
        Number.parseFloat(style.bottom) || 0,
        sheet.offsetHeight
      ),
      scrollerTop: scroller.getBoundingClientRect().top,
      scrollRemaining: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    });
    if (scrollBy <= 0) return;

    // The inline value is restored rather than cleared: a future rule setting one here must not be
    // erased by this sheet closing.
    const previousPadding = scroller.style.paddingBottom;
    if (padBy > 0) {
      const current = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      scroller.style.paddingBottom = `${current + padBy}px`;
    }
    scroller.scrollTop += scrollBy;

    return () => {
      if (padBy > 0) scroller.style.paddingBottom = previousPadding;
    };
  });
</script>

<!--
  PORTALLED, AND THE RUNG ALONE WOULD NOT HAVE BEEN ENOUGH.

  This sheet is rendered at the bottom of a `MessageBubble`, deep inside `.page-scroll-wrap` - which
  carries `will-change: transform` for the swipe-between-tabs gesture. That makes the wrapper BOTH a
  stacking context and the containing block for `position: fixed`, so before this the sheet's
  `inset-0` resolved against the WRAPPER's box rather than the viewport, and its rung was compared
  only with the wrapper's own children. Measured on `/chat` at 393px: the page sits at rung 10 of the
  root context, so a sheet asking for 160 was really asking for 160-of-10, and anything the wrapper
  does not cover - the conversation header among them - stayed outside the scrim.

  Moving the node to `document.body` is what makes `inset-0` mean the viewport and its z-index mean
  the window, on every device rather than on the ones whose wrapper happens to fill the screen.
-->
{#if visible}
  <div use:portal use:coversScreen style:z-index={layer.z} class="fixed inset-0 md:hidden">
    <button
      type="button"
      class="absolute inset-0 cursor-default bg-black/45 outline-none"
      aria-label={m.msg_close_actions_label()}
      onclick={onClose}
      transition:fade={{ duration: 180 }}
    ></button>

    <div
      bind:this={sheetEl}
      data-keyboard-aware-actions
      class="absolute inset-x-0 flex flex-col items-center gap-4"
      transition:fly={{ y: 24, duration: 220 }}
    >
      {#if !isDeleted && canReact}
        <!-- Quick emoji reaction strip (WhatsApp/Messenger style) -->
        <div
          class="bg-cn-surface flex items-center gap-1 rounded-full border border-black/10 px-3 py-2 shadow-2xl dark:border-white/10"
        >
          {#each QUICK_REACTION_EMOJIS as emoji (emoji)}
            {@const isActive = userReactions.includes(emoji)}
            <button
              type="button"
              class="flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none transition-transform active:scale-75 {isActive
                ? 'bg-accent/20 ring-accent-icon ring-2'
                : 'hover:bg-black/5 dark:hover:bg-white/10'}"
              aria-label={m.msg_react_with_emoji({ emoji })}
              aria-pressed={isActive}
              onclick={() => {
                onReactEmoji?.(emoji);
                onClose?.();
              }}
            >
              <EmojiText text={emoji} />
            </button>
          {/each}
          <button
            type="button"
            class="text-text-muted flex h-11 w-11 items-center justify-center rounded-full transition-transform hover:bg-black/5 active:scale-75 dark:hover:bg-white/10"
            aria-label={m.msg_more_reactions_label()}
            onclick={() => {
              onOpenFullPicker?.();
              onClose?.();
            }}
          >
            <FaceSlightlySmilingPlus size={22} />
          </button>
        </div>
      {/if}

      <!-- ONE ROW, ICONS ONLY (owner, 2026-11-08: "les actions possibles devraient tenir sur une
           ligne, quitte a ne pas mettre les textes"). The name of each action is its accessible
           name (aria-label) and its tooltip on a pointer device (title). The widest sheet is an
           own text message with seven actions: the buttons share the row equally (flex-1, 44px
           tall) and never wrap - 48px wide each from 360px, 42px at 320px. -->
      <div
        class="bg-cn-surface flex w-[calc(100vw-1rem)] max-w-96 items-center justify-between rounded-2xl border border-black/10 px-1 py-2 shadow-xl dark:border-white/10"
      >
        {#each actions as action (action.key)}
          {@const Icon = action.icon}
          <button
            type="button"
            onclick={() => {
              action.run();
              onClose?.();
            }}
            class="flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl transition-transform active:scale-95 {action.tone}"
            aria-label={action.label}
            title={action.label}
          >
            <Icon size={22} />
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}
