# Read receipt privacy - what may move a salon's "Lu par"

**CLOSED 2026-10-14** (see [the closing section](#closed-2026-10-14)). The user's chantier of
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
visible, the app in the foreground - or a notification banner that shows the message's text. Clearing
a badge is not reading and moves only the private mark.

`advanceChannelReadMark` has exactly two doors, both found by searching every caller of it and of
`POST /channels/:id/read-mark`:

1. **the receipt effect in `MainChatPage.svelte`** - `selectedContact` set, `isWindowFocused`,
   `isTabVisible`, `isAppInForeground()`, conversation `active`; it writes the owed mark
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
| 1 | reader clicks a salon, window focused | moves after the 2 s debounce, or AT ONCE when the reader leaves the salon inside it (since 2026-10-27; only a mark the reading already decided, never one for an unread message) | cleared | bench 10-08: one salon opened -> exactly one `read-mark`, that salon only | intended |
| 2 | message arrives in the salon being read | moves | stays 0 | receipt effect; bench 10-10 control row | intended |
| 3 | reader walks the ten communities, opens no salon | none | unchanged | bench 10-08 (twice): 0 `read-mark`, server marks unchanged; `onSelectCommunity` clears the selection | intended |
| 4 | community selected, a salon auto-selected | n/a | n/a | only creation (`ensureWorkspaceByName`) and invite acceptance (`openInvitedChannel`) select a salon, both gestures; every other `selectConversation` caller is a click, a notification tap or the profile/mini-panel "message" button | refuted |
| 5 | salon still selected, reader on another page (`/posts`) | none (`MainChatPage` unmounted) | WAS swallowed -> counted since 10-10 | bench 10-10 | fixed 2026-10-10 |
| 6 | tab hidden or window blurred | held until visible and focused | counted | bench 10-10 (simulated `visibilityState` + `blur`) | intended |
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

### Read in the code, not reachable by any path found - recorded so nobody chases them again

- **The first run of the receipt effect sees `isWindowFocused = isTabVisible = true`.** Both start
  `$state(true)` and `onMount`, declared after the effect, corrects them. It matters only if
  `MainChatPage` MOUNTS while the document is hidden or unfocused WITH a salon already selected and
  loaded - and every selection is a gesture (row 4) that also focuses the window. Not proven, not
  changed.
- **A salon open on a phone and covered by its side panel or the conversation drawer** keeps marking
  arrivals. The salon WAS opened by the reader; this is not "marked without opening".
- **iOS (WKWebView) relies on the document's visibility**: nothing writes `__canariForeground` there.
  JS is suspended seconds after backgrounding, so the window is short; it was never measured on an
  iPhone.
- **The other direction, under-marking:** the receipt effect does not track `isAppInForeground()`
  (a plain global), so on Android a message that arrived while the app was in the background is not
  marked on resume until something else changes the conversation - read in the code, not measured.

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
