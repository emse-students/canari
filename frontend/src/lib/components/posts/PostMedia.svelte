<script lang="ts">
  import { arbitratePlayback } from '$lib/actions/playbackArbiter';
  import { FileText, Download, Image as ImageIcon, Mic } from '@lucide/svelte';
  import MediaLoadFailure from '$lib/components/shared/MediaLoadFailure.svelte';
  import { Log } from '$lib/utils/Log';
  import LetterboxedImage from '$lib/components/shared/LetterboxedImage.svelte';
  import { MediaService } from '$lib/media';
  import type { MediaRef, MediaType } from '$lib/media';
  import {
    adoptDecryptedMediaBlob,
    releaseDecryptedMediaBlobUrl,
    retainWarmDecryptedMediaBlobUrl,
  } from '$lib/utils/mediaBlobCache';
  import {
    isRetryableMediaFailure,
    logMediaFailure,
    mediaFailureCause,
    type MediaFailureCause,
  } from '$lib/utils/mediaErrors';
  import { chooseSegmentedPlayback, openSegmentedStream } from '$lib/utils/segmentedMediaStream';
  import { mediaUrl } from '$lib/utils/apiUrl';
  import { resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import InlineVideo from '$lib/components/shared/InlineVideo.svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import type { MediaViewerInfo } from '$lib/utils/mediaViewerInfo';
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
      /** How the blob is sealed - see `MediaRef.encoding`. Absent: the single block. */
      encoding?: string;
    };
    /** Non-empty once the session is authenticated; the download resolves its own live token. */
    authToken: string;
    /** When set, clicking the image calls this instead of opening its own lightbox. */
    onOpen?: () => void;
    /** When true, renders the image/video filling its container (used inside gallery lightbox). */
    galleryMode?: boolean;
    /**
     * Show the WHOLE picture, and fill whatever the box has left over with the picture itself.
     *
     * TRUE wherever the box's width is imposed by something other than the picture - a single
     * attachment stacked under the post text, where the card sets the width and the ceiling sets
     * the height, so the two rarely agree with the picture's own shape. FALSE for the multi-image
     * grid, whose square cells are square ON PURPOSE and where filling the cell is the point - except
     * for a VIDEO cell, which sets it: for a clip it means "fill the caller's box, cropped", where
     * without it the clip draws its own 16:9 card inside the square.
     *
     * The fill is the same already-decrypted blob drawn again as a blurred `cover` layer, under a
     * veil of `--cn-surface`. That is deliberately not a dominant-colour extraction: no canvas, no
     * pixel read, no worker, no second decrypt - and the bands still come from the picture's own
     * colours by construction, with the theme holding them.
     */
    letterbox?: boolean;
    /**
     * Hold the download until the card comes near the viewport.
     *
     * A feed mounts every attachment of every card it renders, including cards well below the
     * fold, and a four-image gallery is four downloads. On a bad link those queue ahead of the
     * `listPosts` page the reader is actually waiting for. The OWNER of the box decides, because
     * the box is what an `IntersectionObserver` can watch: this component renders a different root
     * per media type and has none of its own. Defaults to `false`, so a lightbox or any other call
     * site that knows the media is on screen is unaffected.
     */
    deferred?: boolean;
    /** The post's publisher and date, for the viewer's title and information panel. */
    postInfo?: Pick<MediaViewerInfo, 'senderName' | 'sentAt'>;
  }

  let {
    media,
    authToken,
    onOpen,
    galleryMode = false,
    letterbox = false,
    deferred = false,
    postInfo,
  }: Props = $props();

  let blobUrl = $state<string | null>(null);
  /**
   * A segmented video's MSE URL while it streams (`segmentedMediaStream.ts`) - for the ONE inline
   * player, since an MSE URL cannot feed two elements. The lightbox and the download wait for
   * `blobUrl`, which the stream fills from the very segments it played once the last one is in.
   */
  let streamUrl = $state<string | null>(null);
  /** Whether that stream runs through Safari's `ManagedMediaSource`. */
  let streamManaged = $state(false);
  /** What the inline player shows: the stream while there is one, the blob otherwise. */
  const playUrl = $derived(streamUrl ?? blobUrl);
  let loading = $state(true);
  /** Set when no session token was handed down: nothing can be asked for. */
  let authMissing = $state(false);
  /** Why the media could not be shown, typed at the throw - see `mediaFailureCause`. */
  let failure = $state<MediaFailureCause | null>(null);
  /** Bumped by "Reessayer": the download effect reads it, so a bump runs it again in place. */
  let attempt = $state(0);

  const mediaType = $derived<MediaType>(resolveMediaType(media));

  // The caller only reserves a box for picture-shaped media, so a file/audio
  // placeholder must take part in the flow instead of filling a parent that has
  // no height of its own.
  const fillsReservedBox = $derived(reservesAspectRatio(mediaType));

  const isPdf = $derived(mediaType === 'file' && isPdfAttachment(media.mimeType, media.fileName));

  $effect(() => {
    void attempt;
    if (!authToken) {
      loading = false;
      authMissing = true;
      return;
    }
    authMissing = false;
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
      ...(media.encoding ? { encoding: media.encoding } : {}),
    };

    // Already decrypted in memory - a page rebuilt by a tab swipe: drawn in this very frame,
    // deferred or not, instead of a placeholder the reader watches turn into what was just there.
    const warm = retainWarmDecryptedMediaBlobUrl(mediaRef);
    if (warm) {
      blobUrl = warm;
      loading = false;
      failure = null;
      return () => {
        releaseDecryptedMediaBlobUrl(mediaRef);
        blobUrl = null;
      };
    }

    // Still far from the viewport: the placeholder is already the right thing on screen, so the
    // download waits rather than competing with the page the reader IS looking at.
    if (deferred) return;

    let destroyed = false;
    let acquired = false;
    loading = true;
    failure = null;

    // A SEGMENTED VIDEO THAT CAN STREAM PLAYS AS IT ARRIVES. The choice is made from facts the ref
    // already holds (`chooseSegmentedPlayback`) and never by trying: everything else - every legacy
    // blob included - takes the whole-blob path below, which reads both formats.
    const playback = mediaType === 'video' ? chooseSegmentedPlayback(mediaRef) : null;
    if (playback?.kind === 'stream') {
      const stream = openSegmentedStream(mediaRef, mediaUrl(), playback);
      streamUrl = stream.url;
      streamManaged = playback.managed;
      loading = false;
      stream.done
        .then((blob) => {
          if (destroyed) return;
          blobUrl = adoptDecryptedMediaBlob(mediaRef, blob);
          acquired = true;
        })
        .catch((err) => {
          if (destroyed) return;
          streamUrl = null;
          // The same vocabulary as the whole-blob path: a segment refused for what it holds is
          // `corrupt`, a range that never arrived is `unreachable` - typed at the throw.
          failure = mediaFailureCause(err);
          logMediaFailure('PostMedia', failure, media.mediaId, err);
        });
      return () => {
        destroyed = true;
        stream.close();
        if (acquired) releaseDecryptedMediaBlobUrl(mediaRef);
        acquired = false;
        streamUrl = null;
        blobUrl = null;
      };
    }
    // A segmented blob that cannot stream here says why; a single block is the ordinary case.
    if (playback && playback.reason !== 'single-block') {
      console.debug(`[PostMedia] ${mediaRef.mediaId}: segmented, read whole (${playback.reason})`);
    }

    const mediaService = new MediaService();
    // Leaves the gate's queue if the card is torn down before its turn comes.
    const abort = new AbortController();

    mediaService
      .downloadAndDecrypt(mediaRef, abort.signal)
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
        failure = mediaFailureCause(err);
        logMediaFailure('PostMedia', failure, media.mediaId, err);
      })
      .finally(() => {
        if (!destroyed) loading = false;
      });

    return () => {
      destroyed = true;
      abort.abort();
      if (acquired) releaseDecryptedMediaBlobUrl(mediaRef);
      acquired = false;
      blobUrl = null;
    };
  });

  /** "Reessayer": the same effect again, in place - no reload, the rest of the feed untouched. */
  function retry() {
    Log.d('PostMedia.retry', { after: failure, mediaId: media.mediaId });
    attempt += 1;
  }

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
  {:else if authMissing}
    <div class="p-4 text-center text-xs text-white/60">{m.post_missing_auth_token()}</div>
  {:else if failure}
    <div class="p-4">
      <MediaLoadFailure
        cause={failure}
        expiredLabel={m.post_media_expired_label()}
        otherLabel={m.post_image_load_error()}
        onRetry={retry}
        tone="dark"
      />
    </div>
  {:else if blobUrl || streamUrl}
    {#if mediaType === 'image'}
      <img
        src={blobUrl}
        alt={media.fileName ?? m.post_image_alt()}
        class="max-h-full max-w-full object-contain select-none"
      />
    {:else if mediaType === 'video'}
      <!-- A streamed `playUrl` reaches the element untouched: `VideoPlayer` never appends to it. -->
      <VideoPlayer src={playUrl!} disableRemotePlayback={streamManaged} class="h-full w-full" />
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
      <!-- Canari's poster, the one a player shows before its first frame: a camera icon pulsing in
           the middle read as a stray logo on the Mi 9T (2026-09-29), and a flat black box as a
           broken one (2026-10-01). -->
      <div
        class="relative overflow-hidden {letterbox
          ? 'h-full w-full'
          : 'aspect-video w-full max-w-md rounded-3xl'}"
      >
        <VideoPoster />
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
        class="flex w-full animate-pulse items-center gap-3.5 rounded-3xl bg-black/5 px-3.5 py-3 dark:bg-white/10"
      >
        <div
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-black/10 dark:bg-white/10"
        >
          <FileText size={22} class="text-text-muted opacity-20" strokeWidth={1.5} />
        </div>
        <div class="h-2.5 flex-1 rounded-full bg-black/10 dark:bg-white/10"></div>
      </div>
    {/if}
  {:else if authMissing}
    <p class="text-text-muted w-full p-4 text-center text-xs">{m.post_missing_auth_token()}</p>
  {:else if failure}
    <div
      class="{fillsReservedBox
        ? 'absolute inset-0'
        : 'w-full rounded-2xl'} {isRetryableMediaFailure(failure)
        ? 'border-red-500/20 bg-red-500/5 dark:bg-red-500/10'
        : 'border-black/10 bg-black/5 dark:border-white/10 dark:bg-white/5'} flex items-center justify-center border border-dashed p-4"
    >
      <MediaLoadFailure
        cause={failure}
        expiredLabel={m.post_media_expired_label()}
        otherLabel={m.post_image_load_error()}
        onRetry={retry}
      />
    </div>
  {:else if blobUrl || streamUrl}
    <!-- Only a VIDEO is ever streamed (`streamUrl`), so every other branch below runs with
         `blobUrl` set - the assertions on it say that, which the guard cannot. -->
    {#if mediaType === 'image'}
      <!-- ========== IMAGE ========== -->
      <button
        type="button"
        onclick={handleClick}
        class="group/img block h-full w-full cursor-zoom-in outline-none focus-visible:z-10 focus-visible:ring-4 focus-visible:ring-amber-500/50"
        aria-label={m.post_zoom_image_label()}
      >
        <!-- NO HOVER ZOOM WHEN THE WHOLE PICTURE IS THE POINT: scaling a contained picture past
             its box crops it again, which is the defect this branch exists to end. The grid cell
             keeps the zoom, having been cropped by design already.

             THE LETTERBOX TREATMENT MOVED TO `LetterboxedImage` ON 2026-09-20, unchanged, because
             two other places need it - the agenda's poster and a shared post's preview card - and a
             blurred fill written three times is three chances to drift apart. This caller RESERVES
             the shape (`mediaAspectStyle` already sized the box), so the picture takes `h-full`
             rather than a ceiling. -->
        {#if letterbox}
          <LetterboxedImage
            src={blobUrl!}
            alt={media.fileName ?? m.post_image_alt()}
            class="h-full w-full"
            imgClass="h-full"
          />
        {:else}
          <img
            src={blobUrl}
            alt={media.fileName ?? m.post_image_alt()}
            class="h-full w-full object-cover object-center transition-transform duration-700 group-hover/img:scale-105"
            loading="lazy"
            decoding="async"
          />
        {/if}
      </button>
    {:else if mediaType === 'video'}
      <!-- ========== VIDEO ========== -->
      <!-- UNDER A SINGLE-ATTACHMENT POST THE BOX IS THE CALLER'S (`letterbox`): `PostContent`
           reserves it at the video's own shape, so the video FILLS it, cropped only by the
           `--media-max-height` ceiling. It used to draw its own 16:9 box inside that reservation,
           which put a phone's vertical clip in a narrow strip over a grey band (Mi 9T, 2026-09-29).
           Cropping is right for a video where it is not for a still: the poster rule
           (`mediaAspectStyle`) is about text at the edge of a picture, a clip's subject is in its
           middle, and the whole frame is one tap away in the viewer. -->
      <InlineVideo
        src={playUrl!}
        disableRemotePlayback={streamManaged}
        streamed={streamUrl !== null}
        onOpen={() => (onOpen ? onOpen() : (lightboxOpen = true))}
        openLabel={m.post_fullscreen_label()}
        class={letterbox
          ? 'h-full w-full bg-black'
          : 'aspect-video w-full max-w-md rounded-3xl bg-black/10 shadow-sm dark:bg-black/40'}
        videoClass="h-full w-full {letterbox ? 'object-cover object-center' : 'object-contain'}"
      />
    {:else if mediaType === 'audio'}
      <!-- ========== AUDIO ========== -->
      <div class="w-full max-w-md overflow-hidden rounded-3xl bg-black/5 dark:bg-white/5">
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio use:arbitratePlayback src={blobUrl} controls preload="metadata" class="h-12 w-full"
        ></audio>
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
          <p class="mb-0.5 truncate text-xs leading-tight font-bold">
            {media.fileName ?? m.post_media_file_label()}
          </p>
          <!-- No `uppercase` here: it would render the "Ko" unit as "KO". -->
          <p class="text-text-muted text-2xs font-semibold tracking-wider">
            {formatFileSize(media.size)}
          </p>
        </div>
      {/snippet}

      <div
        class="group/file w-full max-w-full overflow-hidden rounded-2xl border border-black/5 bg-black/5 transition-colors dark:border-white/10 dark:bg-white/10"
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
            class="ui-icon-button rounded-xl transition-all outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/10"
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
              url={blobUrl!}
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
      info={{
        ...postInfo,
        fileName: media.fileName,
        sizeBytes: media.size,
        width: media.width,
        height: media.height,
      }}
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
        <!-- Canari's player, never the engine's `controls` (`VideoPlayer`). Opened from a video
             that is still STREAMING, the viewer has no `blobUrl` yet - the MSE URL feeds the one
             inline element only - so it shows the poster until the last segment fills it. -->
        {#if blobUrl}
          <VideoPlayer src={blobUrl} class="h-full w-full" />
        {:else}
          <div class="relative h-full w-full"><VideoPoster /></div>
        {/if}
      {/if}
    </MediaLightbox>
  {/if}
{/if}
