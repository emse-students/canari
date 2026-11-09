<script lang="ts">
  import { untrack } from 'svelte';
  import { arbitratePlayback } from '$lib/actions/playbackArbiter';
  import { FileText, Download, Image as ImageIcon, LoaderCircle, Mic } from '@lucide/svelte';
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
  import {
    chooseSegmentedPlayback,
    FEED_STREAM_PACING,
    VIEWER_STREAM_PACING,
    openSegmentedStream,
    type SegmentedStreamHandle,
  } from '$lib/utils/segmentedMediaStream';
  import { mediaUrl } from '$lib/utils/apiUrl';
  import { resolveMediaType, reservesAspectRatio } from '$lib/utils/mediaLayout';
  import { formatFileSize } from '$lib/utils/fileSize';
  import { isPdfAttachment } from '$lib/utils/pdfThumbnail';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import PdfThumbnail from '$lib/components/shared/PdfThumbnail.svelte';
  import PdfViewerModal from '$lib/components/shared/PdfViewerModal.svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import VideoPlayer from '$lib/components/shared/VideoPlayer.svelte';
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import MediaSpinner from '$lib/components/shared/MediaSpinner.svelte';
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
    /** How a letterboxed VIDEO fills the box: the whole frame (`contain`, the feed's rule) or cropped (`cover`, a square gallery cell). */
    videoFit?: 'contain' | 'cover';
    /**
     * Hold the download until the card comes near the viewport.
     *
     * A feed mounts every attachment of every card it renders, including cards well below the
     * fold, and a four-image gallery is four downloads. On a bad link those queue ahead of the
     * `listPosts` page the reader is actually waiting for. The OWNER of the box decides, because
     * the box is what an `IntersectionObserver` can watch: this component renders a different root
     * per media type and has none of its own. Defaults to `false`, so a lightbox or any other call
     * site that knows the media is on screen is unaffected.
     *
     * A VIDEO THAT BECOMES DEFERRED AGAIN GIVES EVERYTHING BACK: its owner reports the card leaving
     * the viewport band (`nearViewport`'s `onleave`), the stream is closed - its segment in flight
     * aborted - and the `<video>` unmounts, decoder and all; the poster stands in until the card
     * comes back, which opens a new stream. A deferred video takes no warm blob either: holding a
     * decoder for a card nobody can see is the cost the reels audit measured (2026-10-11).
     */
    deferred?: boolean;
    /** The post's publisher and date, for the viewer's title and information panel. */
    postInfo?: Pick<MediaViewerInfo, 'senderName' | 'sentAt'>;
    /** `galleryMode` only: draw the video with the reel viewer's minimal player (`VideoPlayer`). */
    minimalPlayer?: boolean;
    /** With `minimalPlayer`: whether its line pads for the home indicator (the frame reaches the bottom). */
    playerSafeBottom?: boolean;
    /**
     * `galleryMode` only: a picture of the video's first frame, drawn while the file loads and
     * until the player holds that frame (the reel viewer's poster, `reelPosters.svelte.ts`).
     */
    poster?: string | null;
    /** Called with the decrypted URL once the WHOLE file is in this device's media pool. */
    onLoaded?: (url: string) => void;
    /**
     * `galleryMode` only: told once the media will not show by itself - its player was refused,
     * interrupted or failed the autoplay (`refused`, `interrupted`, `errored` - `videoAutoplay.ts`),
     * refused the bytes (`unplayable`), or the download failed (`failed`). The reel viewer stops
     * waiting on it then.
     */
    onPlaybackBlocked?: (
      cause: 'refused' | 'interrupted' | 'errored' | 'unplayable' | 'failed'
    ) => void;
    /**
     * Told WHY the download failed, typed (`mediaFailureCause`), once per failure. A conversation's
     * reel reads `expired` (the `410`) to record the loss on its message (RC-6); nothing else
     * branches on it here.
     */
    onFailure?: (cause: MediaFailureCause) => void;
    /**
     * A FILE drawn as one row of a list - no preview, and NO DOWNLOAD UNTIL ASKED (owner,
     * 2026-11-02: a post with several PDFs was one very long column). The row comes from the
     * metadata the post already holds; the tap, or the download button, fetches the file and then
     * does what was asked. Ignored for anything that is not a generic file.
     */
    compact?: boolean;
    /**
     * `galleryMode` only: whether the download spinner is announced to assistive tech. False for a
     * page drawn ahead of the reader (the reel viewer's preloading neighbour), which is not on screen.
     */
    announceLoading?: boolean;
  }

  let {
    media,
    authToken,
    onOpen,
    galleryMode = false,
    letterbox = false,
    videoFit = 'contain',
    deferred = false,
    postInfo,
    minimalPlayer = false,
    playerSafeBottom = true,
    poster = null,
    onLoaded,
    onPlaybackBlocked,
    onFailure,
    compact = false,
    announceLoading = true,
  }: Props = $props();

  // A failed download is decided: the caller stops waiting on this media.
  $effect(() => {
    if (failure && onPlaybackBlocked) untrack(() => onPlaybackBlocked('failed'));
  });

  // ...and told why, for the one caller that keeps a record of it.
  $effect(() => {
    const cause = failure;
    if (cause && onFailure) untrack(() => onFailure(cause));
  });

  // The whole file is in the pool: the caller may draw from it (a reel's first frame).
  $effect(() => {
    if (blobUrl && onLoaded) {
      const url = blobUrl;
      untrack(() => onLoaded(url));
    }
  });

  let blobUrl = $state<string | null>(null);
  /**
   * A segmented video's MSE URL while it streams (`segmentedMediaStream.ts`) - for the ONE inline
   * player, since an MSE URL cannot feed two elements. The lightbox and the download wait for
   * `blobUrl`, which the stream fills from the very segments it played once the last one is in.
   */
  let streamUrl = $state<string | null>(null);
  /** Whether that stream runs through Safari's `ManagedMediaSource`. */
  let streamManaged = $state(false);
  /** Hands a finished stream's whole file to the pool - set by the download effect while it runs. */
  let adoptStreamed: ((blob: Blob) => void) | null = null;
  /**
   * The stream itself while there is one. Outside the viewer it is PACED (`FEED_STREAM_PACING`):
   * the head, then what the inline element is about to play - a card scrolled past without being
   * watched never downloads the whole reel.
   */
  let stream = $state.raw<SegmentedStreamHandle | null>(null);
  /** Hands the inline `<video>` to the paced stream - a new function per stream, so it re-attaches. */
  const attachStream = $derived(
    stream ? (video: HTMLVideoElement) => stream?.attach(video) : undefined
  );
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

  /** A compact row: drawn from metadata, the file fetched only once the reader asks for it. */
  const compactFile = $derived(compact && mediaType === 'file');

  const isPdf = $derived(mediaType === 'file' && isPdfAttachment(media.mimeType, media.fileName));

  /** The media as the download reads it - built from the prop, never tracked through it. */
  function buildMediaRef(): MediaRef {
    return {
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
  }

  /**
   * WHAT THE DOWNLOAD DEPENDS ON, AS A VALUE. The feed replaces its list with the server's answer -
   * the stored copy, then the page - and every post in it is a NEW object carrying the SAME media.
   * Tracked through the object, that re-ran the effect: the stream closed and reopened on the same
   * `<video>`, whose `play()` the reload interrupted (two `[media-seg] stream` lines 133 ms apart and
   * one `play() refused` per cold start, Mi 9T v1.2.9-alpha.3). A string changes only when the media
   * does.
   */
  const mediaIdentity = $derived(JSON.stringify(buildMediaRef()));

  $effect(() => {
    void attempt;
    void mediaIdentity;
    if (!authToken) {
      loading = false;
      authMissing = true;
      return;
    }
    authMissing = false;
    const mediaRef = untrack(buildMediaRef);

    // A deferred VIDEO holds nothing, not even a warm blob: a mounted `<video>` with a source is a
    // decoder, and a card outside the band is one nobody sees. The poster draws the same either
    // way - an inline video shows it until its first frame decodes. A viewer the card's tap opened
    // and that is still waiting for the file goes with it: the stream it waited on is closed.
    if (deferred && mediaType === 'video') {
      loading = true;
      failure = null;
      lightboxOpen = false;
      return;
    }

    // Already decrypted in memory - a page rebuilt by a tab swipe: drawn in this very frame instead
    // of a placeholder the reader watches turn into what was just there. Deferred or not for a
    // PICTURE; a deferred video returned above.
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

    // A compact row holds nothing until it is asked for: a post of ten PDFs is ten rows, not ten
    // downloads the reader may never want (`activate`).
    if (compactFile && !asked) {
      loading = false;
      failure = null;
      return;
    }

    // Still far from the viewport: the placeholder is already the right thing on screen, so the
    // download waits rather than competing with the page the reader IS looking at. A compact row
    // the reader TAPPED is not deferred: they asked for it, whatever the observer thinks.
    if (deferred && !(compactFile && asked)) return;

    let destroyed = false;
    let acquired = false;
    loading = true;
    failure = null;

    // A SEGMENTED VIDEO THAT CAN STREAM PLAYS AS IT ARRIVES. The choice is made from facts the ref
    // already holds (`chooseSegmentedPlayback`) and never by trying: everything else - every legacy
    // blob included - takes the whole-blob path below, which reads both formats.
    const playback = mediaType === 'video' ? chooseSegmentedPlayback(mediaRef) : null;
    if (playback?.kind === 'stream') {
      // The viewer (`galleryMode`) is paced too, further ahead: it starts on its head and never
      // waits for the whole file (a 33 MB video took 26 s to start, production 1.6.8).
      const opened = openSegmentedStream(
        mediaRef,
        mediaUrl(),
        playback,
        galleryMode ? VIEWER_STREAM_PACING : FEED_STREAM_PACING
      );
      stream = opened;
      streamUrl = opened.url;
      streamManaged = playback.managed;
      loading = false;
      /** The whole file, from whichever stream finished it first: the card's or the viewer's fork. */
      const adopt = (blob: Blob) => {
        if (destroyed || acquired) return;
        blobUrl = adoptDecryptedMediaBlob(mediaRef, blob);
        acquired = true;
      };
      adoptStreamed = adopt;
      opened.done.then(adopt).catch((err) => {
        if (destroyed) return;
        streamUrl = null;
        // The same vocabulary as the whole-blob path: a segment refused for what it holds is
        // `corrupt`, a range that never arrived is `unreachable` - typed at the throw.
        failure = mediaFailureCause(err);
        logMediaFailure('PostMedia', failure, media.mediaId, err);
      });
      return () => {
        destroyed = true;
        adoptStreamed = null;
        opened.close();
        if (acquired) releaseDecryptedMediaBlobUrl(mediaRef);
        acquired = false;
        stream = null;
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

  /** A compact row's file was asked for (its tap or its download button): the download may start. */
  let asked = $state(false);
  /** What the reader asked of a compact row, to run once its file is in. */
  let pendingAction = $state<'open' | 'download' | null>(null);

  /** A compact row's file is being fetched because the reader asked: the row shows it. */
  const busy = $derived(compactFile && asked && loading);
  /** A compact row's file arrived for a SAVE: it waits for a tap of its own (see `activate`). */
  let saveReady = $state(false);

  /**
   * Opens or saves the file.
   *
   * - Ready (a full card, a warm blob, or a row whose fetch is done): it happens now, inside the tap.
   * - A compact row not yet fetched: the request is remembered and the fetch starts. THE FIRST
   *   REQUEST WINS: while one is pending, further taps are ignored (they used to overwrite it).
   *   An OPEN runs as soon as the file is in - showing the viewer needs no gesture. A SAVE does
   *   not: a download started from an effect, long after the tap, is the call WKWebView and Tauri
   *   may refuse, so the row turns to "ready - tap to save" and the save runs on THAT tap.
   * - A failure drops the pending request. After "Reessayer" the file arrives and the row is
   *   simply ready: the reader taps again, and the tap acts at once.
   */
  function activate(action: 'open' | 'download') {
    Log.d('PostMedia.activate', {
      action,
      mediaId: media.mediaId,
      ready: blobUrl !== null,
      pending: pendingAction,
    });
    if (blobUrl) {
      saveReady = false;
      if (action === 'open') pdfViewerOpen = true;
      else downloadBlob(blobUrl, media.fileName ?? (isPdf ? 'document.pdf' : 'file'));
      return;
    }
    if (pendingAction) {
      Log.d('PostMedia.activate', { ignored: action, kept: pendingAction });
      return;
    }
    pendingAction = action;
    asked = true;
  }

  $effect(() => {
    if (!pendingAction) return;
    if (failure) {
      Log.d('PostMedia.activate', { dropped: pendingAction, after: failure });
      pendingAction = null;
      return;
    }
    if (!blobUrl) return;
    const action = pendingAction;
    pendingAction = null;
    if (action === 'open') pdfViewerOpen = true;
    else saveReady = true;
  });

  let lightboxOpen = $state(false);
  let pdfViewerOpen = $state(false);

  /**
   * THE VIEWER OF A STREAMING VIDEO IS A FORK OF ITS STREAM, NOT A WAIT FOR THE FILE (owner,
   * 2026-11-09: 26 s before the viewer of a 33 MB video played, with the head already appended and
   * the card playing). An MSE URL feeds one element, so the viewer gets its own - over the SAME
   * segment feed, so what the card fetched is not fetched again and what the viewer fetches is the
   * card's too. It plays once ITS head is in, paced like the card but further ahead. Closing the
   * viewer closes the fork only. A whole file that arrives meanwhile (from either stream) does not
   * swap the viewer's source: the video would restart at 0.
   */
  let viewerStream = $state.raw<SegmentedStreamHandle | null>(null);
  const attachViewer = $derived(
    viewerStream ? (video: HTMLVideoElement) => viewerStream?.attach(video) : undefined
  );
  $effect(() => {
    if (!lightboxOpen || !stream || untrack(() => blobUrl)) return;
    const fork = stream.fork();
    viewerStream = fork;
    let gone = false;
    fork.done
      .then((blob) => adoptStreamed?.(blob))
      .catch((err) => {
        if (gone) return;
        const cause = mediaFailureCause(err);
        logMediaFailure('PostMedia.viewer', cause, media.mediaId, err);
      });
    return () => {
      gone = true;
      fork.close();
      viewerStream = null;
    };
  });

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
    activate('open');
  }
</script>

{#if galleryMode}
  <!-- Inside parent gallery lightbox - just render the content -->
  {#if loading}
    <!-- THE DOWNLOAD IS THE WAIT, AND IT IS SAID (Mi 9T, 400 kbps: ~55 s of a bare image icon before
         the player mounted). The first-frame poster, when there is one, stays under the spinner. -->
    <div
      class="relative flex h-full min-h-[12rem] w-full items-center justify-center"
      data-media-loading
    >
      {#if poster}
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          class="pointer-events-none h-full w-full object-contain select-none"
          data-video-first-frame-poster
        />
      {/if}
      <MediaSpinner live={announceLoading} />
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
      <VideoPlayer
        src={playUrl!}
        disableRemotePlayback={streamManaged}
        streamed={streamUrl !== null}
        onVideo={attachStream}
        class="h-full w-full"
        variant={minimalPlayer ? 'reel' : 'lightbox'}
        safeBottom={playerSafeBottom}
        {poster}
        {onPlaybackBlocked}
      />
    {:else}
      <div class="flex flex-col items-center gap-3 text-white/80">
        <FileText size={48} strokeWidth={1.5} />
        <span class="text-sm font-medium">{media.fileName ?? m.post_media_file_label()}</span>
      </div>
    {/if}
  {/if}
{:else}
  <!-- Standalone rendering -->
  {#if compactFile && !failure && !authMissing}
    <!-- A compact row never waits on its download: it is drawn from metadata alone. -->
    {@render fileCard()}
  {:else if loading}
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
      <!-- `data-double-tap-defers`: on a post card the viewer opens once the double-tap window has
           passed, since a second tap on the picture likes the post (`doubleTapLike`). -->
      <button
        type="button"
        onclick={handleClick}
        class="group/img block h-full w-full cursor-zoom-in outline-none focus-visible:z-10 focus-visible:ring-4 focus-visible:ring-amber-500/50"
        aria-label={m.post_zoom_image_label()}
        data-double-tap-defers
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
           reserves it at the video's own shape under the `--media-max-height` ceiling, and the
           video is CONTAINED in it: the whole frame, the sides filled by a blurred copy of its first frame (`VideoPlayer` `backdrop`)
           (user, 2026-10-22; a gallery cell passes `videoFit="cover"`, its square being the point). It used to draw its own 16:9 box inside that reservation,
           which put a phone's vertical clip in a narrow strip over a grey band (Mi 9T, 2026-09-29).
           It was cropped (`object-cover`) until 2026-10-22, which cut a portrait clip. -->
      <VideoPlayer
        variant="feed"
        src={playUrl!}
        disableRemotePlayback={streamManaged}
        streamed={streamUrl !== null}
        onVideo={attachStream}
        onOpen={() => (onOpen ? onOpen() : (lightboxOpen = true))}
        openLabel={m.post_fullscreen_label()}
        backdrop={letterbox && videoFit === 'contain'}
        class={letterbox
          ? videoFit === 'contain'
            ? 'bg-cn-card h-full w-full'
            : 'h-full w-full bg-black'
          : 'aspect-video w-full max-w-md rounded-3xl bg-black/10 shadow-sm dark:bg-black/40'}
        videoClass="relative h-full w-full {letterbox && videoFit === 'cover'
          ? 'object-cover object-center'
          : 'object-contain'}"
      />
    {:else if mediaType === 'audio'}
      <!-- ========== AUDIO ========== -->
      <div class="w-full max-w-md overflow-hidden rounded-3xl bg-black/5 dark:bg-white/5">
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio use:arbitratePlayback src={blobUrl} controls preload="metadata" class="h-12 w-full"
        ></audio>
      </div>
    {:else}
      {@render fileCard()}
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
  <!-- A STREAMED video's viewer opens AT THE TAP, on the poster, and plays from its own fork of the
       stream (`viewerStream` above) as soon as its head is in: waiting for `blobUrl` here made a tap
       on a paced feed video do nothing until the last segment, then pop the viewer up unasked
       (review of #1744), and waiting for the file kept a 33 MB video from starting for 26 s. -->
  {#if lightboxOpen && (blobUrl || streamUrl) && (mediaType === 'image' || mediaType === 'video')}
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
             that is still STREAMING, the MSE URL feeds the one inline element only, so the viewer
             plays its own fork of the stream; the poster shows only until the fork exists. -->
        {#if viewerStream}
          <VideoPlayer
            src={viewerStream.url}
            streamed
            disableRemotePlayback={streamManaged}
            onVideo={attachViewer}
            class="h-full w-full"
          />
        {:else if blobUrl}
          <VideoPlayer src={blobUrl} class="h-full w-full" />
        {:else}
          <div class="relative h-full w-full"><VideoPoster /></div>
        {/if}
      {/if}
    </MediaLightbox>
  {/if}
{/if}

<!-- THE FILE CARD: a header row (icon, name, size, download) and, for a lone PDF, the first page.
     `compact` is a document among several (owner, 2026-11-02): the row alone, no preview. -->
{#snippet fileCard()}
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
      <p class="text-text-muted text-2xs font-semibold">
        {formatFileSize(media.size)}
      </p>
      {#if saveReady}
        <p class="text-2xs font-semibold text-amber-700 dark:text-amber-400" data-save-ready-hint>
          {m.post_file_ready_to_save()}
        </p>
      {/if}
    </div>
  {/snippet}

  <div
    class="group/file w-full max-w-full overflow-hidden rounded-2xl border border-black/5 bg-black/5 transition-colors dark:border-white/10 dark:bg-white/10"
    aria-busy={busy}
    data-file-card
    data-busy={busy ? '' : undefined}
    data-save-ready={saveReady ? '' : undefined}
  >
    <div class="flex items-center gap-3.5 px-3.5 {compactFile ? 'py-2' : 'py-3'}">
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
          activate('download');
        }}
        class="ui-icon-button rounded-xl transition-all outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-amber-500 dark:hover:bg-white/10"
        aria-label={m.post_download_label()}
      >
        {#if busy}
          <LoaderCircle
            size={18}
            strokeWidth={2.5}
            class="animate-spin opacity-70"
            data-file-spinner
          />
        {:else}
          <Download
            size={18}
            strokeWidth={2.5}
            class="{saveReady
              ? 'text-amber-700 dark:text-amber-400'
              : 'opacity-70'} transition-opacity group-hover/file:opacity-100"
          />
        {/if}
      </button>
    </div>
    {#if isPdf && !compactFile}
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
{/snippet}
