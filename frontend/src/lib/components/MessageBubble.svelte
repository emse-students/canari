<script lang="ts">
  import { Reply, Smile, Pencil, Trash2, EllipsisVertical } from 'lucide-svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { parseEnvelope } from '$lib/envelope';
  import Modal from './Modal.svelte';
  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import MessageEmojiPicker from './MessageEmojiPicker.svelte';
  import MessageMediaRenderer from './MessageMediaRenderer.svelte';
  import MessageEditForm from './MessageEditForm.svelte';
  import MessageReactions from './MessageReactions.svelte';
  import MessageMobileActions from './MessageMobileActions.svelte';
  import MessageInfoTooltip from './MessageInfoTooltip.svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { onDestroy } from 'svelte';

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Props {
    messageId: string;
    senderId: string;
    content: string;
    timestamp: Date;
    editedAt?: Date;
    isOwn: boolean;
    isSystem?: boolean;
    replyTo?: {
      id: string;
      senderId: string;
      content: string;
    };
    reactions?: MessageReaction[];
    readBy?: string[];
    isEdited?: boolean;
    isDeleted?: boolean;
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
    onReply?: (messageId: string) => void;
    onNavigateToMessage?: (messageId: string) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    authToken?: string;
    shouldAnimate?: boolean;
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
    isEdited = false,
    isDeleted = false,
    groupPosition = 'single',
    onReply,
    onNavigateToMessage,
    onReact,
    onDelete,
    onEdit,
    authToken = '',
    shouldAnimate = false,
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
  let firstLink = $derived(!mediaRef && !isDeleted ? extractFirstUrl(textContent) : null);

  let replyPreviewText = $derived(shortenReplyPreview(effectiveReplyTo?.content ?? ''));
  let textSegments = $derived(splitTextWithLinks(textContent));

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

  function shortenReplyPreview(text: string): string {
    if (!text) return '';
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= 84) return normalized;
    return `${normalized.slice(0, 81)}...`;
  }

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

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match?.[0] ?? null;
  }

  function splitTextWithLinks(text: string): Array<{ type: 'text' | 'link'; value: string }> {
    const regex = /https?:\/\/[^\s]+/gi;
    const segments: Array<{ type: 'text' | 'link'; value: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'link', value: match[0] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      segments.push({ type: 'text', value: text.slice(lastIndex) });
    }

    if (segments.length === 0) {
      segments.push({ type: 'text', value: text });
    }

    return segments;
  }

  function getBubbleShapeClass(position: 'single' | 'start' | 'middle' | 'end') {
    if (position === 'single') return 'rounded-[1.25rem]';

    if (isOwn) {
      if (position === 'start') return 'rounded-[1.25rem] rounded-br-md';
      if (position === 'middle') return 'rounded-[1.25rem] rounded-tr-md rounded-br-md';
      return 'rounded-[1.25rem] rounded-tr-md';
    }

    if (position === 'start') return 'rounded-[1.25rem] rounded-bl-md';
    if (position === 'middle') return 'rounded-[1.25rem] rounded-tl-md rounded-bl-md';
    return 'rounded-[1.25rem] rounded-tl-md';
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
  <div
    class="px-4 py-1.5 bg-cn-bg rounded-full text-xs text-text-muted text-center max-w-md {shouldAnimate
      ? 'animate-rise-in'
      : ''}"
  >
    {textContent}
  </div>
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
    <button
      type="button"
      onclick={openMobileActions}
      class="absolute top-1/2 -translate-y-1/2 {isOwn
        ? 'right-full mr-2'
        : 'left-full ml-2'} md:hidden z-10 p-1.5 rounded-full bg-white/85 dark:bg-black/40 border border-white/60 dark:border-white/10 text-gray-500 dark:text-gray-300"
      aria-label="Ouvrir les actions du message"
    >
      <EllipsisVertical size={14} />
    </button>

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
      class="px-4 py-2.5 cursor-pointer min-w-0 {getBubbleShapeClass(groupPosition)} {isOwn
        ? 'bg-gradient-to-br from-amber-400 to-amber-500 text-white shadow-md shadow-amber-500/20'
        : 'backdrop-blur-sm bg-white/80 dark:bg-gray-700/80 shadow-sm rounded-2xl text-cn-dark border border-white/55 dark:border-white/10'} {shouldAnimate
        ? 'animate-rise-in'
        : ''}"
    >
      {#if effectiveReplyTo}
        <button
          type="button"
          class="mb-2 pb-2 border-l-4 border-gray-400 pl-3 text-xs opacity-80 text-left w-full hover:opacity-100 transition-opacity"
          onclick={(e) => {
            e.stopPropagation();
            if (effectiveReplyTo.id) {
              onNavigateToMessage?.(effectiveReplyTo.id);
            }
          }}
          title="Aller au message cite"
          aria-label="Aller au message cite"
        >
          <div class="font-semibold truncate">{effectiveReplyTo.senderId}</div>
          <div class="truncate">{replyPreviewText}</div>
        </button>
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
          <p
            class="text-base leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] {isDeleted
              ? 'italic text-gray-500'
              : ''}"
          >
            {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
              {#if segment.type === 'link'}
                <a
                  href={segment.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline underline-offset-2 decoration-current hover:opacity-80"
                  onclick={(e) => e.stopPropagation()}
                >
                  {segment.value}
                </a>
              {:else}
                {segment.value}
              {/if}
            {/each}
          </p>
          {#if firstLink}
            <LinkPreviewCard url={firstLink} />
          {/if}
        {/if}
      {/if}

      {#if isEdited || (isOwn && readBy.length > 0)}
        <div class="flex items-center justify-end gap-1 mt-1">
          {#if isEdited}
            <span class="italic text-[0.6rem] opacity-60">(modifié)</span>
          {/if}
        </div>
      {/if}
    </div>

    <div
      class="absolute top-1/2 -translate-y-1/2 {isOwn
        ? 'right-full mr-2'
        : 'left-full ml-2'} opacity-0 {showEmojiPicker
        ? 'opacity-100'
        : 'group-hover:opacity-100'} transition-opacity hidden md:flex flex-row items-center gap-1 rounded-full bg-[var(--cn-surface)]/95 border border-cn-border shadow-sm px-1.5 py-1 z-10"
    >
      {#if !isDeleted && onReply}
        <button
          onclick={() => onReply?.(messageId)}
          class="p-1.5 rounded-full hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700"
          aria-label="Répondre"
        >
          <Reply size={15} />
        </button>
      {/if}
      {#if onReact}
        <button
          onclick={(e) => {
            e.stopPropagation();
            showEmojiPicker = !showEmojiPicker;
          }}
          class="p-1.5 rounded-full hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700"
          aria-label="Réagir"
        >
          <Smile size={15} />
        </button>
      {/if}
      {#if !isDeleted && isOwn && !mediaRef && onEdit}
        <button
          onclick={(e) => {
            e.stopPropagation();
            startInlineEdit();
          }}
          class="p-1.5 rounded-full hover:bg-gray-200 transition-colors text-gray-400 hover:text-gray-700"
          aria-label="Modifier"
        >
          <Pencil size={15} />
        </button>
      {/if}
      {#if !isDeleted && isOwn && onDelete}
        <button
          onclick={(e) => {
            e.stopPropagation();
            showDeleteModal = true;
          }}
          class="p-1.5 rounded-full hover:bg-gray-200 transition-colors text-red-400 hover:text-red-600"
          aria-label="Supprimer"
        >
          <Trash2 size={15} />
        </button>
      {/if}
    </div>

    <MessageReactions
      {groupedReactions}
      {isOwn}
      onReactionClick={(emoji) => onReact?.(messageId, emoji)}
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
    <p class="text-sm text-gray-600">
      Supprimer définitivement ce message ? Cette action est irréversible.
    </p>
    {#snippet footer()}
      <button
        onclick={() => (showDeleteModal = false)}
        class="px-4 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
      >
        Annuler
      </button>
      <button
        onclick={confirmDelete}
        class="px-4 py-2 text-sm rounded-lg bg-red-500 text-white font-medium hover:bg-red-600 transition-colors"
      >
        Supprimer
      </button>
    {/snippet}
  </Modal>
{/if}
