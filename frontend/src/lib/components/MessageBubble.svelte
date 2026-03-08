<script lang="ts">
  import { format } from 'date-fns';
  import { fly } from 'svelte/transition';
  import { onDestroy } from 'svelte';
  import { parseMediaMessage, MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { FileText, Download } from 'lucide-svelte';

  interface Props {
    senderId: string;
    content: string;
    timestamp: Date;
    isOwn: boolean;
    authToken?: string;
  }

  let { senderId: _senderId, content, timestamp, isOwn, authToken = '' }: Props = $props();

  // Detect media messages
  let mediaRef = $derived(parseMediaMessage(content));

  // Blob URL for decrypted media (image/video)
  let blobUrl = $state<string | null>(null);
  let loadError = $state(false);

  // Download & decrypt whenever authToken or mediaRef changes
  $effect(() => {
    if (!mediaRef || !authToken) return;

    // Revoke any previous blob URL before creating a new one
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
    loadError = false;

    const ref: MediaRef = mediaRef;
    const token: string = authToken;

    new MediaService()
      .downloadAndDecrypt(ref, token)
      .then((url) => { blobUrl = url; })
      .catch(() => { loadError = true; });
  });

  onDestroy(() => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }
</script>

<div class="flex w-full {isOwn ? 'justify-end' : 'justify-start'}">
  <div
    in:fly={{ y: 5, duration: 200 }}
    class="max-w-[75%] rounded-[1.25rem] overflow-hidden {isOwn
      ? 'bg-cn-yellow text-cn-dark rounded-br-sm'
      : 'bg-white text-cn-dark border border-cn-border rounded-bl-sm'}"
  >
    {#if mediaRef}
      <!-- ── Media message ── -->
      <div class="px-2 pt-2">
        {#if mediaRef.type === 'image'}
          {#if blobUrl}
            <a href={blobUrl} target="_blank" rel="noopener noreferrer" aria-label="Ouvrir l'image en plein écran">
              <img
                src={blobUrl}
                alt={mediaRef.fileName ?? 'Image'}
                class="rounded-xl max-h-64 object-contain"
              />
            </a>
          {:else if loadError}
            <div class="w-48 h-32 rounded-xl bg-gray-100 flex items-center justify-center text-xs text-gray-400 px-3 text-center">
              Impossible de charger l'image
            </div>
          {:else}
            <!-- Loading skeleton -->
            <div class="w-48 h-32 rounded-xl bg-gray-100 animate-pulse"></div>
          {/if}
        {:else if mediaRef.type === 'video'}
          {#if blobUrl}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              src={blobUrl}
              controls
              class="rounded-xl max-h-64 max-w-xs"
            ></video>
          {:else if loadError}
            <div class="w-48 h-24 rounded-xl bg-gray-100 flex items-center justify-center text-xs text-gray-400">
              Impossible de charger la vidéo
            </div>
          {:else}
            <div class="w-48 h-24 rounded-xl bg-gray-100 animate-pulse"></div>
          {/if}
        {:else}
          <!-- Generic file -->
          <div class="flex items-center gap-3 px-3 py-3 min-w-[180px]">
            <FileText size={28} class="flex-shrink-0 opacity-60" />
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium truncate">{mediaRef.fileName ?? 'Fichier'}</p>
              <p class="text-xs opacity-60">{formatFileSize(mediaRef.size)}</p>
            </div>
            {#if blobUrl}
              <a href={blobUrl} download={mediaRef.fileName ?? 'fichier'} aria-label="Télécharger">
                <Download size={18} class="opacity-70 hover:opacity-100" />
              </a>
            {/if}
          </div>
        {/if}
      </div>
      <!-- Timestamp below media -->
      <span class="block text-[0.65rem] px-3 pb-2 pt-1 text-right opacity-70">
        {format(timestamp, 'HH:mm')}
      </span>
    {:else}
      <!-- ── Plain text message ── -->
      <div class="px-5 py-3">
        <p class="text-base leading-relaxed break-words">{content}</p>
        <span class="block text-[0.65rem] mt-2 text-right opacity-70">
          {format(timestamp, 'HH:mm')}
        </span>
      </div>
    {/if}
  </div>
</div>
