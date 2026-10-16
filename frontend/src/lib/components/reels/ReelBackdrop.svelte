<script lang="ts">
  /**
   * The rest of the screen around a reel's frame, painted from the reel itself: a blurred, dimmed
   * copy of the frame's picture, so the screen is never black bands (user, 2026-10-11).
   *
   * IT IS PAINTED ONCE PER PICTURE AND NEVER AGAIN (Mi 9T, 2026-10-16). It used to re-sample the
   * playing video every 250 ms into a 24 px canvas the browser stretched 45x: the bands were blocky
   * ("pixelise") and stepped four times a second ("saccade"), and each `drawImage` of a video cost
   * ~25 ms on the main thread - in the viewer a dropped frame per sample, in the CAMERA a 100-150 ms
   * hole in the recorded take every 250 ms (20 fps instead of 29). The picture is now blurred ON THE
   * CANVAS (`paintBlurredBackdrop`) once per source and left alone: no timer, no animation frame, no
   * CSS `filter` for the compositor to re-run.
   *
   * WHEN IT IS READ IS AN EVENT, NEVER A READINESS FLAG. A video is read on its first PRESENTED frame
   * after `playing` (one `requestVideoFrameCallback`), not on `loadeddata`: WKWebView can report
   * HAVE_CURRENT_DATA and still hand a canvas a black picture. A read that comes back blank paints
   * nothing and waits for the next presented frame, at most `BLANK_READS` of them (a count, not a
   * clock). An image is read on `load`. The source is keyed on the `srcObject` itself, so the camera
   * switching lens on the same element repaints.
   *
   * NO SECOND DECODER: it reads the picture the frame's own video or image element already decoded,
   * found in `host`, so the camera, the review, the editor and the viewer all use it unchanged. It
   * renders nothing when the frame fills the stage (`active` false). A frame that cannot be read
   * (tainted canvas) leaves the dark surface, logged once.
   */
  import { paintBlurredBackdrop } from '$lib/reels/reelBackdropPaint';

  /** Presented frames a blank read may be retried on before the dark surface is kept. */
  const BLANK_READS = 5;

  interface Props {
    /** The element holding the frame's media; searched for the first video or image. */
    host: HTMLElement | null;
    /** The backdrop is visible: the frame leaves some of the stage uncovered. */
    active: boolean;
  }

  let { host, active }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  let warned = false;
  /** The source last painted (a `MediaStream` or a URL): the same one is never read twice. */
  let paintedSource: unknown = null;
  /** The source a frame callback is already pending for, so a second `playing` asks no other. */
  let pendingSource: unknown = null;
  let blankReads = 0;

  function sourceOf(media: HTMLVideoElement | HTMLImageElement): unknown {
    return (media instanceof HTMLVideoElement && media.srcObject) || media.currentSrc || null;
  }

  /** Reads `media` once into the canvas; true when nothing more is to be done for its source. */
  function paint(media: HTMLVideoElement | HTMLImageElement): boolean {
    if (!canvas) return true;
    const source = sourceOf(media);
    if (source !== null && source === paintedSource) return true;
    try {
      const result = paintBlurredBackdrop(canvas, media);
      if (result === 'painted') {
        paintedSource = source;
        blankReads = 0;
        console.debug('[reel-backdrop] painted');
        return true;
      }
      console.debug(`[reel-backdrop] not painted: ${result}`);
      return result !== 'blank';
    } catch (error) {
      if (!warned) console.warn('[reel-backdrop] the frame could not be sampled', error);
      warned = true;
      return true;
    }
  }

  /** Reads the video on its next presented frame, and again on a blank read, `BLANK_READS` at most. */
  function paintOnPresentedFrame(video: HTMLVideoElement) {
    const source = sourceOf(video);
    if (source === null || source === paintedSource || source === pendingSource) return;
    if (typeof video.requestVideoFrameCallback !== 'function') {
      console.warn('[reel-backdrop] no requestVideoFrameCallback: the backdrop stays dark');
      return;
    }
    pendingSource = source;
    const onFrame = () => {
      if (sourceOf(video) !== source) {
        pendingSource = null;
        return;
      }
      const done = paint(video);
      if (done || ++blankReads >= BLANK_READS) {
        if (!done)
          console.warn(`[reel-backdrop] ${BLANK_READS} blank reads: the backdrop stays dark`);
        pendingSource = null;
        return;
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  $effect(() => {
    if (!active || !host || !canvas) return;
    // `load` and `playing` do not bubble: capture them on the host to catch the media's own.
    const onPlaying = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) paintOnPresentedFrame(e.target);
    };
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) paint(e.target);
    };
    host.addEventListener('playing', onPlaying, true);
    host.addEventListener('load', onLoad, true);
    const media = host.querySelector<HTMLVideoElement | HTMLImageElement>('video, img');
    if (media instanceof HTMLVideoElement && !media.paused) paintOnPresentedFrame(media);
    else if (media instanceof HTMLImageElement && media.complete) paint(media);
    return () => {
      host.removeEventListener('playing', onPlaying, true);
      host.removeEventListener('load', onLoad, true);
      paintedSource = null;
      pendingSource = null;
      blankReads = 0;
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
