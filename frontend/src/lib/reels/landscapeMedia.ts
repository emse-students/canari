import { Log } from '$lib/utils/Log';

/** What a media records about its own picture size. */
type MediaDims = { mediaId?: string; width?: number; height?: number };

/** Whether the media records a usable picture size (both sides finite and positive). */
function hasUsableDims({ width, height }: MediaDims): boolean {
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
  );
}

/**
 * WHETHER A VIDEO'S OWN FILE IS WIDER THAN TALL (owner, 2026-11-11) - the one question behind the
 * "Plein ecran" chip of the CanaReels pager. A landscape file can be watched full screen turned to
 * landscape (`MediaLightbox` `forceLandscape`); the decision is PER MEDIA, from that media's own
 * recorded width and height, so the next reel is never affected by this one.
 *
 * PURE, NO LOG (it runs in a `$derived`). A SQUARE FILE IS NOT LANDSCAPE (turning the phone gains
 * nothing), and A MEDIA WITHOUT USABLE DIMENSIONS GETS NO CHIP: the answer is unknown, and guessing
 * "landscape" would turn a phone for a vertical clip. That case is said by
 * {@link reportUnusableDimensions}, once per media.
 *
 * Black bars baked INTO a file are not looked at (owner, 2026-11-11: no detection, not now): a
 * portrait file holding a letterboxed landscape picture is portrait here.
 */
export function isLandscapeMedia(media: MediaDims): boolean {
  return hasUsableDims(media) && media.width! > media.height!;
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a log's memory, never rendered
const said = new Set<string>();

/**
 * Says, once per media, that it records no usable dimensions - so it gets no chip. It accuses the
 * upload that recorded no size. Called from an effect, never from a derivation.
 */
export function reportUnusableDimensions(media: MediaDims): void {
  if (hasUsableDims(media)) return;
  const id = media.mediaId ?? '?';
  if (said.has(id)) return;
  said.add(id);
  Log.w(
    'reel-landscape',
    `${id}: no usable dimensions (${media.width} x ${media.height}) - no full-screen chip`
  );
}

/** Test seam: forgets which media were already reported. */
export function resetLandscapeMediaLogForTest(): void {
  said.clear();
}
