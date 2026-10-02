/**
 * The arithmetic of `MediaFrame`: what box a medium holds BEFORE it is downloaded.
 *
 * ONE ANSWER FOR EVERY RENDERER. A chat photo, a chat video, a GIF and a feed attachment each used to
 * size their own skeleton, their own failure box and their own loaded box - three boxes per medium,
 * and wherever two of them disagreed the row moved when the bytes landed. Here the box is a function
 * of what the MESSAGE says (its declared `width` / `height`) or, for an old message that says
 * nothing, of what this device measured the first time it drew it. The bytes never enter into it.
 * [media-frame](../../../../docs/wiki/frontend/media-frame.md)
 */
import {
  DEFAULT_MEDIA_ASPECT,
  mediaAspectStyle,
  normalizedAspectRatio,
} from '$lib/utils/mediaLayout';

/** A medium's size in pixels, as declared by its sender or measured once by this device. */
export interface MediaSize {
  width: number;
  height: number;
}

/**
 * How the frame takes its size.
 *
 * - `fill`: the WIDTH comes from the caller's class, the height from the ratio, under the
 *   `--media-max-height` ceiling. A chat photo or video, a feed attachment.
 * - `intrinsic`: the frame IS the medium's own size, scaled down (never up) to fit the container's
 *   width and `maxHeight`. Discord's GIF; the GIF panel's tiles.
 */
export type MediaFrameSizing = 'fill' | 'intrinsic';

/** A usable size, or `null` for an absent, zero or non-finite one. */
export function validMediaSize(width?: number, height?: number): MediaSize | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * The size the frame is drawn at: the sender's declaration first, this device's measurement of an
 * old message second, nothing third (the caller's fallback ratio then applies).
 *
 * THE DECLARATION WINS EVEN OVER A MEASUREMENT, because it is the one fact every device shares: two
 * phones measuring the same picture agree, but a declaration is what makes the FIRST render right.
 */
export function resolveMediaSize(
  declared: { width?: number; height?: number },
  measured: MediaSize | null
): MediaSize | null {
  return validMediaSize(declared.width, declared.height) ?? measured;
}

export interface MediaFrameStyleInput {
  size: MediaSize | null;
  sizing: MediaFrameSizing;
  /** Ratio drawn while no size is known - an old message before its first load. */
  fallbackAspect?: number;
  /** `intrinsic` only: the tallest the frame may be, as a CSS length. */
  maxHeight?: string;
}

/** The ceiling a GIF is drawn under, in `app.css`; the literal is only the stylesheet-missing case. */
export const INTRINSIC_MEDIA_MAX_HEIGHT = 'var(--media-inline-max-height, 16rem)';

/**
 * The frame's inline style. Pure, so a test can hold it equal across a load.
 *
 * `intrinsic` is CSS rather than a measurement: `width: min(<w>px, <maxHeight> * <ratio>)` with
 * `aspect-ratio` gives the medium's own size scaled down to the height bound before any layout has
 * run, and `max-width: 100%` scales it down to a narrower container. THE `100%` IS A SEPARATE
 * `max-width`, NEVER A TERM OF THE `min()`: a message bubble is `w-fit`, so it sizes itself FROM this
 * frame, and a percentage inside the width would be cyclic - the frame would contribute nothing and
 * the bubble would collapse around it. A percentage `max-width` is resolved after the bubble has
 * taken the definite width, which is how an `<img>` has always behaved.
 */
export function mediaFrameStyle(input: MediaFrameStyleInput): string {
  const fallback = input.fallbackAspect ?? DEFAULT_MEDIA_ASPECT;
  // `fill` IS `mediaAspectStyle` - the feed and the gallery cells call it directly, and two copies of
  // the ceiling are how the chat and the feed would come to disagree about it.
  if (input.sizing === 'fill')
    return mediaAspectStyle(input.size?.width, input.size?.height, fallback);
  const ratio = normalizedAspectRatio(input.size?.width, input.size?.height, fallback);
  const maxHeight = input.maxHeight ?? INTRINSIC_MEDIA_MAX_HEIGHT;
  const byHeight = `calc(${maxHeight} * ${ratio})`;
  const width = input.size ? `min(${input.size.width}px, ${byHeight})` : byHeight;
  return `aspect-ratio: ${ratio}; width: ${width}; max-width: 100%`;
}
