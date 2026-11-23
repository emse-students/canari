## Reading owed - an iPhone that is no longer active announces what it ACKs, and a reaction in a conversation left with Back is announced (2026-11-23)

target: 1.8.0

Two losses of the `1.8.0-alpha.1` iPhone 12 sitting, fixed by the active fact and the reaction
predicate ([mobile](../frontend/mobile.md#an-app-that-is-not-active-is-not-read-2026-11-23)). Compiled
by CI only: the shell change (`CanariPublishActive`) has never run on a phone.

Reading, on the bench iPhone, on the first pre-release carrying it, with a second account on the web
sending:

1. Open a conversation, make the home gesture, and have the peer send two messages within the next
   10 s: TWO banners (or one banner standing for both), never zero, never four. The in-app log shows
   `[CanariIOS] active=false published to the page`, then `[NOTIF] Inbound ... while the app is no
   longer active` for each; dev shows no `[PUSH_DEFERRED]` for them.
2. The same with the app swiped up into the app switcher and held there: the same banners.
3. Pull down Notification Center over an open conversation, have the peer send one message, let go:
   one banner, and the message is marked read once the conversation is back in front (not before).
4. Open a conversation, tap Back to the list, have the peer react to one of my messages in it: one
   reaction banner. With the conversation itself open: none.
5. A Face ID unlock at launch publishes `active` twice and re-runs no resume (`[LIFECYCLE] App in
   foreground` once).

All pass: delete this file.
