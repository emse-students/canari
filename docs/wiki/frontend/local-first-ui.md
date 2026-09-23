# The network must not be in the interaction path

> **The rule.** *A user-visible interaction that can be served from local state must NEVER await
> the network.* Switching a tab, scrolling, opening a thread, tapping a reaction - none of these
> asks a question the device cannot already answer, and none of them may spend a round trip before
> the pixels move.

This page exists because the complaint was not "the app is slow when the network is slow". It was
that things **unrelated to the network** are slowed by it (user, 2026-09-22: *"Beaucoup de choses ne
sont pas liees a internet mais sont impactees"*). That is a different defect class, and it is fixed
mechanism by mechanism rather than screen by screen.

## 1. What was measured, and on what

The phone is the Mi 9T running the real APK against the LOCAL estate through `adb reverse`. A
shaping TCP proxy sits inside that tunnel, because the APK has **two** network clients - the
WebView's `fetch` and Tauri's `plugin-http`, a Rust client reached over an IPC bridge whose `invoke`
is `{writable: false, configurable: false}` and therefore unwrappable from the page. CDP's
`Network.emulateNetworkConditions` only ever sees Chromium's stack, so it measures half the app.
Shaping the socket is the one place that covers both clients **and** the gateway WebSocket.

| what | unshaped | 1500 ms / 64 kbps | 2000 ms / 40 kbps / 7% loss |
| --- | --- | --- | --- |
| cold boot to usable | 3.0 s | 27.4 s | 38.2 s |
| tab -> Discussions | - | 144 ms | - |
| tab -> Communautes | - | 140 ms | - |
| tab -> Fil, first paint | 262 ms | **2045 ms** | - |
| tab -> Fil, settled | 397 ms | **3801 ms** | - |
| scroll of loaded text | - | median 17 ms, p95 17 ms, 0 longtasks | - |

**The causal model the numbers support: perceived cost = (number of SERIAL round trips) x RTT.**
Boot is ~15 deep on an account with two conversations and one community, and the per-group and
per-channel loops make that depth grow with the size of the account. Discussions and Communautes
are served from a store and cost nothing. The Fil was network-gated - and spent its 2 s to then
render an **empty** state.

Scrolling already-loaded text is **not** affected; what makes scrolling feel bad is measured
elsewhere (media fetched on mount with no viewport gate, a non-passive `touchmove` left bound
during a refresh, a forced layout per scroll tick) and is tracked below rather than assumed.

## 2. The three shapes every finding falls into

1. **First paint gated on a request** - a `load` or an `onMount` awaits something before the shell,
   the tab highlight or the already-held list can render.
2. **An interaction that awaits its own confirmation** - a vote, a reaction, a follow, a comment:
   the local copy is complete and the UI still waits for the server before it moves.
3. **Per-item fan-out with no gate** - one request per rendered row, with no batching, no viewport
   gate, no concurrency cap and no cancellation, competing with the request the reader is actually
   waiting for.

## 3. The Fil tab, and what it cost (2026-09-23)

Three separate mechanisms, all on the tab a reader switches to most.

**The audience gate was a round trip in front of the request.** `routes/posts/+page.ts` opened with
`await redirectIfNotFeedAudience()`, and only then constructed the `listPosts` promise - so the
posts request had not left the device until `GET /api/users/me` came back. Two serial latencies to
first paint where one was owed, and `fetchMyProfile` had no cache at all, unlike `fetchUserProfile`
beside it. The verdict is now remembered per account (`feedAudienceState`, persisted, cleared on
logout and on a change of account) and revalidated **behind** the render; the request is issued
before the gate, since the gate is a redirect and not an authorization - the API answers
`GET /api/posts` to anybody who asks, which that helper's docblock has always said.

**A transport failure was read as an answer.** The old `catch` redirected on everything, so a
reader on a train was ejected from the feed to `/chat` by a timeout. Only a 404 - the account does
not exist - is a statement about who somebody is. `routes/+layout.ts` had already reached that split
for the same endpoint; the helper now matches it instead of holding a second opinion.

**The tab was erased on the tap.** An `$effect` on `page.url.search` cleared `postsOverride`
synchronously, so switching tab and back replaced a rendered feed with four skeletons and refetched
from zero. `$lib/posts/feedCache` holds the last page **per tab per reader**, so the pill and the
posts under it can never disagree, and the fresh answer replaces the paint it is replacing -
anything the reader has since appended or deleted is kept. A pull-to-refresh no longer collapses a
list that is on screen either: the skeleton is for an empty list, which is the rule `ChatArea`
already followed.

## 3bis. Who may move the reader's viewport (2026-09-23)

FOUR PLACES ANSWERED THAT, AND THREE OF THEM ASKED NOTHING. `useMessaging` ended every message
persisted, every batch and every finished catch-up drain with a bare
`chatContainer.scrollTop = chatContainer.scrollHeight`. It asked neither whether the reader had
scrolled up to read, nor even whether the message belonged to the thread they had open - the
container it wrote to is *whichever conversation is on screen*, so a batch landing in conversation B
yanked the reader of conversation A to the bottom. On a bad link, where frames trickle in for
minutes, that IS the reading experience. Worst of the three was the one at the end of the drain: a
catch-up finishing is exactly when a bad connection has just recovered, so the recovery itself took
the reader's place away from them.

`ChatArea` already held the careful decision and was being overruled. It is now the only writer, and
the decision is `respondToNewMessage` in `threadAnchor.ts`, tested on its own. Its one behavioural
change: a catch-up may re-pin only while the reader has not left the bottom, and it no longer
re-arms `entering` - which was setting the whole message list to `opacity-0`, so a thread flickered
blank once per arriving frame.

THE OTHER END OF THE PANE HAD NO ANSWER AT ALL. Three mechanisms prepend into the scroller and only
one compensated: `loadOlderGroups` restores `scrollTop` for the IndexedDB page, while the render
window stepping up by 140 groups did not, and neither did a PEER scrollback answer - which does not
arrive as a return value but later, as an ordinary bundle, by which time nothing is holding an
anchor. So a reader who asked for older history was slid down the page by exactly the height of what
they had asked for. `scrollTop` cannot tell a prepend from an append, so a ROW is anchored instead:
the growth observer keeps the topmost rendered row and asks how far it moved (`anchorShift`). That
covers all three mechanisms without knowing which one ran, and it needs no `overflow-anchor`, which
WebKit does not implement.

## 4. The ledger - what is fixed, what is not

Audited 2026-09-22/23 across chat, feed, communities, associations, settings and profile. Every
line below is a verified file:line reading, not a guess. The "shape" column is section 2.

| # | mechanism | shape | state |
| --- | --- | --- | --- |
| 1 | Fil: audience gate, profile cache, per-tab cache, no blanking | 1 | **fixed 2026-09-23** |
| 2 | Chat scroll yanked to the bottom by any inbound frame, in any conversation | - | **fixed 2026-09-23** |
| 3 | Prepends with no anchor compensation: peer scrollback, and the render window stepping up | - | **fixed 2026-09-23** |
| 4 | Post and message media fetched on mount: no viewport gate, no cap, no cancel (`PostMedia.svelte:78`, `MessageBubble.svelte:522`, `SharedMediaThumb.svelte:27`) | 3 | open |
| 5 | Optimistic UI missing: poll vote, comment, comment like, follow, unblock, reaction-behind-a-mute-check | 2 | open |
| 6 | `apiFetch` carries no `AbortSignal` and no timeout, so every await below is unbounded | - | open |
| 7 | `listAssociations()` uncached across 13 call sites; `listPaymentMethods()` once per product tile | 3 | open |
| 8 | Display names re-resolved per row although the payload already carries them (`directory:177`, `AssociationMemberRow:106`, `NotificationRow:166`) | 3 | open |
| 9 | Channel open deletes the local page **before** awaiting the server (`useConversations.svelte.ts:457`) | 1 | open |
| 10 | The global MLS mutex is held across `fetchHistory` HTTP calls (`history.ts:830`..`:1270`) | - | open |
| 11 | Serial page loads: `/calendar` (5 deep), `/documents` (blank until a boolean), `/forms/[id]` (5), `/associations/[slug]` (3) | 1 | open |
| 12 | Association edit: every tab switch remounts and refetches | 1 | open |
| 13 | Polls with no in-flight guard (`admin/status:74`, `SettingsSecuritySection:100`) | - | open |
| 14 | `pullToRefresh` keeps a non-passive `touchmove` bound for the whole refresh (`pullToRefresh.ts:173`) | - | open |
| 15 | Forced layout per scroll tick (`ChatArea.svelte:410`), `tick()` + `getElementById` per log line (`MainChatPage.svelte:232`) | - | open |

## 5. The tools, and where they live

Both are scratch instruments rather than committed gates - they drive a phone that is not in CI.

- **`shaper.mjs`** - `bun shaper.mjs <listen> <upstream> <rttMs> <kbps> [lossPct]`, then
  `adb reverse tcp:8081 tcp:<listen>`. Every chunk waits half an RTT, then occupies the link for
  `len / bandwidth`, so a later chunk queues behind an earlier one as it would on a narrow pipe.
  Loss is expressed as a **dropped connection**, which is what a mobile radio does to a socket.
- **`cdp.mjs`** - a minimal Chrome DevTools Protocol driver over
  `adb forward localabstract:webview_devtools_remote_<pid>`. Note that
  `Page.addScriptToEvaluateOnNewDocument` registrations die with the client session, so a probe and
  the reload it is meant to observe must happen in ONE invocation.

See also: [design-reference](design-reference.md), [posts](modules/posts.md),
[chat](modules/chat.md), [architecture](architecture.md).
