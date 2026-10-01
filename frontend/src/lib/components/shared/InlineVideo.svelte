<script lang="ts">
  import { TRANSPARENT_VIDEO_POSTER } from '$lib/utils/videoPoster';
  import { Volume2, VolumeX } from '@lucide/svelte';
  import { playWhileVisible } from '$lib/actions/playWhileVisible';
  import { videoSound } from '$lib/stores/videoSound.svelte';
  import { m } from '$lib/paraglide/messages';

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
   * poster, which is what shows before the video comes into view.
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
  }

  let {
    src,
    onOpen,
    openLabel,
    class: klass = '',
    videoClass = 'h-full w-full',
    disableRemotePlayback = false,
  }: Props = $props();

  let videoEl: HTMLVideoElement | null = $state(null);

  // The property, not the attribute: `muted` as an attribute is only the INITIAL state.
  $effect(() => {
    if (videoEl) videoEl.muted = videoSound.muted;
  });

  function toggleSound(e: MouseEvent) {
    e.stopPropagation();
    videoSound.toggle();
  }
</script>

<div class="relative overflow-hidden {klass}">
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={videoEl}
    src="{src}#t=0.1"
    poster={TRANSPARENT_VIDEO_POSTER}
    muted
    loop
    playsinline
    preload="metadata"
    disableremoteplayback={disableRemotePlayback || undefined}
    use:playWhileVisible
    class={videoClass}
  ></video>
  <button
    type="button"
    class="absolute inset-0 cursor-zoom-in outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:ring-inset"
    aria-label={openLabel}
    onclick={(e) => {
      e.stopPropagation();
      onOpen();
    }}
  ></button>
  <!-- THE APP'S AMBER, NOT THE PICTURE'S COLOUR (user, 2026-10-01, Mi 9T: green). The button was
       55 % black over a blurred backdrop, so it took the hue of whatever frame was under it - on a
       green clip, green. It is now a near-opaque scrim with no blur, carrying the theme's `--cn-yellow` glyph while
       muted, and a solid `--cn-yellow` disc once the sound is on, so its colour says the state and
       nothing else. -->
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
</div>
