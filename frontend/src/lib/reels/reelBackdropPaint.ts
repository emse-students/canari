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

/** A read of the media, shrunk to the sample size: the input of the blur, and its mean colour. */
export interface BackdropSample {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** The mean red, green and blue of the sample, 0-255 each. */
  mean: [number, number, number];
}

/** The mean red, green and blue of an RGBA read, 0-255 each (`[0, 0, 0]` for an empty read). */
export function meanColour(data: ArrayLike<number>): [number, number, number] {
  const pixels = Math.floor(data.length / 4);
  if (pixels === 0) return [0, 0, 0];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / pixels, g / pixels, b / pixels];
}

/**
 * Reads `media`'s current picture once, shrunk to {@link backdropSampleSize}: the one media read
 * a paint costs.
 *
 * @throws whatever `drawImage` throws for a picture it may not read (a tainted source).
 */
export function readBackdropSample(
  media: HTMLVideoElement | HTMLImageElement
): BackdropSample | Exclude<BackdropPaintResult, 'painted'> {
  const isVideo = media instanceof HTMLVideoElement;
  const sourceWidth = isVideo ? media.videoWidth : media.naturalWidth;
  const sourceHeight = isVideo ? media.videoHeight : media.naturalHeight;
  if (!sourceWidth || !sourceHeight) return 'no-size';

  const { width, height } = backdropSampleSize(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'no-context';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(media, 0, 0, width, height);
  // A dozen pixels across: reading them back costs nothing next to the media read above.
  const data = ctx.getImageData(0, 0, width, height).data;
  if (isBlankSample(data)) return 'blank';
  return { canvas, width, height, mean: meanColour(data) };
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
  const sample = readBackdropSample(media);
  if (typeof sample === 'string') return sample;
  return blurSampleInto(target, sample);
}

/**
 * A LIVE CAMERA'S FIRST FRAME IS NOT ITS PICTURE. The sensor opens dark and with no white balance,
 * and auto-exposure converges over the frames after it: the backdrop read on the first presented
 * frame came out near black (post camera, Mi 9T, v1.2.9-alpha.4, 3 of 3) or teal (`/camera`) over a
 * grey wall. So a camera's backdrop is read again every {@link EXPOSURE_SAMPLE_STRIDE} presented
 * frames until two reads in a row agree within {@link EXPOSURE_SETTLED_DELTA} per channel, and is
 * repainted ONCE from that read. Counted in frames, never in time; at most
 * {@link EXPOSURE_MAX_SAMPLES} reads, after which the last one is painted.
 */
export const EXPOSURE_SAMPLE_STRIDE = 8;
/** The most reads the settle takes (~1.6 s of a 30 fps preview at the stride above). */
export const EXPOSURE_MAX_SAMPLES = 6;
/** Two reads whose mean channels differ by no more than this (of 255) show a settled exposure. */
export const EXPOSURE_SETTLED_DELTA = 6;

/** Whether two consecutive reads of a live camera agree: its exposure and white balance settled. */
export function exposureSettled(
  previous: readonly [number, number, number],
  next: readonly [number, number, number]
): boolean {
  return previous.every((channel, i) => Math.abs(channel - next[i]) <= EXPOSURE_SETTLED_DELTA);
}

/** Blurs a sample into `target` (resized to the final blur size) by bilinear doublings. */
export function blurSampleInto(
  target: HTMLCanvasElement,
  sample: BackdropSample
): 'painted' | 'no-context' {
  let current = sample.canvas;
  let { width, height } = sample;
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
