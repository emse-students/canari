## Reading owed - a reaction to my message notifies a backgrounded and a killed phone, on both platforms (2026-11-17)

target: 1.7.0

**What is built:** `POST /api/mls/notify-reaction` pushes `type=social, reaction=true` to the message
author; Android posts it on `canari_reactions_v2` (sound, no heads-up), iOS through the extension
([mobile](../frontend/mobile.md#background-mls-decrypt-ladder), the reaction paragraph above it).
Production showed every call answered by a sent push on 2026-11-17; nothing showed a phone DRAWING
one. While the app is open nothing is drawn, which is a known defect
([backlog](p2-a-reaction-to-my-message-notifies-nobody-while-the-app-is-open.md)) and not this reading.

**The reading that closes it** (the background half, which `1.7.0` already ships; the foreground
half is the [P2's own reading](p2-a-reaction-to-my-message-notifies-nobody-while-the-app-is-open.md),
owed on the `1.7.1` pre-release): on the `1.7.0` pre-release, a third seat reacts to a message the
Mi 9T wrote in a 1:1, then in a group, then in a salon - first with the Mi 9T's app in the background
(screen on, home screen), then with the app swiped away. Each time the shade shows one "a reagi"
notification for that conversation with the emoji, a second reaction in the same conversation
REPLACES it rather than stacking, and an unread message notification of that conversation is still
there beside it. `adb logcat -s CanariFCM` shows `reaction: group=<8> actor=<8>` and no
`App in foreground` line; the server logs `[SOCIAL_PUSH] sent ... platform=android`. Repeat on the
iPhone 12 (locked, then app killed). Also read, on the Mi 9T, Settings > Apps > Canari >
Notifications: the "Reactions" channel is ON. A reaction with no notification in the background is a
FAIL.
