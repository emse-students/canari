<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';
  import { Reply, Smile, FileText, Download, Pencil, Trash2 } from 'lucide-svelte';
  import { clickOutside } from '$lib/actions/clickOutside';
  import { onDestroy } from 'svelte';
  import { parseMediaMessage, MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import 'emoji-picker-element';

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
    showTimestamp?: boolean;
    isEdited?: boolean;
    isDeleted?: boolean;
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
    showTimestamp = true,
    isEdited = false,
    isDeleted = false,
    onReply,
    onReact,
    onDelete,
    onEdit,
    authToken = '',
  }: Props = $props();

  let showEmojiPicker = $state(false);
  let mediaRef = $derived(parseMediaMessage(content));
  let blobUrl = $state<string | null>(null);
  let loadError = $state(false);

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
    if (blobUrl) URL.revokeObjectURL(blobUrl);
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
</script>

{#if isSystem}
  <div class="px-4 py-1.5 bg-gray-100 rounded-full text-xs text-gray-600 text-center max-w-md">
    {content}
  </div>
{:else}
  <div
    use:clickOutside={() => (showEmojiPicker = false)}
    class="flex flex-col gap-1 relative group"
  >
    <div
      in:fly={{ y: 5, duration: 200 }}
      class="px-5 py-3 rounded-[1.25rem] {isOwn
        ? 'bg-cn-yellow text-cn-dark rounded-br-sm'
        : 'bg-white text-cn-dark border border-cn-border rounded-bl-sm'}"
    >
      {#if replyTo}
        <div class="mb-2 pb-2 border-l-4 border-gray-400 pl-3 text-xs opacity-70">
          <div class="font-semibold">{replyTo.senderId}</div>
          <div class="truncate">{replyTo.content}</div>
        </div>
      {/if}

      {#if mediaRef}
        <div class="overflow-hidden rounded-xl">
          {#if mediaRef.type === 'image'}
            {#if blobUrl}
              <button
                type="button"
                onclick={() => openBlob(blobUrl!)}
                aria-label="Ouvrir l'image en plein écran"
                class="hover:opacity-90 transition-opacity"
              >
                <img
                  src={blobUrl}
                  alt={mediaRef.fileName ?? 'Image'}
                  class="rounded-xl max-h-80 object-contain cursor-pointer"
                />
              </button>
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
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={blobUrl} controls class="rounded-xl max-h-80 max-w-md"></video>
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
              <div class="min-w-[280px] max-w-sm">
                <audio src={blobUrl} controls class="w-full h-10"></audio>
                {#if mediaRef.fileName}
                  <p class="text-xs opacity-60 mt-1 truncate">{mediaRef.fileName}</p>
                {/if}
              </div>
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
                  onclick={() => downloadBlob(blobUrl!, mediaRef.fileName ?? 'fichier')}
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
          class="text-base leading-relaxed break-words line-clamp-none whitespace-pre-wrap {isDeleted
            ? 'italic text-gray-500'
            : ''}"
        >
          {content}
        </p>
      {/if}

      <div class="flex items-center justify-between mt-2 gap-2">
        <span class="text-[0.65rem] opacity-70 flex items-center gap-1">
          {#if showTimestamp}
            {format(timestamp, 'HH:mm')}
          {/if}
          {#if isEdited}
            <span class="italic text-[0.6rem] ml-1" title="Modifié">(modifié)</span>
          {/if}
          {#if isOwn && readBy.length > 0}
            <span class="text-blue-500 font-bold ml-1" title="Lu par {readBy.join(', ')}">✓</span>
          {/if}
        </span>

        <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
          {#if !isDeleted && isOwn && !mediaRef && onEdit}
            <button
              onclick={() => {
                const newText = prompt('Modifier le message:', content);
                if (newText !== null && newText !== content) {
                  onEdit?.(messageId, newText);
                }
              }}
              class="p-1 rounded hover:bg-black/10 transition-colors"
              aria-label="Modifier"
            >
              <Pencil size={14} />
            </button>
          {/if}
          {#if !isDeleted && isOwn && onDelete}
            <button
              onclick={() => {
                if (confirm('Supprimer ce message ?')) {
                  onDelete?.(messageId);
                }
              }}
              class="p-1 rounded hover:bg-black/10 transition-colors text-red-500 hover:text-red-700"
              aria-label="Supprimer"
            >
              <Trash2 size={14} />
            </button>
          {/if}
          {#if !isDeleted && onReply}
            <button
              onclick={() => onReply?.(messageId)}
              class="p-1 rounded hover:bg-black/10 transition-colors"
              aria-label="Répondre"
            >
              <Reply size={14} />
            </button>
          {/if}
          {#if onReact}
            <button
              onclick={() => {
                showEmojiPicker = !showEmojiPicker;
              }}
              class="p-1 rounded hover:bg-black/10 transition-colors"
              aria-label="Réagir"
            >
              <Smile size={14} />
            </button>
          {/if}
        </div>
      </div>
    </div>

    {#if Object.keys(groupedReactions).length > 0}
      <div class="flex gap-1 flex-wrap px-2">
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

    {#if showEmojiPicker}
      <div
        class="absolute bottom-full mb-1 {isOwn
          ? 'right-0'
          : 'left-0'} bg-white border border-cn-border rounded-lg shadow-xl z-[100] overflow-hidden"
      >
        <emoji-picker use:attachEmojiPicker class="light"></emoji-picker>
      </div>
    {/if}
  </div>
{/if}
