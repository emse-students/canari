<script lang="ts">
  import {
    Reply,
    Smile,
    Pencil,
    Trash2,
    EllipsisVertical,
    CheckCheck,
    Check,
    Info,
    LoaderCircle,
    TriangleAlert,
  } from 'lucide-svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { parseEnvelope } from '$lib/envelope';
  import Modal from '../shared/Modal.svelte';
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
    isLastOwn?: boolean;
    isEdited?: boolean;
    isDeleted?: boolean;
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
    onReply?: (messageId: string) => void;
    onNavigateToMessage?: (messageId: string) => void;
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    currentUserId?: string;
    authToken?: string;
    shouldAnimate?: boolean;
    isHighlighted?: boolean;
    searchTerm?: string;
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
  const normalizedSearchTerm = $derived(searchTerm.trim().toLowerCase());

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

  function isGifUrl(url: string): boolean {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host.includes('tenor.com') || host.includes('giphy.com')) return true;
      if (/\.gif(\?.*)?$/i.test(u.pathname)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /** Convert a tenor/giphy page URL into a direct .gif embed URL when possible. */
  function getGifEmbedUrl(url: string): string {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      // Tenor: /view/... pages → use media.tenor.com embed
      if (host.includes('tenor.com') && u.pathname.includes('/view/')) {
        return `https://media.tenor.com/${u.pathname.split('-').pop()}/tenor.gif`;
      }
      // Giphy: /gifs/ or /media/ pages → direct giphy media URL
      if (host.includes('giphy.com')) {
        const match = u.pathname.match(/(?:gifs|media)\/(?:.*-)?([a-zA-Z0-9]+)$/);
        if (match) return `https://media.giphy.com/media/${match[1]}/giphy.gif`;
      }
    } catch {
      // fallback
    }
    return url;
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

  function splitWithHighlight(text: string, needle: string): Array<{ text: string; hit: boolean }> {
    if (!needle) return [{ text, hit: false }];
    const lowerText = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    const parts: Array<{ text: string; hit: boolean }> = [];
    let cursor = 0;

    while (cursor < text.length) {
      const idx = lowerText.indexOf(lowerNeedle, cursor);
      if (idx === -1) {
        parts.push({ text: text.slice(cursor), hit: false });
        break;
      }
      if (idx > cursor) {
        parts.push({ text: text.slice(cursor, idx), hit: false });
      }
      parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
      cursor = idx + needle.length;
    }

    return parts.length > 0 ? parts : [{ text, hit: false }];
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
  <!-- Message Système Premium -->
  <div
    class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium text-text-muted text-center max-w-md border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/5 backdrop-blur-md shadow-sm {shouldAnimate
      ? 'animate-rise-in'
      : ''}"
  >
    <Info size={14} class="flex-shrink-0 opacity-60" />
    <span>{textContent}</span>
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
      class="px-4 py-2.5 cursor-pointer min-w-0 {getBubbleShapeClass(
        groupPosition
      )} transition-shadow duration-200
      {isOwn
        ? 'bg-gradient-to-br from-amber-400 to-amber-500 text-[#151B2C] shadow-md shadow-amber-500/20 hover:shadow-lg hover:shadow-amber-500/30'
        : 'bg-white/70 dark:bg-black/40 backdrop-blur-xl border border-black/5 dark:border-white/10 text-text-main shadow-sm hover:shadow-md'}
      {isHighlighted
        ? 'ring-2 ring-amber-500/80 ring-offset-2 ring-offset-transparent animate-pulse'
        : ''}
      {shouldAnimate ? 'animate-rise-in' : ''}"
    >
      <!-- Citation de réponse -->
      {#if effectiveReplyTo}
        <button
          type="button"
          class="mb-2 pb-2 border-l-4 border-current/60 pl-3.5 text-xs opacity-95 text-left w-full hover:opacity-100 transition-opacity rounded-r-lg bg-black/5 dark:bg-white/5"
          onclick={(e) => {
            e.stopPropagation();
            if (effectiveReplyTo.id) {
              onNavigateToMessage?.(effectiveReplyTo.id);
            }
          }}
          title="Aller au message cité"
          aria-label="Aller au message cité"
        >
          <a
            href="/profile/{encodeURIComponent(effectiveReplyTo.senderId)}"
            class="font-bold truncate hover:underline"
            onclick={(e) => e.stopPropagation()}>{effectiveReplyTo.senderId}</a
          >
          <div class="truncate mt-0.5">{replyPreviewText}</div>
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
            class="text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap [overflow-wrap:anywhere] {isDeleted
              ? 'italic opacity-60'
              : ''}"
          >
            {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
              {#if segment.type === 'link'}
                {#if isGifUrl(segment.value)}
                  <span class="block my-1.5">
                    <img
                      src={getGifEmbedUrl(segment.value)}
                      alt="GIF"
                      class="rounded-xl max-h-64 max-w-full object-contain shadow-sm"
                      onerror={(e) => {
                        const img = e.currentTarget;
                        if (img instanceof HTMLImageElement) {
                          img.style.display = 'none';
                          const link = document.createElement('a');
                          link.href = segment.value;
                          link.target = '_blank';
                          link.rel = 'noopener noreferrer';
                          link.textContent = segment.value;
                          link.className =
                            'underline underline-offset-2 decoration-current hover:opacity-80 transition-opacity';
                          img.parentElement?.appendChild(link);
                        }
                      }}
                    />
                  </span>
                {:else}
                  <a
                    href={segment.value}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline underline-offset-2 decoration-current hover:opacity-80 font-medium transition-opacity"
                    onclick={(e) => e.stopPropagation()}
                  >
                    {segment.value}
                  </a>
                {/if}
              {:else}
                {#each splitWithHighlight(segment.value, normalizedSearchTerm) as part, pIndex (`${pIndex}-${part.text}`)}
                  {#if part.hit}
                    <mark class="rounded px-0.5 bg-amber-300/60 text-inherit">{part.text}</mark>
                  {:else}
                    {part.text}
                  {/if}
                {/each}
              {/if}
            {/each}
          </p>
          {#if firstLink}
            <LinkPreviewCard url={firstLink} />
          {/if}
        {/if}
      {/if}

      <!-- Méta données du message (Modifié, Lu, statut envoi) -->
      {#if isEdited || (isOwn && isLastOwn) || (isOwn && (status === 'sending' || status === 'error'))}
        <div class="flex items-center justify-end gap-1.5 mt-1.5">
          {#if isEdited}
            <span class="italic text-[0.65rem] opacity-65 font-medium">(modifié)</span>
          {/if}
          {#if isOwn}
            {#if status === 'sending'}
              <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-50">
                <LoaderCircle size={12} class="animate-spin" />
                Envoi...
              </span>
            {:else if status === 'error'}
              <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-red-500">
                <TriangleAlert size={12} />
                Échec
              </span>
            {:else if isLastOwn}
              {#if readBy.length > 0}
                <span
                  class="inline-flex items-center gap-1 text-[0.65rem] font-bold text-emerald-700 dark:text-emerald-400"
                >
                  <CheckCheck size={12} strokeWidth={2.5} class="animate-pulse" />
                  Lu{readBy.length > 1 ? ` (${readBy.length})` : ''}
                </span>
              {:else}
                <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-80">
                  <Check size={12} strokeWidth={2.4} />
                  Envoyé
                </span>
              {/if}
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Barre d'actions flottante au survol (Desktop) -->
    <div
      class="absolute top-1/2 -translate-y-1/2 {isOwn
        ? 'right-full mr-2'
        : 'left-full ml-2'} opacity-0 {showEmojiPicker
        ? 'opacity-100'
        : 'group-hover:opacity-100'} transition-opacity duration-200 hidden md:flex flex-row items-center gap-0.5 rounded-full bg-white/90 dark:bg-black/70 backdrop-blur-xl border border-black/5 dark:border-white/10 shadow-lg px-2 py-1.5 z-10 text-text-muted"
    >
      {#if !isDeleted && onReply}
        <button
          onclick={() => onReply?.(messageId)}
          class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-text-main transition-colors"
          aria-label="Répondre"
          title="Répondre"
        >
          <Reply size={16} />
        </button>
      {/if}
      {#if onReact}
        <button
          onclick={(e) => {
            e.stopPropagation();
            showEmojiPicker = !showEmojiPicker;
          }}
          class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-amber-500 transition-colors"
          aria-label="Réagir"
          title="Réagir"
        >
          <Smile size={16} />
        </button>
      {/if}
      {#if !isDeleted && isOwn && !mediaRef && onEdit}
        <button
          onclick={(e) => {
            e.stopPropagation();
            startInlineEdit();
          }}
          class="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 hover:text-blue-500 transition-colors"
          aria-label="Modifier"
          title="Modifier"
        >
          <Pencil size={16} />
        </button>
      {/if}
      {#if !isDeleted && isOwn && onDelete}
        <button
          onclick={(e) => {
            e.stopPropagation();
            showDeleteModal = true;
          }}
          class="p-1.5 rounded-full hover:bg-red-500/10 hover:text-red-500 transition-colors"
          aria-label="Supprimer"
          title="Supprimer"
        >
          <Trash2 size={16} />
        </button>
      {/if}
    </div>

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
