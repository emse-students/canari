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
   * WHEN IT IS READ IS AN EVENT, NEVER A READINESS FLAG. A video is read on its next PRESENTED frame
   * (one `requestVideoFrameCallback`) after `playing` or `loadeddata`, never on the flag itself:
   * WKWebView can report HAVE_CURRENT_DATA and still hand a canvas a black picture. A read that comes
   * back blank paints nothing and waits for the next presented frame, at most `BLANK_READS` of them
   * (a count, not a clock). A video found PAUSED on a frame already on screen is read at once - no
   * new frame will come. An image is read on `load`. The source is keyed on the `srcObject` itself,
   * so the camera switching lens on the same element repaints; a new source cancels the old chain.
   *
   * NO SECOND DECODER: it reads the picture the frame's own video or image element already decoded,
   * found in `host`, so the camera, the review, the editor and the viewer all use it unchanged. It
   * renders nothing when the frame fills the stage (`active` false). A frame that cannot be read
   * (tainted canvas) leaves the dark surface, logged once.
   *
   * A LIVE CAMERA IS REPAINTED ONCE MORE (Mi 9T, v1.2.9-alpha.4): its first frame is under-exposed,
   * so the paint above read near black or teal over a grey wall. After it, the stream is read every
   * few presented frames until two reads agree, and painted from that read - a bounded frame count
   * (`exposureSettled` in reelBackdropPaint.ts), never a timer. A file's first frame IS its picture.
   */
  import {
    blurSampleInto,
    EXPOSURE_MAX_SAMPLES,
    EXPOSURE_SAMPLE_STRIDE,
    exposureSettled,
    paintBlurredBackdrop,
    readBackdropSample,
  } from '$lib/reels/reelBackdropPaint';

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
  /**
   * The source that needs nothing more (a `MediaStream` or a URL): painted, or given up after
   * `BLANK_READS` blank reads, or unreadable on this engine. The same source is never read again.
   */
  let settledSource: unknown = null;
  /** The frame callback in flight, cancelled on a source change and on cleanup. */
  let pending: { video: HTMLVideoElement; source: unknown; handle: number } | null = null;
  let blankReads = 0;

  function sourceOf(media: HTMLVideoElement | HTMLImageElement): unknown {
    return (media instanceof HTMLVideoElement && media.srcObject) || media.currentSrc || null;
  }

  function cancelPending() {
    if (!pending) return;
    pending.video.cancelVideoFrameCallback?.(pending.handle);
    pending = null;
  }

  /** Reads `media` once into the canvas; true when nothing more is to be done for its source. */
  function paint(media: HTMLVideoElement | HTMLImageElement): boolean {
    if (!canvas) return true;
    const source = sourceOf(media);
    if (source !== null && source === settledSource) return true;
    try {
      const result = paintBlurredBackdrop(canvas, media);
      if (result === 'painted') {
        settledSource = source;
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

  /**
   * Reads the video on its next PRESENTED frame, and again on a blank read, `BLANK_READS` at most.
   * One chain per source: a new source cancels the old chain and starts from zero.
   */
  function paintOnPresentedFrame(video: HTMLVideoElement) {
    const source = sourceOf(video);
    if (source === null || source === settledSource || pending?.source === source) return;
    cancelPending();
    if (typeof video.requestVideoFrameCallback !== 'function') {
      console.warn('[reel-backdrop] no requestVideoFrameCallback: the backdrop stays dark');
      settledSource = source;
      return;
    }
    blankReads = 0;
    const onFrame = () => {
      const chain = pending;
      if (!chain || chain.source !== source) return;
      if (sourceOf(video) !== source) {
        // The element took another source without an event yet; its `loadeddata` re-arms.
        pending = null;
        return;
      }
      const done = paint(video);
      if (!done && ++blankReads < BLANK_READS) {
        chain.handle = video.requestVideoFrameCallback(onFrame);
        return;
      }
      if (!done) {
        console.warn(`[reel-backdrop] ${BLANK_READS} blank reads: the backdrop stays dark`);
        settledSource = source;
      }
      pending = null;
      // A live camera's first frame is read before its exposure settles: one repaint follows.
      if (done && settledSource === source && video.srcObject) repaintOnceSettled(video, source);
    };
    pending = { video, source, handle: video.requestVideoFrameCallback(onFrame) };
  }

  /**
   * The ONE repaint of a live camera's backdrop, from the first read that agrees with the one before
   * it (`exposureSettled`), sampled every `EXPOSURE_SAMPLE_STRIDE` presented frames and given up
   * into a paint of the last read after `EXPOSURE_MAX_SAMPLES` - frames counted, never time. It takes
   * the same `pending` slot, so a lens switch or the teardown cancels it as it cancels a first read.
   */
  function repaintOnceSettled(video: HTMLVideoElement, source: unknown) {
    let frames = 0;
    let reads = 0;
    let previous: [number, number, number] | null = null;
    const onFrame = () => {
      const chain = pending;
      if (!chain || chain.source !== source) return;
      if (sourceOf(video) !== source) {
        pending = null;
        return;
      }
      if (++frames % EXPOSURE_SAMPLE_STRIDE !== 0) {
        chain.handle = video.requestVideoFrameCallback(onFrame);
        return;
      }
      let sample: ReturnType<typeof readBackdropSample>;
      try {
        sample = readBackdropSample(video);
      } catch (error) {
        console.warn('[reel-backdrop] the settled frame could not be sampled', error);
        pending = null;
        return;
      }
      reads += 1;
      if (typeof sample === 'string') {
        console.debug(`[reel-backdrop] settle read ${reads}: ${sample}`);
      } else {
        const settled = previous !== null && exposureSettled(previous, sample.mean);
        if (settled || reads >= EXPOSURE_MAX_SAMPLES) {
          pending = null;
          const why = settled
            ? 'once the exposure settled'
            : 'from the last read, the exposure never settled';
          if (!canvas) {
            console.debug(`[reel-backdrop] not repainted ${why}: the canvas is gone`);
            return;
          }
          const result = blurSampleInto(canvas, sample);
          if (result === 'painted') {
            console.debug(`[reel-backdrop] repainted ${why} (${reads} reads, ${frames} frames)`);
          } else {
            console.warn(`[reel-backdrop] not repainted ${why}: ${result}`);
          }
          return;
        }
        previous = sample.mean;
      }
      if (reads >= EXPOSURE_MAX_SAMPLES) {
        console.debug(
          `[reel-backdrop] no readable settle frame in ${reads} reads: first paint kept`
        );
        pending = null;
        return;
      }
      chain.handle = video.requestVideoFrameCallback(onFrame);
    };
    pending = { video, source, handle: video.requestVideoFrameCallback(onFrame) };
  }

  $effect(() => {
    if (!active || !host || !canvas) return;
    // `load`, `loadeddata` and `playing` do not bubble: capture them on the host. `loadeddata`
    // covers a video that stays PAUSED on its first frame (review, editor): that frame is
    // presented once, so the frame callback fires for it too.
    const onVideo = (e: Event) => {
      if (e.target instanceof HTMLVideoElement) paintOnPresentedFrame(e.target);
    };
    const onLoad = (e: Event) => {
      if (e.target instanceof HTMLImageElement) paint(e.target);
    };
    host.addEventListener('playing', onVideo, true);
    host.addEventListener('loadeddata', onVideo, true);
    host.addEventListener('load', onLoad, true);
    const media = host.querySelector<HTMLVideoElement | HTMLImageElement>('video, img');
    if (media instanceof HTMLVideoElement && media.paused && media.readyState >= 2) {
      // Paused on a frame already on screen: no new frame will be presented, so it is read now.
      paint(media);
    } else if (media instanceof HTMLVideoElement && !media.paused) {
      paintOnPresentedFrame(media);
    } else if (media instanceof HTMLImageElement && media.complete) {
      paint(media);
    }
    return () => {
      host.removeEventListener('playing', onVideo, true);
      host.removeEventListener('loadeddata', onVideo, true);
      host.removeEventListener('load', onLoad, true);
      cancelPending();
      settledSource = null;
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
