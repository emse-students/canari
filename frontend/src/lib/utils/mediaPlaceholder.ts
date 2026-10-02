/**
 * The tiny picture a medium's box shows while its encrypted blob downloads - a ThumbHash
 * (https://evanw.github.io/thumbhash/), about 25 bytes, the format Discord's attachment
 * `placeholder` carries.
 *
 * MADE BY THE SENDER, because nobody else can: the server stores ciphertext, so the preview Discord
 * and Slack cut server-side does not exist here. It rides inside the end-to-end message
 * (`MediaMsg.placeholder`, `MediaRef.placeholder` as base64), like the CEK beside it.
 * docs/wiki/frontend/media-frame.md
 */
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';
import { fromBase64, toBase64 } from '$lib/utils/hex';
import { Log } from '$lib/utils/Log';

/** ThumbHash's own input ceiling: the encoder is defined on images of at most 100x100. */
const MAX_SIDE = 100;

/**
 * A ThumbHash for an image source already decoded at `width` x `height`, as base64 - or `null`
 * when this engine cannot draw it (no 2D context). Scales the image down to the 100 px ceiling
 * first; the hash keeps the aspect ratio itself.
 */
export function encodeMediaPlaceholder(
  source: CanvasImageSource,
  width: number,
  height: number
): string | null {
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    Log.d('mediaPlaceholder', 'no 2D context - the medium is sent without a placeholder');
    return null;
  }
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  return toBase64(rgbaToThumbHash(w, h, data));
}

/**
 * The placeholder of a picked picture file (a GIF's first frame), or `null` when the engine
 * cannot decode it - HEIC on most of them. A missing placeholder costs the receiver a plain tone
 * instead of a blur, never the message, so this never throws.
 */
export async function placeholderForImageFile(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return encodeMediaPlaceholder(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch (e) {
    Log.d('mediaPlaceholder', `could not decode ${file.type} for a placeholder: ${String(e)}`);
    return null;
  }
}

/**
 * The data URL to paint for a placeholder the message carries, or `null` for none or one this
 * client cannot decode - a placeholder is decoration, and a bad one is dropped, never shown broken.
 */
export function placeholderDataUrl(placeholder: string | undefined): string | null {
  if (!placeholder) return null;
  try {
    return thumbHashToDataURL(fromBase64(placeholder));
  } catch (e) {
    Log.d('mediaPlaceholder', `undecodable placeholder dropped: ${String(e)}`);
    return null;
  }
}
