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
  import MediaFrame from '$lib/components/shared/MediaFrame.svelte';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
  import AppLink from '$lib/components/shared/AppLink.svelte';
  import MessageInlineText from './MessageInlineText.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { nearViewport } from '$lib/actions/nearViewport';
  import ChatReelTile from './ChatReelTile.svelte';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import { isReelMessage, isReelMessageExpired, reelMessageAsPost } from '$lib/reels/chatReel';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

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
    /**
     * The picture or video fills the top of its bubble edge to edge, and the caption sits under it
     * in the same bubble (Messenger's and WhatsApp's). Set by `MessageBubble` for a photo or a video
     * that carries text: the bubble clips the media's corners, so this only cancels the bubble's own
     * padding around it and the media's own rounding.
     */
    bleed?: boolean;
    /** Who sent the message, for the viewer's information panel. */
    senderId?: string;
    /** When the message was sent: the viewer's title and its information panel. */
    sentAt?: Date;
    /** The message's id: a received reel's viewer keys its slide, and names a saved file, by it. */
    messageId?: string;
    /** Bearer token the reel viewer's own download resolves; a tile fetches nothing without a tap. */
    authToken?: string;
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
    bleed = false,
    senderId,
    sentAt,
    messageId = '',
    authToken = '',
  }: Props = $props();

  /**
   * A CanaReel SENT IN A CONVERSATION is a tile, not a video. Decided by the sender's declared
   * intent, never by the file name or the bytes - a picked clip stays an ordinary video.
   */
  const isReel = $derived(isReelMessage(mediaRef));
  let showReelViewer = $state(false);
  /** The hint, read when the row is drawn: a tombstone needs no request to be told it is one. */
  const reelExpired = $derived(!!mediaRef && isReel && isReelMessageExpired(mediaRef, Date.now()));
  const reelSenderName = $derived(senderId ? getUserDisplayNameSync(senderId, senderId) : '');
  const reelPost = $derived(
    showReelViewer && mediaRef && isReel
      ? reelMessageAsPost({
          messageId: messageId || mediaRef.mediaId,
          media: mediaRef,
          caption: textContent,
          senderName: reelSenderName,
          sentAt: sentAt ?? new Date(),
        })
      : null
  );

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

  /**
   * What an image or video frame shows behind its layers: the bubble-aware tone until the bytes are
   * drawn, then a near-transparent tone under a picture and black under a clip (its letterbox).
   */
  const frameSurfaceClass = $derived(
    blobUrl && mediaRef?.type === 'video'
      ? 'bg-black shadow-sm'
      : blobUrl
        ? 'bg-black/5 dark:bg-white/5'
        : isOwn
          ? 'bg-black/10'
          : 'bg-black/5 dark:bg-white/10'
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
  <div
    class="overflow-hidden {bleed ? '-mx-3 -mt-2' : 'rounded-3xl'}"
    use:nearViewport={{ onnear: () => onNear?.() }}
  >
    <!-- ================= IMAGE / VIDEO ================= -->
    <!-- ONE FRAME FOR THE SKELETON, THE FAILURE AND THE MEDIA (user, 2026-10-02: "le LAYOUT SHIFTING
         c'est tres mauvais"). Each state used to draw its own box - the skeleton `max-w-[14rem]`, the
         failure `max-w-xs`, a video skeleton 16:9 whatever the clip - so the row moved when the bytes
         landed. The frame is sized from what the MESSAGE declares, before a byte is downloaded, and
         every state is a layer inside it. `w-56`, or `w-68` under a caption: an explicit width at
         every breakpoint, because the bubble is `w-fit` and a percentage has nothing to resolve
         against. docs/wiki/frontend/media-frame.md -->
    {#if isReel}
      <ChatReelTile
        {mediaRef}
        expired={reelExpired}
        senderName={reelSenderName}
        sentAt={sentAt ?? new Date()}
        {bleed}
        onOpen={() => (showReelViewer = true)}
      />
    {:else if mediaRef.type === 'image' || mediaRef.type === 'video'}
      <MediaFrame
        width={mediaRef.width}
        height={mediaRef.height}
        measureKey={mediaRef.mediaId || undefined}
        fallbackAspect={mediaRef.type === 'video' ? 16 / 9 : undefined}
        placeholder={mediaRef.type === 'image' || !blobUrl ? mediaRef.placeholder : undefined}
        class="group/media max-w-full {bleed ? 'w-68' : 'w-56 rounded-3xl'} {frameSurfaceClass}"
      >
        {#snippet children(frame)}
          {#if blobUrl && mediaRef.type === 'image'}
            <button
              type="button"
              onclick={openLightbox}
              onpointerdown={(e) => e.stopPropagation()}
              aria-label={m.msg_open_image_fullscreen_label()}
              class="absolute inset-0 block"
            >
              <img
                src={blobUrl}
                alt={mediaRef.fileName ?? m.msg_shared_image_alt()}
                onload={frame.onLoad}
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
          {:else if blobUrl}
            <!-- THE FEED'S VIDEO, NOT THE ENGINE'S (2026-10-01): plays by itself while on screen,
                 muted by the app's one sound answer, a tap opening the viewer. ITS OWN SHAPE, NEVER
                 CROPPED (user, 2026-10-02): CONTAINED in the frame, so past the height ceiling it
                 letterboxes on the black rather than losing its edges. -->
            <InlineVideo
              src={blobUrl}
              onOpen={() => (showLightbox = true)}
              onMetadata={frame.onLoad}
              manualPlay
              openLabel={m.msg_open_video_fullscreen_label()}
              class="absolute inset-0"
              videoClass="h-full w-full object-contain object-center"
            />
          {:else if failure}
            <!-- `compact`: the frame of a 4:1 panorama is 56 px tall, and the failure must fit the
                 box the picture would have had rather than re-shape the row. The frame's own
                 `overflow-hidden` rounds this layer's corners. -->
            <div
              class="absolute inset-0 flex items-center justify-center border border-dashed p-2 {glassBoxClass}"
            >
              <MediaLoadFailure
                cause={failure}
                expiredLabel={mediaRef.type === 'video'
                  ? m.msg_video_expired_label()
                  : m.msg_media_expired_label()}
                otherLabel={mediaRef.type === 'video'
                  ? m.msg_video_load_error()
                  : m.msg_image_load_error()}
                {onRetry}
                tone={failureTone}
                compact
              />
            </div>
          {:else}
            <div class="absolute inset-0 flex animate-pulse items-center justify-center">
              {#if mediaRef.type === 'video'}
                <VideoIcon size={32} class="opacity-20" />
              {:else}
                <ImageIcon size={32} class="opacity-20" />
              {/if}
            </div>
          {/if}
        {/snippet}
      </MediaFrame>
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
          class="h-[5.25rem] w-[20rem] max-w-full rounded-2xl border border-dashed {glassBoxClass} flex items-center justify-center px-3 py-1"
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
        <!-- Skeleton Audio. THE PLAYER'S BOX, NOT A SMALLER ONE (2026-10-02): it was `h-14` and
             `w-full` - 56 px tall, and a percentage width inside a `w-fit` bubble - so the row grew
             by 28 px when the recording decrypted. `w-[20rem] max-w-full` is the player's own width
             below, and 5.25rem the player's height measured at 436 px (one 44 px button, the
             timestamp line, `py-3` and the border). -->
        <div
          class="h-[5.25rem] w-[20rem] max-w-full rounded-2xl {isOwn
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
    <!-- Under a bleeding media the bubble is exactly the media's width (`w-68`, 17rem): a width in
         PERCENT would resolve against a bubble that is itself sized by its content and balloon it
         over the whole row, so the caption wraps at that width less the bubble's side padding. -->
    <p
      class="text-sm leading-relaxed wrap-break-word whitespace-pre-wrap select-text {bleed
        ? 'mt-1.5 w-[calc(17rem-1.5rem)] max-w-full'
        : 'mt-2'}"
    >
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

{#if reelPost}
  <!-- THE FEED'S REEL VIEWER, on this one reel: it downloads and streams on its own (nothing was
       fetched by the tile), shows the sender and the age, and carries the save beside the volume.
       No further page: a conversation's reels are not the feed's. -->
  <ReelViewer
    startPost={reelPost}
    {authToken}
    onClose={() => (showReelViewer = false)}
    loadPage={async () => []}
  />
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
      <VideoPlayer src={blobUrl} soundScope="local" class="h-full w-full" />
    {/if}
  </MediaLightbox>
{/if}
