## P3 - a conversation does not keep its scroll position when you come back from a profile

Since 2026-11-01 a sender, a members row and a direct header open the person's profile
([chat](../frontend/modules/chat.md#a-person-in-a-conversation-opens-their-profile-2026-11-01)). The chat route unmounts on
navigation and the conversation reopens at its entry window, so returning from a profile lands at the
bottom (or the first unread), not where the reader was. No per-conversation scroll memory exists.

The mechanism it needs, with no timer: a per-conversation ANCHOR MESSAGE ID (the first message
visible at the top of the viewport) plus the thread's `windowStart`, saved when the reader navigates
away (the route's teardown, never a clock), and restored THROUGH THE ENTRY-WINDOW PATH - the window
opens at `windowStart` and scrolls the anchor into place once it is rendered, the same way an
entry at a message already does. Held in memory for the session only; a conversation never visited
since start has no anchor and opens as today.

**Brief (batch 19, 2026-11-12) - one frontend agent, not a small fix.** The entry window decides
where a conversation opens, so the anchor must enter THERE and nowhere after:

1. Find the entry-window decision (the function that picks the first unread or the bottom) and give
   it one more input, `anchor: { messageId, windowStart } | null`, from a per-conversation map held
   in memory (`conversationAnchors`, cleared at sign-out with the other per-account stores).
2. Write the anchor at the chat route's teardown only (`onDestroy` or `beforeNavigate`), from the
   first message whose row intersects the top of the viewport. No timer, no scroll listener writing it.
3. A stale anchor (its message deleted or out of the stored window) falls back to today's entry with
   one `appendLog` line naming why: a fallback is a signal.
4. Tests: the entry decision as a pure function (anchor present, absent, stale); one rig row opening
   a profile from a sender name half-way up a long conversation and coming back to the same message.
