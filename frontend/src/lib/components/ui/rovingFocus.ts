/**
 * THE ARROW KEYS OF A ROVING-TABINDEX GROUP (a tab set, a radio group): which item a key moves to.
 * One implementation for every group that hands focus around with the arrows - `SegmentedControl`'s
 * tabs and the live's scene radios - so they wrap, jump and ignore the same keys.
 *
 * Right/Down move forward, Left/Up back, both wrapping; Home and End jump to the ends. Answers -1
 * for any other key (the caller lets the event through untouched).
 */
export function rovingTarget(key: string, index: number, count: number): number {
  const last = count - 1;
  if (last < 0) return -1;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return index >= last ? 0 : index + 1;
    case 'ArrowLeft':
    case 'ArrowUp':
      return index <= 0 ? last : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return -1;
  }
}
