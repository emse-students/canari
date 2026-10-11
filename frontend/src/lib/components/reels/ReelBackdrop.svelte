<script lang="ts">
  /**
   * The rest of the screen around a reel's frame, painted from the reel itself: a tiny canvas copy of
   * the frame's picture, upscaled by the browser (which is the blur - no CSS filter to re-apply on
   * every repaint) and dimmed, so the screen is never black bands (user, 2026-10-11).
   *
   * NO SECOND DECODER: it draws the picture the frame's own video or image element already decoded,
   * 24 px wide - the audit found decoder count is what hurts a 5.6 GB phone. It reads the element out
   * of `host`, so the camera, the review, the editor and the viewer (whose player is a component) all
   * use it unchanged.
   *
   * IT SAMPLES ONLY WHEN IT CAN BE SEEN: `active` is false when the frame fills the stage, so nothing
   * is mounted or timed then. A still image is sampled once (on load); a video only while it plays, on
   * a visible tab. A frame that cannot be sampled (tainted canvas) leaves the dark surface, logged once.
   */
  interface Props {
    /** The element holding the frame's media; searched for the first video or image. */
    host: HTMLElement | null;
    /** The backdrop is visible: the frame leaves some of the stage uncovered. */
    active: boolean;
  }

  let { host, active }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  /** Width of the sampled copy: the upscale blurs it, so detail is wasted. */
  const SAMPLE_WIDTH = 24;
  /** Refresh period while a video plays; cosmetic, nothing depends on it being right. */
  const REFRESH_MS = 250;

  let warned = false;

  function sample() {
    const media = host?.querySelector<HTMLVideoElement | HTMLImageElement>('video, img');
    if (!media || !canvas) return;
    const isVideo = media instanceof HTMLVideoElement;
    const sourceWidth = isVideo ? media.videoWidth : media.naturalWidth;
    const sourceHeight = isVideo ? media.videoHeight : media.naturalHeight;
    if (!sourceWidth || !sourceHeight) return;
    if (isVideo && media.readyState < 2) return;
    canvas.width = SAMPLE_WIDTH;
    canvas.height = Math.max(1, Math.round((SAMPLE_WIDTH * sourceHeight) / sourceWidth));
    try {
      canvas.getContext('2d')?.drawImage(media, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      if (!warned) console.warn('[reel-backdrop] the frame could not be sampled', error);
      warned = true;
    }
  }

  /** Whether the first media of the host is a video that is playing: the only case needing a timer. */
  function videoPlaying(): boolean {
    const video = host?.querySelector('video');
    return !!video && !video.paused && !video.ended;
  }

  $effect(() => {
    if (!active || !host || !canvas) return;
    console.debug('[reel-backdrop] sampling on');
    // `load` and `loadeddata` do not bubble: capture them on the host to catch the media's own.
    const onLoaded = () => sample();
    host.addEventListener('load', onLoaded, true);
    host.addEventListener('loadeddata', onLoaded, true);
    sample();
    const timer = setInterval(() => {
      if (!document.hidden && videoPlaying()) sample();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      host.removeEventListener('load', onLoaded, true);
      host.removeEventListener('loadeddata', onLoaded, true);
      console.debug('[reel-backdrop] sampling off');
    };
  });
</script>

{#if active}
  <canvas
    bind:this={canvas}
    class="pointer-events-none absolute inset-0 h-full w-full opacity-60"
    aria-hidden="true"
    data-reel-backdrop
  ></canvas>
{/if}
