<script lang="ts">
  /**
   * ONE MEDIA OF A CANAREELS PAGE: a reel's video, a photo page's picture, or one picture or video of
   * a carousel page (owner, 2026-11-06). `ReelSlide` draws the page around it - the frame, the
   * caption, the rail - and one pane per media; this is everything that belongs to ONE media: its
   * download, its player, its first frame, and the moment it SETTLES.
   *
   * ONLY THE ACTIVE PANE MOUNTS A PLAYER (`active`: the visible media of the page on screen). A video
   * anywhere else draws its FIRST FRAME as a picture (`reelPosters`, else the publisher's ThumbHash),
   * because every mounted player counts as an open viewer and claims playback
   * (`followVideoSound`) - so in a carousel only the visible video plays, and a swipe to the next
   * media pauses it by unmounting it, the same rule as a swipe to the next post.
   *
   * `preload` fetches the media ahead (`reelViewerNav.carouselMediaRole` says which): a picture
   * mounts, a video is fetched by `ReelPreload` when it is worth it (`worthPreloading`), so the
   * player takes the warm path the moment the swipe lands.
   *
   * EVERY VIEW OF A VIDEO ENDS IN ONE INFO LINE (`[reel-view]`, owner, 2026-11-09): whether its first
   * frame came and when, else where its load stopped (`reels/reelViewOutcome.ts`) - the in-app log
   * records no debug, and a reel that neither failed nor played left nothing in it.
   */
  import { untrack } from 'svelte';
  import PostMedia from '$lib/components/posts/PostMedia.svelte';
  import type { PostMediaRef } from '$lib/posts/api';
  import type { MediaFailureCause } from '$lib/utils/mediaErrors';
  import type { FullScreenMediaKind } from '$lib/reels/fullScreenPost';
  import { ReelPreload, worthPreloading } from '$lib/reels/reelPreload';
  import { captureReelPoster, reelPosterUrl } from '$lib/reels/reelPosters.svelte';
  import { placeholderDataUrl } from '$lib/utils/mediaPlaceholder';
  import { Log } from '$lib/utils/Log';
  import { mediaRequestGate } from '$lib/utils/requestGate';
  import { chooseSegmentedPlayback, streamProgressOf } from '$lib/utils/segmentedMediaStream';
  import { ReelView, reelSourceKind, type ReelViewEvent } from '$lib/reels/reelViewOutcome';

  interface Props {
    /** The post the media belongs to, for the log lines. */
    postId: string;
    media: PostMediaRef;
    kind: FullScreenMediaKind;
    authToken: string;
    /** The visible media of the page on screen: a video plays, the settle is reported. */
    active: boolean;
    /** Fetched ahead of being shown. */
    preload: boolean;
    /** Drawn at all: off, the pane is an empty box that keeps its place in a carousel's strip. */
    show: boolean;
    /** Whether the frame reaches the screen bottom: the player's progress line clears the inset. */
    playerSafeBottom: boolean;
    /** The active media is SETTLED: whole and, for a video, playing (or decidedly failed). */
    onReady?: () => void;
    /** The media service answered `410`: the file is gone for good. */
    onMediaGone?: () => void;
  }

  let {
    postId,
    media,
    kind,
    authToken,
    active,
    preload,
    show,
    playerSafeBottom,
    onReady,
    onMediaGone,
  }: Props = $props();

  const video = $derived(kind === 'video' ? media : undefined);

  /**
   * WHAT A VIDEO SHOWS BEFORE ITS FIRST FRAME IS DECODED (owner, 2026-10-31: never a play glyph on a
   * loading reel): the sharp first frame this device decoded (`reelPosters`), else the publisher's
   * ThumbHash of it, else nothing - the frame's black. A picture not yet mounted shows its ThumbHash.
   */
  const posterUrl = $derived(
    video
      ? (reelPosterUrl(video.mediaId) ?? placeholderDataUrl(video.placeholder))
      : placeholderDataUrl(media.placeholder)
  );
  /** The file is whole on this device (`PostMedia`'s `onLoaded`). */
  let loaded = $state(false);
  /** The player of this pane has started playing. */
  let playing = $state(false);
  /**
   * The media will not show by itself (`PostMedia`'s `onPlaybackBlocked`: an autoplay refused or
   * failed, bytes the engine refused, a download that failed). A decided failure SETTLES the pane
   * too: waiting on it would withhold the next preload for good.
   */
  let blocked = $state<string | null>(null);
  /**
   * The decrypted URL of the active video, whole, whose first frame is still to be kept. Decoded
   * only once the pane stops being active: a frame decode is a second WebCodecs decoder, and it
   * must not run beside the player being watched (review of #2822).
   */
  let posterSource: string | null = null;

  $effect(() => {
    if (active) return;
    loaded = false;
    playing = false;
    blocked = null;
    const source = posterSource;
    posterSource = null;
    if (source && video) {
      console.debug(
        `[reel-viewer] ${postId} ${video.mediaId} left the screen - keeping its first frame`
      );
      void captureReelPoster(video.mediaId, source);
    }
  });

  /** The whole file is in: a video's first frame is kept once it leaves, so a swipe back lands on it. */
  function onMediaLoaded(url: string) {
    view?.downloaded();
    loaded = true;
    if (video) posterSource = url;
  }

  function onPlaybackBlocked(cause: string) {
    console.debug(`[reel-viewer] ${postId} ${media.mediaId} will not play by itself (${cause})`);
    view?.wontPlay(cause);
    blocked = cause;
  }

  function onMediaFailure(cause: MediaFailureCause) {
    view?.failed(cause);
    if (cause !== 'expired' || !onMediaGone) return;
    console.debug(`[reel-viewer] ${postId} answered 410 - its file is gone, the opener is told`);
    onMediaGone();
  }

  $effect(() => {
    if (!active) return;
    const whole = loaded && (kind !== 'video' || playing);
    if (!whole && !blocked) return;
    console.debug(
      `[reel-viewer] ${postId} ${media.mediaId} settled${blocked ? ` on a failure (${blocked})` : ''} - the next media may preload`
    );
    untrack(() => onReady?.());
  });

  /**
   * The preload this pane ran while it was the NEXT reel, kept for the view that starts when it
   * becomes current (its outcome line says whether the warm path was taken). Dropped when the
   * preload ends for any other reason. Either order of the two effects below gives the same
   * answer: the preload's state is frozen at its stop.
   */
  let handedPreload: ReelPreload | null = null;

  $effect(() => {
    if (!preload || active || !video || !authToken) return;
    // A long feed video is not fetched whole for a media not yet reached (`worthPreloading`).
    if (!worthPreloading(video)) return;
    const ref = video;
    const ahead = new ReelPreload(
      ref,
      undefined,
      (url) => void captureReelPoster(ref.mediaId, url)
    );
    handedPreload = ahead;
    return () => {
      // Handed to the player only when the stop comes from this pane becoming the current one.
      if (!active && handedPreload === ahead) handedPreload = null;
      ahead.stop();
    };
  });

  /** The view of the video on screen, from the moment it is active to the moment it is not. */
  let view: ReelView | null = null;

  $effect(() => {
    if (!active || kind !== 'video') return;
    const started = untrack(
      () =>
        new ReelView({
          postId,
          mediaId: media.mediaId,
          source: reelSourceKind(chooseSegmentedPlayback(media)),
          size: media.size,
          preload: handedPreload?.state ?? 'none',
        })
    );
    handedPreload = null;
    view = started;
    return () => {
      if (view === started) view = null;
      Log.i(
        'reel-view',
        started.end({ inFlight: mediaRequestGate.inFlight, queued: mediaRequestGate.queued })
      );
    };
  });

  /** One `<video>` event of the active player, heard in the capture phase (media events do not bubble). */
  function onVideoEvent(e: Event) {
    const target = e.target;
    if (!view || !(target instanceof HTMLMediaElement)) return;
    const type = e.type as ReelViewEvent;
    const stream =
      type === 'loadstart' ? streamProgressOf(target.currentSrc || target.src) : undefined;
    view.event(type, target, stream);
  }
</script>

<div
  class="flex h-full w-full items-center justify-center"
  data-reel-media={kind}
  data-reel-media-active={active ? '' : undefined}
  onplayingcapture={(e) => {
    onVideoEvent(e);
    if (active && !playing) playing = true;
  }}
  onloadstartcapture={onVideoEvent}
  onloadedmetadatacapture={onVideoEvent}
  onloadeddatacapture={onVideoEvent}
  onwaitingcapture={onVideoEvent}
  onstalledcapture={onVideoEvent}
>
  {#if !show}
    <!-- Out of reach: an empty box that keeps the strip's geometry. -->
  {:else if kind === 'photo' && (active || preload)}
    <!-- A picture has no player to claim playback, so a pane fetched ahead mounts too. -->
    <PostMedia
      {media}
      {authToken}
      galleryMode
      announceLoading={active}
      onLoaded={active ? onMediaLoaded : undefined}
      onPlaybackBlocked={active ? onPlaybackBlocked : undefined}
    />
  {:else if kind === 'video' && active}
    <PostMedia
      {media}
      {authToken}
      galleryMode
      minimalPlayer
      {playerSafeBottom}
      poster={posterUrl}
      onLoaded={onMediaLoaded}
      {onPlaybackBlocked}
      onFailure={onMediaFailure}
    />
  {:else if posterUrl}
    <!-- A NEIGHBOUR DRAWS ITS FIRST FRAME (or its ThumbHash), NO PLAYER: a mounted player claims playback. -->
    <img
      src={posterUrl}
      alt=""
      aria-hidden="true"
      draggable="false"
      class="pointer-events-none h-full w-full object-contain select-none"
      data-video-first-frame-poster={video ? '' : undefined}
    />
  {/if}
</div>
