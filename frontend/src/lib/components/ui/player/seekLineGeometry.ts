/**
 * THE ONE SOURCE OF THE REEL SEEK LINE'S TOUCH ZONE, AND OF THE ROOM A CONTROL ABOVE IT OWES.
 *
 * The reel's progress line (`VideoScrubber`, variant `line`) is 2px to see and SEEK_LINE_TOUCH_REM to
 * touch, on the frame's bottom edge. A control drawn above it (the caption's "Voir plus", the rail)
 * must leave that whole zone free, AND its own enlarged coarse-pointer target (`.tap-target` in
 * `app.css`: at least 2.75rem, centred on the control) must not reach into it. With a hand-picked
 * 1rem the two overlapped and a tap on "Voir plus" grabbed the seek line (owner, 2026-11-10 and
 * 2026-11-11). The clearance is derived from these numbers, never chosen beside them.
 */

/** The seek line's touch height, in rem (32px at the root size). */
export const SEEK_LINE_TOUCH_REM = 2;

/** The minimum coarse-pointer target `.tap-target` gives a control, in rem (`app.css`). */
export const COARSE_TAP_TARGET_REM = 2.75;

/**
 * The bottom room, in rem, a control whose visible line is `controlLineRem` tall needs above the
 * frame's edge so that neither it nor its enlarged target overlaps the seek line's touch zone.
 */
export function clearanceAboveSeekLineRem(controlLineRem: number): number {
  const targetOverhang = Math.max(0, (COARSE_TAP_TARGET_REM - controlLineRem) / 2);
  return SEEK_LINE_TOUCH_REM + targetOverhang;
}
