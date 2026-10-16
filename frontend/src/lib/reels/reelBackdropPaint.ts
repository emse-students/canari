/**
 * The blur of a reel's backdrop, computed ONCE on a canvas (`ReelBackdrop.svelte`).
 *
 * The picture is shrunk to a few pixels across, then enlarged by doubling, each step a bilinear
 * resample: a chain of tent filters, which converges on a Gaussian blur. The result is a smooth
 * canvas a few dozen pixels wide that the browser can stretch to the screen without a visible
 * block - where stretching the few-pixel sample directly drew each pixel as a square (Mi 9T,
 * 2026-10-16, a 24 px canvas shown 45x). Everything is done here, once, on the main thread in about
 * a millisecond plus the single read of the media; nothing is left for the compositor to blur on
 * each frame, which is also why it costs WKWebView nothing after the paint (no CSS `filter`).
 */

/** Pixels across the shrunk picture: the blur radius, as a share of the width (~1/12). */
export const BACKDROP_SAMPLE_WIDTH = 12;
/** Doublings after the shrink: 12 -> 96 px across, smooth enough to stretch to any screen. */
export const BACKDROP_UPSCALE_STEPS = 3;

/** The size of the shrunk picture for a source of the given size, at least 1 px each way. */
export function backdropSampleSize(
  sourceWidth: number,
  sourceHeight: number
): { width: number; height: number } {
  return {
    width: BACKDROP_SAMPLE_WIDTH,
    height: Math.max(1, Math.round((BACKDROP_SAMPLE_WIDTH * sourceHeight) / sourceWidth)),
  };
}

/**
 * Paints `media`'s current picture, blurred, into `target` (resized to the final blur size).
 *
 * @returns false when the media has no picture size yet (nothing was drawn); true once painted.
 * @throws whatever `drawImage` throws for a picture it may not read (a tainted source).
 */
export function paintBlurredBackdrop(
  target: HTMLCanvasElement,
  media: HTMLVideoElement | HTMLImageElement
): boolean {
  const isVideo = media instanceof HTMLVideoElement;
  const sourceWidth = isVideo ? media.videoWidth : media.naturalWidth;
  const sourceHeight = isVideo ? media.videoHeight : media.naturalHeight;
  if (!sourceWidth || !sourceHeight) return false;

  let { width, height } = backdropSampleSize(sourceWidth, sourceHeight);
  let current = document.createElement('canvas');
  current.width = width;
  current.height = height;
  const first = current.getContext('2d');
  if (!first) return false;
  first.imageSmoothingQuality = 'high';
  first.drawImage(media, 0, 0, width, height);

  for (let step = 0; step < BACKDROP_UPSCALE_STEPS; step++) {
    const isLast = step === BACKDROP_UPSCALE_STEPS - 1;
    const next = isLast ? target : document.createElement('canvas');
    width *= 2;
    height *= 2;
    next.width = width;
    next.height = height;
    const ctx = next.getContext('2d');
    if (!ctx) return false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, width, height);
    current = next;
  }
  return true;
}
