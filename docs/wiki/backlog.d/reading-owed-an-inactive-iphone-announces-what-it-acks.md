## Reading owed - an iPhone that is no longer active announces what it ACKs, and a reaction is never louder than a message (2026-11-23)

target: 1.8.0

Two observations of the `1.8.0-alpha.1` iPhone 12 sitting, answered by the active fact and the
reaction rule ([mobile](../frontend/mobile.md#an-app-that-is-not-active-is-not-read-2026-11-23)). Compiled
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
4. A reaction is never louder than a message in the same place: have the peer react to one of my
   messages, then send a message, in each of these places - and the two must match. A salon left with
   Back on `/communities` (the salon list does not draw it): a banner for each. A DM left with Back to
   the chat list on `/chat` (its row would light up): a tone for the message, nothing for the
   reaction, no banner for either. The conversation itself open: no banner for either.
5. A system permission alert over an open conversation (the photo library or the microphone asked
   for the first time) makes the app inactive: a message from the peer meanwhile raises one banner,
   and is marked read once the alert is answered and the conversation is back in front.
6. A Face ID unlock at launch publishes `active` twice and re-runs no resume (`[LIFECYCLE] App in
   foreground` once).
7. Bring the app back in front during the second between a message's arrival and its banner (hard
   to time by hand; the in-app log says it when it happens): `[NOTIF] ... the reader came back in
   front before the post; nothing raised`, and no banner left over in Notification Center.

All pass: delete this file.
