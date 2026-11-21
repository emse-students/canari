## P2 - iOS: the app's activation must stop clearing chat banners, and a conversation opened or ended must take its own down (owner decision 2026-11-21)

target: 1.7.3

**The owner's decision, 2026-11-21: "N'effacer que les lues"** - a banner goes only when its
conversation is opened or read, here or on another device. Android is done
([social-service](../services/social-service.md)). **iOS still clears every chat banner on
activation** (`CanariPushCancelMessageNotifications` in `canari_push.mm`, called from
`canari_ios.mm`'s `didBecomeActive`), and NO page event reaches its notification centre: the quick
action, a silent read frame and `channel_read` call `CanariCancelConversationNotification`, but the
reader opening a conversation here does not.

**What it takes** (not done in the Android pull request: `canari_push.mm` was being changed by #3929
and could not be touched; none of it can be compiled on the Windows box):

1. `CanariPushCancelMessageNotifications` keeps only the ring alerts (`canariCallId` in `userInfo`) and
   recomputes the badge from what remains - never zero.
2. A class `CanariConversationNotifications` with `+ (BOOL)cancelForConversation:(NSString *)` calling
   `CanariCancelConversationNotification`, reached from a new Tauri command
   `cancel_conversation_notifications(group_id, reason)` through the Objective-C runtime (the pattern of
   `push_registration.rs`: this crate is linked into the notification extension, which has no such
   class).
3. `handOverConversationEvent` (`nativeNotification.ts`) calls it on iOS for `read_here` and
   `conversation_ended`, as it calls `record_read_elsewhere` on Android.

**The reading:** on the iPhone 12, a message banner delivered in the background stays after the app
is brought up on another conversation, and goes when its own conversation is opened; one for a
conversation then deleted goes with it.
