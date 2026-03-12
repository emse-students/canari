<script lang="ts">
  import { FileText, Download } from 'lucide-svelte';
  import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
  import type { MediaRef } from '$lib/media';

  interface Props {
    mediaRef: MediaRef | null;
    blobUrl: string | null;
    loadError: boolean;
    mediaPurgedByRetention: boolean;
    textContent: string;
    isOwn?: boolean;
    textSegments?: Array<{ type: 'text' | 'link'; value: string }>;
    onNavigateLink?: (e: MouseEvent) => void;
  }

  let {
    mediaRef = null,
    blobUrl = null,
    loadError = false,
    mediaPurgedByRetention = false,
    textContent = '',
    isOwn: _isOwn,
    textSegments = [],
    onNavigateLink: _onNavigateLink,
  }: Props = $props();

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
          {mediaPurgedByRetention
            ? 'Media supprime (retention 30 jours). Demandez un renvoi.'
            : "Impossible de charger l'image"}
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
          {mediaPurgedByRetention
            ? 'Media supprime (retention 30 jours). Demandez un renvoi.'
            : 'Impossible de charger la vidéo'}
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
          {mediaPurgedByRetention
            ? 'Media supprime (retention 30 jours). Demandez un renvoi.'
            : "Impossible de charger l'audio"}
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
        {:else if mediaPurgedByRetention}
          <span class="text-xs text-red-600">Media supprime (retention 30 jours)</span>
        {/if}
      </div>
    {/if}
  </div>
  {#if textContent}
    <p class="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
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
  {/if}
{/if}
