<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleAlert, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from '@lucide/svelte';
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { followVideoSound, type VideoSoundScope } from '$lib/actions/playWhileVisible';
  import {
    CONTROLS_FADE_MS,
    bufferedFraction,
    clampFraction,
    formatVideoTime,
    videoKeyAction,
  } from '$lib/utils/videoPlayback';
  import { resumePosition, takeVideoPosition } from '$lib/utils/videoResume';
  import VideoPoster from './VideoPoster.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * CANARI'S VIDEO PLAYER - the full-screen viewer's, wherever a video is opened (user, 2026-10-01).
   *
   * WHY NOT `controls`: the native bar is the engine's, not the app's. On the Mi 9T it was Android's
   * grey strip with its own "plein ecran" pill and download button, on iOS a different one, and
   * neither can be themed, sized to a 44 px target or kept off the picture. This draws one bar for
   * every engine: play/pause, a seek bar showing what is buffered, elapsed/duration, the app's ONE
   * sound answer (`followVideoSound`) and full screen where the engine offers it.
   *
   * THE CONTROLS FADE after {@link CONTROLS_FADE_MS} of playback without a touch, and come back on
   * ANY mouse movement over the player, a tap ANYWHERE on it, a key, or a pause (user, 2026-10-02:
   * *"sur web, afficher les controles lors de tout mouvement de souris, sur mobile un appui
   * n'importe ou sur l'ecran de la video ouverte en grand est un toggle des controles"*). Anywhere
   * means the black around a letterboxed clip too, which a tap listener on the `<video>` alone never
   * reached. A paused video keeps them: there is nothing to watch.
   *
   * NO NATIVE POSTER, EVER: `poster` stays `TRANSPARENT_VIDEO_POSTER` (the Android WebView would
   * otherwise draw its grey play button), and `VideoPoster` covers the box until `loadeddata` says
   * the first frame is in the element.
   *
   * A STREAMED `src` (a segmented video's MSE URL, `segmentedMediaStream.ts`) reaches the element
   * exactly as minted - this component never appends to a URL, so the rule `InlineVideo` states for
   * `#t=0.1` holds here by construction.
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
  }: Props = $props();

  /**
   * WHERE THE INLINE VIDEO THIS ONE WAS OPENED FROM HAD GOT TO (`videoResume`), taken once at mount.
   * The seek waits for `loadedmetadata`: before it the element has no duration to seek within, and
   * a clip that played to its end starts over rather than resuming on its last frame.
   */
  let resumeFrom = 0;
  onMount(() => {
    resumeFrom = takeVideoPosition(src);
  });

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

  let root: HTMLDivElement | null = $state(null);
  let video: HTMLVideoElement | null = $state(null);

  let paused = $state(true);
  let muted = $state(true);
  let currentTime = $state(0);
  let duration = $state(Number.NaN);
  let buffered = $state(0);
  /** The first frame is in the element: the poster gives way to it. */
  let frameReady = $state(false);
  /** The engine refused the bytes (codec, container): said, rather than a black box. */
  let unplayable = $state(false);
  let controlsVisible = $state(true);
  /** Bumped by every interaction: the fade timer restarts from it. */
  let poke = $state(0);
  let scrubbing = $state(false);
  let fullscreen = $state(false);

  /** Capability, not a fallback: an engine without element full screen draws no button for it. */
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true;

  const played = $derived(
    Number.isFinite(duration) && duration > 0 ? clampFraction(currentTime / duration) : 0
  );
  const timeText = $derived(
    m.video_time_value({
      elapsed: formatVideoTime(currentTime),
      duration: formatVideoTime(duration),
    })
  );

  // The fade: only while playing, never mid-scrub, restarted by every `poke`.
  $effect(() => {
    void poke;
    if (paused || scrubbing || !controlsVisible) return;
    const timer = setTimeout(() => (controlsVisible = false), CONTROLS_FADE_MS);
    return () => clearTimeout(timer);
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
    if (video.paused) {
      video.play().catch((err: unknown) => {
        console.warn('[VideoPlayer] play() refused', {
          name: err instanceof Error ? err.name : String(err),
          muted: video?.muted,
        });
      });
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    if (!video) return;
    showControls();
    // In the `app` scope `followVideoSound` turns this element's change into the app's one answer.
    video.muted = !video.muted;
  }

  function seekTo(seconds: number) {
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(video.duration, Math.max(0, seconds));
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
        void toggleFullscreen();
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
    if (e.pointerType === 'mouse') showControls();
  }

  /**
   * A tap anywhere on the player - the picture or the black around it - brings the controls back, or
   * hides them when they are up. Controls, the play button and the seek bar stop their own clicks, so
   * only a tap that is nobody else's gets here.
   */
  function onPictureTap(e: MouseEvent) {
    e.stopPropagation();
    if (controlsVisible && !paused) controlsVisible = false;
    else showControls();
  }

  // ---- seek bar: a pointer drag, captured, so a finger leaving the bar keeps scrubbing ----
  let track: HTMLDivElement | null = $state(null);

  function fractionAt(clientX: number): number {
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? clampFraction((clientX - rect.left) / rect.width) : 0;
  }

  function onScrubStart(e: PointerEvent) {
    if (!Number.isFinite(duration)) return;
    e.stopPropagation();
    scrubbing = true;
    controlsVisible = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekTo(fractionAt(e.clientX) * duration);
  }

  function onScrubMove(e: PointerEvent) {
    if (!scrubbing) return;
    seekTo(fractionAt(e.clientX) * duration);
  }

  function onScrubEnd() {
    if (!scrubbing) return;
    scrubbing = false;
    poke += 1;
  }

  function onFullscreenChange() {
    fullscreen = !!root && document.fullscreenElement === root;
  }

  function onVideoError() {
    const code = video?.error?.code ?? 0;
    console.error('[VideoPlayer] the engine refused the video', {
      code,
      msg: video?.error?.message,
    });
    unplayable = true;
  }
</script>

<svelte:document onfullscreenchange={onFullscreenChange} />

<!-- The player is ONE keyboard stop, like a native one: focus lands on it, its keys drive it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="relative flex items-center justify-center overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {klass}"
  role="group"
  aria-label={m.video_player_label()}
  tabindex="0"
  data-video-player
  onkeydown={onKeydown}
  onfocusin={onFocusIn}
  onpointermove={onPointerMove}
  onclick={onPictureTap}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <video
    bind:this={video}
    {src}
    {autoplay}
    {loop}
    playsinline
    preload="metadata"
    poster={TRANSPARENT_VIDEO_POSTER}
    disableremoteplayback={disableRemotePlayback || undefined}
    use:followVideoSound={soundScope}
    class={videoClass}
    style="transform: var(--lightbox-zoom, none); transform-origin: center;"
    onloadedmetadata={() => {
      resumeOnce();
      sync();
    }}
    onloadeddata={() => {
      frameReady = true;
      sync();
    }}
    ondurationchange={sync}
    ontimeupdate={sync}
    onprogress={sync}
    onplay={() => {
      sync();
      poke += 1;
    }}
    onpause={() => {
      sync();
      controlsVisible = true;
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
      <VideoPoster />
    {/if}

    {#if paused && frameReady}
      <!-- The one big target while nothing plays; the bar below repeats it for the keyboard. -->
      <button
        type="button"
        class="bg-cn-yellow text-cn-ink absolute top-1/2 left-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-lg outline-none focus-visible:ring-4 focus-visible:ring-white/60"
        aria-label={m.video_play_label()}
        tabindex="-1"
        onclick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
      >
        <Play size={30} strokeWidth={2.25} fill="currentColor" class="ml-1" />
      </button>
    {/if}

    <div
      data-video-controls
      class="from-cn-scrim/80 absolute inset-x-0 bottom-0 flex items-center gap-1 bg-linear-to-t to-transparent px-2 pt-8 text-white transition-opacity duration-300 {safeBottom
        ? 'pb-[max(0.5rem,env(safe-area-inset-bottom))]'
        : 'pb-2'} {controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={(e) => e.stopPropagation()}
      role="presentation"
    >
      <button
        type="button"
        class="ui-icon-button rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label={paused ? m.video_play_label() : m.video_pause_label()}
        onclick={togglePlay}
      >
        {#if paused}
          <Play size={20} strokeWidth={2.25} fill="currentColor" />
        {:else}
          <Pause size={20} strokeWidth={2.25} fill="currentColor" />
        {/if}
      </button>

      <span class="text-2xs shrink-0 font-semibold tabular-nums" aria-hidden="true">
        {formatVideoTime(currentTime)} / {formatVideoTime(duration)}
      </span>

      <div
        bind:this={track}
        class="group/seek relative mx-2 flex h-11 min-w-0 flex-1 cursor-pointer touch-none items-center outline-none"
        role="slider"
        tabindex="0"
        aria-label={m.video_seek_label()}
        aria-valuemin={0}
        aria-valuemax={Number.isFinite(duration) ? Math.floor(duration) : 0}
        aria-valuenow={Math.floor(currentTime)}
        aria-valuetext={timeText}
        onpointerdown={onScrubStart}
        onpointermove={onScrubMove}
        onpointerup={onScrubEnd}
        onpointercancel={onScrubEnd}
      >
        <div class="relative h-1 w-full overflow-hidden rounded-full bg-white/25">
          <div class="absolute inset-y-0 left-0 bg-white/45" style="width: {buffered * 100}%"></div>
          <div class="bg-cn-yellow absolute inset-y-0 left-0" style="width: {played * 100}%"></div>
        </div>
        <div
          class="bg-cn-yellow absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow transition-transform group-focus-visible/seek:scale-125 group-focus-visible/seek:ring-2 group-focus-visible/seek:ring-white {scrubbing
            ? 'scale-125'
            : ''}"
          style="left: {played * 100}%"
        ></div>
      </div>

      <button
        type="button"
        class="ui-icon-button rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-amber-500 {muted
          ? ''
          : 'text-cn-yellow'}"
        aria-label={m.video_sound_label()}
        aria-pressed={!muted}
        disabled={soundScope === 'silent'}
        onclick={toggleMute}
      >
        {#if muted}
          <VolumeX size={20} strokeWidth={2.25} />
        {:else}
          <Volume2 size={20} strokeWidth={2.25} />
        {/if}
      </button>

      {#if canFullscreen}
        <button
          type="button"
          class="ui-icon-button rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-amber-500"
          aria-label={fullscreen ? m.video_exit_fullscreen_label() : m.video_fullscreen_label()}
          onclick={() => void toggleFullscreen()}
        >
          {#if fullscreen}
            <Minimize size={20} strokeWidth={2.25} />
          {:else}
            <Maximize size={20} strokeWidth={2.25} />
          {/if}
        </button>
      {/if}
    </div>
  {/if}
</div>
