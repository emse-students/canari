<script lang="ts">
  /**
   * The rest of the screen around a reel's frame, painted from the reel itself: a blurred, dimmed
   * copy of the frame's picture, so the screen is never black bands (user, 2026-10-11).
   *
   * IT IS PAINTED ONCE PER PICTURE AND NEVER AGAIN (Mi 9T, 2026-10-16). It used to re-sample the
   * playing video every 250 ms into a 24 px canvas the browser stretched 45x: the bands were blocky
   * ("pixelise") and stepped four times a second ("saccade"), and each `drawImage` of a video cost
   * ~25 ms on the main thread - in the viewer a dropped frame per sample, in the CAMERA a 100-150 ms
   * hole in the recorded take every 250 ms (20 fps instead of 29). The picture is now drawn when the
   * media first has a frame (`loadeddata`, `load`), blurred ON THE CANVAS (`paintBlurredBackdrop`),
   * and left alone: no timer, no animation frame, no CSS `filter` for the compositor to re-run.
   *
   * NO SECOND DECODER: it reads the picture the frame's own video or image element already decoded,
   * found in `host`, so the camera, the review, the editor and the viewer all use it unchanged. It
   * renders nothing when the frame fills the stage (`active` false). A frame that cannot be read
   * (tainted canvas) leaves the dark surface, logged once.
   */
  import { paintBlurredBackdrop } from '$lib/reels/reelBackdropPaint';

  interface Props {
    /** The element holding the frame's media; searched for the first video or image. */
    host: HTMLElement | null;
    /** The backdrop is visible: the frame leaves some of the stage uncovered. */
    active: boolean;
  }

  let { host, active }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  let warned = false;
  /** The media and source last painted: a second `loadeddata` of the same picture paints nothing. */
  let painted: { media: Element; src: string } | null = null;

  function paint() {
    const media = host?.querySelector<HTMLVideoElement | HTMLImageElement>('video, img');
    if (!media || !canvas) return;
    const src =
      media.currentSrc || (media instanceof HTMLVideoElement && media.srcObject ? 'stream' : '');
    if (painted?.media === media && painted.src === src) return;
    if (media instanceof HTMLVideoElement && media.readyState < 2) return;
    try {
      if (!paintBlurredBackdrop(canvas, media)) return;
      painted = { media, src };
      console.debug('[reel-backdrop] painted');
    } catch (error) {
      if (!warned) console.warn('[reel-backdrop] the frame could not be sampled', error);
      warned = true;
    }
  }

  $effect(() => {
    if (!active || !host || !canvas) return;
    // `load` and `loadeddata` do not bubble: capture them on the host to catch the media's own.
    const onLoaded = () => paint();
    host.addEventListener('load', onLoaded, true);
    host.addEventListener('loadeddata', onLoaded, true);
    paint();
    return () => {
      host.removeEventListener('load', onLoaded, true);
      host.removeEventListener('loadeddata', onLoaded, true);
      painted = null;
    };
  });
</script>

{#if active}
  <canvas
    bind:this={canvas}
    class="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-60"
    aria-hidden="true"
    data-reel-backdrop
  ></canvas>
{/if}
