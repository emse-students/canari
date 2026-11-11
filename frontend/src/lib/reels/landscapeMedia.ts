import { Log } from '$lib/utils/Log';

/**
 * WHETHER A VIDEO'S OWN FILE IS WIDER THAN TALL (owner, 2026-11-11) - the one question behind the
 * "Plein ecran" chip of the CanaReels pager. A landscape file can be watched full screen turned to
 * landscape (`MediaLightbox` `forceLandscape`); the decision is PER MEDIA, from that media's own
 * recorded width and height, so the next reel is never affected by this one.
 *
 * A SQUARE FILE IS NOT LANDSCAPE (turning the phone gains nothing), and A MEDIA WITHOUT USABLE
 * DIMENSIONS GETS NO CHIP: the answer is unknown, and guessing "landscape" would turn a phone for a
 * vertical clip. That case is said once per media in the log (it accuses the upload that recorded no
 * size), never drawn wrong.
 *
 * Black bars baked INTO a file are not looked at (owner, 2026-11-11: no detection, not now): a
 * portrait file holding a letterboxed landscape picture is portrait here.
 */
export function isLandscapeMedia(media: {
  mediaId?: string;
  width?: number;
  height?: number;
}): boolean {
  const { width, height } = media;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    sayOnce(
      media.mediaId ?? '?',
      `no usable dimensions (${width} x ${height}) - no full-screen chip`
    );
    return false;
  }
  return width > height;
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a log's memory, never rendered
const said = new Set<string>();

function sayOnce(mediaId: string, what: string): void {
  if (said.has(mediaId)) return;
  said.add(mediaId);
  Log.w('reel-landscape', `${mediaId}: ${what}`);
}

/** Test seam: forgets which media were already reported. */
export function resetLandscapeMediaLogForTest(): void {
  said.clear();
}
