# Read receipt privacy - what may move a salon's "Lu par"

**CLOSED 2026-10-14, REOPENED BY THE OWNER ON 2026-11-11** for two items: an idle web window must
not mark (decided, built - [the reopening](#reopened-2026-11-11---an-idle-window-is-not-a-reader)),
and a report of a message marked read, and not notified, while the PC's tab was not in front
(investigated there, rows 17-19). The user's chantier of
2026-10-08, *"communities may mark messages read without the salon being opened - measure on a
ten-community bench, then fix what is proven"*, ends here: every path that can move a read mark is
listed below with its evidence, one defect was found and fixed, and nothing else was proven.

## The two marks, and the rule

| Mark | Column | Who sees it | Written by |
| --- | --- | --- | --- |
| the read RECEIPT | `channel_members."readMarks"` | every member of the salon ("Lu par" heads), via `channel.read` and `GET read-marks` | `advanceChannelReadMark` ONLY |
| the private CLEAR | `channel_members."clearedMarks"` | the member's own devices | `clearWorkspaceUnread` ONLY ("Marquer tout comme lu", migration 082) |

The unread COUNT a device shows is the server's (`listUnreadCounts`: newer than the later of both
marks, the membership and `UNREAD_TRACKED_SINCE_MS`) plus what landed live after it counted
([chat](frontend/modules/chat.md#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08)).

**The rule** ([durable-rules](durable-rules.md#community-channels---chat-social-service)):
the receipt moves only where the reader SAW the message - a salon on screen, the window focused and
visible AND, on web and desktop, touched by a person in the last two minutes (since 2026-11-11), the
app in the foreground - or a notification banner that shows the message's text. Clearing
a badge is not reading and moves only the private mark.

`advanceChannelReadMark` has exactly two doors, both found by searching every caller of it and of
`POST /channels/:id/read-mark`:

1. **the receipt effect in `MainChatPage.svelte`** - `selectedContact` set, `isWindowFocused`,
   `isTabVisible`, `isAppInForeground()`, conversation `active`, and `windowAttention.attentive`
   (2026-11-11); it writes the owed mark
   (`recordSalonReadMark`) and the flushes in `useChannelWorkspaces` / `useConversations` only
   DELIVER what that effect recorded (`salonReadMarkQueue.ts`);
2. **the Android shade's "Marquer comme lu"** - `CanariNotificationActionReceiver.handleMarkRead` ->
   `POST /api/mls/push/channel-read` -> `internal/channels/:id/read`. iOS offers no action on a salon
   (`canari_push.mm` and the NSE set the category on DMs and groups only).

## The census

**What was measured, and how.** Three passes. The first two were benches on the local estate
(`tools/cross-client-harness/unread-communities.mjs`, ten communities, 2-5 salons each, the reader's
screen + its server marks + nginx's log of the read endpoints at every step): 2026-10-08 and
2026-10-10, their tables on [chat](frontend/modules/chat.md#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08).
**The third (2026-10-14) could not re-run the bench: Docker Desktop's daemon did not answer
(`docker version` timed out, nothing listened on the estate's ports)**, so it is a census of every
writer and every door in the code, the server suites, and production COUNTS (no content): over the
~24 h since the 2026-10-13 deploy, chat-delivery printed **15 Android `[PUSH_BLIND]` salon banners**
(all `missing=seed held=true`) and 5 on iOS, and social-service **1 `[CHANNEL_READ_PUSH] moved=true`**.

| # | Path | Receipt ("Lu par") | Private count | Evidence | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | reader clicks a salon, window focused | moves AT ONCE on the first reading (leading-edge throttle, owner 2026-11-07), later marks inside the 2 s window coalesce into one trailing send, flushed at once when the reader leaves the salon (only a mark the reading already decided, never one for an unread message) | cleared | bench 10-08: one salon opened -> exactly one `read-mark`, that salon only | intended |
| 2 | message arrives in the salon being read | moves | stays 0 | receipt effect; bench 10-10 control row | intended |
| 3 | reader walks the ten communities, opens no salon | none | unchanged | bench 10-08 (twice): 0 `read-mark`, server marks unchanged; `onSelectCommunity` clears the selection | intended |
| 4 | community selected, a salon auto-selected | n/a | n/a | only creation (`ensureWorkspaceByName`) and invite acceptance (`openInvitedChannel`) select a salon, both gestures; every other `selectConversation` caller is a click, a notification tap or the profile/mini-panel "message" button | refuted |
| 5 | salon still selected, reader on another page (`/posts`) | none (`MainChatPage` unmounted) | WAS swallowed -> counted since 10-10 | bench 10-10 | fixed 2026-10-10 |
| 6 | tab hidden or window blurred | held until visible, focused and touched (row 17) | counted | bench 10-10 (simulated `visibilityState` + `blur`) | intended |
| 7 | Android app in the background, salon selected | none (`isAppInForeground()` false) | counted | `MainActivity` writes `__canariForeground`; measured 2026-09-05 that the document lies there | intended |
| 8 | reload / cold start / reconnect / history load / `read-marks` hydration | none (GETs) | server count restored | bench 10-08 row "reader reloads"; no write outside the two doors | intended |
| 9 | server count `unread-counts` | none - seeding a mark was refused for this very reason | the count | `listUnreadCounts` doc; `channel-unread-counts.spec.ts` | intended |
| 10 | "Marquer tout comme lu" on a community | none, `clearedMarks` only, no `channel.read` | cleared on every device | `channel-unread-clear.spec.ts` (who is told), its PGlite run in #1820 (the SQL) | intended |
| 11 | own mark from another device (`channel.read` with my id) | merged here, no POST from this device | zeroed | `channelEventHandler.ts` | intended (I read it elsewhere) |
| 12 | a follower tab of the same browser | none (only a focused tab's effect posts) | zeroed by `conversation_read` from the reading tab | [chat](frontend/modules/chat.md) multi-tab section | intended |
| 13 | owed marks flushed on load / reconnect | delivers a mark recorded while focused | - | `salonReadMarkQueue.ts`: one recorder, the receipt effect | intended |
| 14 | notification TAP (opens the salon) | moves, as a click | cleared | the tap selects it, then row 1 | intended |
| 15 | shade "Marquer comme lu", banner shows the text | moves to that message's `createdAt` | - | decision of 2026-10-13 ([chat](frontend/modules/chat.md#mark-a-whole-community-as-read-2026-10-13)): the reader read it in the banner | intended |
| 16 | **shade "Marquer comme lu" on a BLIND banner** ("Nouveau message": seed late or missing, no ciphertext, a refused decryption) | **moved - "Lu par" for a message whose text the reader never saw** | - | `ChannelReadMark.offered` asked only for a salon and an instant; the blind body went through the same builder with `sentAt = createdAt`; 15 blind Android banners/day on prod | **DEFECT - fixed 2026-10-14** |
| 17 | **web/desktop window visible and focused, nobody at it** (a PC left on with Canari in front) | **moved on every arrival, and the read signal cleared this account's PHONE banner** (salon: `markChannelRead` -> silent `channel_read` -> `CanariFirebaseMessagingService` cancels it; DM/group: the own `read_watermark`) | zeroed | `isReadingConversationNow` and the receipt effect asked only `visibilityState` and `hasFocus()` | **DEFECT - fixed 2026-11-11** (owner's decision): a gesture in the last 2 min is also required |
| 18 | `MainChatPage` mounting in a hidden or unfocused window with a conversation selected | WOULD move on the effect's first run | - | `isWindowFocused`/`isTabVisible` started `$state(true)`, corrected only by an `onMount` declared after the effect (the bullet below) | **fixed 2026-11-11**: both read from the document at declaration |
| 19 | the owner's report of 2026-11-11 (production web, a 1:1 row bold before a reload, read after it; no phone notification) | the web tab, hidden, posted NOTHING: its log shows the arrivals notified "while the tab is hidden" and no `[READ] mark ... delivered` | - | the mark that read it was the owner's OWN, from another device, received five minutes later (`[READ] <self> has read up to <the newest message's server time>`); the web reload only derived the count from it | not a web door - which device marked, and why, is owed a phone log; why the row stayed bold between that mark and the reload is NOT explained by the code (`withOwnReadAdvanced` recounts on an own mark) and is owed a reproduction (readings below) |
| 20 | the lead's bench, dev, 2026-11-11: a group message from a phone shown "read by" an account whose iPhone was killed and whose only other client was an unattended Chrome (window minimized at the time of reading) | the Chrome LEADER tab (hidden) logged the arrival as notified "while the tab is hidden", and no outbound mark; the second tab's renderer did not answer the debugger (frozen), so its part cannot be read | - | CDP on the bench Chrome | open - the device that sent the mark is not identified; the sender's own log of the incoming `[READ] <reader> has read up to` line is the next reading |

### Read in the code, not reachable by any path found - recorded so nobody chases them again

- **The first run of the receipt effect sees `isWindowFocused = isTabVisible = true`.** Both start
  `$state(true)` and `onMount`, declared after the effect, corrects them. It matters only if
  `MainChatPage` MOUNTS while the document is hidden or unfocused WITH a salon already selected and
  loaded - and every selection is a gesture (row 4) that also focuses the window. Not proven;
  **closed anyway on 2026-11-11** (row 18): both are read from the document at declaration.
- **A salon open on a phone and covered by its side panel or the conversation drawer** keeps marking
  arrivals. The salon WAS opened by the reader; this is not "marked without opening".
- **iOS (WKWebView) relies on the document's visibility**: nothing writes `__canariForeground` there.
  JS is suspended seconds after backgrounding, so the window is short; it was never measured on an
  iPhone.
- **The other direction, under-marking:** the receipt effect does not track `isAppInForeground()`
  (a plain global), so on Android a message that arrived while the app was in the background is not
  marked on resume until something else changes the conversation - read in the code, not measured.
  **Fixed 2026-11-02**, door 1 unchanged: the effect now follows the foreground as state, so the
  resume itself runs it ([chat](frontend/modules/chat.md#read-state-between-devices---the-census-2026-11-02)).
  **Its consequence, decided by the owner the same day:** a resume caused by tapping a notification
  for conversation Y, with X left open, must NOT mark X, the same on both platforms. The shell sends
  the link the resume opens WITH the foreground edge (`detail.opening`: Android from the intent
  `onNewIntent` took before `onResume`, iOS from its notification delegate), and the page holds X
  until the landing selects Y, is abandoned, or the link navigates (`resumeOpening.svelte.ts`). A
  plain resume still marks X, and a tap on a notification the page raised itself follows the same
  rule. The hold only withholds a mark - door 1 is narrowed, never widened.

## The fix (2026-10-14)

`ChannelReadMark.offered(conversationId, sentAt, showsMessage)`: the salon action needs the banner to
show the message. `postChannelNotification` sets `showsMessage` only where `nativeOpenGrainePush`
answered `ok` with a text; every generic branch posts no action, and `showMessageNotification` takes
the flag (default `true`: its other callers hand in real text, and the reaction path offers no
action at all). A held blind line redrawn with its plaintext when the seed arrives goes through the
same function and offers the action again. A DM never had the hole: its generic banner carries
`sentAt = 0`, which the DM action already refuses. Test: `ChannelReadMarkTest` (`a blind banner
never offers it`), mutation-checked - it fails with the old predicate; the app module compiles
(`:app:compileArm64DebugKotlin`).

**Owed:** one look on the Mi 9T - a salon banner posted while the seed is missing shows no "Marquer
comme lu", and the same banner redrawn with its text shows it.

## REOPENED 2026-11-11 - an idle window is not a reader

**The decision (owner, 2026-11-11):** an idle web window must not mark messages read. A window left
in front answers `visibilityState = visible` and `hasFocus() = true` for as long as it stays there,
whoever is at it; a PC left on with Canari open marked every arrival read, told the sender "Vu", and
- through the same read signal - told this account's phone to drop the banner, so the reader saw the
message NOWHERE (row 17). The two questions of the report separate cleanly:

1. **a mark from a hidden tab** - every path that writes or clears was re-read: the receipt effect
   (door 1) and the arrival path (`isReadingConversationNow`, `useMessaging` live and batch paths) ask
   visibility and focus; the owed-mark flushes (`salonReadMarkQueue.ts`, `flushOwedDmReadMarks`) only
   deliver what door 1 recorded; `conversation_read` from a sibling tab and `read_state` from the
   leader move only this account's local count; a follower tab and the leader each decide for their
   OWN window (no tab posts for another). The one theoretical hole was the effect's first run (row 18),
   closed. **No hidden-tab door was found**; the measured case is the attended-looking idle window.
2. **no phone notification because a web tab is connected** - the server does not suppress anything
   on presence: a salon push goes to every registered token (`sendPushToUser`,
   `apps/chat-delivery-service/src/services/messaging.service.ts`), a DM frame is queued per device and
   pushed to an offline one, or to an "online" one whose socket does not ACK within 10 s
   (`scheduleDeferredPush`). What removes the phone's banner is the web's READ SIGNAL (row 17), so the
   phone's silence is the same defect as item 1, and the same fix ends it.

**What was built.** `frontend/src/lib/utils/windowAttention.svelte.ts`: one attention signal per
window (a module singleton, so each tab answers for itself), fed by passive capture listeners on
`pointerdown`, `pointermove` (only with movement - a still pointer's synthetic move after a layout
change is not a hand), `keydown`, `wheel` and `touchstart`, untrusted (scripted) events ignored.
**`scroll` is deliberately not a gesture**: the app's own scroll to a new message fires it, so an
arrival would prove its own reader. It starts IDLE: a page load is not a gesture.

- `arrivalRuntime.ts` asks it with visibility and focus (web and desktop), so an arrival in an idle
  window is NOT read on arrival: the badge, the title count and the notification behave as for any
  unread message, and no read signal leaves.
- The receipt effect asks it after the target is known and before any write, logging
  `[READ] ... not marked: nobody has touched this window` when it withholds. It reads it as STATE: the
  only edge the signal announces is idle -> attended, so the first gesture runs the effect again and
  marks what landed meanwhile.

**Why two minutes, and why it is not a timer.** The threshold is a product definition of attention -
long enough that reading a long message without touching anything still counts, short enough that a
window left alone stops claiming a reader. Nothing fires when it elapses: it is read only at a
decision already being made (an arrival, a run of the receipt effect), and a write is caused by a
gesture or an arrival, never by the clock. Its failure mode is a mark that comes LATER (the reader
alt-tabs back and reads without moving: window `focus` and `visibilitychange` are not counted as
gestures, since an OS can produce them - an unlock, a closing dialog), never a mark for a message
nobody saw.

**Native mobile is exempt** (the owner: native apps keep today's rule, the screen sleeps by itself and
the shell states the foreground). **A desktop app window is NOT exempt**: it is a PC window left open
exactly like a browser tab.

Tests: `windowAttention.svelte.test.ts` (idle 2 min then an arrival -> no mark; then a gesture ->
mark; attended -> mark as before; native -> unchanged; the receipt effect's gate sits before every
write), `arrivalRuntime.attention.test.ts`.

**Owed readings.** Web: a conversation open in a focused window, hands off for 2 min, a message from
another account -> the row stays bold, a notification is raised, the sender keeps "Envoye"; one mouse
move -> marked. A second tab of the same browser behind it posts nothing. Phone: the same message
keeps its banner on the reader's phone while the PC sits idle.

## CLOSED 2026-10-14

**This chantier is closed. Do not re-open it on a report that a salon "was marked read" without
first finding a NEW path that writes `readMarks`** - the two doors above are the only ones, and each
row of the census carries its evidence. A new door is added to this table in the commit that adds
it ([durable-rules](durable-rules.md#community-channels---chat-social-service)).

What is NOT part of it, and stays where it lives:

- a shade mark covers every earlier message of the salon, including ones that never had a banner
  (notification level `mentions`, more than six lines): a receipt is a WATERMARK, read "up to", as a
  DM's is. Changing that is a product decision, not a defect of this chantier;
- the "owed" readings of rows 5, 10 and 16 on dev and on the phones ([chat](frontend/modules/chat.md),
  [backlog](backlog.md#owed-a-verification-and-nothing-else)).
