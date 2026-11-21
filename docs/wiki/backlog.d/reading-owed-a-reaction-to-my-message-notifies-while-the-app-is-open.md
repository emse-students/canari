## Reading owed - a reaction to my message notifies while the app is open, and goes with its conversation (2026-11-21)

target: 1.7.3

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
   the WebView logs `readElsewhereFromWebSocket: queued ... (read_here)`. A message notification
   raised for that conversation goes too; one for ANOTHER conversation stays.
2. **A salon's first reaction of a new seed session (Mi 9T, feed):** remove then re-add a member so
   the reactor's distribution epoch moves, then have the reactor react to a line the Mi wrote. ONE
   "a reagi" notification on `canari_reactions_v2`, and the WebView logs `live row ... parked until
   its seed opens it` then `[NOTIF] Reaction to my message ... asking`. A second reaction a minute
   later draws one too. None with the salon open.
3. **The web with its tab hidden:** a signed-in seat that GRANTED notifications, tab hidden, while
   another seat reacts to a message it wrote in a 1:1: ONE browser notification, none once the tab
   shows that conversation (the rig seats report `denied`, see
   [the harness entry](p3-the-web-hidden-tab-reaction-reading-cannot-be-taken-no-rig-seat-gets-notification-permission.md)).
