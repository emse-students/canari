## P2 - The boot restore opens the frame pipeline before any conversation row exists: a queued frame for a stored conversation is refused (`absent-conversation`), not ACKed, and re-pulled (found by the 1.4.1 dev campaign, DECIDED TO DEFER)

**RAISED FROM P3 ON PRODUCTION NUMBERS (2026-10-30).** One `1.5.1` log of the owner's Pixel: **425
absent-conversation refusals, and up to 124 unacked frames in ONE boot** - every one a second
handling, and the gap healer holding later frames of its group until the re-pull lands. Not a dev
campaign's corner any more: the size of the cost is the size of the backlog a phone comes back to.

**Deferred past 1.4.1 on purpose.** The fix reorders Welcome and commit handling relative to the
restore; a hang there would stop a device receiving anything, so it needs its own plan, review and
campaign. Nothing below is built.

**What happens (read from the code, certain).** The login starts the handshake alongside the MLS
load (the 2026-09-16 optimisation, not the cause). `markInboundReady` opens the gate and replays held
frames; `openGatewayConnection` then awaits the first pull (`fetchPendingMessages` + `settleMailbox`),
so the whole first pull is decrypted BEFORE `loadAndRestoreConversations` starts.
`loadExistingConversations` has awaits (migrate, `getConversations`, duplicate merge) before phase 1
seeds the rows and calls `notifyConversationRowsSeeded`. Any payload frame for a stored conversation
handled in between reaches `handleKnownGroup`, finds no row, logs `Message for absent conversation`
and returns `false` (no ACK); `refetchFramesLeftBehind` re-pulls the mailbox after
`notifyConversationRowsSeeded`.

**Cost.** One extra pull, a second handling of each such frame, the gap healer holding later frames
of that group as `behind-refused-backlog` until the re-pull lands, and a log line. Measured
elsewhere: [startup-load-audit-2026-10-12](../frontend/startup-load-audit-2026-10-12.md) (83 refused,
80 duplicate replays) and finding F12 of
[notification-to-conversation-latency](../frontend/notification-to-conversation-latency.md), which
shortened the window and did not remove it.

**Why the obvious fixes do not work.**

- *Hold frames at the inbound gate*: pulled rows go through `enqueuePendingRows` ->
  `enqueueMessage` -> the scheduler, never `deliverFrame`. Holding the scheduler deadlocks, because
  `openGatewayConnection` waits for the scheduler to settle while the restore that would release it
  starts after.
- *Move the whole restore before the gateway*: ruled out by the 2026-09-15 rationale - the socket
  must be up before phase 2's archive replay, or every mailbox wait re-pulls the mailbox.

**Proposed change (for review).** Give `loadExistingConversations` (via `loadAndRestoreConversations` /
`restoreOnce` in `useConversations.svelte.ts`) two optional arguments: a `historyAfter` promise
awaited between phase 1 and phase 2, and an `onRowsSeeded` callback. New login order:
`beginConversationSource`, await `landingPreview`, adopt mirror entries, start the restore, await
rows seeded, `markInboundReady`, `openGatewayConnection`, resolve `historyAfter`, await the restore.
Keep the `notifyConversationRowsSeeded` re-fetch (the mid-session restore needs it).

**Risks to review first.**

- (a) A boot hang: if the restore throws before phase 1, or `stopIfSignedOut` fires between steps,
  "rows seeded" must still settle on EVERY exit path.
- (b) Welcomes and commits would be processed after phase 1, including
  `mergeDirectConversationDuplicates`, which can call `deleteGroupOnServer` before held frames are
  handled (today it runs after them).
- (c) The pre-restore merge loses its boot use but stays for the mid-session Welcome restore.
- (d) `startupOrder.test.ts` pins the current order and must change.

**Tests owed if built.** A frame held at the gate, or returned by the first pull, for a stored
conversation is handled with its row present; `takeGroupsAwaiting('absent-conversation')` is empty
and no second pull happens; a restore that throws before phase 1 still opens the gate;
`startupOrder.test.ts` updated; a frame decrypted between the gate and phase 2 survives phase 2's
stored-page write.
