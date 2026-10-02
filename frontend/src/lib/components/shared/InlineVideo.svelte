<script lang="ts">
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { Play, Volume2, VolumeX } from '@lucide/svelte';
  import { arbitratePlayback } from '$lib/actions/playbackArbiter';
  import { playWhileVisible } from '$lib/actions/playWhileVisible';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { rememberVideoPosition } from '$lib/utils/videoResume';
  import VideoPoster from './VideoPoster.svelte';

  /**
   * A VIDEO THAT PLAYS WHERE IT IS - in the feed and in a conversation, the way Instagram's do.
   *
   * WHY (user, 2026-09-29, on the Mi 9T): the native controls drew Android's grey bar over the
   * picture, with a "Plein ecran" pill and a download button on top of that. Now the video plays by
   * itself, looped, while it is on screen (`playWhileVisible`); one small button turns the sound on
   * or off for EVERY video in the app (`videoSound`, muted at every start); a tap anywhere else
   * opens the full-screen viewer, which carries the controls and the download.
   *
   * `#t=0.1` is what makes the Android WebView decode a first frame instead of its grey default
   * poster, which is what shows before the video comes into view. NEVER ON A STREAM: an MSE URL
   * names a `MediaSource` in the engine's registry, and a URL with a fragment is a different URL -
   * Chromium refuses it with `MEDIA_ERR_SRC_NOT_SUPPORTED` ("Format error") before `sourceopen`,
   * measured on the Mi 9T (2026-10-01). A stream starts at its first frame anyway.
   */
  interface Props {
    /** The decrypted blob URL, or a segmented stream's MSE URL. */
    src: string;
    /** Opens the full-screen viewer. */
    onOpen: () => void;
    /** The accessible name of the tap that opens it. */
    openLabel: string;
    /** Classes of the wrapper - its box. */
    class?: string;
    /** Classes of the `<video>` - how it sits in that box. */
    videoClass?: string;
    /**
     * Set for a `ManagedMediaSource` stream (`segmentedMediaStream.ts`): Safari opens one only on an
     * element that cannot be handed to AirPlay, which would need a second, non-MSE source.
     */
    disableRemotePlayback?: boolean;
    /** `src` is a segmented stream's MSE URL, which must reach the element exactly as minted. */
    streamed?: boolean;
    /** The element's `loadedmetadata` - a `MediaFrame` reads an undeclared clip's size from it. */
    onMetadata?: (event: Event) => void;
    /**
     * Plays only when the reader presses play (a conversation's video - user, 2026-10-02: *"ne pas
     * les jouer automatiquement par rapport au scroll, mettre un bouton play ... comme sur Discord"*).
     * The play button starts it where it is, with sound of its own: it shows NO sound button and
     * neither reads nor changes the app-wide `videoSound`, which is the feed's. A tap anywhere else opens the viewer, whose
     * player starts it too. It does not loop: it stops on its last frame and offers play again. Several
     * can play at once, as on Discord; opening a viewer pauses them.
     */
    manualPlay?: boolean;
  }

  let {
    src,
    onOpen,
    openLabel,
    class: klass = '',
    videoClass = 'h-full w-full',
    disableRemotePlayback = false,
    streamed = false,
    onMetadata,
    manualPlay = false,
  }: Props = $props();

  /**
   * How the element starts: an autoplaying video plays while it is on screen (and is the only one
   * that does), a manual one plays when asked and PAUSES whatever else plays (`playbackArbiter`) - it only
   * registers, so that it and every other media take turns. Chosen once, at mount - the mode is not live.
   */
  function autoplayAction(node: HTMLVideoElement) {
    return manualPlay ? arbitratePlayback(node) : playWhileVisible(node);
  }

  let videoEl: HTMLVideoElement | null = $state(null);
  /**
   * The first frame is in the element. Until then `VideoPoster` covers the box: a stream has no
   * `#t=0.1` frame to show, and an engine slow to decode one would otherwise show a black box.
   */
  let frameReady = $state(false);

  // A new source has no frame yet - the poster comes back until it decodes one.
  $effect(() => {
    void src;
    frameReady = false;
  });

  // The property, not the attribute: `muted` as an attribute is only the INITIAL state. A manual
  // video is never muted by the app's answer: it does not read it, so it cannot open silent.
  $effect(() => {
    if (!videoEl) return;
    videoEl.muted = manualPlay ? false : videoSound.muted;
  });

  /** The element is playing (manual mode only: an autoplaying video has no button to show). */
  let playing = $state(false);

  /**
   * The play button. A press is a gesture, so the browser allows sound - and the reader asked for
   * the video, so it has it, on THIS element only: the feed's `videoSound` is neither read nor
   * changed (user, 2026-10-02: a conversation's button used to flip every button in the app).
   */
  function playNow(e: MouseEvent) {
    e.stopPropagation();
    if (!videoEl) return;
    Log.d('VIDEO', 'InlineVideo: manual play, audible, app-wide sound untouched');
    videoEl.muted = false;
    videoEl.play().catch((err: unknown) => {
      console.warn('[video] InlineVideo: play() refused', {
        name: err instanceof Error ? err.name : String(err),
      });
    });
  }

  function toggleSound(e: MouseEvent) {
    e.stopPropagation();
    videoSound.toggle();
  }
</script>

<div class="relative overflow-hidden {klass}">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={videoEl}
    src={streamed ? src : `${src}#t=0.1`}
    poster={TRANSPARENT_VIDEO_POSTER}
    muted={!manualPlay}
    loop={!manualPlay}
    playsinline
    preload="metadata"
    disableremoteplayback={disableRemotePlayback || undefined}
    use:autoplayAction
    class={videoClass}
    onloadeddata={() => (frameReady = true)}
    onloadedmetadata={onMetadata}
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
    onended={() => (playing = false)}
  ></video>
  {#if !frameReady}
    <VideoPoster />
  {/if}
  <button
    type="button"
    class="absolute inset-0 cursor-zoom-in outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:ring-inset"
    aria-label={openLabel}
    onclick={(e) => {
      e.stopPropagation();
      // The viewer opens where this video is, not at its first frame (`videoResume`).
      rememberVideoPosition(src, videoEl?.currentTime ?? 0);
      onOpen();
    }}
  ></button>
  <!-- THE APP'S AMBER, NOT THE PICTURE'S COLOUR (user, 2026-10-01, Mi 9T: green). The button was
       55 % black over a blurred backdrop, so it took the hue of whatever frame was under it - on a
       green clip, green. It is now a near-opaque scrim with no blur, carrying the theme's `--cn-yellow` glyph while
       muted, and a solid `--cn-yellow` disc once the sound is on, so its colour says the state and
       nothing else. -->
  {#if manualPlay && !playing && frameReady}
    <!-- The one big target while nothing plays, over the open-viewer tap: it starts the video where
         it is, and everything around it opens the viewer. The amber disc is `VideoPlayer`'s. -->
    <button
      type="button"
      class="bg-cn-yellow text-cn-ink absolute top-1/2 left-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full shadow-lg outline-none focus-visible:ring-4 focus-visible:ring-white/60"
      aria-label={m.video_play_label()}
      onclick={playNow}
    >
      <Play size={26} strokeWidth={2.25} fill="currentColor" class="ml-1" />
    </button>
  {/if}
  {#if !manualPlay}
    <!-- The APP-WIDE sound button: the feed's only. A conversation's video has none - its sound is
         its own and audible (see `manualPlay`). -->

    <button
      type="button"
      class="absolute right-2.5 bottom-2.5 inline-flex h-8 w-8 items-center justify-center rounded-full shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {videoSound.muted
        ? 'bg-cn-scrim/90 text-cn-yellow'
        : 'bg-cn-yellow text-cn-ink'}"
      aria-label={m.video_sound_label()}
      aria-pressed={!videoSound.muted}
      onclick={toggleSound}
    >
      {#if videoSound.muted}
        <VolumeX size={16} strokeWidth={2.5} />
      {:else}
        <Volume2 size={16} strokeWidth={2.5} />
      {/if}
    </button>
  {/if}
</div>
