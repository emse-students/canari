<script lang="ts">
  import { EllipsisVertical, Info, Hash } from '@lucide/svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { parseEnvelope } from '$lib/envelope';
  import Modal from '../shared/Modal.svelte';
  import MessageEmojiPicker from './MessageEmojiPicker.svelte';
  import MessageMediaRenderer from './MessageMediaRenderer.svelte';
  import MessageEditForm from './MessageEditForm.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import MessageMobileActions from './MessageMobileActions.svelte';
  import MessageInfoTooltip from './MessageInfoTooltip.svelte';
  import MessageReplyQuote from './MessageReplyQuote.svelte';
  import MessageTextBody from './MessageTextBody.svelte';
  import MessageMetadata from './MessageMetadata.svelte';
  import MessageBubbleToolbar from './MessageBubbleToolbar.svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { onDestroy } from 'svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    splitTextWithLinks,
    extractFirstUrl,
    getBubbleShapeClass,
  } from '$lib/utils/chat/messageDisplay';

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
    /** When true, shows the delivery status indicator (sent/read) below the bubble. */
    isLastOwn?: boolean;
    /** When true, shows an "(modifié)" label. */
    isEdited?: boolean;
    /** When true, renders the content as struck-through italic and hides action buttons. */
    isDeleted?: boolean;
    /** Controls which corners of the bubble are rounded based on adjacent messages. */
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
    /** Called when the user triggers the reply action. */
    onReply?: (messageId: string) => void;
    /** Called when the user clicks a quoted reply to scroll to the original message. */
    onNavigateToMessage?: (messageId: string) => void;
    /** Called when the user selects an emoji reaction. */
    onReact?: (messageId: string, emoji: string) => void;
    /** Called when the user confirms message deletion. */
    onDelete?: (messageId: string) => void;
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
    status?: 'sending' | 'sent' | 'error';
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
    isEdited = false,
    isDeleted = false,
    groupPosition = 'single',
    onReply,
    onNavigateToMessage,
    onReact,
    onDelete,
    onEdit,
    currentUserId = '',
    authToken = '',
    shouldAnimate = false,
    isHighlighted = false,
    searchTerm = '',
    status,
  }: Props = $props();

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
  let pointerStartX = $state(0);
  let pointerStartY = $state(0);
  let swipeHandled = $state(false);

  let envelope = $derived(parseEnvelope(content));
  let effectiveSystem = $derived(isSystem || envelope.kind === 'system');
  let channelInvite = $derived(
    envelope.kind === 'system' ? (envelope.channelInvite ?? null) : null
  );
  let textContent = $derived(
    envelope.kind === 'text' || envelope.kind === 'system'
      ? envelope.text
      : (envelope.caption ?? '')
  );
  let effectiveReplyTo = $derived(
    replyTo ??
      (envelope.kind === 'text' || envelope.kind === 'media' ? envelope.replyTo : undefined)
  );
  let mediaRef = $derived(envelope.kind === 'media' ? envelope.media : null);
  // Image/video with no caption and no reply quote — render naked (no bubble background)
  const isMediaOnly = $derived(!!mediaRef && !textContent && !effectiveReplyTo && !isDeleted);
  let firstLink = $derived(!mediaRef && !isDeleted ? extractFirstUrl(textContent) : null);
  let textSegments = $derived(splitTextWithLinks(textContent));

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

  function openMobileActions(e: MouseEvent) {
    e.stopPropagation();
    showEmojiPicker = false;
    showInfo = false;
    showMobileActions = true;
  }

  function closeMobileActions() {
    showMobileActions = false;
  }

  function beginLongPress(e: PointerEvent) {
    pointerStartX = e.clientX;
    pointerStartY = e.clientY;
    swipeHandled = false;

    if (supportsHover || e.pointerType === 'mouse') return;
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      showMobileActions = true;
      showEmojiPicker = false;
      showInfo = false;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(10);
      }
    }, 420);
  }

  function handleSwipeReply(e: PointerEvent) {
    if (supportsHover || e.pointerType === 'mouse' || swipeHandled) return;
    if (isDeleted || !onReply) return;

    const deltaX = e.clientX - pointerStartX;
    const deltaY = Math.abs(e.clientY - pointerStartY);
    const towardCenter = isOwn ? deltaX < -72 : deltaX > 72;

    if (towardCenter && deltaY < 42) {
      swipeHandled = true;
      onReply(messageId);
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(12);
      }
      cancelLongPress();
    }
  }

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  $effect(() => {
    if (!mediaRef || !authToken) return;

    let destroyed = false;
    let urlToRevoke: string | null = null;
    loadError = false;
    mediaPurgedByRetention = false;

    const ref: MediaRef = mediaRef;
    const token: string = authToken;

    new MediaService()
      .downloadAndDecrypt(ref, token)
      .then((url) => {
        if (destroyed) {
          URL.revokeObjectURL(url);
        } else {
          blobUrl = url;
          urlToRevoke = url;
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
      if (urlToRevoke) {
        URL.revokeObjectURL(urlToRevoke);
      }
      blobUrl = null;
    };
  });

  onDestroy(() => {
    cancelLongPress();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
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
        Vous avez été invité à rejoindre ce canal chiffré.
      </p>
      <a
        href="/chat"
        class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-[#151B2C] hover:bg-amber-400 active:scale-95 transition-all shadow-sm shadow-amber-500/20"
      >
        <Hash size={12} strokeWidth={3} /> Rejoindre le canal
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
    id={`msg-${messageId}`}
    use:clickOutside={{
      enabled: showEmojiPicker || showInfo || showMobileActions,
      callback: () => {
        showEmojiPicker = false;
        showInfo = false;
        showMobileActions = false;
      },
    }}
    class="relative group"
  >
    <!-- Bouton Mobile (Ellipsis) -->
    <button
      type="button"
      onclick={openMobileActions}
      class="absolute top-1/2 -translate-y-1/2 {isOwn
        ? 'right-full mr-2'
        : 'left-full ml-2'} md:hidden z-10 p-1.5 rounded-full bg-white/80 dark:bg-black/60 border border-black/5 dark:border-white/10 text-text-muted backdrop-blur-sm shadow-sm"
      aria-label="Ouvrir les actions du message"
    >
      <EllipsisVertical size={16} />
    </button>

    <!-- Bulle de message principale -->
    <div
      role="button"
      tabindex="0"
      onclick={handleBubbleClick}
      onpointerdown={beginLongPress}
      onpointermove={handleSwipeReply}
      onpointerup={cancelLongPress}
      onpointerleave={cancelLongPress}
      onpointercancel={cancelLongPress}
      oncontextmenu={(e) => {
        e.preventDefault();
        showMobileActions = true;
      }}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleInfo(e as unknown as MouseEvent);
        }
      }}
      class="{isMediaOnly ? 'p-0' : 'px-4 py-2.5'} cursor-pointer min-w-0 {isMediaOnly
        ? ''
        : getBubbleShapeClass(groupPosition, isOwn)} transition-shadow duration-200
      {isMediaOnly
        ? ''
        : isOwn
          ? 'bg-gradient-to-br from-amber-400 to-amber-500 text-cn-dark shadow-md shadow-amber-500/20 hover:shadow-lg hover:shadow-amber-500/30'
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

      <MessageMetadata {isEdited} {isOwn} {isLastOwn} {status} {readBy} {readAt} />
    </div>

    <MessageBubbleToolbar
      {isOwn}
      {isDeleted}
      hasMedia={!!mediaRef}
      {showEmojiPicker}
      onReply={onReply ? () => onReply!(messageId) : undefined}
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
    />

    <MessageReactions
      {groupedReactions}
      {isOwn}
      {currentUserId}
      onReact={(emoji) => onReact?.(messageId, emoji)}
    />

    <MessageEmojiPicker
      visible={showEmojiPicker}
      {isOwn}
      onEmojiSelect={(emoji) => onReact?.(messageId, emoji)}
    />

    <MessageInfoTooltip visible={showInfo} {timestamp} {editedAt} {readBy} {isOwn} {isEdited} />

    <MessageMobileActions
      visible={showMobileActions}
      {isOwn}
      {isDeleted}
      hasMedia={!!mediaRef}
      onReply={() => onReply?.(messageId)}
      onReact={() => (showEmojiPicker = true)}
      onEdit={startInlineEdit}
      onDelete={() => (showDeleteModal = true)}
      onClose={closeMobileActions}
    />
  </div>

  <Modal
    open={showDeleteModal}
    title="Supprimer le message"
    onClose={() => (showDeleteModal = false)}
  >
    <p class="text-sm text-text-muted leading-relaxed">
      Supprimer définitivement ce message ? Cette action est irréversible.
    </p>
    {#snippet footer()}
      <button
        onclick={() => (showDeleteModal = false)}
        class="px-4 py-2.5 text-sm font-semibold rounded-xl text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        Annuler
      </button>
      <button
        onclick={confirmDelete}
        class="px-4 py-2.5 text-sm rounded-xl bg-red-500 text-white font-bold hover:bg-red-600 hover:-translate-y-0.5 shadow-md shadow-red-500/20 transition-all"
      >
        Supprimer
      </button>
    {/snippet}
  </Modal>
{/if}
