<script lang="ts">
  import InlineVideo from '$lib/components/shared/InlineVideo.svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    FileText,
    Download,
    CircleAlert,
    Image as ImageIcon,
    Video as VideoIcon,
    Mic,
    RotateCw,
  } from '@lucide/svelte';
  import MediaLoadFailure from '$lib/components/shared/MediaLoadFailure.svelte';
  import { isRetryableMediaFailure, type MediaFailureCause } from '$lib/utils/mediaErrors';
  import { mediaFailureLabel } from '$lib/utils/mediaFailureLabel';
  import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
  import type { MediaRef } from '$lib/media';
  import { mediaAspectStyle } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
  import AppLink from '$lib/components/shared/AppLink.svelte';
  import MessageInlineText from './MessageInlineText.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { nearViewport } from '$lib/actions/nearViewport';

  interface Props {
    /** Parsed media descriptor from the message envelope, or null for text-only messages. */
    mediaRef: MediaRef | null;
    /** Decrypted object URL for the media blob, or null while loading. */
    blobUrl: string | null;
    /** Why the media could not be shown (`mediaFailureCause`), or null while it can still arrive. */
    failure: MediaFailureCause | null;
    /** Downloads it again in place; the failure box offers it when a retry can help. */
    onRetry?: () => void;
    /** Caption text shown below the media (or the full text for text-only messages). */
    textContent: string;
    /** When true, adjusts colours for the amber bubble used on own messages. */
    isOwn?: boolean;
    /**
     * Pre-split text+link segments used to render the caption with clickable links - the text runs
     * between them go through {@link MessageInlineText}, which is what resolves a mention to a
     * name. Printing `segment.value` here is what showed a raw `@[64-hex]` under a photo.
     */
    textSegments?: Array<{ type: 'text' | 'link'; value: string }>;
    /** Called when the user clicks a link inside the caption. */
    onNavigateLink?: (e: MouseEvent) => void;
    /**
     * Called once, the first time this row comes near the viewport.
     *
     * The DOWNLOAD is the caller's, so the gate on it has to be too: `MessageBubble` renders a
     * dozen mutually exclusive branches and has no single element to observe, while this component
     * has exactly one whenever there is media at all.
     */
    onNear?: () => void;
    /** Who sent the message, for the viewer's information panel. */
    senderId?: string;
    /** When the message was sent: the viewer's title and its information panel. */
    sentAt?: Date;
  }

  let {
    mediaRef = null,
    blobUrl = null,
    failure = null,
    onRetry,
    textContent = '',
    isOwn = false,
    textSegments = [],
    onNavigateLink: _onNavigateLink,
    onNear,
    senderId,
    sentAt,
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

  /** Red is unreadable on one's own amber bubble, so the failure box speaks in its ink there. */
  const failureTone = $derived(isOwn ? 'ink' : 'surface');

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
  <!-- THE ROW'S ONE ELEMENT THAT ALWAYS EXISTS WHEN THERE IS MEDIA, which is why the viewport
       hook lives here and the download it gates lives in `MessageBubble`: that component renders
       a dozen mutually exclusive branches and has no root of its own to observe. -->
  <div class="overflow-hidden rounded-3xl" use:nearViewport={{ onnear: () => onNear?.() }}>
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
            class="block w-56 max-w-full overflow-hidden rounded-3xl bg-black/5 dark:bg-white/5"
            style={imageAspectStyle}
          >
            <img
              src={blobUrl}
              alt={mediaRef.fileName ?? m.msg_shared_image_alt()}
              class="h-full w-full cursor-zoom-in object-cover object-center transition-transform duration-500 md:group-hover/media:scale-[1.02]"
            />
          </button>

          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef.fileName ?? 'image');
            }}
            class="absolute right-2.5 bottom-2.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white shadow-lg transition-all duration-300 outline-none hover:scale-110 hover:bg-black/70 focus:opacity-100 md:opacity-0 md:group-hover/media:opacity-100"
            aria-label={m.msg_download_image_label()}
            title={m.common_download_label()}
          >
            <Download size={16} strokeWidth={2.5} />
          </button>
        </div>
      {:else if failure}
        <div
          class="w-full max-w-xs rounded-3xl border border-dashed sm:w-64 {glassBoxClass} flex items-center justify-center p-4"
          style={imageAspectStyle}
        >
          <MediaLoadFailure
            cause={failure}
            expiredLabel={m.msg_media_expired_label()}
            otherLabel={m.msg_image_load_error()}
            {onRetry}
            tone={failureTone}
          />
        </div>
      {:else}
        <!-- Skeleton Image -->
        <div
          class="w-full max-w-[14rem] rounded-3xl sm:w-56 {isOwn
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
        <!-- THE FEED'S VIDEO, NOT THE ENGINE'S (2026-10-01). This was a native `controls` element
             with a "Plein ecran" pill and a download button laid over it - the very picture the
             feed left on 2026-09-29 (Android's grey bar over the clip). A conversation's video now
             plays like the feed's: by itself while on screen, muted by the app's one sound answer,
             a tap opening the viewer, whose player carries the controls and the download. -->
        <div
          class="w-56 max-w-full overflow-hidden rounded-3xl bg-black shadow-sm"
          style={mediaAspectStyle(mediaRef.width, mediaRef.height, 16 / 9)}
        >
          <InlineVideo
            src={blobUrl}
            onOpen={() => (showLightbox = true)}
            openLabel={m.msg_open_video_fullscreen_label()}
            class="h-full w-full"
            videoClass="h-full w-full object-cover object-center"
          />
        </div>
      {:else if failure}
        <div
          class="aspect-video w-full max-w-[16rem] rounded-3xl border border-dashed {glassBoxClass} flex items-center justify-center p-4"
        >
          <MediaLoadFailure
            cause={failure}
            expiredLabel={m.msg_video_expired_label()}
            otherLabel={m.msg_video_load_error()}
            {onRetry}
            tone={failureTone}
          />
        </div>
      {:else}
        <!-- Skeleton Video -->
        <div
          class="aspect-video w-full max-w-[16rem] rounded-3xl {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} flex animate-pulse items-center justify-center"
        >
          <VideoIcon size={32} class="opacity-20" />
        </div>
      {/if}

      <!-- ================= AUDIO ================= -->
    {:else if mediaRef.type === 'audio'}
      {#if blobUrl}
        <!--
          THE BUBBLE HAS 351px ON A PHONE AND THIS ASKED FOR 200 (measured on A1, Mi 9T, 436 x 945
          CSS px, 2026-09-14). A `min-w` with no `w` IS the width: the bubble shrink-wraps, so the
          player landed at its floor and left 151px of the row unused. Inside that 200, the fixed
          furniture takes 174 - a 44px play button and its 14px gap, two 36px controls and theirs,
          and 28px of padding - which left the timestamp line 26px to draw two stamps needing 54.
          They touched, and "0:00" beside "0:01" read as "0:000:01" (user, 2026-09-14).

          `w-[20rem]` ASKS, `max-w-full` OBEYS THE BUBBLE. 320px gives the middle column 146px, so
          the two stamps have 92px between them; where the bubble is narrower than that - 298px at a
          375px window, 252px at 320px - the cap clamps it and nothing overflows.
        -->
        <div class="w-[20rem] max-w-full">
          <VoiceMessagePlayer
            src={blobUrl}
            onDownload={() => downloadBlob(blobUrl!, mediaRef.fileName ?? 'vocal.webm')}
          />
        </div>
      {:else if failure}
        <div
          class="min-h-14 w-full rounded-xl border border-dashed sm:w-56 {glassBoxClass} flex items-center justify-center px-3 py-1"
        >
          <MediaLoadFailure
            cause={failure}
            expiredLabel={m.msg_audio_expired_label()}
            otherLabel={m.msg_audio_load_error()}
            {onRetry}
            tone={failureTone}
            compact
          />
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
        class="flex w-full max-w-full items-center gap-3.5 rounded-3xl border px-3.5 py-3 {glassBoxClass} group/file transition-colors"
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
            <p class="mb-0.5 truncate text-xs leading-tight font-bold">
              {mediaRef!.fileName ?? m.msg_attached_file_label()}
            </p>
            {#if failure && failure !== 'other' && failure !== 'expired'}
              <!-- A file row has no box to fill, so the cause is its second line. -->
              <p class="text-2xs leading-tight font-semibold opacity-70">
                {mediaFailureLabel(failure, {
                  expired: m.msg_expired_label(),
                  other: m.msg_image_load_error(),
                })}
              </p>
            {:else if !failure}
              <!-- No `uppercase`: it would render the "Ko" unit as "KO". -->
              <p class="text-2xs font-semibold tracking-wider opacity-60">
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
            class="ui-icon-button rounded-xl transition-all outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current"
          >
            <Download
              size={18}
              strokeWidth={2.5}
              class="opacity-70 transition-opacity group-hover/file:opacity-100"
            />
          </button>
        {:else if failure === 'expired'}
          <span
            class="text-2xs shrink-0 rounded-md bg-red-500/10 px-2 py-1 font-bold text-red-600 dark:text-red-400"
          >
            {m.msg_expired_label()}
          </span>
        {:else if failure && onRetry && isRetryableMediaFailure(failure)}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
            aria-label={m.media_retry_button()}
            title={m.media_retry_button()}
            class="ui-icon-button rounded-xl text-red-500 transition-all outline-none hover:bg-current/10 focus-visible:ring-2 focus-visible:ring-current"
          >
            <RotateCw size={18} strokeWidth={2.5} />
          </button>
        {:else if failure}
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
    <p class="mt-2 text-sm leading-relaxed wrap-break-word whitespace-pre-wrap select-text">
      {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
        {#if segment.type === 'link'}
          <AppLink href={segment.value} />
        {:else}
          <MessageInlineText text={segment.value} />
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
    info={{
      senderId,
      sentAt,
      fileName: mediaRef.fileName,
      sizeBytes: mediaRef.size,
      width: mediaRef.width,
      height: mediaRef.height,
    }}
    onDownload={() => downloadBlob(blobUrl, mediaRef.fileName ?? 'media')}
  >
    {#if mediaRef.type === 'image'}
      <img
        src={blobUrl}
        alt={mediaRef.fileName ?? m.msg_shared_image_alt()}
        class="max-h-full max-w-full object-contain select-none"
      />
    {:else}
      <VideoPlayer src={blobUrl} class="h-full w-full" />
    {/if}
  </MediaLightbox>
{/if}
