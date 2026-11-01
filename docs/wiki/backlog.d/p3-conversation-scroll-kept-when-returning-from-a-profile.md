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
