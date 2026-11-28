## Reading owed - the scroll-to-bottom arrow shows the unread count after a catch-up into a scrolled-up thread

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

Built 2026-11-25 (`fix/scroll-arrow-unread-count`). Cause measured by reading the code, not a clock: an
open conversation in front marks everything it holds as read (the read-mark effect of `MainChatPage`
carries no scroll position), so a catch-up into a thread scrolled up was covered by the mark the instant
it landed and `countUnreadBelow` answered 0 by its own definition. The pill now counts against the marks
the reader held WHEN THEY LEFT THE LIVE END (`pillCountingPoint`, `pillBaseline` in `ChatArea.svelte`),
dropped on the way back to the end or on another conversation
([chat](../frontend/modules/chat.md#the-scroll-to-bottom-badge-counts-only-what-lies-below-the-viewport-2026-11-01)).
`readState.test.ts` pins it; happy-dom draws no frame.

**The reading, on the Mi 9T** on the first alpha carrying it: scroll a DM up about 1700 px, put the app
away, let 60+ messages arrive from the peer, reopen. **Passes when** the pane stays where it was and the
arrow carries the number of rows below the viewport that arrived since the reader went up; scrolling back
to the end clears it, and the next departure counts from zero again.
