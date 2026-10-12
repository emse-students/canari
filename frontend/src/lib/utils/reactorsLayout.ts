/** What the reactors panel draws for a given amount of room. */
export interface ReactorsLayout {
  /** Columns of names. */
  cols: number;
  /** Rows per column (the last column may be shorter). */
  rows: number;
  /** How many names are drawn. */
  shown: number;
  /** How many are NOT drawn - they are counted on a last "+K" line instead. */
  hidden: number;
}

/**
 * Lays `count` names out in the room a popover really has, so its frame always contains every row
 * it shows (the panel was capped by a constant 200 px and eleven names spilled out of it).
 *
 * Fill a column down to `rowsFit`, then add columns up to `colsFit`; past that, the last cell
 * becomes a "+K" line rather than a row that would leave the frame. Never a scroll: the panel
 * closes on any scroll, so a scrollable list could not be reached.
 */
export function layoutReactors(count: number, rowsFit: number, colsFit: number): ReactorsLayout {
  const maxRows = Math.max(1, Math.floor(rowsFit));
  const maxCols = Math.max(1, Math.floor(colsFit));
  if (count <= maxRows * maxCols) {
    const rows = Math.max(1, Math.min(count, maxRows));
    return { cols: Math.max(1, Math.ceil(count / rows)), rows, shown: count, hidden: 0 };
  }
  const shown = Math.max(maxRows * maxCols - 1, 0);
  return { cols: maxCols, rows: maxRows, shown, hidden: count - shown };
}
