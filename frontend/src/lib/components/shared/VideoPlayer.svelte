<script module lang="ts">
  /**
   * The surface a player is (owner, 2026-11-09: one player, a `variant` each): the full-screen
   * viewer, a CanaReel, a feed card's inline video, a conversation's, a conversation's viewer.
   */
  import type { VideoVariant as TapVariant } from '$lib/utils/videoTapAction';
  export type VideoVariant = TapVariant;
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { videoTapAction } from '$lib/utils/videoTapAction';
  import { useViewerChrome } from '$lib/utils/videoViewerChrome.svelte';
  import { CircleAlert, Ellipsis, Maximize, Minimize, Pause, Play } from '@lucide/svelte';
  import { videoGestures } from '$lib/actions/videoGestures';
  import { videoGlass } from '$lib/utils/videoGlass';
  import VideoChipButton from '$lib/components/ui/player/VideoChipButton.svelte';
  import VideoPlayGlyph from '$lib/components/ui/player/VideoPlayGlyph.svelte';
  import VideoScrubber from '$lib/components/ui/player/VideoScrubber.svelte';
  import VideoSoundButton from '$lib/components/ui/player/VideoSoundButton.svelte';
  import VideoExpandButton from '$lib/components/ui/player/VideoExpandButton.svelte';
  import VideoFeedbackGlyph, {
    type VideoFeedbackKind,
  } from '$lib/components/ui/player/VideoFeedbackGlyph.svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import {
    followVideoSound,
    markReaderPaused,
    playWhileVisible,
    type VideoSoundScope,
  } from '$lib/actions/playWhileVisible';
  import { arbitratePlayback } from '$lib/actions/playbackArbiter';
  import { feedAutoplayPermitted } from '$lib/video/autoplayPolicy';
  import { captureVideoFrame } from '$lib/utils/videoFrameBackdrop';
  import BlurredBackdrop from './BlurredBackdrop.svelte';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import {
    CONTROLS_FADE_MS,
    bufferedFraction,
    formatVideoTime,
    videoKeyAction,
  } from '$lib/utils/videoPlayback';
  import {
    awaitVideoHandBack,
    handBackVideoPosition,
    rememberVideoPosition,
    resumePosition,
    takeVideoPosition,
  } from '$lib/utils/videoResume';
  import {
    decideAutoplayRejection,
    playRejectionName,
    type AutoplayBlockCause,
  } from '$lib/utils/videoAutoplay';
  import VideoPoster from './VideoPoster.svelte';
  import {
    isTimeBuffered,
    streamProgressOf,
    streamSeekFloor,
  } from '$lib/utils/segmentedMediaStream';
  import { Log } from '$lib/utils/Log';
  import { reelVideoFit } from '$lib/reels/reelFrame';
  import { m } from '$lib/paraglide/messages';
  import MediaSpinner from './MediaSpinner.svelte';

  /**
   * CANARI'S VIDEO PLAYER - the full-screen viewer's, wherever a video is opened (user, 2026-10-01).
   *
   * WHY NOT `controls`: the native bar is the engine's, not the app's. On the Mi 9T it was Android's
   * grey strip with its own "plein ecran" pill and download button, on iOS a different one, and
   * neither can be themed, sized to a 44 px target or kept off the picture. This draws one bar for
   * every engine: play/pause, a seek bar showing what is buffered, elapsed/duration, the app's ONE
   * sound answer (`followVideoSound`) and full screen where the engine offers it.
   *
   * THE FULL PLAYER IS THE SHARED KIT'S (owner, 2026-11-09, `docs/wiki/frontend/modules/video-player.md`):
   * one floating glass bar (`ui/player/`: play/pause, time, scrubber with its time bubble, the speaker,
   * full screen), the glass play disc, and the gestures of every video surface (`videoGestures`): a
   * TAP toggles the sound and brings the bar up, a PRESS HELD pauses while held and resumes on
   * release. The tap used to toggle the bar (user, 2026-10-02); it now only RAISES it - the bar goes
   * by itself after the fade.
   *
   * THE CONTROLS FADE after {@link CONTROLS_FADE_MS} of playback without a touch, and come back on
   * ANY mouse movement over the player, a tap ANYWHERE on it, a key, or a pause (user, 2026-10-02:
   * *"sur web, afficher les controles lors de tout mouvement de souris"*). Anywhere means the black
   * around a letterboxed clip too, which a tap listener on the `<video>` alone never reached. A paused
   * video keeps them: there is nothing to watch - except a pause the reader is HOLDING, which is for
   * watching the frame. A faded bar is UNMOUNTED, not transparent: a transparent layer with a backdrop
   * filter still pays its blur over every frame.
   *
   * NO NATIVE POSTER, EVER: `poster` stays `TRANSPARENT_VIDEO_POSTER` (the Android WebView would
   * otherwise draw its grey play button), and until `loadeddata` says the first frame is in the
   * element the box shows the caller's picture of that frame (the `poster` prop) or, without one,
   * `VideoPoster` - except the minimal reel player, which shows black: its play button answers an
   * autoplay REFUSAL and nothing else.
   *
   * `#t=0.1` IS WHAT MAKES THE ANDROID WEBVIEW DECODE A FIRST FRAME of an inline video (the feed's,
   * a conversation's) instead of its grey default poster. NEVER ON A STREAM (`streamed`): an MSE URL
   * names a `MediaSource` in the engine's registry, and a URL with a fragment is a different URL -
   * Chromium refuses it with `MEDIA_ERR_SRC_NOT_SUPPORTED` ("Format error") before `sourceopen`,
   * measured on the Mi 9T (2026-10-01). The viewers never append it: they open on a playing clip.
   *
   * INSIDE `MediaLightbox` the bar carries `data-video-controls`, which the viewer's swipe, pinch and
   * pan read as "not mine" exactly as they read a `<button>`: a drag on the seek bar is a seek, never
   * a swipe to the next media.
   *
   * THE CONTROLS ARE AN OVERLAY ON A ZOOMABLE PICTURE (user, 2026-10-02): the viewer zooms and pans
   * only the `<video>`, handing its transform down as `--lightbox-zoom`, which the element applies to
   * itself. The bar, the play button and the poster are siblings of it, so a zoom never scales them or
   * carries them off the screen.
   */
  interface Props {
    /** The decrypted blob URL, or a segmented stream's MSE URL. */
    src: string;
    /** Starts playing when mounted (the viewer). */
    autoplay?: boolean;
    /**
     * Starts over at the end, as a feed video does (Instagram): the default. A looping element never
     * fires `ended` and stays playing, so the bar keeps its fade and the time reads from 0 again.
     */
    loop?: boolean;
    /** Set for a `ManagedMediaSource` stream, which Safari only opens without AirPlay. */
    disableRemotePlayback?: boolean;
    /** Classes of the root - its box. */
    class?: string;
    /** Classes of the `<video>` - how it sits in that box. */
    videoClass?: string;
    /**
     * Whose sound answer the bar's button gives: the app's (a feed viewer, the default) or this
     * video's own (a conversation's) - see `VideoSoundScope`.
     */
    soundScope?: VideoSoundScope;
    /**
     * Whether the bar pads for the home indicator. Off when the player is NOT at the screen's bottom
     * edge (the reel review keeps its own bar beneath), so the inset is paid once, not twice.
     */
    safeBottom?: boolean;
    /**
     * WHICH SURFACE THIS PLAYER IS (owner, 2026-11-09: one player, a `variant` each):
     *
     * - `lightbox` (the default): the full-screen viewer's glass bar, disc and fade;
     * - `feed`: a post's video, playing while on screen, muted by the app's answer: a speaker chip
     *   bottom-right and an expand chip top-right, no bar, no disc (Instagram's);
     * - `chat`: a conversation's video, played when asked (user, 2026-10-02, Discord's way): the
     *   glass disc until started, then its own speaker and progress line; never looped, its sound
     *   its own;
     * - `conversation`: a conversation's MEDIA VIEWER (owner, 2026-11-10: "moche et casse", make it
     *   minimal like the CanaReels): the line on the bottom edge (dragged to seek), its speaker in
     *   the bottom-right corner, the glass play glyph while paused - no bar, no time, no fade. The
     *   tap PAUSES and PLAYS (`videoTapAction`); never looped; its sound the caller's scope;
     * - `reel`: THE REEL VIEWER'S PLAYER (user, 2026-10-23: *"les Reels d'instagram sont beaucoup plus
     *   epures, la barre de lecture est discrete et collee en bas, sans timecode"*): no control row,
     *   no timecode, no big play button except on an autoplay refusal. One thin progress line on the
     *   very bottom edge, ABOVE the caption's vignette (`z-40` over its `z-20`) so the scrim never dims
     *   it, thickening with a handle only while touched. Its speaker is the reel rail's
     *   (`ReelActionRail`, the kit's `VideoSoundButton`), on the same `videoSound` answer.
     *
     * The tap is `videoTapAction`'s table (a feed tap opens full screen, a full-screen tap is the
     * sound, a conversation viewer's the pause); a hold pauses everywhere (`videoGestures`).
     */
    variant?: VideoVariant;
    /**
     * WHAT NAMES THIS VIDEO across the two players of an opening (`videoResume`): a post's media id,
     * so the feed card and the CanaReels viewer - two downloads, two URLs - hand the time over. The
     * URL when absent (a conversation's inline video and its viewer share one blob URL).
     */
    positionKey?: string;
    /** `src` is a segmented stream's MSE URL, which must reach the element exactly as minted. */
    streamed?: boolean;
    /**
     * Opens the full-screen viewer: an inline video's expand chip (`feed`, `chat`), which replaced the
     * tap that used to open it - the tap is the sound now. Where it is, the viewer resumes
     * (`videoResume`). Without it, no chip.
     */
    onOpen?: () => void;
    /** The expand chip's accessible name (the surface's own "open in full screen"). */
    openLabel?: string;
    /**
     * A conversation's video: opens the MESSAGE's actions (the bubble's long-press sheet). A hold on
     * the picture is the pause only (owner, 2026-11-09), so a bubble that is nothing but its video
     * keeps its menu through this chip. Without it, no chip.
     */
    onActions?: () => void;
    /** The element's `loadedmetadata` - a `MediaFrame` reads an undeclared clip's size from it. */
    onMetadata?: (event: Event) => void;
    /**
     * Handed the `<video>` once it exists, and again with a new callback; the function it returns
     * runs when either goes. A PACED stream reads its demand from this element (`PostMedia`,
     * `SegmentedStreamHandle.attach`): what it plays decides what is fetched.
     */
    onVideo?: (video: HTMLVideoElement) => (() => void) | void;
    /**
     * Fill the bands a CONTAINED inline clip leaves with a blurred copy of its own first frame, drawn
     * once to a tiny canvas (`captureVideoFrame`) - the same backdrop a picture has. The caller's box
     * should be `bg-cn-surface`, which is what shows until that frame exists.
     */
    backdrop?: boolean;
    /**
     * A picture of the video's first frame, drawn in its place until the element holds that frame
     * (a reel's: `reelPosters.svelte.ts` or the publisher's ThumbHash). Given, it replaces Canari's
     * glyph poster: a loading reel shows its picture, never a play button (owner, 2026-10-31).
     */
    poster?: string | null;
    /**
     * How {@link poster} sits in the box: the caller's `videoClass` fit, so a cropped grid cell
     * (`cover`) shows a cropped poster and never changes stage when its frame arrives.
     */
    posterFit?: 'contain' | 'cover';
    /**
     * Told once when this video will NOT play by itself and the reader has to act: the engine
     * refused the autoplay (`refused`), something paused it while it was asked (`interrupted`), it
     * failed otherwise (`errored`) - the play button is shown for each (`videoAutoplay.ts`) - or the
     * engine refused the bytes (`unplayable`). The reel viewer stops waiting on it then, so the
     * next reel preloads.
     */
    onPlaybackBlocked?: (cause: AutoplayBlockCause | 'unplayable') => void;
  }

  let {
    src,
    autoplay = true,
    loop = true,
    disableRemotePlayback = false,
    class: klass = '',
    videoClass = 'max-h-full max-w-full object-contain',
    soundScope = 'app',
    safeBottom = true,
    variant = 'lightbox',
    poster = null,
    posterFit = 'contain',
    onPlaybackBlocked,
    streamed = false,
    onOpen,
    openLabel,
    onActions,
    onMetadata,
    onVideo,
    backdrop = false,
    positionKey,
  }: Props = $props();

  /** The key positions travel under (`positionKey`, else the URL). */
  const resumeKey = $derived(positionKey ?? src);

  /**
   * HOW THE ELEMENT TAKES TURNS, chosen once at mount - the variant is not live:
   * - `feed`: plays while it is on screen, muted by the app's answer (`playWhileVisible`);
   * - `chat`: plays when asked, and pauses whatever else plays (`arbitratePlayback`); its sound is
   *   its own (`local`), never the app's (user, 2026-10-02);
   * - a viewer (`lightbox`, `reel`): the only media playing while open, on its scope's sound
   *   (`followVideoSound`).
   */
  function playback(node: HTMLVideoElement, scope: VideoSoundScope) {
    Log.d('VideoPlayer', `mounted as ${variant}`);
    if (variant === 'feed') return playWhileVisible(node);
    if (variant === 'chat') return arbitratePlayback(node);
    return followVideoSound(node, scope);
  }

  /** An inline video (the feed's, a conversation's): no bar, chips in its corners. */
  const inline = $derived(variant === 'feed' || variant === 'chat');
  /** A conversation's viewer: the minimal chrome (a line, a speaker, the glyph while paused). */
  const conversation = $derived(variant === 'conversation');
  /** A conversation's sound is the element's own, whatever the caller says. */
  const scope = $derived<VideoSoundScope>(variant === 'chat' ? 'local' : soundScope);
  /** What the element is given: a decrypted file seeks to its first frame inline (see above). */
  const elementSrc = $derived(inline && !streamed ? `${src}#t=0.1` : src);
  /** The blurred backdrop's picture: one frame of THIS element, taken once per source. */
  let backdropUrl = $state<string | null>(null);
  /** A conversation's video has been started once: its line and speaker show from then on. */
  let started = $state(false);

  /**
   * WHERE THE INLINE VIDEO THIS ONE WAS OPENED FROM HAD GOT TO (`videoResume`), taken once at mount.
   * The seek waits for `loadedmetadata`: before it the element has no duration to seek within, and
   * a clip that played to its end starts over rather than resuming on its last frame.
   */
  let resumeFrom = 0;
  onMount(() => {
    // An inline video is where a position is WRITTEN for the viewer about to open; it takes none.
    if (!inline) resumeFrom = takeVideoPosition(resumeKey);
  });

  /** The inline player waits for the viewer it opened to hand its time back (`videoResume`). */
  let stopAwaiting: (() => void) | null = null;
  onDestroy(() => {
    stopAwaiting?.();
    // A VIEWER HANDS BACK WHERE IT GOT TO as it leaves, so the inline video resumes there - or, if
    // it never reached its resume point (closed before the metadata), the point it was opened at.
    if (!inline) handBackVideoPosition(resumeKey, resumeFrom > 0 ? resumeFrom : currentTime);
  });

  $effect(() => {
    if (!video || !onVideo) return;
    return onVideo(video) ?? undefined;
  });

  /**
   * Opens the viewer from a tap, the expand chip or `f`, noting where this video had got to, and
   * waiting for the viewer to hand back where it left it (owner, 2026-11-10: entering and leaving
   * full screen never restart at 0).
   */
  function openViewer() {
    if (!onOpen) return;
    Log.d('VideoPlayer', `${variant}: the viewer is opened`);
    rememberVideoPosition(resumeKey, video?.currentTime ?? 0);
    stopAwaiting?.();
    stopAwaiting = awaitVideoHandBack(resumeKey, (seconds) => {
      if (!video) return;
      // A STREAMED CARD TAKES THE TIME ONLY IF IT HOLDS IT (review of #3311): the viewer is its own
      // download, and a card sought outside its buffer fetches every segment up to there - a third
      // copy of the clip - or stalls behind a cut. It stays where it was instead. A whole file seeks
      // for free.
      if (streamed && !isTimeBuffered(video.buffered, seconds)) {
        Log.d(
          'VideoPlayer',
          `${variant}: the viewer's ${seconds.toFixed(1)} s is not buffered here - kept at ${video.currentTime.toFixed(1)} s`
        );
        return;
      }
      Log.d(
        'VideoPlayer',
        `${variant}: resumes at ${seconds.toFixed(1)} s, where the viewer left it`
      );
      video.currentTime = seconds;
      currentTime = seconds;
    });
    onOpen();
  }

  /** Seeks to {@link resumeFrom} once, as soon as the element knows its duration. */
  function resumeOnce() {
    if (!video || resumeFrom <= 0) return;
    const at = resumePosition(resumeFrom, video.duration);
    resumeFrom = 0;
    if (at > 0) {
      Log.d('VideoPlayer', `resuming at ${at.toFixed(1)} s`);
      video.currentTime = at;
    }
  }

  /** The reel's spare player: a line, no bar, its play disc only on a decided refusal. */
  const minimal = $derived(variant === 'reel');

  let root: HTMLDivElement | null = $state(null);
  let video: HTMLVideoElement | null = $state(null);
  /**
   * THE REEL'S VIDEO FILLS ITS FRAME (owner, 2026-11-09: "Certains posts ont des bords noirs, ils ne
   * sont pas etires"). An element with no size of its own is drawn at the clip's intrinsic size under
   * `max-h/max-w`, which leaves bands on ALL FOUR sides when the clip is smaller than its frame; the
   * reel's is the whole box, fitted by `reelVideoFit` (cover unless the clip is clearly another shape).
   */
  const REEL_VIDEO_CLASS = 'absolute inset-0 h-full w-full';
  let boxWidth = $state(0);
  let boxHeight = $state(0);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  const reelFit = $derived(
    reelVideoFit(
      naturalHeight > 0 ? naturalWidth / naturalHeight : 0,
      boxHeight > 0 ? boxWidth / boxHeight : 0
    )
  );

  let paused = $state(true);
  let muted = $state(true);
  let currentTime = $state(0);
  let duration = $state(Number.NaN);
  let buffered = $state(0);
  /** The first frame is in the element: the poster gives way to it. */
  let frameReady = $state(false);
  /** The engine refused the bytes (codec, container): said, rather than a black box. */
  let unplayable = $state(false);
  /**
   * THE AUTOPLAY WILL NOT HAPPEN AND THE READER MUST ACT (`videoAutoplay.ts`: refused, interrupted
   * by a pause, failed). Only then does the minimal player draw a play button: it is the answer to
   * a decided outcome, never a loading state - and it is drawn even before the first frame (over the
   * poster or the black box), since a paused `preload="metadata"` element may never fetch one.
   */
  let autoplayRefused = $state(false);
  /** The autoplay of the current load has an answer (playing, or a decided failure). */
  let autoplayDone = false;
  /** A `play()` is pending: a second load event does not ask twice. */
  let autoplayInFlight = false;
  /** THE LOAD THE ELEMENT IS ON, bumped by every `loadstart`: it names each load in the logs. */
  let loadGeneration = 0;
  /**
   * THE ELEMENT WAITS FOR DATA WHILE IT SHOULD PLAY (`waiting`): the network is slow. The minimal
   * player draws a spinner then - a loading state, never the play button, which only a decided
   * outcome earns. Cleared by `playing`, a pause or a new load.
   */
  let buffering = $state(false);
  let controlsVisible = $state(true);
  /** Bumped by every interaction: the fade timer restarts from it. */
  let poke = $state(0);
  let scrubbing = $state(false);
  let fullscreen = $state(false);

  /** Capability, not a fallback: an engine without element full screen draws no button for it. */
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  /**
   * A PRESS IS HELD (`videoGestures`): the video is paused for the reader to look at a frame, so
   * neither the bar nor the play disc comes up for that pause. `heldWasPlaying` is what the release
   * restores - a hold on a paused video resumes nothing.
   */
  let holding = $state(false);
  let heldWasPlaying = false;

  /** What the reader's last gesture did, for the glyph (`VideoFeedbackGlyph`). */
  let feedback = $state<{ kind: VideoFeedbackKind; n: number } | null>(null);
  let feedbackCount = 0;
  function showFeedback(kind: VideoFeedbackKind) {
    feedback = { kind, n: ++feedbackCount };
  }

  // THE VIEWER'S BARS FOLLOW THESE CONTROLS (`videoViewerChrome`): the header fades with the glass bar
  // on the same clock, comes back with it, and a player that leaves - another slide, the next video
  // of a gallery - gives the bars back. Only the viewer's own player reports.
  const viewerChrome = useViewerChrome();
  const chromeOwner = {};
  $effect(() => {
    if (variant !== 'lightbox') return;
    viewerChrome?.report(chromeOwner, !controlsVisible);
  });
  $effect(() => () => viewerChrome?.leave(chromeOwner));
  // The reader reached for the header (a mouse over it, a focus on Back): the controls come up.
  $effect(() => {
    const raised = viewerChrome?.raised ?? 0;
    if (raised > 0 && variant === 'lightbox') untrack(showControls);
  });

  // The fade: only while playing, never mid-scrub, restarted by every `poke`.
  $effect(() => {
    void poke;
    // An unplayable video has no bar to fade: the viewer's header stays up with its message.
    if (paused || scrubbing || unplayable || !controlsVisible) return;
    const timer = setTimeout(() => (controlsVisible = false), CONTROLS_FADE_MS);
    return () => clearTimeout(timer);
  });

  // THE APP'S ONE SOUND ANSWER, BOTH WAYS: `followVideoSound` carries the element's change to the
  // store, and this carries a change made elsewhere (the reel rail's sound button) to the element.
  $effect(() => {
    const muted = videoSound.muted;
    if (scope === 'app' && video && video.muted !== muted) {
      video.muted = muted;
      sync();
    }
  });

  function showControls() {
    controlsVisible = true;
    poke += 1;
  }

  function sync() {
    if (!video) return;
    paused = video.paused;
    muted = video.muted;
    currentTime = video.currentTime;
    duration = video.duration;
    buffered = bufferedFraction(video.buffered, video.currentTime, video.duration);
  }

  function togglePlay() {
    if (!video) return;
    showControls();
    if (minimal || inline || conversation) showFeedback(video.paused ? 'play' : 'pause');
    if (video.paused) {
      playNow();
    } else {
      pauseByReader();
    }
  }

  /** Asks the element to play; a refusal is logged with what it was asked with. */
  function playNow() {
    video?.play().catch((err: unknown) => {
      console.warn('[VideoPlayer] play() refused', {
        name: err instanceof Error ? err.name : String(err),
        muted: video?.muted,
      });
    });
  }

  /** A pause the READER made: a feed video then stays paused (`markReaderPaused`). */
  function pauseByReader() {
    if (!video) return;
    if (variant === 'feed') markReaderPaused(video);
    video.pause();
  }

  /**
   * THE PICTURE'S TAP (stack review, 2026-11-09): the sound everywhere, and two cases where a sound
   * toggle alone would leave the reader with a still picture and nothing to press:
   * - a conversation's video NOT YET STARTED: the tap plays it, audible, as its disc does - its sound
   *   is the tap's once it has started;
   * - a feed video ON SCREEN BUT PAUSED (an autoplay the engine refused, the reader's own pause): the
   *   tap gives the sound, then plays it.
   */
  function onPictureTap() {
    if (!video) return;
    const action = videoTapAction({
      variant,
      canOpen: !!onOpen,
      paused: video.paused,
      started,
      muted: video.muted,
    });
    Log.d('VideoPlayer', `${variant}: tap -> ${action}`);
    switch (action) {
      case 'open-viewer':
        openViewer();
        break;
      case 'toggle-play':
        togglePlay();
        break;
      case 'toggle-sound':
        toggleMute();
        break;
      case 'toggle-sound-and-play':
        toggleMute();
        playNow();
        break;
      case 'sound-on':
        turnSoundOn();
        break;
    }
  }

  /**
   * A tap's sound is only ever ON (owner, 2026-11-10): the same write as the speaker's unmute, so the
   * app's one answer follows the same way (a viewer's `followVideoSound` reads the element's change).
   * A `silent` video has none to give and only raises the bar.
   */
  function turnSoundOn() {
    if (!video) return;
    if (video.muted && scope !== 'silent') toggleMute();
    else showControls();
  }

  /**
   * The sound, from the speaker, the `m` key or a tap on the picture. In the `app` scope it becomes
   * the app's one answer, remembered (a viewer's `followVideoSound` reads the element's change; an
   * inline video writes it, having no viewer action); `local` mutes this element only; a `silent`
   * video has no sound to give and only raises the bar.
   */
  function toggleMute() {
    if (!video) return;
    showControls();
    if (scope === 'silent') return;
    video.muted = !video.muted;
    // Drawn from the element at once, not at its `volumechange`: the speaker is the answer.
    muted = video.muted;
    if (inline && scope === 'app') videoSound.setMuted(video.muted);
    showFeedback(video.muted ? 'sound-off' : 'sound-on');
  }

  /** A press held on the picture: pause for as long as it is held. */
  function onHoldStart() {
    if (!video) return;
    holding = true;
    heldWasPlaying = !video.paused;
    if (heldWasPlaying) pauseByReader();
  }

  /** The hold ended: resume what it paused, and nothing it did not. */
  function onHoldEnd() {
    holding = false;
    if (!video || !heldWasPlaying) return;
    heldWasPlaying = false;
    video.play().catch((err: unknown) => {
      console.warn('[VideoPlayer] play() refused after a hold', {
        name: err instanceof Error ? err.name : String(err),
      });
    });
  }

  /**
   * Seeks within the clip. A STREAM IS CLAMPED TO WHAT IT STILL HOLDS (`streamSeekFloor`): its
   * declared duration makes the whole clip seekable to the engine, but a segment trimmed or evicted
   * behind the playhead is never appended again, and a seek there would stall for ever.
   */
  function seekTo(seconds: number) {
    if (!video || !Number.isFinite(video.duration)) return;
    const floor = streamed ? streamSeekFloor(streamProgressOf(src), video.buffered) : 0;
    if (seconds < floor) {
      Log.d('VideoPlayer', `seek to ${seconds.toFixed(1)} s clamped to ${floor.toFixed(1)} s`);
    }
    video.currentTime = Math.min(video.duration, Math.max(floor, seconds));
    currentTime = video.currentTime;
  }

  async function toggleFullscreen() {
    if (!root || !canFullscreen) return;
    showControls();
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch (err) {
      console.warn('[VideoPlayer] full screen refused', err);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    // A focused button answers its own space bar: the sound button must not play the video.
    if (e.key === ' ' && (e.target as HTMLElement).closest('button')) return;
    // A feed card's tap is the viewer, so its keyboard twin is Enter on the focused card.
    if (e.key === 'Enter' && variant === 'feed' && onOpen && e.target === root) {
      e.preventDefault();
      e.stopPropagation();
      openViewer();
      return;
    }
    const action = videoKeyAction(e.key);
    if (!action) return;
    // The viewer around uses the same arrows for previous/next: the player's focus wins.
    e.preventDefault();
    e.stopPropagation();
    Log.d('VideoPlayer.key', { key: e.key, action: action.kind });
    switch (action.kind) {
      case 'toggle-play':
        togglePlay();
        break;
      case 'seek-by':
        showControls();
        seekTo(currentTime + action.seconds);
        break;
      case 'seek-to':
        showControls();
        if (Number.isFinite(duration)) seekTo(action.fraction * duration);
        break;
      case 'toggle-mute':
        toggleMute();
        break;
      case 'toggle-fullscreen':
        // An inline video's full screen is the viewer.
        if (inline) openViewer();
        else void toggleFullscreen();
        break;
    }
  }

  /**
   * Focus reaching the player FROM THE KEYBOARD brings the controls up. Only from the keyboard: a
   * tap focuses the player too, and its `focusin` ran BEFORE its `click` - the controls came up on
   * the focus and the click that followed read them as up and hid them again, so on the Mi 9T the
   * first tap on a playing video did nothing visible (2026-10-01).
   */
  function onFocusIn(e: FocusEvent) {
    if ((e.target as HTMLElement).matches(':focus-visible')) showControls();
  }

  /**
   * A MOUSE MOVING OVER THE PLAYER BRINGS THE CONTROLS UP, wherever it is on it. Mouse only: a
   * finger's `pointermove` is a drag - a swipe in the viewer around, a seek on the bar - and must not
   * show anything by itself.
   */
  function onPointerMove(e: PointerEvent) {
    // Only a player with a bar has controls to raise; elsewhere this would restart the fade timer on
    // every mouse movement for nothing.
    if (e.pointerType === 'mouse' && !minimal && !inline && !conversation) showControls();
  }

  /** A drag on the scrubber keeps the controls up; its end restarts the fade. */
  function onScrubbingChange(next: boolean) {
    scrubbing = next;
    if (next) controlsVisible = true;
    else poke += 1;
  }

  function onFullscreenChange() {
    fullscreen = !!root && document.fullscreenElement === root;
  }

  /**
   * THE AUTOPLAY, ASKED SO ITS REFUSAL IS KNOWN. The `autoplay` attribute fails silently; `play()`
   * answers. Asked once the element can play: a refusal is `NotAllowedError`, typed at the throw;
   * an interruption (`AbortError`, a new `src`) is not a refusal and leaves the button off.
   */
  function tryAutoplay() {
    // The full player draws its button on any pause already; only the minimal one needs the answer.
    if (!minimal || !autoplay || autoplayDone || autoplayInFlight || !video) return;
    if (!video.paused) {
      autoplayDone = true;
      return;
    }
    askAutoplay(video);
  }

  /**
   * Asks `play()` for the current load and acts on the answer (`decideAutoplayRejection`). Asked
   * from `loadedmetadata` on: `play()` before the data is legal and makes the engine fetch it,
   * whereas waiting for `canplay` left a reel the engine had stopped loading at its metadata (an
   * iPhone with `preload="metadata"` whose `autoplay` attribute WebKit declined - its
   * `InvisibleAutoplayNotPermitted` rule, a reel not yet in the viewport) with nobody ever asking.
   */
  function askAutoplay(el: HTMLVideoElement) {
    autoplayInFlight = true;
    // The source the ask is made on: a rejection that finds another one was interrupted by that
    // new load (`videoAutoplay.ts` - the load rejects synchronously, before its `loadstart`).
    const askedSrc = el.src;
    const muted = el.muted;
    Log.d(
      'VideoPlayer',
      `autoplay asked (load ${loadGeneration}, ${muted ? 'muted' : 'with sound'})`
    );
    el.play()
      .then(() => {
        autoplayInFlight = false;
        autoplayDone = true;
      })
      .catch((err: unknown) => {
        autoplayInFlight = false;
        const name = playRejectionName(err);
        const verdict = decideAutoplayRejection(name, { sourceChanged: el.src !== askedSrc });
        if (verdict.kind === 'ask-at-next-load') {
          console.debug(
            `[VideoPlayer] autoplay interrupted by a new source (${name}) - its load asks again`
          );
          return;
        }
        if (verdict.cause === 'refused' && !muted && scope !== 'silent') {
          // A full-screen viewer opens WITH sound where the app may; the engine refused it, so it
          // plays muted rather than sit paused (owner, 2026-11-10) - and a tap turns the sound on.
          console.warn(
            `[VideoPlayer] autoplay with sound refused (${name}) - playing muted, a tap turns the sound on`,
            err
          );
          if (scope === 'app') videoSound.muteForRefusedStart();
          el.muted = true;
          sync();
          askAutoplay(el);
          return;
        }
        autoplayDone = true;
        if (verdict.cause === 'interrupted') {
          console.info(
            `[VideoPlayer] autoplay interrupted by a pause (${name}, same source) - the play button is shown`
          );
        } else {
          console.warn(
            `[VideoPlayer] autoplay ${verdict.cause} (${name}, ${muted ? 'muted' : 'with sound'}) - the play button is shown`,
            err
          );
        }
        autoplayRefused = true;
        buffering = false;
        tellBlocked(verdict.cause);
      });
  }

  /** `onPlaybackBlocked` was called: the contract is ONE call per player, whatever follows. */
  let blockedTold = false;

  /** Says once that this video will not play by itself; a later verdict is only logged. */
  function tellBlocked(cause: AutoplayBlockCause | 'unplayable') {
    if (blockedTold) {
      Log.d('VideoPlayer', `blocked again (${cause}) - already told`);
      return;
    }
    blockedTold = true;
    onPlaybackBlocked?.(cause);
  }

  /** A new load of the element: its autoplay is asked afresh, earlier answers are void. */
  function onLoadStart() {
    loadGeneration += 1;
    autoplayDone = false;
    autoplayRefused = false;
    buffering = false;
    // A new source has no frame yet: the poster comes back until it decodes one.
    frameReady = false;
    backdropUrl = null;
    Log.d('VideoPlayer', `load ${loadGeneration} started`);
  }

  /** The first frame is decoded: show it, and take the backdrop from it if the box wants one. */
  function onFirstFrame() {
    frameReady = true;
    // A first-frame picture is already the backdrop's source: no second capture, no swap.
    if (backdrop && video && backdropUrl === null && !poster) {
      backdropUrl = captureVideoFrame(video);
      Log.d('VideoPlayer', `backdrop frame taken=${backdropUrl !== null}`);
    }
  }

  /** `waiting`: the element should play but has no data - a slow network, drawn as a spinner. */
  function onWaiting() {
    if (!video || video.paused || buffering) return;
    buffering = true;
    Log.d(
      'VideoPlayer',
      `waiting for data (readyState ${video.readyState}, networkState ${video.networkState})`
    );
  }

  /** `stalled`: the download made no progress for a while - logged; the spinner is `waiting`'s. */
  function onStalled() {
    if (!video) return;
    Log.d(
      'VideoPlayer',
      `download stalled (readyState ${video.readyState}, ${video.paused ? 'paused' : 'playing'})`
    );
  }

  function onVideoError() {
    const code = video?.error?.code ?? 0;
    console.error('[VideoPlayer] the engine refused the video', {
      code,
      msg: video?.error?.message,
    });
    unplayable = true;
    // The error replaces the bar: if the bar had faded, the viewer's header would stay hidden over
    // a message nobody can dismiss, so the controls (and with them the header) come back.
    controlsVisible = true;
    tellBlocked('unplayable');
  }
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- The player is ONE keyboard stop, like a native one: focus lands on it, its keys drive it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="relative flex items-center justify-center overflow-hidden outline-none select-none [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-white {inline
    ? ''
    : 'bg-black'} {klass}"
  role="group"
  aria-label={variant === 'feed' && onOpen && openLabel ? openLabel : m.video_player_label()}
  tabindex="0"
  data-video-player={variant}
  use:videoGestures={{ onTap: onPictureTap, onHoldStart, onHoldEnd }}
  onkeydown={onKeydown}
  onfocusin={onFocusIn}
  onpointermove={onPointerMove}
>
  {#if backdrop && (backdropUrl ?? poster)}
    <!-- The bands' blur, from the first-frame picture while there is one, so the picture and its
         backdrop come in TOGETHER (owner, 2026-11-10: three visible stages before). -->
    <BlurredBackdrop src={(backdropUrl ?? poster)!} />
  {/if}
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <video
    bind:this={video}
    src={elementSrc}
    autoplay={autoplay && !inline}
    loop={loop && variant !== 'chat' && !conversation}
    playsinline
    preload="metadata"
    poster={TRANSPARENT_VIDEO_POSTER}
    disableremoteplayback={disableRemotePlayback || undefined}
    use:playback={scope}
    class="{minimal ? REEL_VIDEO_CLASS : videoClass} {backdrop && !frameReady && !unplayable
      ? 'opacity-0'
      : ''}"
    style:object-fit={minimal ? reelFit : undefined}
    bind:clientWidth={boxWidth}
    bind:clientHeight={boxHeight}
    data-reel-video-fit={minimal ? reelFit : undefined}
    style="transform: var(--lightbox-zoom, none); transform-origin: center;"
    onloadstart={onLoadStart}
    onloadedmetadata={(e) => {
      if (video) {
        naturalWidth = video.videoWidth;
        naturalHeight = video.videoHeight;
        Log.d(
          'VideoPlayer',
          `intrinsic ${naturalWidth}x${naturalHeight} in a ${boxWidth}x${boxHeight} box`
        );
        // NO LENGTH, NO SEEK (owner, 2026-11-10): a file or stream that declares none is said, with
        // what it is, so the population of such videos is countable (`mp4Duration.ts`).
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          console.info(
            `[VideoPlayer] ${variant}: the engine knows no duration (${video.duration}, ${streamed ? 'stream' : 'file'}) - the scrubber cannot seek`
          );
        }
      }
      resumeOnce();
      sync();
      tryAutoplay();
      onMetadata?.(e);
    }}
    onloadeddata={() => {
      onFirstFrame();
      sync();
      tryAutoplay();
    }}
    oncanplay={tryAutoplay}
    ondurationchange={sync}
    ontimeupdate={sync}
    onprogress={sync}
    onplay={() => {
      autoplayRefused = false;
      started = true;
      sync();
      poke += 1;
    }}
    onplaying={() => (buffering = false)}
    onwaiting={onWaiting}
    onstalled={onStalled}
    onpause={() => {
      buffering = false;
      sync();
      // A pause the reader holds is for looking at the frame: the bar stays where it was.
      if (!holding) controlsVisible = true;
    }}
    onvolumechange={sync}
    onerror={onVideoError}
  ></video>

  {#if unplayable}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/75"
      role="status"
    >
      <CircleAlert size={24} strokeWidth={2} class="opacity-70" />
      <span class="text-xs font-semibold">{m.video_unplayable()}</span>
    </div>
  {:else}
    {#if !frameReady}
      {#if poster}
        <!-- The first frame's picture, in the place the frame will take (fitted as the video is,
             `posterFit`, in the same box), so the frame replaces it without a jump. -->
        <img
          src={poster}
          alt=""
          aria-hidden="true"
          class="pointer-events-none absolute inset-0 h-full w-full select-none {posterFit ===
          'cover'
            ? 'object-cover'
            : 'object-contain'}"
          data-video-first-frame-poster
        />
      {:else if !minimal}
        <VideoPoster />
      {/if}
      <!-- The minimal (reel) player with no picture yet draws its black box: a play glyph there
           read as "tap to play" on a video that was only loading (owner, 2026-10-31). -->
    {/if}

    {#if (variant !== 'feed' || !feedAutoplayPermitted()) && paused && !holding && (minimal ? autoplayRefused : frameReady)}
      <!-- The one big target while nothing plays; the bar below repeats it for the keyboard. The
           minimal player draws it on a decided outcome only, with or without a first frame; the
           feed's only when the reader's "Lecture automatique des vidéos" keeps it from starting
           (`video/autoplayPolicy.ts`) - otherwise it plays by being on screen, as Instagram's does. -->
      <VideoPlayGlyph onclick={togglePlay} size={minimal ? 'lg' : 'md'} tabindex={-1} />
    {/if}

    {#if minimal && buffering}
      <!-- A SLOW NETWORK, NOT A REFUSAL: the reel was asked to play and waits for its data. -->
      <MediaSpinner />
    {/if}

    <!-- THE GLYPH IS THE FEEDBACK OF A GESTURE, NEVER A STATE: a tap's sound, a reel's pause. -->
    <VideoFeedbackGlyph {feedback} />

    {#if inline}
      <!-- AN INLINE VIDEO'S CHROME (owner, 2026-11-10: minimal, as Instagram and CanaReels). The
           CHAT's expand chip top-right (its tap is the sound, not the viewer); the FEED has none,
           its tap opens the viewer and the root carries `openLabel` (Enter and `f` open it from the
           keyboard). The speaker bottom-right: the feed's a bare quiet glyph drawn only while the
           video plays (nothing on a poster that is not playing), a conversation's a chip once
           started, with its progress line. No bar: there is nothing to fade. -->
      {#if onOpen && variant !== 'feed'}
        <VideoExpandButton
          label={openLabel}
          onclick={openViewer}
          class="absolute top-0.5 right-0.5 z-20"
        />
      {/if}
      {#if variant === 'feed' ? !paused : started}
        <VideoSoundButton
          {muted}
          onToggle={toggleMute}
          quiet={variant === 'feed'}
          class="absolute right-0.5 bottom-0.5 z-20"
        />
      {/if}
      {#if onActions}
        <!-- The message's actions: a hold on the picture is the pause, so the menu is a chip. -->
        <VideoChipButton
          label={m.msg_more_actions_label()}
          onclick={onActions}
          class="absolute top-0.5 left-0.5 z-20"
          data-video-actions
        >
          <Ellipsis size={16} strokeWidth={2.5} class="drop-shadow" />
        </VideoChipButton>
      {/if}
      {#if variant === 'chat' && started}
        <!-- Pause and play again without the keyboard: the tap is the sound once started. -->
        <VideoChipButton
          label={paused ? m.video_play_label() : m.video_pause_label()}
          onclick={togglePlay}
          class="absolute bottom-0.5 left-0.5 z-20"
          data-video-toggle
        >
          {#if paused}
            <Play size={14} strokeWidth={2.5} fill="currentColor" class="ml-0.5 drop-shadow" />
          {:else}
            <Pause size={14} strokeWidth={2.5} fill="currentColor" class="drop-shadow" />
          {/if}
        </VideoChipButton>
        <div class="absolute inset-x-0 bottom-0 z-10" data-video-line-slot>
          <VideoScrubber
            variant="line"
            {currentTime}
            {duration}
            onSeek={seekTo}
            {onScrubbingChange}
          />
        </div>
      {/if}
    {:else if conversation}
      <!-- A CONVERSATION'S VIEWER, MINIMAL (owner, 2026-11-10): the line on the bottom edge, always
           drawn and dragged to seek, and the speaker in the corner above it. No bar, no time, no
           fade - so nothing hides the viewer's header either. -->
      <VideoSoundButton
        {muted}
        onToggle={toggleMute}
        disabled={scope === 'silent'}
        class="absolute right-1 z-40 {safeBottom
          ? 'bottom-[calc(var(--safe-area-inset-bottom,0px)+2rem)]'
          : 'bottom-8'}"
      />
      <div
        class="absolute inset-x-0 bottom-0 z-40"
        style={safeBottom ? 'bottom: var(--safe-area-inset-bottom, 0px)' : undefined}
        data-video-line-slot
      >
        <VideoScrubber
          variant="line"
          {currentTime}
          {duration}
          onSeek={seekTo}
          {onScrubbingChange}
        />
      </div>
    {:else if minimal}
      <!-- THE LINE: on the bottom edge (above the home indicator when the player reaches it), above
           the caption's vignette (`z-40` over its `z-20`). Always drawn: it is not part of the
           controls' fade. -->
      <div
        class="absolute inset-x-0 bottom-0 z-40"
        style={safeBottom ? 'bottom: var(--safe-area-inset-bottom, 0px)' : undefined}
        data-video-line-slot
      >
        <VideoScrubber
          variant="line"
          {currentTime}
          {duration}
          onSeek={seekTo}
          {onScrubbingChange}
        />
      </div>
    {:else if controlsVisible}
      <!-- THE BAR, ONE FLOATING GLASS PILL over a free scrim gradient, UNMOUNTED when faded. Its
           buttons draw no chip of their own: one blur per player. -->
      <div
        data-video-controls
        class="video-controls-in from-cn-scrim/60 absolute inset-x-0 bottom-0 bg-linear-to-t to-transparent px-3 pt-10 {safeBottom
          ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]'
          : 'pb-3'}"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div
          class="glass-video flex w-full items-center gap-1 rounded-3xl px-1.5"
          data-glass={videoGlass()}
          data-video-bar
        >
          <VideoChipButton
            label={paused ? m.video_play_label() : m.video_pause_label()}
            onclick={togglePlay}
            glass={false}
          >
            {#if paused}
              <Play size={20} strokeWidth={2.25} fill="currentColor" class="drop-shadow" />
            {:else}
              <Pause size={20} strokeWidth={2.25} fill="currentColor" class="drop-shadow" />
            {/if}
          </VideoChipButton>

          <span class="text-2xs shrink-0 font-semibold tabular-nums" aria-hidden="true">
            {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
          </span>

          <VideoScrubber
            variant="bar"
            class="mx-2 min-w-0 flex-1"
            {currentTime}
            {duration}
            {buffered}
            onSeek={seekTo}
            {onScrubbingChange}
          />

          <VideoSoundButton
            {muted}
            onToggle={toggleMute}
            glass={false}
            disabled={soundScope === 'silent'}
          />

          {#if canFullscreen}
            <VideoChipButton
              label={fullscreen ? m.video_exit_fullscreen_label() : m.video_fullscreen_label()}
              onclick={() => void toggleFullscreen()}
              glass={false}
            >
              {#if fullscreen}
                <Minimize size={20} strokeWidth={2.25} class="drop-shadow" />
              {:else}
                <Maximize size={20} strokeWidth={2.25} class="drop-shadow" />
              {/if}
            </VideoChipButton>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The bar comes in with a short fade; it leaves by being unmounted (a hidden blur must not pay). */
  .video-controls-in {
    animation: video-controls-in 150ms ease-out;
  }
  @media (prefers-reduced-motion: reduce) {
    .video-controls-in {
      animation: none;
    }
  }
  @keyframes video-controls-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
