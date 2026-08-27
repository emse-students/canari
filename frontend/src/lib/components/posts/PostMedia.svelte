<script lang="ts">
  import {
    FileText,
    Download,
    CircleAlert,
    Image as ImageIcon,
    ImageOff,
    Video as VideoIcon,
    Mic,
  } from '@lucide/svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef, MediaType } from '$lib/media';
  import { releaseDecryptedMediaBlobUrl } from '$lib/utils/mediaBlobCache';
  import { isMediaPurgedError } from '$lib/utils/mediaErrors';
  import { resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
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
  /** Purged by the 30-day retention: a permanent absence, not a failure to retry. */
  let mediaExpired = $state(false);

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
    mediaExpired = false;

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
        if (destroyed) return;
        if (isMediaPurgedError(err)) {
          // Retention GC, not a failure: say so, and never in red.
          mediaExpired = true;
          loadError = m.post_media_expired_label();
        } else {
          // The raw message used to be rendered as-is - a dev string shown to the user.
          console.error('[PostMedia] media download failed', err);
          loadError = m.post_image_load_error();
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
  let pdfViewerOpen = $state(false);

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

  /** Saves the decrypted bytes; on Tauri an anchor download would silently do nothing. */
  function downloadBlob(url: string, name: string) {
    void downloadDecryptedFile(url, name);
  }

  /** Opens the in-app PDF reader. Bound to the whole card - header and preview alike. */
  function openPdfViewer(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!blobUrl) return;
    pdfViewerOpen = true;
  }
</script>

{#if galleryMode}
  <!-- Inside parent gallery lightbox - just render the content -->
  {#if loading}
    <div class="flex min-h-[12rem] w-full items-center justify-center">
      <ImageIcon size={32} class="animate-pulse text-white opacity-20" strokeWidth={1.5} />
    </div>
  {:else if loadError}
    <div class="flex flex-col items-center justify-center gap-2 p-4 text-center text-white/60">
      {#if mediaExpired}
        <ImageOff size={24} strokeWidth={2} />
      {:else}
        <CircleAlert size={24} strokeWidth={2} />
      {/if}
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
        class="max-h-full max-w-full rounded-xl bg-black object-contain"
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
        class="absolute inset-0 flex animate-pulse items-center justify-center bg-black/5 dark:bg-white/5"
      >
        <ImageIcon size={32} class="text-text-muted opacity-20" strokeWidth={1.5} />
      </div>
    {:else if mediaType === 'video'}
      <div
        class="flex aspect-video w-full max-w-md animate-pulse items-center justify-center rounded-[1.1rem] bg-black/5 dark:bg-white/10"
      >
        <VideoIcon size={32} class="text-text-muted opacity-20" />
      </div>
    {:else if mediaType === 'audio'}
      <div
        class="flex h-14 w-full animate-pulse items-center justify-center rounded-xl bg-black/5 px-4 sm:w-56 dark:bg-white/10"
      >
        <Mic size={20} class="text-text-muted opacity-20" />
        <div class="ml-3 h-2 flex-1 rounded-full bg-current opacity-10"></div>
      </div>
    {:else}
      <!-- Same footprint as the loaded file card, so nothing jumps on arrival. -->
      <div
        class="flex w-full animate-pulse items-center gap-3.5 rounded-[1rem] bg-black/5 px-3.5 py-3 dark:bg-white/10"
      >
        <div
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-black/10 dark:bg-white/10"
        >
          <FileText size={22} class="text-text-muted opacity-20" strokeWidth={1.5} />
        </div>
        <div class="h-2.5 flex-1 rounded-full bg-black/10 dark:bg-white/10"></div>
      </div>
    {/if}
  {:else if loadError}
    <div
      class="{fillsReservedBox ? 'absolute inset-0' : 'w-full rounded-2xl'} {mediaExpired
        ? 'border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/5'
        : 'border-red-500/20 bg-red-500/5 dark:bg-red-500/10'} flex flex-col items-center justify-center gap-2 border border-dashed p-4 text-center"
    >
      {#if mediaExpired}
        <ImageOff size={24} class="text-text-muted opacity-70" strokeWidth={2} />
        <span class="text-text-muted text-xs font-medium">{loadError}</span>
      {:else}
        <CircleAlert size={24} class="text-red-500 opacity-70" strokeWidth={2} />
        <span class="text-xs font-semibold text-red-600 dark:text-red-400">{loadError}</span>
      {/if}
    </div>
  {:else if blobUrl}
    {#if mediaType === 'image'}
      <!-- ========== IMAGE ========== -->
      <button
        type="button"
        onclick={handleClick}
        class="group/img block h-full w-full cursor-zoom-in outline-none focus-visible:z-10 focus-visible:ring-4 focus-visible:ring-amber-500/50"
        aria-label={m.post_zoom_image_label()}
      >
        <img
          src={blobUrl}
          alt={media.fileName ?? m.post_image_alt()}
          class="h-full w-full object-cover object-top transition-transform duration-700 group-hover/img:scale-105"
          loading="lazy"
        />
      </button>
    {:else if mediaType === 'video'}
      <!-- ========== VIDEO ========== -->
      <div
        class="group/media relative aspect-video w-full max-w-md overflow-hidden rounded-[1.1rem] bg-black/10 shadow-sm dark:bg-black/40"
      >
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={blobUrl} controls preload="metadata" class="h-full w-full object-contain"
        ></video>
        <button
          type="button"
          onclick={handleClick}
          class="absolute bottom-2.5 left-2.5 inline-flex h-8 items-center justify-center rounded-full bg-black/50 px-2.5 text-xs font-bold text-white shadow-lg backdrop-blur-md transition-all duration-300 hover:bg-black/70"
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
          class="absolute top-2.5 right-2.5 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white shadow-lg backdrop-blur-md transition-all duration-300 outline-none hover:scale-110 hover:bg-black/70 focus:opacity-100 md:opacity-0 md:group-hover/media:opacity-100"
          aria-label={m.post_download_label()}
        >
          <Download size={16} strokeWidth={2.5} />
        </button>
      </div>
    {:else if mediaType === 'audio'}
      <!-- ========== AUDIO ========== -->
      <div class="w-full max-w-md overflow-hidden rounded-[1.1rem] bg-black/5 dark:bg-white/5">
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio src={blobUrl} controls preload="metadata" class="h-12 w-full"></audio>
      </div>
    {:else}
      <!-- ========== GENERIC FILE ========== -->
      {#snippet fileRowContent()}
        <div
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-black/10 dark:bg-white/10"
        >
          <FileText size={22} strokeWidth={2} class="text-text-muted" />
        </div>
        <div class="min-w-0 flex-1 overflow-hidden text-left">
          <p class="mb-0.5 truncate text-[0.85rem] leading-tight font-bold">
            {media.fileName ?? m.post_media_file_label()}
          </p>
          <!-- No `uppercase` here: it would render the "Ko" unit as "KO". -->
          <p class="text-text-muted text-[0.65rem] font-semibold tracking-wider">
            {formatFileSize(media.size)}
          </p>
        </div>
      {/snippet}

      <div
        class="group/file w-full max-w-full overflow-hidden rounded-2xl border border-black/5 bg-black/5 backdrop-blur-md transition-colors dark:border-white/10 dark:bg-white/10"
      >
        <div class="flex items-center gap-3.5 px-3.5 py-3">
          {#if isPdf}
            <!-- The whole header opens the document; only the download button is carved out
                 of it, which is why it cannot simply wrap the row. -->
            <button
              type="button"
              onclick={openPdfViewer}
              class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              aria-label={m.pdf_open_document_label()}
            >
              {@render fileRowContent()}
            </button>
          {:else}
            {@render fileRowContent()}
          {/if}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, media.fileName ?? 'file');
            }}
            class="shrink-0 rounded-xl p-2.5 transition-all outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/10"
            aria-label={m.post_download_label()}
          >
            <Download
              size={18}
              strokeWidth={2.5}
              class="opacity-70 transition-opacity group-hover/file:opacity-100"
            />
          </button>
        </div>
        {#if isPdf}
          <!-- A post is wide enough to show the page itself; the row keeps its
               icon so the document is never rendered twice. The preview repeats the header's
               action rather than adding a second tab stop, hence tabindex -1. -->
          <button
            type="button"
            onclick={openPdfViewer}
            tabindex="-1"
            aria-hidden="true"
            class="block w-full cursor-pointer"
          >
            <PdfThumbnail
              url={blobUrl}
              maxWidth={640}
              imgClass="w-full max-h-[22rem] object-contain object-top border-t border-black/5 dark:border-white/10 bg-white"
            />
          </button>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- In-app PDF reader -->
  {#if pdfViewerOpen && blobUrl}
    <PdfViewerModal
      url={blobUrl}
      fileName={media.fileName ?? m.post_media_file_label()}
      onClose={() => (pdfViewerOpen = false)}
      onDownload={() => downloadBlob(blobUrl!, media.fileName ?? 'document.pdf')}
    />
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
          class="max-h-full max-w-full rounded-xl bg-black object-contain"
        ></video>
      {/if}
    </MediaLightbox>
  {/if}
{/if}
