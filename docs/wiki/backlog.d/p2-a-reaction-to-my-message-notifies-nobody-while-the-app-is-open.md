## P2 - A reaction to my message notifies nobody while the app is open, on any screen (2026-11-17)

target: 1.7.1

**Reported by the owner, 2026-11-17** (Android, production): no notification when someone reacts to
one of his messages, seen in a 1:1.

**What is designed today** ([mobile](../frontend/mobile.md#background-mls-decrypt-ladder), the
paragraph above that heading; [chat-delivery](../services/chat-delivery.md#notification-categories---one-switch-per-kind-decided-before-the-send)):
the reacting client queues the silent MLS reaction frame, then calls `POST /api/mls/notify-reaction`
(`addReaction` in `messaging.ts` for a DM or group, `toggleChannelReaction` for a salon). The server
checks membership, the `reactions` category (on by default) and, for a private conversation, the level
(`all` only), and pushes `type=social, reaction=true` to the message author's tokens. Android and iOS
draw it as the conversation's reaction notification - UNLESS the app is in the foreground, where both
drop it: "the bubble on screen already carries the reaction". The frame itself is drawn by nobody: it
is silent on the push path, and `notifyInbound` (the WebSocket trigger a message has) never sees it.

**The defect.** The suppression's reason holds only while THAT conversation is on screen, and the
predicate is the whole app. On the feed, in another conversation, or in a salon, a reaction is lost:
the push is suppressed and nothing else exists to draw it. The web and desktop have no push at all,
so they never notify a reaction.

**Measured in production, 2026-11-17** (read-only): every `notify-reaction` call in the edge log's
window (11:24-14:13 UTC, 4 calls, all `201`) produced a push sent within the same second (3 Android,
1 iOS); none was refused by a category, a level or a missing token. One of them went to the owner's
only Android token three seconds after his app's socket opened (closed 20 s later): suppressed in the
foreground. His account has no category switched off and every conversation at `all`. The server
half works; the loss is on the device. Reaction FRAMES cannot be counted server-side (ciphertext, and
the history stream carries no kind since 2026-09-28), and no log line names a push's kind - so a
7-day sent-versus-reacted ratio is not measurable today. A `kind=` on the `[SOCIAL_PUSH] sent` line
would make it so.

**The fix, and why it is also step 2's.** Give the reaction the second trigger a message has: when an
inbound reaction frame ADDS (never removes) a reaction by someone else to a message whose sender is
this account, and the app is in the foreground and `canSeeArrival` says the conversation is not on
screen, raise the reaction notification - through `notifier_message_natif` on Android (a `reaction`
flag selecting `CHANNEL_REACTIONS`, `quickActions = false`, the `reaction:<groupId>` id), the plain
plugin on iOS and desktop, the web Notification API in a browser - after `notificationPreferences`
(category `reactions`, the conversation level). Disjoint from the push by construction: the push is
drawn only while the app is NOT in the foreground, this trigger only while it IS. A catch-up drain
must not raise it (live frames only), or a reaction already announced in the background is announced
again on resume. The owner's decision of 2026-11-14 (privacy chantier step 2, "DM reactions travel as
an MLS frame, never as a plaintext push side channel",
[owner-decisions-of-2026-11-14](owner-decisions-of-2026-11-14.md)) needs this exact trigger: when the
side channel goes, the frame is the only carrier and must be drawn by both triggers like a message.

**Not a defect, recorded so nobody chases it:** the background reaction notification has no heads-up
(channel `canari_reactions_v2`, IMPORTANCE_DEFAULT, decided 2026-09-17), and opening the app clears it
with the message notifications.
