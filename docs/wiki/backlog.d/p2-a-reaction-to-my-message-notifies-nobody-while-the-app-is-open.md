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

**What is built (2026-11-17, for `1.7.1`)** - the design above, as written, mechanism in
[mobile](../frontend/mobile.md#the-frame-trigger-of-a-reaction-2026-11-17):
`reactionNotification.ts` decides (live frame, someone else, my message, a change that ADDS; app in
the foreground, conversation off screen, `reactions` on, a private conversation at `all`);
`useMessaging.notifyInboundReaction` asks it for every applied reaction frame, MLS and live salon;
Android posts through `notifier_message_natif` with `reaction = true` into ONE Kotlin composition
shared with the push (`showReactionNotification`, `CHANNEL_REACTIONS`, key `reaction:<groupId>`);
iOS, desktop and the browser post through the message's plain path, keyed `reaction:<conversation>`.
The server's `[SOCIAL_PUSH] sent` lines now carry `kind=` (`message_reaction` for this push,
`pushKindOf`), so the sent count is one `grep`. Tests: `reactionNotification.test.ts` (the matrix,
and both native guards read from source as the exact complement),
`useMessaging.reactionNotification.svelte.test.ts` (raised in the foreground off screen, never in the
background or for a catch-up frame), `nativeNotification.test.ts`, `push-category.spec.ts`.

**Decided while building, reversible:** a salon's notification level does not govern a salon
reaction on this trigger, because the server cannot apply it to the push either - one rule in both
builders. Applying it would need the salon level on the server's reaction path first.

**The reading owed (on the `1.7.1` pre-release, both phones, the third seat reacting):** with the
Mi 9T's app OPEN on the feed, then in another conversation, then in a salon, a reaction to a message
it wrote in a 1:1, a group and a salon draws ONE "a reagi" notification on `canari_reactions_v2`
(logcat: `notifyMessageFromWebSocket: reaction queued`, and the FCM side's `App in foreground` skip);
with the reacted conversation OPEN, none. Then the app in the background: the push draws exactly one
and the WebView logs `the push draws it`. On the iPhone 12 the same, plus the two windows only a phone
can settle: Control Center pulled down over the open app, and a reaction while LOCKED for ~30 s then
unlocked - each must show ONE notification, never two. A second notification for one reaction is a
FAIL. The web: a hidden tab is told.

**Read early on `1.7.0-alpha.10`, 2026-11-17 (#3792 carried the trigger into `1.7.0`, [readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha10-both-phones-and-the-rig)), all PASS so far, 1:1 only:** the Mi 9T on the feed drew ONE notification on `canari_reactions_v2` (`reaction queued` beside the FCM `App in foreground` skip), none with the reacted conversation open, and exactly one from the push in the background. The iPhone 12 in another conversation: one identifier for the page's post and the push, ONE Notification Center entry (`a delivered twin delivered - kept in the list`); under Control Center one identifier, delivered then replaced (presentation 7 then 26: at most a second sound, never two entries); on the reacted conversation none (`absent - not presented`). **Left:** the group and salon cases, the Mi in another conversation, the locked iPhone, and the web's hidden tab.

**Read on `1.7.0-alpha.10`, 2026-11-18 ([readings](../device-verification.md#the-phone-readings-of-2026-11-18-170-alpha10-the-iphone-broadcasting-and-reactions-in-a-group-a-salon-and-a-locked-iphone)):** a GROUP, the Mi on the feed and then in another conversation: ONE notification each time (the same id updated, `messages=2`), PASS. The iPhone LOCKED about 30 s, twice: one delivered push, one lock-screen row, and on unlocking the catch-up said `not a live frame ... nothing raised`, PASS. A SALON: PASS on a reaction whose seed the Mi held, **FAIL on the first reaction of the reactor's new seed session** - the frame came before its seed, the repair re-read it as history, and the push was dropped in the foreground: [its own entry](p2-a-salon-reaction-that-opens-its-sender-s-new-seed-session-is-never-notified-in-the-foreground.md). **Left: the web with its tab hidden** - no signed-in web seat could grant notifications in this sitting (the rig seats report `denied`).
