/**
 * THE GIF GRID'S GEOMETRY, COMPUTED BEFORE A SINGLE GIF HAS LOADED.
 *
 * The provider declares every GIF's width and height in its search results, so each tile's box is
 * known from the response alone: the grid is laid out once, tiles never reflow as their pictures
 * arrive (the layout shift the user reported, 2026-10-02), and - because every tile's position is
 * known - only the tiles near the scrolled window are mounted. That is the virtualisation: a long
 * scroll of trending GIFs keeps a few dozen `<img>` alive, not hundreds of animating decoders.
 *
 * Masonry, shortest column first, which is how Discord, WhatsApp and Messenger lay their GIF panels.
 *
 * The ratio is `normalizedAspectRatio`'s - the same clamp `MediaFrame` draws with - so a tile's box
 * and the frame inside it are one shape even for a GIF thinner than the clamp allows.
 */
import { normalizedAspectRatio } from '$lib/utils/mediaLayout';

/** A GIF's declared size, in any unit - only its ratio is used, clamped as every medium's is. */
export interface DeclaredSize {
  width: number;
  height: number;
}

/** One tile placed in the grid, in CSS pixels relative to the grid's top-left. */
export interface MasonryTile {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MasonryLayout {
  tiles: MasonryTile[];
  /** The grid's total height - the scroll extent. */
  height: number;
}

/** Columns for a grid `width` px wide: two on a phone, three from a large phone or a dialog up. */
export function columnsFor(width: number): number {
  return width >= 480 ? 3 : 2;
}

/**
 * Places every tile: each column is `(width - gaps) / columns` wide, each tile as tall as its own
 * ratio makes it, and each goes under the currently shortest column (the leftmost on a tie, so the
 * layout is a pure function of its input).
 */
export function layoutMasonry(
  sizes: DeclaredSize[],
  containerWidth: number,
  columns: number,
  gap: number
): MasonryLayout {
  const columnWidth = Math.max(0, (containerWidth - gap * (columns - 1)) / columns);
  const bottoms = Array.from({ length: columns }, () => 0);
  const tiles: MasonryTile[] = sizes.map((size, index) => {
    let column = 0;
    for (let c = 1; c < columns; c++) if (bottoms[c] < bottoms[column]) column = c;
    const height = Math.round(columnWidth / normalizedAspectRatio(size.width, size.height));
    const tile = {
      index,
      x: Math.round(column * (columnWidth + gap)),
      y: bottoms[column],
      width: Math.round(columnWidth),
      height,
    };
    bottoms[column] += height + gap;
    return tile;
  });
  const height = Math.max(0, ...bottoms.map((b) => b - gap));
  return { tiles, height: tiles.length === 0 ? 0 : height };
}

/** The tiles that intersect `[scrollTop - overscan, scrollTop + viewport + overscan]`. */
export function visibleTiles(
  tiles: MasonryTile[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): MasonryTile[] {
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewportHeight + overscan;
  return tiles.filter((t) => t.y + t.height >= top && t.y <= bottom);
}

/** Whether the reader has scrolled within `threshold` px of the end - time to ask for the next page. */
export function nearEnd(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
  threshold: number
): boolean {
  return contentHeight > 0 && scrollTop + viewportHeight >= contentHeight - threshold;
}
