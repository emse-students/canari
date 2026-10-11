<script lang="ts">
  /**
   * The rest of the screen around a reel's frame, painted from the reel itself: a tiny canvas copy of
   * the frame's picture, blurred and dimmed, so the screen is never black bands (user, 2026-10-11).
   *
   * NO SECOND DECODER: it draws the picture the frame's own video or image element already decoded,
   * 32 px wide, a few times a second while a video plays - the audit found decoder count is what
   * hurts a 5.6 GB phone. It reads the element out of `host`, so the camera, the review, the editor
   * and the viewer (whose player is a component) all use it unchanged. A frame that cannot be sampled
   * (no picture yet, a tainted canvas) leaves the dark surface, logged once.
   */
  import { onMount } from 'svelte';

  interface Props {
    /** The element holding the frame's media; searched for the first video or image. */
    host: HTMLElement | null;
  }

  let { host }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  /** Width of the sampled copy: it is blurred, so detail is wasted. */
  const SAMPLE_WIDTH = 32;
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

  onMount(() => {
    const timer = setInterval(() => {
      if (!document.hidden) sample();
    }, REFRESH_MS);
    sample();
    return () => clearInterval(timer);
  });
</script>

<canvas
  bind:this={canvas}
  class="pointer-events-none absolute inset-0 h-full w-full scale-125 opacity-60 blur-2xl"
  aria-hidden="true"
  data-reel-backdrop
></canvas>
