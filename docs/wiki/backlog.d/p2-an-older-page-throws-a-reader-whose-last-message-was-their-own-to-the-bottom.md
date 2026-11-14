## P2 - an older page throws a reader whose last message was their own back to the bottom

target: 1.7.0

Found 2026-11-14 on dev (`1.6.12-alpha.2`, desktop Chrome) while measuring a seeded 5000-message
thread ([render window](p3-the-thread-s-render-window-only-grows-with-listeners-per-bubble.md)),
reproduced three times: scrolling up through older history, the mounted range fell from 1732 bubbles
to 200, and from 760 to 200, with no input. Every fall coincides with one
`[CHAT_VIEW] <conv> messages N (hasNewMessage=true, response=follow-bottom)` line where N grew by 50 -
an OLDER page joining the conversation - while the newest message had not changed.

**Cause, read in the code.** `ChatArea.svelte` passes `ownMessageAdded: c.messages.at(-1)?.isOwn === true`
to `respondToNewMessage` (`threadAnchor.ts`), which answers `follow-bottom` when it is true. So any
growth of the list, an older page included, in a conversation whose NEWEST message is one's own reads
as "I just sent a message": the pane follows the bottom and the window moves with it. In real use it
throws back to the bottom anyone who sent the last message of a thread and then reads back.

**The fix belongs at the classification**: "own message added" means the newest message CHANGED and
is one's own, not that the newest message is one's own. A test of `threadAnchor` / `ChatArea` with an
older page prepended under an own newest message pins it.
