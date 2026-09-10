<script lang="ts">
  import {
    Reply,
    Forward,
    Pencil,
    Trash2,
    FaceSlightlySmilingPlus,
    Copy,
    Pin,
    PinOff,
  } from '@lucide/svelte';
  import { fly, fade } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';
  import { QUICK_REACTION_EMOJIS } from '$lib/utils/chat/messageActions';

  /** Quick-reaction emojis shown in the strip (WhatsApp/Messenger style). */

  interface Props {
    /** Whether the radial action menu overlay is visible. */
    visible: boolean;
    /** When true, the message belongs to the current user (gates edit/delete). */
    isOwn?: boolean;
    /** When true, hides reply and edit actions (message has been deleted). */
    isDeleted?: boolean;
    /** When true, hides the edit action (media messages cannot be edited). */
    hasMedia?: boolean;
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
    isOwn = false,
    isDeleted = false,
    hasMedia = false,
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
    pinned = false,
    onPin,
    onEdit,
    onDelete,
    onClose,
    canModerate = false,
  }: Props = $props();
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

  Moving the node to `document.body` is what makes `inset-0` mean the viewport and `--z-sheet` mean
  the ladder, on every device rather than on the ones whose wrapper happens to fill the screen.
-->
{#if visible}
  <div use:portal class="fixed inset-0 z-(--z-sheet) md:hidden">
    <button
      type="button"
      class="absolute inset-0 cursor-default bg-black/45 outline-none"
      aria-label={m.msg_close_actions_label()}
      onclick={onClose}
      transition:fade={{ duration: 180 }}
    ></button>

    <div
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
                ? 'bg-amber-400/20 ring-2 ring-amber-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10'}"
              aria-label={m.msg_react_with_emoji({ emoji })}
              aria-pressed={isActive}
              onclick={() => {
                onReactEmoji?.(emoji);
                onClose?.();
              }}
            >
              {emoji}
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

      <!-- Action buttons row. An own message can show one more button than a received one
           (edit), which is enough to overflow a narrow phone screen at full width - wraps to a
           second line instead, rather than spilling off both edges. -->
      <div
        class="bg-cn-surface flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-3 rounded-2xl border border-black/10 px-4 py-3 shadow-xl dark:border-white/10"
      >
        {#if !isDeleted && canReply}
          <button
            onclick={() => {
              onReply?.();
              onClose?.();
            }}
            class="text-text-main flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-transform hover:bg-black/5 active:scale-95 dark:hover:bg-white/5"
            aria-label={m.msg_reply_label()}
          >
            <Reply size={20} />
            <span class="text-text-muted text-2xs font-medium">{m.msg_reply_label()}</span>
          </button>
        {/if}

        {#if !isDeleted && onForward}
          <button
            onclick={() => {
              onForward?.();
              onClose?.();
            }}
            class="text-text-main flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-transform hover:bg-black/5 active:scale-95 dark:hover:bg-white/5"
            aria-label={m.msg_forward_label()}
          >
            <Forward size={20} />
            <span class="text-text-muted text-2xs font-medium">{m.msg_forward_label()}</span>
          </button>
        {/if}

        {#if !isDeleted && onCopy}
          <button
            onclick={() => {
              onCopy?.();
              onClose?.();
            }}
            class="text-text-main flex flex-col items-center gap-1 rounded-xl px-3 py-2 transition-transform hover:bg-black/5 active:scale-95 dark:hover:bg-white/5"
            aria-label={m.msg_copy_label()}
          >
            <Copy size={20} />
            <span class="text-text-muted text-2xs font-medium">{m.msg_copy_label()}</span>
          </button>
        {/if}

        {#if !isDeleted && onPin}
          <button
            onclick={() => {
              onPin?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-amber-600 transition-transform hover:bg-amber-500/10 active:scale-95 dark:text-amber-500"
            aria-label={pinned ? m.msg_unpin_label() : m.msg_pin_label()}
          >
            {#if pinned}<PinOff size={20} />{:else}<Pin size={20} />{/if}
            <span class="text-2xs font-medium"
              >{pinned ? m.msg_unpin_label() : m.msg_pin_label()}</span
            >
          </button>
        {/if}

        {#if !isDeleted && isOwn && !hasMedia && canEdit}
          <button
            onclick={() => {
              onEdit?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-blue-500 transition-transform hover:bg-blue-500/10 active:scale-95"
            aria-label={m.common_edit_label()}
          >
            <Pencil size={20} />
            <span class="text-2xs font-medium">{m.common_edit_label()}</span>
          </button>
        {/if}

        {#if !isDeleted && (isOwn || canModerate) && canDelete}
          <button
            onclick={() => {
              onDelete?.();
              onClose?.();
            }}
            class="flex flex-col items-center gap-1 rounded-xl px-3 py-2 text-red-500 transition-transform hover:bg-red-500/10 active:scale-95"
            aria-label={m.common_delete_button()}
          >
            <Trash2 size={20} />
            <span class="text-2xs font-medium">{m.common_delete_button()}</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
