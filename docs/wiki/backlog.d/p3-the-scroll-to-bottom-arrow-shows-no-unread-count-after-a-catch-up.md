## P3 - the scroll-to-bottom arrow shows no unread count after a catch-up

target: 1.8.2

Read on the Mi 9T, `1.8.1-alpha.2` (2026-11-25), in a DM scrolled up about 1700 px before the app was put
away: after a 65-message catch-up the pane stayed where it was and the "Revenir en bas de la discussion"
arrow was drawn, but it carried NO number. [chat](../frontend/modules/chat.md) promises the unread pill on
`.chat-scroll-bottom-button` (`unreadBelowCount`, `ChatArea.svelte`) for what arrived below.

**To find before fixing:** whether `countUnreadBelow` returns 0 because the drain's rows reach the pane
without moving the reader's read point (so the count is genuinely 0 by its own definition), or because the
count is read before the drain closes. Measure with a catch-up into a scrolled-up thread.
**It closes when** a test pins the count after a bulk-ingest window ended, and a Mi 9T catch-up into a
scrolled-up thread shows the number.

**Not the same defect:** the arrow left drawn AT the end after a DM open (owner, 1.8.0, 2026-11-25) was
a stick-to-bottom flag decided mid-glide; its fix and reading are
[reading-owed-a-dm-opens-at-its-end-in-one-render](reading-owed-a-dm-opens-at-its-end-in-one-render.md).
