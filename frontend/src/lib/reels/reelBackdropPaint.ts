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
 * What a paint did. `no-size`: the media has no picture size yet. `no-context`: the engine gave no
 * 2D context. `blank`: the read came back with no picture at all (every pixel 0, as a video read
 * before its frame is really presented can on WKWebView) and `target` was left untouched.
 */
export type BackdropPaintResult = 'painted' | 'no-size' | 'no-context' | 'blank';

/** Whether a read holds no picture: every channel of every pixel is 0 except, at most, alpha. */
export function isBlankSample(data: ArrayLike<number>): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return false;
  }
  return true;
}

/**
 * Paints `media`'s current picture, blurred, into `target` (resized to the final blur size).
 *
 * @throws whatever `drawImage` throws for a picture it may not read (a tainted source).
 */
export function paintBlurredBackdrop(
  target: HTMLCanvasElement,
  media: HTMLVideoElement | HTMLImageElement
): BackdropPaintResult {
  const isVideo = media instanceof HTMLVideoElement;
  const sourceWidth = isVideo ? media.videoWidth : media.naturalWidth;
  const sourceHeight = isVideo ? media.videoHeight : media.naturalHeight;
  if (!sourceWidth || !sourceHeight) return 'no-size';

  let { width, height } = backdropSampleSize(sourceWidth, sourceHeight);
  let current = document.createElement('canvas');
  current.width = width;
  current.height = height;
  const first = current.getContext('2d');
  if (!first) return 'no-context';
  first.imageSmoothingQuality = 'high';
  first.drawImage(media, 0, 0, width, height);
  // A dozen pixels across: reading them back costs nothing next to the media read above.
  if (isBlankSample(first.getImageData(0, 0, width, height).data)) return 'blank';

  for (let step = 0; step < BACKDROP_UPSCALE_STEPS; step++) {
    const isLast = step === BACKDROP_UPSCALE_STEPS - 1;
    const next = isLast ? target : document.createElement('canvas');
    width *= 2;
    height *= 2;
    next.width = width;
    next.height = height;
    const ctx = next.getContext('2d');
    if (!ctx) return 'no-context';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, width, height);
    current = next;
  }
  return 'painted';
}
