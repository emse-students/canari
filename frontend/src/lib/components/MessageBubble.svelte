<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';
  import {
    Reply,
    Smile,
    FileText,
    Download,
    Pencil,
    Trash2,
    CheckCheck,
    EllipsisVertical,
  } from 'lucide-svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { onDestroy, onMount } from 'svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { parseEnvelope } from '$lib/envelope';
  import 'emoji-picker-element';
  import Modal from './Modal.svelte';
  import LinkPreviewCard from './LinkPreviewCard.svelte';
  import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';

  interface MessageReaction {
    emoji: string;
    userId: string;
  }

  interface Props {
    messageId: string;
    senderId: string;
    content: string;
    timestamp: Date;
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
    onReact?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    authToken?: string;
  }

  let {
    messageId,
    senderId: _senderId,
    content,
    timestamp,
    isOwn,
    isSystem = false,
    replyTo,
    reactions = [],
    readBy = [],
    isEdited = false,
    isDeleted = false,
    groupPosition = 'single',
    onReply,
    onReact,
    onDelete,
    onEdit,
    authToken = '',
  }: Props = $props();

  let showEmojiPicker = $state(false);
  let showInfo = $state(false);
  let showMobileActions = $state(false);
  let showEditModal = $state(false);
  let showDeleteModal = $state(false);
  let editText = $state('');
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
  let blobUrl = $state<string | null>(null);
  let loadError = $state(false);
  let supportsHover = $state(true);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let firstLink = $derived(!mediaRef && !isDeleted ? extractFirstUrl(textContent) : null);

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

  function handleEmojiClick(emoji: string) {
    onReact?.(messageId, emoji);
    showEmojiPicker = false;
  }

  function confirmEdit() {
    if (editText !== content) {
      onEdit?.(messageId, editText);
    }
    showEditModal = false;
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

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function attachEmojiPicker(node: HTMLElement) {
    const handleEmoji = (event: any) => {
      handleEmojiClick(event.detail.unicode);
    };
    node.addEventListener('emoji-click', handleEmoji);
    return {
      destroy() {
        node.removeEventListener('emoji-click', handleEmoji);
      },
    };
  }

  $effect(() => {
    if (!mediaRef || !authToken) return;

    let destroyed = false;
    let urlToRevoke: string | null = null;
    loadError = false;

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
      .catch(() => {
        if (!destroyed) {
          loadError = true;
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

  onMount(() => {
    supportsHover = window.matchMedia('(hover: hover)').matches;
  });

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function openBlob(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function downloadBlob(url: string, fileName: string) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
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

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s]+/i);
    return match?.[0] ?? null;
  }
</script>

{#if effectiveSystem}
  <div class="px-4 py-1.5 bg-cn-bg rounded-full text-xs text-text-muted text-center max-w-md">
    {textContent}
  </div>
{:else}
  <!-- Outer wrapper: relative for absolute children (emoji picker, info tooltip) -->
  <div
    use:clickOutside={() => {
      showEmojiPicker = false;
      showInfo = false;
      showMobileActions = false;
    }}
    class="relative group"
  >
    <button
      type="button"
      onclick={openMobileActions}
      class="absolute top-1 right-1 md:hidden z-10 p-1.5 rounded-full bg-white/90 border border-cn-border text-gray-500"
      aria-label="Ouvrir les actions du message"
    >
      <EllipsisVertical size={14} />
    </button>

    <!-- ── Bubble ── -->
    <div
      in:fly={{ y: 5, duration: 200 }}
      role="button"
      tabindex="0"
      onclick={toggleInfo}
      onpointerdown={beginLongPress}
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
        ? 'bg-cn-yellow text-cn-dark'
        : 'bg-[var(--cn-surface)] text-cn-dark border border-cn-border'}"
    >
      {#if effectiveReplyTo}
        <div class="mb-2 pb-2 border-l-4 border-gray-400 pl-3 text-xs opacity-70">
          <div class="font-semibold">{effectiveReplyTo.senderId}</div>
          <div class="truncate">{effectiveReplyTo.content}</div>
        </div>
      {/if}

      {#if mediaRef}
        <div class="overflow-hidden rounded-xl">
          {#if mediaRef.type === 'image'}
            {#if blobUrl}
              <div class="relative inline-block">
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    openBlob(blobUrl!);
                  }}
                  aria-label="Ouvrir l'image en plein écran"
                  class="hover:opacity-90 transition-opacity"
                >
                  <img
                    src={blobUrl}
                    alt={mediaRef.fileName ?? 'Image'}
                    class="rounded-xl max-h-80 object-contain cursor-pointer"
                  />
                </button>
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    downloadBlob(blobUrl!, mediaRef.fileName ?? 'image');
                  }}
                  class="absolute right-2 bottom-2 w-8 h-8 rounded-full bg-black/60 text-white inline-flex items-center justify-center"
                  aria-label="Telecharger l'image"
                >
                  <Download size={15} />
                </button>
              </div>
            {:else if loadError}
              <div
                class="w-48 h-32 rounded-xl bg-gray-100 flex items-center justify-center text-xs text-gray-400 px-3 text-center"
              >
                Impossible de charger l'image
              </div>
            {:else}
              <div class="w-48 h-32 rounded-xl bg-gray-100 animate-pulse"></div>
            {/if}
          {:else if mediaRef.type === 'video'}
            {#if blobUrl}
              <div class="relative inline-block">
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                  src={blobUrl}
                  controls
                  onclick={(e) => e.stopPropagation()}
                  class="rounded-xl max-h-80 max-w-md"
                ></video>
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    downloadBlob(blobUrl!, mediaRef.fileName ?? 'video');
                  }}
                  class="absolute right-2 bottom-2 w-8 h-8 rounded-full bg-black/60 text-white inline-flex items-center justify-center"
                  aria-label="Telecharger la video"
                >
                  <Download size={15} />
                </button>
              </div>
            {:else if loadError}
              <div
                class="w-48 h-24 rounded-xl bg-gray-100 flex items-center justify-center text-xs text-gray-400"
              >
                Impossible de charger la vidéo
              </div>
            {:else}
              <div class="w-48 h-24 rounded-xl bg-gray-100 animate-pulse"></div>
            {/if}
          {:else if mediaRef.type === 'audio'}
            {#if blobUrl}
              <VoiceMessagePlayer
                src={blobUrl}
                onDownload={() => downloadBlob(blobUrl!, mediaRef.fileName ?? 'vocal.webm')}
              />
            {:else if loadError}
              <div
                class="w-48 h-12 rounded-xl bg-gray-100 flex items-center justify-center text-xs text-gray-400"
              >
                Impossible de charger l'audio
              </div>
            {:else}
              <div class="w-48 h-12 rounded-xl bg-gray-100 animate-pulse"></div>
            {/if}
          {:else}
            <div
              class="flex items-center gap-3 px-4 py-3 min-w-[200px] bg-white/40 rounded-xl border border-white/50"
            >
              <FileText size={32} class="flex-shrink-0 opacity-60" />
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium truncate">{mediaRef.fileName ?? 'Fichier'}</p>
                <p class="text-xs opacity-60">{formatFileSize(mediaRef.size)}</p>
              </div>
              {#if blobUrl}
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    downloadBlob(blobUrl!, mediaRef!.fileName ?? 'fichier');
                  }}
                  aria-label="Télécharger"
                  class="p-2 rounded-lg hover:bg-black/10 transition-colors"
                >
                  <Download size={20} class="opacity-70 hover:opacity-100" />
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <p
          class="text-base leading-relaxed break-words whitespace-pre-wrap {isDeleted
            ? 'italic text-gray-500'
            : ''}"
        >
          {textContent}
        </p>
        {#if firstLink}
          <LinkPreviewCard url={firstLink} />
        {/if}
      {/if}

      <!-- Micro-footer: only (modifié) + read checkmark, no time -->
      {#if isEdited || (isOwn && readBy.length > 0)}
        <div class="flex items-center justify-end gap-1 mt-1">
          {#if isEdited}
            <span class="italic text-[0.6rem] opacity-60">(modifié)</span>
          {/if}
          {#if isOwn && readBy.length > 0}
            <span class="text-blue-500" title="Lu par {readBy.join(', ')}">
              <CheckCheck size={14} strokeWidth={2.25} />
            </span>
          {/if}
        </div>
      {/if}
    </div>

    <!-- ── Action bar (visible on hover) ── -->
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
            editText = textContent;
            showEditModal = true;
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

    <!-- ── Reactions (below bubble, aligned with it) ── -->
    {#if Object.keys(groupedReactions).length > 0}
      <div class="flex gap-1 flex-wrap mt-1 px-1 {isOwn ? 'justify-end' : 'justify-start'}">
        {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
          <button
            class="flex items-center gap-1 px-2 py-0.5 bg-gray-100 hover:bg-gray-200 rounded-full text-xs transition-colors"
            onclick={() => handleEmojiClick(emoji)}
            title={users.join(', ')}
          >
            <span>{emoji}</span>
            <span class="text-gray-600">{users.length}</span>
          </button>
        {/each}
      </div>
    {/if}

    <!-- ── Emoji picker ── -->
    {#if showEmojiPicker}
      <div
        class="absolute top-full mt-2 {isOwn
          ? 'right-0'
          : 'left-0'} w-[min(92vw,22rem)] bg-[var(--cn-surface)] border border-cn-border rounded-2xl shadow-2xl z-[110] overflow-hidden"
      >
        <div
          class="px-3 py-2 border-b border-cn-border text-xs text-text-muted flex items-center gap-1.5"
        >
          <Smile size={12} /> Reagir au message
        </div>
        <emoji-picker use:attachEmojiPicker class="light w-full"></emoji-picker>
      </div>
    {/if}

    <!-- ── Info tooltip (time sent + readBy) on bubble click ── -->
    {#if showInfo}
      <div
        class="absolute {isOwn
          ? 'right-0'
          : 'left-0'} top-full mt-1 px-3 py-1.5 bg-gray-800 text-white text-[0.65rem] rounded-lg shadow-lg z-50 whitespace-nowrap flex flex-col gap-0.5 pointer-events-none"
        in:fly={{ y: -3, duration: 100 }}
      >
        <span>Envoyé à {format(timestamp, 'HH:mm')}</span>
        {#if readBy.length > 0}
          <span class="text-blue-300">Lu par {readBy.join(', ')}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if showMobileActions}
    <button
      type="button"
      class="fixed inset-0 z-40 bg-black/30 md:hidden"
      aria-label="Fermer le menu des actions"
      onclick={closeMobileActions}
    ></button>
    <div
      class="fixed inset-x-0 bottom-0 z-50 md:hidden rounded-t-3xl bg-[var(--cn-surface)] border-t border-cn-border shadow-2xl p-4"
      in:fly={{ y: 12, duration: 120 }}
    >
      <div class="w-12 h-1.5 rounded-full bg-gray-200 mx-auto mb-4"></div>
      <div class="grid grid-cols-2 gap-2">
        {#if !isDeleted && onReply}
          <button
            onclick={() => {
              onReply?.(messageId);
              closeMobileActions();
            }}
            class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Reply size={15} /> Repondre
          </button>
        {/if}
        {#if onReact}
          <button
            onclick={() => {
              showEmojiPicker = true;
              closeMobileActions();
            }}
            class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Smile size={15} /> Reagir
          </button>
        {/if}
        {#if !isDeleted && isOwn && !mediaRef && onEdit}
          <button
            onclick={() => {
              editText = textContent;
              showEditModal = true;
              closeMobileActions();
            }}
            class="px-3 py-2.5 rounded-xl bg-cn-bg text-sm font-medium flex items-center justify-center gap-2"
          >
            <Pencil size={15} /> Modifier
          </button>
        {/if}
        {#if !isDeleted && isOwn && onDelete}
          <button
            onclick={() => {
              showDeleteModal = true;
              closeMobileActions();
            }}
            class="px-3 py-2.5 rounded-xl bg-red-50 text-red-600 text-sm font-medium flex items-center justify-center gap-2"
          >
            <Trash2 size={15} /> Supprimer
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ── Modals (outside the relative div so z-index is clean) ── -->
  <Modal open={showEditModal} title="Modifier le message" onClose={() => (showEditModal = false)}>
    <textarea
      bind:value={editText}
      rows="3"
      class="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-cn-yellow/50"
      placeholder="Nouveau texte…"
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          confirmEdit();
        }
      }}
    ></textarea>
    {#snippet footer()}
      <button
        onclick={() => (showEditModal = false)}
        class="px-4 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
      >
        Annuler
      </button>
      <button
        onclick={confirmEdit}
        class="px-4 py-2 text-sm rounded-lg bg-cn-yellow text-cn-dark font-medium hover:opacity-90 transition-opacity"
      >
        Enregistrer
      </button>
    {/snippet}
  </Modal>

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
