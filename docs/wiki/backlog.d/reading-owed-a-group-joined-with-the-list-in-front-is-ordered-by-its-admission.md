## Reading owed - a group joined with the list in front is ordered by its admission, and drawn at once

target: 1.7.0

**What is built:** the row a Welcome writes carries the Welcome's server time as its ordering seed
(`admissionSeed`, `setupMessageHandler.ts`), so a joined group sorts at the top of the chat list at
once instead of at 0 - the last row, below a phone's screen - until a reconnect's group sweep wrote
`startedAt`. Cause, evidence and fix: [chat](../frontend/modules/chat.md#a-joined-conversation-is-ordered-by-its-admission-2026-11-16).

**What was seen (iPhone 12, `1.7.0-alpha.5`, dev, 2026-11-16, two of two;
[readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-sixth-sitting-170-alpha5-a-ten-minute-live-and-a-newcomer-after-a-nickname)):**
`delta` (a web seat) created a group and added `gamma` with the phone in front on the chat list. The
phone joined within a second (`[WELCOME] Group ... ready`, `Drain complete`), yet the visible tree did
not list the row for 3 min (through a tab change and a pull-down) and for more than 80 s the second
time; after `button home` then `launch` both were on the first screen, "11 min" and "2 min" old.

**The reading that closes it:** on a build carrying the fix, with `gamma`'s phone in front on the chat
list (a list longer than one screen), another account creates a group and adds `gamma`: the row is on
the FIRST screen within seconds of `[WELCOME] Group ... ready`, with no resume, and no
`the Welcome carries no server time` line in the app log. Once on the iPhone 12; the Mi 9T may take
the same reading (the cause is not platform-specific).
