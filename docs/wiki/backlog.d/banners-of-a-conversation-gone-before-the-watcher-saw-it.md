## P3 - A banner of a conversation gone before the app could watch it stays until swiped away

target: 1.8.0

**Today.** Opening the app clears no banner (owner, 2026-11-21), and a banner goes with its
conversation through the page's watcher (`endedConversations.ts`), which only sees a conversation
that was in the list and then ended while the app ran. Two narrow cases are outside it and keep their
banner until it is swiped away, a stale notice being the safer error (principle 2):

- a conversation already `removed`, or absent, at boot (it ended while the app was closed), and
- a first DM from a new correspondent, posted by FCM and deleted before it was ever stored.

**What would lift it.** A positive signal from the server at the catch-up (the list of deleted or
excluded groups since the last session, not the absence of a row in a list that is incomplete at
boot), consumed once per catch-up; the test is a closed-app deletion followed by a boot that takes
the banner down, and a Welcome re-admission that does not.
