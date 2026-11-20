## Reading owed - the broadcaster's right-edge control column on both phones (owner, 2026-11-19)

target: 1.7.2

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

Built: on air, the six controls (End, flip, mic, camera, share, chat toggle) are one column on the
right edge, End on top, identity top-left; the column is height-capped and scrolls on a short screen
([live](../frontend/modules/live.md#the-broadcasters-controls-are-one-right-edge-column-owner-2026-11-19)).
Closing reading, iPhone 12 and Mi 9T, portrait AND landscape: nothing wraps, the column clears the
notch and the home bar, no control sits under the comment bar, End asks before ending, and a long
title does not run under the column.

Also read: before going live the controls are still ONE row on the right (the column is on air only),
clear of the pre-live sheet and the rules sheet; with the keyboard up in portrait the column may sit
over the top of the chat box (chat lines stack from the bottom, so it matters only with many lines);
the title editor at 360 px (it is `max-w-full` below `sm`) stays clear of the column.

Also read: a short screen with the studio on (the scene bar is the second right-edge column, at the bottom): the control column scrolls inside its cap and never meets it.

**Read in [S12](../device-verification.md#the-readings-of-2026-11-19-s12-171-alpha4-replays-texts-live-sound-and-the-controls) (`1.7.1-alpha.4`), portrait only:** on the Mi 9T and the iPhone 12 the column is one right edge, End first, the pre-live controls are one row, End asks before ending. **Still owed:** landscape on both phones, a long title, the keyboard up, and the studio on a short screen.
