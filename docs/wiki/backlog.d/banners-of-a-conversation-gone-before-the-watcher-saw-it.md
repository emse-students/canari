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

**Mi 9T sitting, `1.7.3-alpha.6` (2026-11-22): the owner's rule (#3951) PASSES on Android.** App backgrounded, two senders' DMs raised two
banners; a warm open and a COLD start (process killed, relaunched) kept both. Reading one conversation on another seat of the same
account took only its banner down (the other stayed). A group text raised a banner; the group deleted by its creator while the app
was in front took that banner down, the unread DM's banner staying. The two narrow cases this entry names are unchanged.
