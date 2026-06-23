<script lang="ts">
  import { CornerDownRight, Info, Hash } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { parseEnvelope } from '$lib/envelope';
  import Modal from '../shared/Modal.svelte';
  import MessageEmojiPicker from './MessageEmojiPicker.svelte';
  import MessageMediaRenderer from './MessageMediaRenderer.svelte';
  import ChannelPoll from '../channels/ChannelPoll.svelte';
  import { getPollMeta } from '$lib/stores/pollStore.svelte';
  import type { ChannelPollMeta } from '$lib/services/ChannelService';
  import MessageEditForm from './MessageEditForm.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import MessageInfoTooltip from './MessageInfoTooltip.svelte';
  import MessageReplyQuote from './MessageReplyQuote.svelte';
  import MessageTextBody from './MessageTextBody.svelte';
  import MessageMetadata from './MessageMetadata.svelte';
  import MessageBubbleToolbar from './MessageBubbleToolbar.svelte';
  import MessageMobileActions from './MessageMobileActions.svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { settings } from '$lib/stores/settingsStore.svelte';
  import { onDestroy } from 'svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    splitTextWithLinks,
    extractFirstUrl,
    getBubbleShapeClass,
    isGifUrl,
  } from '$lib/utils/chat/messageDisplay';
  import {
    createReplySwipeGesture,
    replySwipeDragOffset,
    reactionSwipeDragOffset,
    replySwipeProgress,
    shouldTriggerReplySwipe,
    shouldTriggerReactionSwipe,
    updateReplySwipeGesture,
    type ReplySwipeGestureState,
  } from '$lib/utils/messageSwipeReply';

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Props {
    /** Unique identifier of the message, used as the DOM anchor for scroll navigation. */
    messageId: string;
    /** User ID of the message author, used to resolve display names and profile links. */
    senderId: string;
    /** Raw encrypted/serialised envelope content of the message. */
    content: string;
    /** Send time of the message. */
    timestamp: Date;
    /** Last edit time, shown in the info tooltip when isEdited is true. */
    editedAt?: Date;
    /** When true, renders the amber bubble variant and enables edit/delete controls. */
    isOwn: boolean;
    /** When true, renders the message as a system notification pill instead of a bubble. */
    isSystem?: boolean;
    /** The message this bubble is replying to, shown as a quote above the content. */
    replyTo?: {
      id: string;
      senderId: string;
      content: string;
    };
    /** Emoji reactions attached to this message. */
    reactions?: MessageReaction[];
    /** User IDs who have read the message, shown in the info tooltip. */
    readBy?: string[];
    /** Timestamp of first read receipt (Date.now() on receiving device). */
    readAt?: number;
    /** When true, shows send status on the last own message. */
    isLastOwn?: boolean;
    /** When true, shows the read receipt below this message. */
    isReadReceiptAnchor?: boolean;
    /** When true, shows an "(modifié)" label. */
    isEdited?: boolean;
    /** When true, renders the content as struck-through italic and hides action buttons. */
    isDeleted?: boolean;
    /** Controls which corners of the bubble are rounded based on adjacent messages. */
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
    /** Called when the user triggers the reply action. */
    onReply?: (messageId: string) => void;
    /** Called when the user triggers the forward action. */
    onForward?: (messageId: string) => void;
    /** Called when the user clicks a quoted reply to scroll to the original message. */
    onNavigateToMessage?: (messageId: string) => void;
    /** Called when the user selects an emoji reaction. */
    onReact?: (messageId: string, emoji: string) => void;
    /** Called when the user votes on a poll message (channels only). */
    onVotePoll?: (messageId: string, optionIds: string[]) => void;
    /** Called when the user confirms message deletion. */
    onDelete?: (messageId: string) => void;
    /** Whether this message is currently pinned in the conversation. */
    pinned?: boolean;
    /** Called to toggle this message's pinned state. Omit to hide the pin action. */
    onTogglePin?: (messageId: string) => void;
    /** Called when the user confirms an inline edit. */
    onEdit?: (messageId: string, newText: string) => void;
    /** ID of the authenticated user, used to highlight own reactions and gate edit/delete. */
    currentUserId?: string;
    /** Bearer token forwarded to MediaService for downloading and decrypting attachments. */
    authToken?: string;
    /** When true, applies the rise-in entrance animation to the bubble. */
    shouldAnimate?: boolean;
    /** When true, pulses a ring around the bubble to highlight it as the search result. */
    isHighlighted?: boolean;
    /** Active search term for in-message text highlighting. */
    searchTerm?: string;
    /** Delivery status of an outbound message; controls the status indicator icon. */
    status?: 'pending' | 'sending' | 'sent' | 'error';
    /** When true, enables mobile-specific interactions: long press toolbar, double-tap heart. */
    isMobile?: boolean;
  }

  let {
    messageId,
    senderId: _senderId,
    content,
    timestamp,
    editedAt,
    isOwn,
    isSystem = false,
    replyTo,
    reactions = [],
    readBy = [],
    readAt,
    isLastOwn = false,
    isReadReceiptAnchor = false,
    isEdited = false,
    isDeleted = false,
    groupPosition = 'single',
    onReply,
    onForward,
    onNavigateToMessage,
    onReact,
    onVotePoll,
    onDelete,
    onEdit,
    pinned = false,
    onTogglePin,
    currentUserId = '',
    authToken = '',
    shouldAnimate = false,
    isHighlighted = false,
    searchTerm = '',
    status,
    isMobile = false,
  }: Props = $props();

  let bubbleAnchor = $state<HTMLElement | null>(null);
  let showEmojiPicker = $state(false);
  let showInfo = $state(false);
  let showMobileActions = $state(false);
  let showDeleteModal = $state(false);
  let isEditingInline = $state(false);
  let editText = $state('');
  let blobUrl = $state<string | null>(null);
  let loadError = $state(false);
  let mediaPurgedByRetention = $state(false);
  let supportsHover = $state(true);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let lastTapTime = 0;
  let pointerStartX = $state(0);
  let pointerStartY = $state(0);
  let swipeHandled = $state(false);
  let replyGesture = $state<ReplySwipeGestureState | null>(null);
  let replyDragPx = $state(0);
  let reactDragPx = $state(0);
  let showQuickReactions = $state(false);

  let envelope = $derived(parseEnvelope(content));
  let effectiveSystem = $derived(isSystem || envelope.kind === 'system');
  let channelInvite = $derived(
    envelope.kind === 'system' ? (envelope.channelInvite ?? null) : null
  );
  let textContent = $derived(
    envelope.kind === 'text' || envelope.kind === 'system'
      ? envelope.text
      : envelope.kind === 'media'
        ? (envelope.caption ?? '')
        : ''
  );
  let effectiveReplyTo = $derived(
    replyTo ??
      (envelope.kind === 'text' || envelope.kind === 'media' ? envelope.replyTo : undefined)
  );
  let mediaRef = $derived(envelope.kind === 'media' ? envelope.media : null);
  // Image/video with no caption and no reply quote - render naked (no bubble background)
  const isMediaOnly = $derived(!!mediaRef && !textContent && !effectiveReplyTo && !isDeleted);

  // Poll message: rendered as a self-contained card (no bubble chrome). The live
  // tally comes from the poll store (keyed by message id); falls back to an empty
  // tally derived from the envelope until the server state arrives.
  let pollEnvelope = $derived(envelope.kind === 'poll' && !isDeleted ? envelope : null);
  const isPollOnly = $derived(!!pollEnvelope);
  let pollSpec = $derived(
    pollEnvelope
      ? {
          kind: 'poll' as const,
          question: pollEnvelope.question,
          options: pollEnvelope.options,
          multipleChoice: pollEnvelope.multipleChoice,
          endsAt: pollEnvelope.endsAt,
        }
      : null
  );
  let pollMeta = $derived.by<ChannelPollMeta | null>(() => {
    if (!pollEnvelope) return null;
    return (
      getPollMeta(messageId) ?? {
        optionIds: pollEnvelope.options.map((o) => o.id),
        multipleChoice: pollEnvelope.multipleChoice,
        endsAt: pollEnvelope.endsAt,
        votesByUser: {},
      }
    );
  });
  let firstLink = $derived(!mediaRef && !isDeleted ? extractFirstUrl(textContent) : null);
  let textSegments = $derived(splitTextWithLinks(textContent));
  // Link-only message (no surrounding text, no reply, not a GIF) - also renders naked
  const isLinkOnly = $derived.by(() => {
    if (!firstLink || isGifUrl(firstLink) || effectiveReplyTo) return false;
    return textSegments.every((s) => s.type === 'link' || (s.type === 'text' && s.value.trim() === ''));
  });
  // GIF-only message (no surrounding text, no reply) - renders naked like an image/media,
  // so the GIF n'a pas de cadre de bulle autour de lui.
  const isGifOnly = $derived.by(() => {
    if (!firstLink || !isGifUrl(firstLink) || effectiveReplyTo || isDeleted) return false;
    return textSegments.every((s) => s.type === 'link' || (s.type === 'text' && s.value.trim() === ''));
  });

  let replySenderDisplayName = $state('');
  $effect(() => {
    const sid = effectiveReplyTo?.senderId;
    if (!sid) {
      replySenderDisplayName = '';
      return;
    }
    replySenderDisplayName = getUserDisplayNameSync(sid, sid);
    resolveUserDisplayName(sid).then((resolved) => {
      if (resolved && effectiveReplyTo?.senderId === sid) replySenderDisplayName = resolved;
    });
  });

  const groupedReactions = $derived(
    reactions.reduce(
      (acc, reaction) => {
        if (!acc[reaction.emoji]) acc[reaction.emoji] = [];
        acc[reaction.emoji].push(reaction.userId);
        return acc;
      },
      {} as Record<string, string[]>
    )
  );

  const userOwnReactions = $derived(
    reactions.filter((r) => r.userId === currentUserId).map((r) => r.emoji)
  );

  function confirmEdit() {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== textContent.trim()) {
      onEdit?.(messageId, trimmed);
    }
    isEditingInline = false;
    showInfo = false;
  }

  function startInlineEdit() {
    editText = textContent;
    isEditingInline = true;
    showEmojiPicker = false;
    showInfo = false;
    showMobileActions = false;
  }

  function cancelInlineEdit() {
    isEditingInline = false;
    editText = textContent;
  }

  function handleBubbleClick(e: MouseEvent) {
    if (isEditingInline) {
      e.stopPropagation();
      return;
    }

    // Double-tap on mobile: react with ❤️ instead of toggling info
    if (isMobile && !isDeleted && onReact) {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        lastTapTime = 0;
        showInfo = false;
        onReact(messageId, '❤️');
        if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(12);
        }
        return;
      }
      lastTapTime = now;
    }

    toggleInfo(e);
  }

  function confirmDelete() {
    onDelete?.(messageId);
    showDeleteModal = false;
  }

  function toggleInfo(e: MouseEvent) {
    e.stopPropagation();
    showEmojiPicker = false;
    showInfo = !showInfo;
  }

  function canSwipeReply(pointerType?: string): boolean {
    if (supportsHover || pointerType === 'mouse') return false;
    if (isDeleted || effectiveSystem || !onReply) return false;
    return true;
  }

  function pointerCoords(e: PointerEvent | TouchEvent): { x: number; y: number } {
    if ('touches' in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if ('changedTouches' in e && e.changedTouches.length > 0) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    const pe = e as PointerEvent;
    return { x: pe.clientX, y: pe.clientY };
  }

  function beginLongPress(e: PointerEvent | TouchEvent) {
    const { x, y } = pointerCoords(e);
    pointerStartX = x;
    pointerStartY = y;
    swipeHandled = false;
    replyDragPx = 0;

    const pointerType = 'pointerType' in e ? e.pointerType : 'touch';

    // Long press: arm on any non-mouse touch event on mobile
    if (pointerType !== 'mouse' && isMobile) {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        if (replyGesture?.phase === 'horizontal') return;
        showMobileActions = true;
        showEmojiPicker = false;
        showInfo = false;
        if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(10);
        }
      }, 420);
    }

    if (!canSwipeReply(pointerType)) return;
    replyGesture = createReplySwipeGesture(x, y);
  }

  function handleSwipeReply(e: PointerEvent | TouchEvent) {
    const pointerType = 'pointerType' in e ? e.pointerType : 'touch';
    if (!canSwipeReply(pointerType) || swipeHandled || !replyGesture) return;

    const { x, y } = pointerCoords(e);
    const updated = updateReplySwipeGesture(replyGesture, x, y);
    replyGesture = updated;

    if (updated.phase === 'horizontal') {
      if ('touches' in e) e.stopPropagation();
      const dx = x - updated.startX;
      const replyOffset = replySwipeDragOffset(dx, isOwn);
      const reactOffset = reactionSwipeDragOffset(dx, isOwn);
      replyDragPx = replyOffset ?? 0;
      reactDragPx = reactOffset ?? 0;
      cancelLongPress();
      return;
    }

    if (Math.abs(x - pointerStartX) > 12 || Math.abs(y - pointerStartY) > 12) {
      cancelLongPress();
    }
  }

  function endSwipeReply(e: PointerEvent | TouchEvent) {
    cancelLongPress();
    if (!replyGesture || swipeHandled) {
      replyGesture = null;
      replyDragPx = 0;
      return;
    }

    const { x, y } = pointerCoords(e);
    const dx = x - replyGesture.startX;
    const dy = y - replyGesture.startY;

    if (shouldTriggerReplySwipe(dx, dy, isOwn, replyGesture.phase)) {
      swipeHandled = true;
      onReply?.(messageId);
      if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(12);
      }
    } else if (shouldTriggerReactionSwipe(dx, dy, isOwn, replyGesture.phase) && onReact) {
      swipeHandled = true;
      showQuickReactions = true;
      if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(12);
      }
    }

    replyGesture = null;
    replyDragPx = 0;
    reactDragPx = 0;
  }

  /** Non-passive `touchmove` so horizontal reply swipes do not bubble to tab navigation. */
  function replySwipeTouchMove(node: HTMLElement) {
    const onMove = (e: TouchEvent) => handleSwipeReply(e);
    node.addEventListener('touchmove', onMove, { passive: false });
    return {
      destroy() {
        node.removeEventListener('touchmove', onMove);
      },
    };
  }

  let replyHintOpacity = $derived(replySwipeProgress(replyDragPx, isOwn));

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  $effect(() => {
    // Empty mediaId = media still queued in the outbox (upload pending): leave blobUrl null
    // so MessageMediaRenderer shows its skeleton/spinner. Don't attempt a download (would 404).
    if (!mediaRef || !mediaRef.mediaId || !authToken) return;

    let destroyed = false;
    let acquired = false;
    loadError = false;
    mediaPurgedByRetention = false;

    const ref: MediaRef = mediaRef;
    const token: string = authToken;

    new MediaService()
      .downloadAndDecrypt(ref, token)
      .then((url) => {
        if (destroyed) {
          releaseDecryptedMediaBlobUrl(ref);
        } else {
          blobUrl = url;
          acquired = true;
        }
      })
      .catch((error) => {
        if (!destroyed) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('MEDIA_PURGED_BY_RETENTION')) {
            mediaPurgedByRetention = true;
          } else {
            loadError = true;
          }
        }
      });

    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(ref);
      acquired = false;
      blobUrl = null;
    };
  });

  onDestroy(() => {
    cancelLongPress();
  });
</script>

{#if effectiveSystem}
  {#if channelInvite}
    <!-- Channel invite card with Join button -->
    <div
      class="inline-flex flex-col gap-2.5 px-4 py-3 rounded-2xl max-w-xs border border-amber-500/20 bg-amber-500/5 dark:bg-amber-500/10 backdrop-blur-md shadow-sm {shouldAnimate
        ? 'animate-rise-in'
        : ''}"
    >
      <div class="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <Hash size={15} strokeWidth={2.5} class="flex-shrink-0" />
        <span class="text-xs font-bold truncate">{channelInvite.channelName}</span>
        {#if channelInvite.workspaceName}
          <span class="text-xs text-text-muted font-medium truncate"
            >· {channelInvite.workspaceName}</span
          >
        {/if}
      </div>
      <p class="text-xs text-text-muted leading-relaxed">
        {m.msg_channel_invite_description()}
      </p>
      <a
        href="/chat"
        class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all shadow-sm shadow-amber-500/20"
      >
        <Hash size={12} strokeWidth={3} /> {m.msg_channel_invite_join_button()}
      </a>
    </div>
  {:else}
    <div
      class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium text-text-muted text-center max-w-md border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 backdrop-blur-md shadow-sm {shouldAnimate
        ? 'animate-rise-in'
        : ''}"
    >
      <Info size={14} class="flex-shrink-0 opacity-60" />
      <span>{textContent}</span>
    </div>
  {/if}
{:else}
  <div
    bind:this={bubbleAnchor}
    id={`msg-${messageId}`}
    use:clickOutside={{
      enabled: showEmojiPicker || showInfo || showMobileActions,
      callback: () => {
        showEmojiPicker = false;
        showInfo = false;
        showMobileActions = false;
      },
    }}
    class="group relative flex max-w-full flex-col {isOwn ? 'items-end' : 'items-start'}"
  >
    <div class="relative w-fit max-w-full">
      {#if replyDragPx !== 0 && onReply}
        <div
          class="pointer-events-none absolute top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-amber-400/90 text-cn-ink shadow-md transition-opacity
          {isOwn ? 'right-full mr-1.5' : 'left-full ml-1.5'}"
          style:opacity={replyHintOpacity}
          aria-hidden="true"
        >
          <CornerDownRight size={18} class={isOwn ? 'rotate-180' : ''} />
        </div>
      {/if}

      {#if reactDragPx !== 0 && onReact}
        <div
          class="pointer-events-none absolute top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 dark:bg-black/60 shadow-md transition-opacity
          {isOwn ? 'left-full ml-1.5' : 'right-full mr-1.5'}"
          style:opacity={Math.min(1, Math.abs(reactDragPx) / 56)}
          aria-hidden="true"
        >
          😊
        </div>
      {/if}

      <!-- Bulle de message principale -->
      <div
        role="button"
        tabindex="0"
        data-swipe-reply
        data-swipe-nav-ignore
        use:replySwipeTouchMove
        onclick={handleBubbleClick}
        onpointerdown={beginLongPress}
        onpointermove={handleSwipeReply}
        onpointerup={endSwipeReply}
        onpointerleave={endSwipeReply}
        onpointercancel={endSwipeReply}
        ontouchstart={beginLongPress}
        ontouchend={endSwipeReply}
        ontouchcancel={endSwipeReply}
        oncontextmenu={(e) => {
          e.preventDefault();
          showMobileActions = true;
        }}
        onkeydown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !isEditingInline) {
            e.preventDefault();
            toggleInfo(e as unknown as MouseEvent);
          }
        }}
        style:transform={replyDragPx !== 0 || reactDragPx !== 0 ? `translate3d(${replyDragPx + reactDragPx}px, 0, 0)` : undefined}
        class="{isMediaOnly || isLinkOnly || isGifOnly || isPollOnly
          ? 'p-0'
          : 'px-4 py-2.5'} w-fit max-w-full cursor-pointer touch-pan-y {isMobile
          ? 'select-none [-webkit-touch-callout:none] [-webkit-user-select:none]'
          : ''} {isMediaOnly || isLinkOnly || isGifOnly || isPollOnly
          ? ''
          : getBubbleShapeClass(groupPosition, isOwn)} {replyDragPx !== 0
          ? 'message-swipe-reply-active'
          : 'transition-shadow duration-200'}
        {isMediaOnly || isLinkOnly || isGifOnly || isPollOnly
          ? ''
          : isOwn
            ? 'bg-gradient-to-br from-amber-400 to-amber-500 text-cn-ink shadow-md shadow-amber-500/20 hover:shadow-lg hover:shadow-amber-500/30'
            : 'bg-white/70 dark:bg-black/40 backdrop-blur-xl border border-black/5 dark:border-white/10 text-text-main shadow-sm hover:shadow-md'}
        {isHighlighted
          ? 'ring-2 ring-amber-500/80 ring-offset-2 ring-offset-transparent animate-pulse'
          : ''}
        {shouldAnimate ? 'animate-rise-in' : ''}"
      >
        {#if effectiveReplyTo}
          <MessageReplyQuote
            replyId={effectiveReplyTo.id}
            senderId={effectiveReplyTo.senderId}
            displayName={replySenderDisplayName}
            content={effectiveReplyTo.content}
            {onNavigateToMessage}
          />
        {/if}

        {#if pollEnvelope && pollSpec && pollMeta}
          <ChannelPoll
            spec={pollSpec}
            meta={pollMeta}
            {currentUserId}
            onVote={(optionIds) => onVotePoll?.(messageId, optionIds)}
          />
        {:else}
          <MessageMediaRenderer
            {mediaRef}
            {blobUrl}
            {loadError}
            {mediaPurgedByRetention}
            {textContent}
            {isOwn}
            {textSegments}
          />

          {#if !mediaRef}
            <MessageEditForm
              editing={!!(isEditingInline && !isDeleted && isOwn && !mediaRef && onEdit)}
              {editText}
              onEditChange={(text) => (editText = text)}
              onConfirm={confirmEdit}
              onCancel={cancelInlineEdit}
            />

            {#if !isEditingInline}
              <MessageTextBody {textSegments} {searchTerm} {isDeleted} {firstLink} />
            {/if}
          {/if}
        {/if}

        <MessageMetadata
          {isEdited}
          {isOwn}
          {isLastOwn}
          isReadReceiptAnchor={false}
          {status}
          {readBy}
          {readAt}
          {timestamp}
          {groupPosition}
        />
      </div>

      <MessageBubbleToolbar
        {isOwn}
        {isDeleted}
        hasMedia={!!mediaRef}
        {showEmojiPicker}
        forceVisible={showMobileActions && isMobile}
        onReply={onReply ? () => onReply!(messageId) : undefined}
        onForward={onForward ? () => onForward!(messageId) : undefined}
        onReact={onReact ? (emoji) => onReact!(messageId, emoji) : undefined}
        userReactions={userOwnReactions}
        onToggleEmojiPicker={onReact
          ? () => {
              showEmojiPicker = !showEmojiPicker;
            }
          : undefined}
        onEdit={!isDeleted && isOwn && !mediaRef && onEdit ? startInlineEdit : undefined}
        onDelete={!isDeleted && isOwn && onDelete
          ? () => {
              showDeleteModal = true;
            }
          : undefined}
        {pinned}
        onPin={!isDeleted && onTogglePin ? () => onTogglePin!(messageId) : undefined}
      />
    </div>

    <MessageReactions
      {groupedReactions}
      {isOwn}
      {currentUserId}
      onReact={(emoji) => onReact?.(messageId, emoji)}
    />

    <MessageMetadata
      {isEdited}
      {isOwn}
      {isLastOwn}
      {isReadReceiptAnchor}
      {status}
      {readBy}
      {readAt}
      outsideBubble
    />

    <MessageEmojiPicker
      visible={showEmojiPicker}
      {isOwn}
      anchor={bubbleAnchor}
      existingReactionEmojis={Object.keys(groupedReactions)}
      onEmojiSelect={(emoji) => onReact?.(messageId, emoji)}
    />

    {#if showQuickReactions && onReact}
      <div
        class="absolute z-30 flex items-center gap-1 rounded-2xl border border-black/8 dark:border-white/10 bg-white/95 dark:bg-[#1a1f2e]/95 backdrop-blur-xl shadow-lg px-2 py-1.5
          {isOwn ? 'right-0 bottom-full mb-2' : 'left-0 bottom-full mb-2'}"
        use:clickOutside={() => (showQuickReactions = false)}
      >
        {#each ['❤️', '😂', '😮', '😢', '👍', '👎'] as emoji (emoji)}
          <button
            type="button"
            onclick={() => {
              onReact(messageId, emoji);
              showQuickReactions = false;
              if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
                navigator.vibrate(12);
              }
            }}
            class="text-xl leading-none px-1 py-0.5 rounded-xl hover:bg-black/8 dark:hover:bg-white/10 active:scale-125 transition-all"
          >{emoji}</button>
        {/each}
      </div>
    {/if}

    <MessageInfoTooltip visible={showInfo} {timestamp} {editedAt} {readBy} {isOwn} {isEdited} />

    <MessageMobileActions
      visible={showMobileActions && isMobile}
      {isOwn}
      {isDeleted}
      hasMedia={!!mediaRef}
      userReactions={userOwnReactions}
      onReactEmoji={(emoji) => {
        onReact?.(messageId, emoji);
        showMobileActions = false;
        if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(12);
        }
      }}
      onOpenFullPicker={() => {
        showMobileActions = false;
        showEmojiPicker = true;
      }}
      onReply={onReply && !isDeleted ? () => { onReply!(messageId); showMobileActions = false; } : undefined}
      onForward={onForward && !isDeleted ? () => onForward!(messageId) : undefined}
      {pinned}
      onPin={!isDeleted && onTogglePin ? () => { onTogglePin!(messageId); showMobileActions = false; } : undefined}
      onCopy={textContent && !isDeleted
        ? () => {
            navigator.clipboard?.writeText(textContent);
            showMobileActions = false;
            if (settings.vibrationsEnabled && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
              navigator.vibrate(8);
            }
          }
        : undefined}
      onEdit={!isDeleted && isOwn && !mediaRef && onEdit ? () => { startInlineEdit(); showMobileActions = false; } : undefined}
      onDelete={!isDeleted && isOwn && onDelete ? () => { showDeleteModal = true; showMobileActions = false; } : undefined}
      onClose={() => { showMobileActions = false; }}
    />
  </div>

  <Modal
    open={showDeleteModal}
    title={m.msg_supprimer_message()}
    onClose={() => (showDeleteModal = false)}
  >
    <p class="text-sm text-text-muted leading-relaxed">
      {m.msg_supprimer_definitif()}
    </p>
    {#snippet footer()}
      <button
        onclick={() => (showDeleteModal = false)}
        class="px-4 py-2.5 text-sm font-semibold rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {m.common_cancel_button()}
      </button>
      <button
        onclick={confirmDelete}
        class="px-4 py-2.5 text-sm rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 hover:-translate-y-0.5 shadow-md shadow-red-500/20 transition-all"
      >
        {m.common_delete_button()}
      </button>
    {/snippet}
  </Modal>
{/if}
