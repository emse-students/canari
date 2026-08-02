import type { MediaType } from '$lib/media';

/** Default aspect ratio when width/height are unknown (legacy messages). */
export const DEFAULT_MEDIA_ASPECT = 4 / 3;

/** Square grid cells for multi-image posts. */
export const GALLERY_MEDIA_ASPECT = 1;

const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;

/**
 * Returns width/height ratio, clamped for layout stability in narrow containers.
 */
export function normalizedAspectRatio(
  width?: number,
  height?: number,
  fallback = DEFAULT_MEDIA_ASPECT
): number {
  if (!width || !height || width <= 0 || height <= 0) return fallback;
  const ratio = width / height;
  return Math.min(Math.max(ratio, MIN_ASPECT), MAX_ASPECT);
}

/** CSS `aspect-ratio` value for inline styles (e.g. skeleton containers). */
export function mediaAspectStyle(
  width?: number,
  height?: number,
  fallback = DEFAULT_MEDIA_ASPECT
): string {
  const ratio = normalizedAspectRatio(width, height, fallback);
  return `aspect-ratio: ${ratio}`;
}

/**
 * Resolved display type of an attachment: the explicit field, or mime-based
 * detection for legacy media stored before `type` existed.
 */
export function resolveMediaType(media: { type?: MediaType; mimeType: string }): MediaType {
  if (media.type) return media.type;
  if (media.mimeType.startsWith('video/')) return 'video';
  if (media.mimeType.startsWith('audio/')) return 'audio';
  if (media.mimeType.startsWith('image/')) return 'image';
  return 'file';
}

/**
 * Whether a container should reserve space with `aspect-ratio` while the media
 * decrypts. Only a picture-shaped attachment has a size known in advance; a file
 * or audio attachment is a self-sizing card, and reserving a ratio for it strands
 * the card at the top of an empty box.
 */
export function reservesAspectRatio(type: MediaType): boolean {
  return type === 'image' || type === 'video';
}

/** Min-height reserved for a form card while metadata loads (matches PostForms). */
export const FORM_CARD_PLACEHOLDER_MIN_HEIGHT = '4.75rem';
