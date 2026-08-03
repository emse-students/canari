<script lang="ts">
  import {
    FileText,
    Download,
    CircleAlert,
    Image as ImageIcon,
    Video as VideoIcon,
    Mic,
  } from '@lucide/svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef, MediaType } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Encrypted media descriptor containing the download reference and decryption keys. */
    media: {
      type?: MediaType;
      mediaId: string;
      key: string;
      iv: string;
      mimeType: string;
      size: number;
      fileName?: string;
      width?: number;
      height?: number;
      caption?: string;
    };
    /** Non-empty once the session is authenticated; the download resolves its own live token. */
    authToken: string;
    /** When set, clicking the image calls this instead of opening its own lightbox. */
    onOpen?: () => void;
    /** When true, renders the image/video filling its container (used inside gallery lightbox). */
    galleryMode?: boolean;
  }

  let { media, authToken, onOpen, galleryMode = false }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  const mediaType = $derived<MediaType>(resolveMediaType(media));

  // The caller only reserves a box for picture-shaped media, so a file/audio
  // placeholder must take part in the flow instead of filling a parent that has
  // no height of its own.
  const fillsReservedBox = $derived(reservesAspectRatio(mediaType));

  const isPdf = $derived(mediaType === 'file' && isPdfAttachment(media.mimeType, media.fileName));

  $effect(() => {
    if (!authToken) {
      loading = false;
      loadError = m.post_missing_auth_token();
      return;
    }

    let destroyed = false;
    let acquired = false;
    loading = true;
    loadError = '';

    const mediaRef: MediaRef = {
      type: mediaType,
      mediaId: media.mediaId,
      key: media.key,
      iv: media.iv,
      mimeType: media.mimeType,
      size: media.size,
      fileName: media.fileName,
      width: media.width,
      height: media.height,
    };

    const mediaService = new MediaService();

    mediaService
      .downloadAndDecrypt(mediaRef)
      .then((url) => {
        if (destroyed) {
          releaseDecryptedMediaBlobUrl(mediaRef);
        } else {
          blobUrl = url;
          acquired = true;
        }
      })
      .catch((err) => {
        if (!destroyed) {
          loadError = err instanceof Error ? err.message : m.post_image_load_error();
        }
      })
      .finally(() => {
        if (!destroyed) loading = false;
      });

    return () => {
      destroyed = true;
      if (acquired) releaseDecryptedMediaBlobUrl(mediaRef);
      acquired = false;
      blobUrl = null;
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

  function downloadBlob(url: string, name: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }
</script>

{#if galleryMode}
  <!-- Inside parent gallery lightbox - just render the content -->
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
    {#if mediaType === 'image'}
      <img
        src={blobUrl}
        alt={media.fileName ?? m.post_image_alt()}
        class="max-h-full max-w-full object-contain select-none"
      />
    {:else if mediaType === 'video'}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={blobUrl}
        controls
        autoplay
        class="max-h-full max-w-full object-contain bg-black rounded-xl"
      ></video>
    {:else}
      <div class="flex flex-col items-center gap-3 text-white/80">
        <FileText size={48} strokeWidth={1.5} />
        <span class="text-sm font-medium">{media.fileName ?? m.post_media_file_label()}</span>
      </div>
    {/if}
  {/if}
{:else}
  <!-- Standalone rendering -->
  {#if loading}
    {#if mediaType === 'image'}
      <div
        class="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-white/5 animate-pulse"
      >
        <ImageIcon size={32} class="opacity-20 text-text-muted" strokeWidth={1.5} />
      </div>
    {:else if mediaType === 'video'}
      <div
        class="w-full aspect-video max-w-md rounded-[1.1rem] bg-black/5 dark:bg-white/10 animate-pulse flex items-center justify-center"
      >
        <VideoIcon size={32} class="opacity-20 text-text-muted" />
      </div>
    {:else if mediaType === 'audio'}
      <div
        class="w-full sm:w-56 h-14 rounded-xl bg-black/5 dark:bg-white/10 animate-pulse flex items-center justify-center px-4"
      >
        <Mic size={20} class="opacity-20 text-text-muted" />
        <div class="flex-1 ml-3 h-2 bg-current opacity-10 rounded-full"></div>
      </div>
    {:else}
      <!-- Same footprint as the loaded file card, so nothing jumps on arrival. -->
      <div
        class="flex items-center gap-3.5 px-3.5 py-3 w-full rounded-[1rem] bg-black/5 dark:bg-white/10 animate-pulse"
      >
        <div
          class="w-11 h-11 rounded-xl bg-black/10 dark:bg-white/10 flex items-center justify-center shrink-0"
        >
          <FileText size={22} class="opacity-20 text-text-muted" strokeWidth={1.5} />
        </div>
        <div class="flex-1 h-2.5 rounded-full bg-black/10 dark:bg-white/10"></div>
      </div>
    {/if}
  {:else if loadError}
    <div
      class="{fillsReservedBox
        ? 'absolute inset-0'
        : 'w-full rounded-[1rem]'} flex flex-col items-center justify-center gap-2 p-4 text-center bg-red-500/5 dark:bg-red-500/10 border border-dashed border-red-500/20"
    >
      <CircleAlert size={24} class="text-red-500 opacity-70" strokeWidth={2} />
      <span class="text-xs font-semibold text-red-600 dark:text-red-400">{loadError}</span>
    </div>
  {:else if blobUrl}
    {#if mediaType === 'image'}
      <!-- ========== IMAGE ========== -->
      <button
        type="button"
        onclick={handleClick}
        class="block w-full h-full outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:z-10 group/img cursor-zoom-in"
        aria-label={m.post_zoom_image_label()}
      >
        <img
          src={blobUrl}
          alt={media.fileName ?? m.post_image_alt()}
          class="w-full h-full object-cover transition-transform duration-700 group-hover/img:scale-105"
          loading="lazy"
        />
      </button>
    {:else if mediaType === 'video'}
      <!-- ========== VIDEO ========== -->
      <div
        class="relative w-full aspect-video max-w-md rounded-[1.1rem] overflow-hidden bg-black/10 dark:bg-black/40 shadow-sm group/media"
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={blobUrl} controls preload="metadata" class="w-full h-full object-contain"
        ></video>
        <button
          type="button"
          onclick={handleClick}
          class="absolute left-2.5 bottom-2.5 px-2.5 h-8 rounded-full bg-black/50 backdrop-blur-md text-white inline-flex items-center justify-center shadow-lg transition-all duration-300 hover:bg-black/70 text-xs font-bold"
          aria-label={m.post_fullscreen_label()}
        >
          {m.post_fullscreen_label()}
        </button>
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            downloadBlob(blobUrl!, media.fileName ?? 'video.mp4');
          }}
          class="absolute right-2.5 top-2.5 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md text-white inline-flex items-center justify-center shadow-lg transition-all duration-300 md:opacity-0 md:group-hover/media:opacity-100 hover:bg-black/70 hover:scale-110 focus:opacity-100 outline-none z-10"
          aria-label={m.post_download_label()}
        >
          <Download size={16} strokeWidth={2.5} />
        </button>
      </div>
    {:else if mediaType === 'audio'}
      <!-- ========== AUDIO ========== -->
      <div class="w-full max-w-md rounded-[1.1rem] overflow-hidden bg-black/5 dark:bg-white/5">
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio src={blobUrl} controls preload="metadata" class="w-full h-12"></audio>
      </div>
    {:else}
      <!-- ========== GENERIC FILE ========== -->
      <div
        class="w-full max-w-full rounded-[1rem] border border-black/5 dark:border-white/10 bg-black/5 dark:bg-white/10 backdrop-blur-md overflow-hidden transition-colors group/file"
      >
        <div class="flex items-center gap-3.5 px-3.5 py-3">
          <div
            class="w-11 h-11 rounded-xl bg-black/10 dark:bg-white/10 flex items-center justify-center shrink-0"
          >
            <FileText size={22} strokeWidth={2} class="text-text-muted" />
          </div>
          <div class="flex-1 min-w-0 overflow-hidden">
            <p class="text-[0.85rem] font-bold truncate leading-tight mb-0.5">
              {media.fileName ?? m.post_media_file_label()}
            </p>
            <!-- No `uppercase` here: it would render the "Ko" unit as "KO". -->
            <p class="text-[0.65rem] tracking-wider font-semibold text-text-muted">
              {formatFileSize(media.size)}
            </p>
          </div>
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, media.fileName ?? 'file');
            }}
            class="p-2.5 rounded-xl hover:bg-black/10 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 shrink-0"
            aria-label={m.post_download_label()}
          >
            <Download
              size={18}
              strokeWidth={2.5}
              class="opacity-70 group-hover/file:opacity-100 transition-opacity"
            />
          </button>
        </div>
        {#if isPdf}
          <!-- A post is wide enough to show the page itself; the row keeps its
               icon so the document is never rendered twice. -->
          <PdfThumbnail
            url={blobUrl}
            maxWidth={640}
            imgClass="w-full max-h-[22rem] object-contain object-top border-t border-black/5 dark:border-white/10 bg-white"
          />
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Lightbox for image/video -->
  {#if lightboxOpen && blobUrl && (mediaType === 'image' || mediaType === 'video')}
    <MediaLightbox
      open={lightboxOpen}
      onClose={closeLightbox}
      ariaLabel={mediaType === 'image' ? m.post_image_enlarged_alt() : m.post_fullscreen_label()}
      title={media.fileName ??
        (mediaType === 'image' ? m.post_image_label() : m.post_media_video_label())}
      onDownload={blobUrl
        ? () =>
            downloadBlob(blobUrl!, media.fileName ?? (mediaType === 'image' ? 'image' : 'video'))
        : undefined}
    >
      {#if mediaType === 'image'}
        <img
          src={blobUrl}
          alt={media.fileName ?? m.post_image_enlarged_alt()}
          class="max-h-full max-w-full object-contain select-none"
        />
      {:else}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={blobUrl}
          controls
          autoplay
          class="max-h-full max-w-full object-contain bg-black rounded-xl"
        ></video>
      {/if}
    </MediaLightbox>
  {/if}
{/if}
