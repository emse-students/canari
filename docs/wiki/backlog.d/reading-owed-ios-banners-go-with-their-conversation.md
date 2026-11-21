## Reading owed - iOS: a banner goes with its conversation, never with the app coming up (owner decision 2026-11-21)

target: 1.7.3

**What is built** (owner, 2026-11-21: *"N'effacer que les lues"*, as Android):
`CanariPushCancelMessageNotifications` (`canari_push.mm`, run at every `didBecomeActive`) now removes
only a call's ring alert (`canariCallId` in `userInfo`) and recomputes the badge from what remains,
where it used to remove every chat banner and zero the badge. A conversation's banners go through the
page: `handOverConversationEvent` calls `cancel_conversation_notifications` on iOS for `read_here` (the
reader opened it) and `conversation_ended` (deleted, left, excluded, its salon or community gone),
which messages the class `CanariConversationNotifications` and so
`CanariCancelConversationNotification` (by thread, then the badge)
([social-service](../services/social-service.md)). Pinned from source by
`iosBannersGoWithTheirConversation.test.ts`, and `nativeNotification.test.ts` for the page half. **It
was compiled by nothing here: the iOS build is CI's.**

**The reading that closes it, on the iPhone 12, on the first pre-release carrying it:**

1. A message banner delivered with the app in the background STAYS in Notification Center after the
   app is brought up on another conversation, and the icon badge still counts it.
2. Opening THAT conversation from inside the app removes its banner and lowers the badge; a banner of
   another conversation stays.
3. A conversation deleted by its peer (or left) takes its banner with it.
4. A call ring alert still goes when the app is brought up.

**Expected merge conflict:** #3929 also edits `canari_push.mm` (the outbox parts); this change is the
body of `CanariPushCancelMessageNotifications` and a new class at the end of the file, so a conflict
is textual and resolves by keeping both.
