/**
 * The most cells a post gallery ever draws. Past it, the last cell carries a "+N" over its picture
 * and the viewer holds the rest - the Facebook / Instagram / Messenger shape (user, 2026-10-05).
 */
export const POST_GALLERY_MAX_CELLS = 4;

/**
 * How a post's pictures and videos are laid out.
 *
 * - `none`: nothing to draw (a post of documents only).
 * - `single`: one picture, drawn at its OWN shape like a single-attachment post.
 * - `pair`: two squares side by side.
 * - `feature`: one large square on the left and two squares stacked on its right.
 * - `quad`: a 2x2 of squares, the fourth carrying the "+N" when there are more.
 */
export type PostGalleryShape = 'none' | 'single' | 'pair' | 'feature' | 'quad';

/** The layout decision for a gallery: its shape, how many cells it draws, and how many it hides. */
export interface PostGalleryLayout {
  shape: PostGalleryShape;
  /** How many of the media, from the first, get a cell. */
  visible: number;
  /** How many are not drawn - the N of the last cell's "+N", 0 when every media has a cell. */
  overflow: number;
}

/**
 * Decides the gallery layout from the number of VIEWABLE media (pictures and videos - a document is
 * never a cell, it is a row under the grid).
 *
 * EVERY CELL IS SQUARE BECAUSE THE CELLS USED TO KEEP THEIR OWN SHAPES, and a two-column grid of
 * different heights left blank areas beside the shorter pictures (user, 2026-10-05, with a
 * screenshot). A square also has a height known before anything is downloaded, so the gallery
 * reserves its exact box and nothing below it moves when the pictures land.
 *
 * A count that is not a positive integer is treated as nothing to draw rather than trusted.
 */
export function postGalleryLayout(count: number): PostGalleryLayout {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n === 0) return { shape: 'none', visible: 0, overflow: 0 };
  if (n === 1) return { shape: 'single', visible: 1, overflow: 0 };
  if (n === 2) return { shape: 'pair', visible: 2, overflow: 0 };
  if (n === 3) return { shape: 'feature', visible: 3, overflow: 0 };
  return {
    shape: 'quad',
    visible: POST_GALLERY_MAX_CELLS,
    overflow: n - POST_GALLERY_MAX_CELLS,
  };
}
