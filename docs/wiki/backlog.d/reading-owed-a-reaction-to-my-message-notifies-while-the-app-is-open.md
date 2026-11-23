## Reading owed - a reaction to my message notifies while the app is open, and goes with its conversation (2026-11-21)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

**What is built** (#3792, the salon seed case, and this change): the reaction frame is the second
trigger a reaction has, a salon reaction that opens its sender's new seed session is parked and raised
once its seed lands, and an alert raised in front goes when this device's reader opens the
conversation ([mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17)). Proven by
`reactionNotification.test.ts`, `channelEventHandler.reaction.test.ts`,
`useConversations.owedLiveReaction.svelte.test.ts` and `openedConversationDismissal.test.ts`. The
1:1 and group cases passed on the phones for `1.7.0-alpha.10`.

**The readings that close it, on the first pre-release carrying it:**

1. **Opened here (Mi 9T):** on the feed, have another seat react to a message the Mi wrote in a 1:1,
   then open that conversation from inside the app. The "a reagi" notification is gone at once, and
   logcat shows `readElsewhereFromWebSocket: queued ... read on this device (read_here)`. A message notification
   raised for that conversation goes too; one for ANOTHER conversation stays.
2. **A salon's first reaction of a new seed session (Mi 9T, feed):** remove then re-add a member so
   the reactor's distribution epoch moves, then have the reactor react to a line the Mi wrote. ONE
   "a reagi" notification on `canari_reactions_v2`, and logcat (the WebView console) shows `live row ... parked until
   its seed opens it` then `[NOTIF] Reaction to my message ... asking`. A second reaction a minute
   later draws one too. None with the salon open.
3. **The web with its tab hidden:** a signed-in seat that GRANTED notifications, tab hidden, while
   another seat reacts to a message it wrote in a 1:1: ONE browser notification, none once the tab
   shows that conversation (the rig seats report `denied`, see
   [the harness entry](p3-the-web-hidden-tab-reaction-reading-cannot-be-taken-no-rig-seat-gets-notification-permission.md)).
4. **Opened here (iPhone 12):** the same as 1 on the iPhone, app open on the feed: the reaction's
   notification the page raised is gone from Notification Center once the conversation is opened from
   inside the app (one drawn by a push while the app was away is not reached, and `willPresent` already
   keeps it out of the foreground).

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Fix shipped in `1.7.3`: takeable now. Row 3 (the hidden web tab) cannot be read, the rig seats are denied notification permission; it is closed by `reactionNotification.test.ts` and the harness entry linked in the row. Left: rows 1 and 2 on the Mi 9T, row 4 on the iPhone 12.

**2026-11-23, [`1.8.0-alpha.2`](../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone) (Mi 9T): row 2 PASS on its outcome.** A salon reaction after two epoch moves raised ONE notification and none with the salon open; the `parked until its seed` line did not appear because the seed arrived 130 ms after the frame, and that path is closed on `useConversations.owedLiveReaction.svelte.test.ts`. Left: row 1 on the Mi 9T and row 4 on the iPhone 12.
