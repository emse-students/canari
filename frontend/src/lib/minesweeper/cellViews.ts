import type { Cell } from './game';

/**
 * What the screen draws, kept apart from the engine's board.
 *
 * The engine mutates its cells in place, so they cannot be reactive; the old screen cloned all 576
 * of them after every action to make Svelte notice, and every cell re-rendered. Here the engine's
 * cells stay out of the reactive graph, and `views` holds one immutable object per cell that is
 * REPLACED only when what a player can see of that cell changed - so a flood that opens 40 cells
 * hands 40 new objects to the keyed list and the other 536 keep their identity, which a Svelte prop
 * compares by reference and skips.
 */
export interface CellViews {
  views: Cell[];
  /** One small integer per cell, summarising what `views` last drew; compared, never cloned. */
  codes: number[];
}

export const EMPTY_CELL_VIEWS: CellViews = { views: [], codes: [] };

/** state (2 bits) | mine (1 bit) | adjacent count 0-8 (4 bits): everything a cell draws. */
export function cellCode(cell: Cell): number {
  const state = cell.state === 'hidden' ? 0 : cell.state === 'flagged' ? 32 : 64;
  return state | (cell.mine ? 16 : 0) | cell.adjacent;
}

/**
 * Brings `prev` up to date with the engine's `cells`. Returns the SAME `prev` when nothing a player
 * can see changed (so assigning it is a no-op), otherwise a new `CellViews` that shares every
 * unchanged view object with `prev`. `changed` counts the replaced views.
 */
export function syncCellViews(
  cells: readonly Cell[],
  prev: CellViews
): { next: CellViews; changed: number } {
  let views: Cell[] | null = null;
  let codes: number[] | null = null;
  let changed = 0;
  for (let i = 0; i < cells.length; i++) {
    const code = cellCode(cells[i]);
    if (prev.codes[i] === code) continue;
    views ??= prev.views.slice(0, cells.length);
    codes ??= prev.codes.slice(0, cells.length);
    codes[i] = code;
    views[i] = { ...cells[i] };
    changed++;
  }
  if (changed === 0 && prev.views.length === cells.length) return { next: prev, changed: 0 };
  return {
    next: {
      views: views ?? prev.views.slice(0, cells.length),
      codes: codes ?? prev.codes.slice(0, cells.length),
    },
    changed,
  };
}
