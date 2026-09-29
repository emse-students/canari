/**
 * Where the open caption field points once the file at `removed` is taken out of the strip.
 *
 * The field is keyed by INDEX, so removing a file before it would silently re-point it at the next
 * photo and let a caption be typed onto the wrong one. Removing the captioned file closes it.
 */
export function shiftAfterRemoval(open: number | null, removed: number): number | null {
  if (open === null || open === removed) return null;
  return open > removed ? open - 1 : open;
}
