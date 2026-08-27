<script lang="ts">
  import { m } from '$lib/paraglide/messages';
  import {
    FileText,
    Download,
    CircleAlert,
    Image as ImageIcon,
    Video as VideoIcon,
    Mic,
  } from '@lucide/svelte';
  import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
  import type { MediaRef } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
  import AppLink from '$lib/components/shared/AppLink.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';

  interface Props {
    /** Parsed media descriptor from the message envelope, or null for text-only messages. */
    mediaRef: MediaRef | null;
    /** Decrypted object URL for the media blob, or null while loading. */
    blobUrl: string | null;
    /** True when the media failed to download or decrypt. */
    loadError: boolean;
    /** True when the media was removed by the 30-day retention policy. */
    mediaPurgedByRetention: boolean;
    /** Caption text shown below the media (or the full text for text-only messages). */
    textContent: string;
    /** When true, adjusts colours for the amber bubble used on own messages. */
    isOwn?: boolean;
    /** Pre-split text+link segments used to render the caption with clickable links. */
    textSegments?: Array<{ type: 'text' | 'link'; value: string }>;
    /** Called when the user clicks a link inside the caption. */
    onNavigateLink?: (e: MouseEvent) => void;
  }

  let {
    mediaRef = null,
    blobUrl = null,
    loadError = false,
    mediaPurgedByRetention = false,
    textContent = '',
    isOwn = false,
    textSegments = [],
    onNavigateLink: _onNavigateLink,
  }: Props = $props();

  let showLightbox = $state(false);
  let showPdfViewer = $state(false);

  function openLightbox(e: MouseEvent) {
    e.stopPropagation();
    if (!blobUrl) return;
    showLightbox = true;
  }

  function closeLightbox() {
    showLightbox = false;
  }

  // Dynamic classes adapt to the message bubble background.
  // isOwn = amber background (dark text); !isOwn = glassmorphism light/dark (theme-adaptive text).
  const glassBoxClass = $derived(
    isOwn
      ? 'bg-black/10 border-black/10 text-cn-ink'
      : 'bg-black/5 dark:bg-white/10 border-black/5 dark:border-white/10'
  );

  const textMutedClass = $derived(isOwn ? 'text-cn-ink/70' : 'text-text-muted');

  const imageAspectStyle = $derived(
    mediaRef?.type === 'image' ? mediaAspectStyle(mediaRef.width, mediaRef.height) : ''
  );

  const isPdf = $derived(
    mediaRef?.type === 'file' && isPdfAttachment(mediaRef.mimeType, mediaRef.fileName)
  );

  /** Saves the decrypted bytes; on Tauri an anchor download would silently do nothing. */
  function downloadBlob(url: string, fileName: string) {
    void downloadDecryptedFile(url, fileName);
  }

  /** Opens the in-app PDF reader from the attachment row. */
  function openPdfViewer(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!blobUrl) return;
    showPdfViewer = true;
  }
</script>

{#if mediaRef}
  <div class="overflow-hidden rounded-[1.1rem]">
    <!-- ================= IMAGE ================= -->
    {#if mediaRef.type === 'image'}
      {#if blobUrl}
        <div class="group/media relative inline-block">
          <!--
            `w-56 max-w-full`, never `w-full`: the wrapper is `inline-block`, so its width comes from
            its content, and a percentage width inside it has nothing definite to resolve against -
            it collapses to the image's intrinsic size. Above `sm` an explicit `sm:w-56` hid that, so
            a small picture only looked wrong on a phone: a 64 px thumbnail under a 36 px download
            button. An explicit width at every breakpoint keeps the box constant whatever the file's
            own dimensions are.
          -->
          <button
            type="button"
            onclick={openLightbox}
            onpointerdown={(e) => e.stopPropagation()}
            aria-label={m.msg_open_image_fullscreen_label()}
            class="block w-56 max-w-full overflow-hidden rounded-[1.1rem] bg-black/5 dark:bg-white/5"
            style={imageAspectStyle}
          >
            <img
              src={blobUrl}
              alt={mediaRef.fileName ?? m.msg_shared_image_alt()}
              class="h-full w-full cursor-zoom-in object-cover object-top transition-transform duration-500 md:group-hover/media:scale-[1.02]"
            />
          </button>

          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef.fileName ?? 'image');
            }}
            class="absolute right-2.5 bottom-2.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white shadow-lg backdrop-blur-md transition-all duration-300 outline-none hover:scale-110 hover:bg-black/70 focus:opacity-100 md:opacity-0 md:group-hover/media:opacity-100"
            aria-label={m.msg_download_image_label()}
            title={m.common_download_label()}
          >
            <Download size={16} strokeWidth={2.5} />
          </button>
        </div>
      {:else if loadError}
        <div
          class="w-full max-w-xs rounded-[1.1rem] border border-dashed sm:w-64 {glassBoxClass} flex flex-col items-center justify-center gap-3 p-4 text-center"
          style={imageAspectStyle}
        >
          <CircleAlert size={28} class="opacity-50" />
          <span class="text-xs leading-snug font-medium {textMutedClass}">
            {mediaPurgedByRetention ? m.msg_media_expired_label() : m.msg_image_load_error()}
          </span>
        </div>
      {:else}
        <!-- Skeleton Image -->
        <div
          class="w-full max-w-[14rem] rounded-[1.1rem] sm:w-56 {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} flex animate-pulse items-center justify-center"
          style={imageAspectStyle}
        >
          <ImageIcon size={32} class="opacity-20" />
        </div>
      {/if}

      <!-- ================= VIDEO ================= -->
    {:else if mediaRef.type === 'video'}
      {#if blobUrl}
        <div class="group/media relative inline-block">
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            src={blobUrl}
            controls
            preload="metadata"
            onclick={(e) => e.stopPropagation()}
            class="max-h-80 max-w-full rounded-[1.1rem] bg-black/10 shadow-sm sm:max-w-md dark:bg-black/40"
          ></video>

          <button
            type="button"
            onclick={openLightbox}
            class="absolute bottom-2.5 left-2.5 inline-flex h-8 items-center justify-center rounded-full bg-black/50 px-2.5 text-white shadow-lg backdrop-blur-md transition-all duration-300 hover:bg-black/70"
            aria-label={m.msg_open_video_fullscreen_label()}
            title={m.msg_fullscreen_label()}
          >
            {m.msg_fullscreen_label()}
          </button>

          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef.fileName ?? 'video.mp4');
            }}
            class="absolute top-2.5 right-2.5 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white shadow-lg backdrop-blur-md transition-all duration-300 outline-none hover:scale-110 hover:bg-black/70 focus:opacity-100 md:opacity-0 md:group-hover/media:opacity-100"
            aria-label={m.msg_download_video_label()}
            title={m.common_download_label()}
          >
            <Download size={16} strokeWidth={2.5} />
          </button>
        </div>
      {:else if loadError}
        <div
          class="aspect-video w-full max-w-[16rem] rounded-[1.1rem] border border-dashed {glassBoxClass} flex flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <CircleAlert size={28} class="opacity-50" />
          <span class="text-xs leading-snug font-medium {textMutedClass}">
            {mediaPurgedByRetention ? m.msg_video_expired_label() : m.msg_video_load_error()}
          </span>
        </div>
      {:else}
        <!-- Skeleton Video -->
        <div
          class="aspect-video w-full max-w-[16rem] rounded-[1.1rem] {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} flex animate-pulse items-center justify-center"
        >
          <VideoIcon size={32} class="opacity-20" />
        </div>
      {/if}

      <!-- ================= AUDIO ================= -->
    {:else if mediaRef.type === 'audio'}
      {#if blobUrl}
        <div class="min-w-[200px] sm:min-w-[240px]">
          <VoiceMessagePlayer
            src={blobUrl}
            onDownload={() => downloadBlob(blobUrl!, mediaRef.fileName ?? 'vocal.webm')}
          />
        </div>
      {:else if loadError}
        <div
          class="h-14 w-full rounded-xl border border-dashed sm:w-56 {glassBoxClass} flex items-center justify-center px-4 text-center"
        >
          <span class="text-[0.7rem] leading-snug font-medium {textMutedClass}">
            {mediaPurgedByRetention ? m.msg_audio_expired_label() : m.msg_audio_load_error()}
          </span>
        </div>
      {:else}
        <!-- Skeleton Audio -->
        <div
          class="h-14 w-full rounded-xl sm:w-56 {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} flex animate-pulse items-center justify-center px-4"
        >
          <Mic size={20} class="opacity-20" />
          <div class="ml-3 h-2 flex-1 rounded-full bg-current opacity-10"></div>
        </div>
      {/if}

      <!-- ================= GENERIC FILE ================= -->
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex w-full max-w-full items-center gap-3.5 rounded-[1rem] border px-3.5 py-3 {glassBoxClass} group/file backdrop-blur-md transition-colors"
        ontouchstart={(e) => e.stopPropagation()}
        ontouchend={(e) => e.stopPropagation()}
      >
        {#snippet fileRowContent()}
          <!-- File icon, or the PDF's own first page once it is decrypted. -->
          <div
            class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-current/10 text-current opacity-80"
          >
            {#if isPdf && blobUrl}
              <PdfThumbnail
                url={blobUrl}
                maxWidth={44}
                imgClass="w-full h-full object-cover object-top"
              >
                {#snippet fallback()}
                  <FileText size={22} strokeWidth={2} />
                {/snippet}
              </PdfThumbnail>
            {:else}
              <FileText size={22} strokeWidth={2} />
            {/if}
          </div>

          <!-- File metadata. -->
          <div class="min-w-0 flex-1 overflow-hidden text-left">
            <p class="mb-0.5 truncate text-[0.85rem] leading-tight font-bold">
              {mediaRef!.fileName ?? m.msg_attached_file_label()}
            </p>
            {#if !mediaPurgedByRetention}
              <!-- No `uppercase`: it would render the "Ko" unit as "KO". -->
              <p class="text-[0.65rem] font-semibold tracking-wider opacity-60">
                {formatFileSize(mediaRef!.size)}
              </p>
            {/if}
          </div>
        {/snippet}

        {#if isPdf && blobUrl}
          <!-- The row opens the document; the download button beside it is carved out of the
               clickable area, which is why this button wraps the content rather than the row. -->
          <button
            type="button"
            onclick={openPdfViewer}
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-current"
            aria-label={m.pdf_open_document_label()}
          >
            {@render fileRowContent()}
          </button>
        {:else}
          {@render fileRowContent()}
        {/if}

        <!-- Actions -->
        {#if blobUrl}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef!.fileName ?? 'fichier');
            }}
            aria-label={m.msg_download_file_label()}
            title={m.common_download_label()}
            class="shrink-0 rounded-xl p-2.5 transition-all outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current"
          >
            <Download
              size={18}
              strokeWidth={2.5}
              class="opacity-70 transition-opacity group-hover/file:opacity-100"
            />
          </button>
        {:else if mediaPurgedByRetention}
          <span
            class="shrink-0 rounded-md bg-red-500/10 px-2 py-1 text-[0.65rem] font-bold text-red-600 dark:text-red-400"
          >
            {m.msg_expired_label()}
          </span>
        {:else if loadError}
          <CircleAlert size={18} class="shrink-0 text-red-500 opacity-50" />
        {:else}
          <div
            class="h-8 w-8 shrink-0 animate-spin rounded-full border-2 border-current/20 border-t-current"
          ></div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Caption text below the media. -->
  {#if textContent}
    <p class="mt-2 text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap select-text">
      {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
        {#if segment.type === 'link'}
          <AppLink href={segment.value} />
        {:else}
          {segment.value}
        {/if}
      {/each}
    </p>
  {/if}
{/if}

{#if showPdfViewer && blobUrl && mediaRef}
  <PdfViewerModal
    url={blobUrl}
    fileName={mediaRef.fileName ?? m.msg_attached_file_label()}
    onClose={() => (showPdfViewer = false)}
    onDownload={() => downloadBlob(blobUrl, mediaRef.fileName ?? 'document.pdf')}
  />
{/if}

{#if showLightbox && blobUrl && mediaRef && (mediaRef.type === 'image' || mediaRef.type === 'video')}
  <MediaLightbox
    open={showLightbox}
    onClose={closeLightbox}
    title={mediaRef.fileName ?? m.msg_media_label()}
    onDownload={() => downloadBlob(blobUrl, mediaRef.fileName ?? 'media')}
  >
    {#if mediaRef.type === 'image'}
      <img
        src={blobUrl}
        alt={mediaRef.fileName ?? m.msg_shared_image_alt()}
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
