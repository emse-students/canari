## P2 - iOS: "Marquer comme lu" from a killed app does its work, then crashes the app off the main thread

target: 1.7.0

**Read 2026-11-15 on dev (iPhone 12, TestFlight `1.6.12-alpha.2`, build `100601202`), 1 of 1.** A DM from
the delta web seat, the app not running, the Notification Center card held and "Marquer comme lu"
tapped: iOS launched Canari in the background, which logged `cancelConversationNotification`,
`setBadgeCount: badge=0`, `drainOutboxBackground: 1 sent` and `sendReadWatermark: queued+drained
at=<the sender's instant>` - every part of NOTIF-6b worked, and the conversation opened later with no
unread count - then, 1 ms later, `*** Assertion failure in <private>, UIApplication.m:3470` and
`Terminating app due to uncaught exception 'NSInternalInconsistencyException', reason: 'Call must be
made on main thread'` (`termination reported by launchd (2, 6, 6)`). The next open showed TestFlight's
"Canari Crashed" prompt.

**Where:** `canari_push.mm`, the `kCanariMarkReadActionId` branch of the notification response
dispatches `CanariHandleMarkReadAction(...)` AND `completionHandler()` on a global queue; the
completion handler of a `UNNotificationResponse` reaches UIKit, which asserts the main thread on this
iOS. The fix calls `completionHandler` on the main queue (the quick reply's hold already publishes on
the main thread); the reading is the same gesture, no crash, and the read mark observed on the peer.
Not the same as [the mark-as-read over an OPEN app](p2-ios-mark-as-read-from-a-banner-over-an-open-app.md).
