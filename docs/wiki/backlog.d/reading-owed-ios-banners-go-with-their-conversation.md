## Reading owed - iOS: a banner goes with its conversation, never with the app coming up (owner decision 2026-11-21)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

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

An ending reaches its own entry on Android (no read mark); on iOS the same thread removal. The activation
also retires the pending-sync notice (`canari-9998`), as Android retires its outbox nudge. No reconcile
by absence exists (see social-service).

**The reading that closes it, on the iPhone 12, on the first pre-release carrying it:**

1. A message banner delivered with the app in the background STAYS in Notification Center after the
   app is brought up on another conversation, and the icon badge still counts it.
2. Opening THAT conversation from inside the app removes its banner and lowers the badge; a banner of
   another conversation stays.
3. A conversation deleted by its peer (or left) takes its banner with it.
4. A call ring alert still goes when the app is brought up.
5. The pending-sync notice, if showing, goes when the app is brought up.

**Expected merge conflict:** #3929 also edits `canari_push.mm` (the outbox parts); this change is the
body of `CanariPushCancelMessageNotifications` and a new class at the end of the file, so a conflict
is textual and resolves by keeping both.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Fix shipped in `1.7.3`: takeable now on the iPhone 12 (rows 1 to 5).

**2026-11-23, [`1.8.0-alpha.2`](../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone) (iPhone 12): rows 4 and 5 are CLOSED, not takeable.** A call rings through CallKit and leaves no call-id notification to retire (row 4), and the bench cannot produce a pending-sync notice (row 5); `iosBannersGoWithTheirConversation.test.ts` pins both from source. Rows 1 to 3 were not taken in that sitting: they stay, on the next alpha.
