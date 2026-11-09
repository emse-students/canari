/**
 * The width under which a `FloatingSurface` opens as a bottom sheet rather than a popover -
 * `phoneFullScreen`'s breakpoint. One copy, read by every control that opens one.
 */
export const SHEET_QUERY = '(width < 40rem)';

/** Whether a surface opened NOW should be a sheet: decided at open time, never while it is open. */
export function opensAsSheet(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(SHEET_QUERY).matches;
}
