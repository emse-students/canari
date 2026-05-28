<script lang="ts">
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { Image as ImageIcon, CircleAlert } from '@lucide/svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';

  interface Props {
    /** Encrypted media descriptor containing the download reference and decryption keys. */
    media: {
      mediaId: string;
      key: string;
      iv: string;
      mimeType: string;
      size: number;
      fileName?: string;
      width?: number;
      height?: number;
    };
    /** Bearer token used to authenticate the media download request. */
    authToken: string;
    /** When set, clicking the image calls this instead of opening its own lightbox. */
    onOpen?: () => void;
    /** When true, renders the image filling its container (used inside gallery lightbox). */
    galleryMode?: boolean;
  }

  let { media, authToken, onOpen, galleryMode = false }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  $effect(() => {
    if (!authToken) {
      loading = false;
      loadError = "Jeton d'authentification manquant";
      return;
    }

    let destroyed = false;
    let currentUrl: string | null = null;
    loading = true;
    loadError = '';

    const mediaService = new MediaService();

    mediaService
      .downloadAndDecrypt(
        {
          type: 'image',
          mediaId: media.mediaId,
          key: media.key,
          iv: media.iv,
          mimeType: media.mimeType,
          size: media.size,
          fileName: media.fileName,
          width: media.width,
          height: media.height,
        } as MediaRef,
        authToken
      )
      .then((url) => {
        if (destroyed) {
          URL.revokeObjectURL(url);
        } else {
          blobUrl = url;
          currentUrl = url;
        }
      })
      .catch((err) => {
        if (!destroyed) {
          loadError = err instanceof Error ? err.message : "Impossible de charger l'image";
        }
      })
      .finally(() => {
        if (!destroyed) loading = false;
      });

    return () => {
      destroyed = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  });

  let lightboxOpen = $state(false);

  function handleClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!blobUrl) return;
    if (onOpen) {
      onOpen();
    } else {
      lightboxOpen = true;
    }
  }

  function closeLightbox() {
    lightboxOpen = false;
  }
</script>

{#if galleryMode}
  <!-- Used inside parent gallery lightbox - just render the image -->
  {#if loading}
    <div class="flex items-center justify-center w-full min-h-[12rem]">
      <ImageIcon size={32} class="opacity-20 text-white animate-pulse" strokeWidth={1.5} />
    </div>
  {:else if loadError}
    <div class="flex flex-col items-center justify-center gap-2 p-4 text-center text-white/60">
      <CircleAlert size={24} strokeWidth={2} />
      <span class="text-xs">{loadError}</span>
    </div>
  {:else if blobUrl}
    <img
      src={blobUrl}
      alt={media.fileName ?? 'Image de la publication'}
      class="max-h-full max-w-full object-contain select-none"
    />
  {/if}
{:else}
  <!-- Standalone image with its own lightbox (single-image or thumbnail) -->
  {#if loading}
    <div
      class="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-white/5 animate-pulse"
    >
      <ImageIcon size={32} class="opacity-20 text-text-muted" strokeWidth={1.5} />
    </div>
  {:else if loadError}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-red-500/5 dark:bg-red-500/10 border border-dashed border-red-500/20"
    >
      <CircleAlert size={24} class="text-red-500 opacity-70" strokeWidth={2} />
      <span class="text-xs font-semibold text-red-600 dark:text-red-400">{loadError}</span>
    </div>
  {:else if blobUrl}
    <button
      type="button"
      onclick={handleClick}
      class="block w-full h-full outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:z-10 group/img cursor-zoom-in"
      aria-label="Agrandir l'image"
    >
      <img
        src={blobUrl}
        alt={media.fileName ?? 'Image de la publication'}
        class="w-full h-full object-cover transition-transform duration-700 group-hover/img:scale-105"
        loading="lazy"
      />
    </button>
  {/if}

  <MediaLightbox
    open={lightboxOpen && !!blobUrl}
    onClose={closeLightbox}
    ariaLabel="Image agrandie"
    title={media.fileName ?? 'Image'}
  >
    {#if blobUrl}
      <img
        src={blobUrl}
        alt={media.fileName ?? 'Image agrandie'}
        class="max-h-full max-w-full object-contain select-none"
        style="touch-action: pinch-zoom;"
      />
    {/if}
  </MediaLightbox>
{/if}
