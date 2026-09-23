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

## 3ter. Sixty downloads in one frame (2026-09-23)

Every media component fetched its object **on mount**, for every row the page rendered - and the
originals, not thumbnails. `ConversationMediaPanel` mounts its grid in a window of 60, which the
code called a way to keep "the number of concurrent decryptions reasonable"; sixty is a BOUND, not
a concurrency limit. A chat scroll steps the render window by 140 groups and did the same for every
media row in the step. A feed card with a four-image gallery is four downloads, whether or not
anybody scrolls to it.

Nothing was cancelled either: a teardown released the blob and let the bytes keep arriving, holding
one of the browser's connections for a row nobody can see.

TWO MECHANISMS, AND THE CAP IS THE ONE THAT MATTERS. A cap does not reduce the work - it decides
the ORDER, which is the only thing that was ever wrong: sixty downloads on a narrow link all finish
last, three at a time means the visible ones finish first, and the page of history or the feed the
reader IS waiting for keeps a share of the link. `mediaRequestGate` (`requestGate.ts`) is that cap,
placed on the network fetch inside `mediaBlobCache` so that a cache hit still answers instantly and
every caller is covered without knowing the gate exists.

The viewport gate is the second: `nearViewport` already existed and `LinkPreviewCard` already used
it - the browser applies the same rule to the `<img>` beside these requests (`loading="lazy"`), and
the request that produces the image did not have it. Where the component has a root to observe it
gates itself (`SharedMediaThumb`); where it renders a different root per media type, the owner of
the reserved box does it (`PostContent` for a post attachment, `MessageMediaRenderer` for a chat
row) and hands the component a `deferred` prop or an `onNear` callback.

ABORT MEANS "NEVER START", NOT "STOP". A request abandoned while still QUEUED is dropped and never
asks - the whole win for a reader scrolling past thirty rows. One that has already started runs to
completion on purpose: the fetch behind it is shared with every other holder of the same object
through the in-flight map, so cancelling it would cancel somebody else's.

## 3quater. Six taps that waited to be told what they already knew (2026-09-23)

SHAPE 2, AND THE WHOLE OF IT IS ONE QUESTION: does the device already know what the control is
about to show? For all six of these it did, and all six waited anyway.

| control | what it showed on the tap | what the server adds |
| --- | --- | --- |
| a poll option | nothing, until `votePoll` answered | confirmation |
| the send button under a comment | nothing; the box kept the text and the button stayed disabled | the comment's real id |
| a comment's heart | nothing, and a failure was swallowed entirely | the authoritative `likes[]` |
| "Suivre" on a profile | nothing; the button was disabled meanwhile | confirmation |
| "Suivre" on an association | the same | confirmation |
| "Debloquer" in the settings | nothing; the row stayed until the round trip finished | confirmation |

**THE TALLY IS ALREADY HERE.** A poll carries `votesByUser` and a `votes[]` per option, so the new
tally is a pure function of the old one and the tap - `applyPostPollVote`, extracted to
`lib/posts/pollVote.ts` so it can be tested without a component, and pure so the rollback is nothing
more than the post the handler came in with. The CHANNEL poll path had reached that conclusion long
ago (`applyLocalVote`, called before the server); the POST poll path had not, and the two shapes
had simply never been compared.

**A COMMENT IS COMPLETE BEFORE IT IS SENT.** It is written into the list immediately, carrying a
LOCAL id - `pending-<uuid>` - and listed in `pendingCommentIds`, which `PostComments` reads to
withhold every control that would name an id to the server: like, reply, edit, delete, report. That
is the contract, and it is the reason a pending row is safe: the reader sees their comment and
cannot act on an id no endpoint would recognise. The server's row REPLACES it, id and all. A
refusal removes the row and puts the text back in the box, where the reader can send it again.

**THE MUTE CHECK STAYS, AND STOPS BEING A ROUND TRIP IN FRONT OF A TAP.** `assertNotMuted()` ASKS
the server, and it was the FIRST statement of both the reaction and the comment handler - so every
tap in a fresh five-minute window waited for `GET /api/moderation/me/mute-status` before anything
moved. Two changes, and neither removes the check:

- `cachedMuteStatus()` answers from the cache **synchronously** or says it does not know. A mute
  ALREADY KNOWN refuses before anything is written - *never learn by failing what a fact could have
  told you*. Anything else lets the interface move and asks behind it.
- `getMuteStatus()` holds the request in flight, so a reader who reacts, comments and reacts again
  inside the same window makes ONE request instead of three racing each other. The five-minute
  cache only ever covered the SECOND window.

**A ROLLBACK IS NOT A FALLBACK.** Nothing here adds a second path: the write is attempted exactly
once, against exactly one endpoint, and a refusal puts the interface back where it was and says so.
The one place that had no sentence at all was the comment heart, which swallowed its failure - so a
tap on a bad link did nothing, and said nothing either. It logs now.

**WHAT WAS DELIBERATELY LEFT ALONE.** A destructive control keeps its confirmation and its
server-first order: deleting a payment method, deleting a comment, granting an admin. The reader is
not made to watch a row vanish optimistically when the question is whether it may vanish at all.

## 3quinquies. The same list, asked for again on every mount (2026-09-23)

SHAPE 3. Nothing here is slow on its own; what is wrong is HOW MANY TIMES it is asked for.

**FOURTEEN CALL SITES READ THE ASSOCIATION DIRECTORY** - `/associations`, `/directory`, `/lists`,
`/shop`, `/calendar`, three admin screens, the co-owner picker, the post composer, both association
edit tabs - and every one of them asked the server again on mount. Switching between two of those
tabs was two identical `GET /api/associations` to redraw a list that had not changed. Worse inside
the association edit screen, whose tab strip UNMOUNTS the panel it is leaving: every switch back to
"Profil" re-asked for the directory AND the category list.

**A SHOP PAGE WAS N IDENTICAL REQUESTS IN ONE FRAME.** `ProductPurchaseButton` asks for the
reader's saved cards on mount and the shop renders one button per product, so twelve tiles opened
twelve `GET /api/payments/payment-methods` - for one answer, all queued behind each other and in
front of the products the reader was actually waiting to see.

`SharedCache` (`lib/utils/sharedCache.ts`) is the one mechanism under all of it, and it is two
mechanisms that are easy to mistake for one:

- **the TTL** answers *"I was told this recently, I am not asking again"*, which is what makes a tab
  switch cost nothing;
- **the in-flight join** answers *"somebody is already asking"*, which is what collapses twelve
  tiles mounting together into one request. A TTL alone never covers that - the first caller of
  every window races itself, and the shop page is entirely first callers.

**THE TTL IS THE FLOOR, NOT THE MECHANISM.** What keeps an answer right is the invalidation at the
write: creating, editing, deleting or re-logoing an association drops the directory; the four
category writes drop the categories; adding, re-roling or removing a member drops the caller's
memberships; deleting or setting up a card drops the cards. The window only bounds how long a
change made somewhere this client cannot see - another member's browser, a moderator - stays
invisible. **A caller who finds themselves choosing a window to make correctness work has found a
write nobody invalidated.**

**A REJECTION IS NEVER HELD.** A cached failure turns one dropped frame into minutes of a screen
that refuses to load, and a transport failure is not a statement about the data.

**PER-READER STATE IS A REGISTRY, NOT A CHECKLIST.** Three of these answers belong to one account -
the reader's own profile, their memberships, their saved cards - and the list of them written out
at the sign-out site is a list that goes stale the first time somebody adds a cache without
thinking about signing out. A cache declares itself `perReader` where it is BUILT, and
`forgetReaderCaches()` is what sign-out and sign-in-as-somebody-else call.
`ensureMyAssociations`'s probe is not a cache but a promise holding three derived flags, so it
registers a plain callback - both have to go together, or `isAssociationSuperAdmin()` answers for
the previous account.

**ONE CACHE PER ENDPOINT, NEVER ONE PER CALLER.** `ensureMyAssociations` already carried that
reasoning in its own comment - *two caches over the same endpoint drift the moment one is forced
and the other is not* - and was itself a second cache over `listMyAssociations`. It now reads
THROUGH it. `fetchMyProfile`'s bespoke 30-second cache, written for the Fil tab in #988, became the
first caller of this class and is now one line.

## 3sexies. What the reader came for, last in the queue (2026-09-23)

SHAPE 1, AND IT IS NOT ABOUT CACHING. Four screens asked for everything they needed one item at a
time, and on each of them the thing the reader actually opened the page to see was not first.
A round trip that is behind another round trip costs both, and a bad link multiplies the whole
chain rather than the longest link in it.

| screen | the chain, in order | what the reader came for |
| --- | --- | --- |
| `/calendar` | the association list -> **the month** -> the super-admin probe -> the membership list -> the pending count | the month, THIRD |
| `/documents` | `getReviewerAccess()` -> **the documents** | the documents, and the page drew NOTHING - not even its header - until the boolean came back |
| `/forms/[id]` | a token refresh -> **the form** -> the linked event -> that event's association -> `checkSubmission` | the form and its controls, and `checkSubmission` decides whether they work at all |
| `/associations/[slug]` | the association -> members + products + partnerships -> the follow status | the page, held at the end by a BUTTON'S LABEL |

**NOTHING BELOW DEPENDS ON ANYTHING BESIDE IT, SO NOTHING BELOW AWAITS ANYTHING BESIDE IT.** That is
the whole change. `/calendar` starts the month alone and lets the filter select and the four
permission probes - which decide only which buttons exist - fill in behind it; the two probes that
read the same endpoint stopped chaining. `/forms/[id]` asks for the linked event and
`checkSubmission` together, and the association slug for the banner follows its event behind the
page rather than in front of it. `/associations/[slug]` folds the follow status into the batch it
used to follow.

**A GATE RUNS BESIDE THE CONTENT, NEVER IN FRONT OF IT** - the same rule #988 applied to the Fil
tab's audience gate, and `/documents` is the other instance of it. The probe and the documents
request start together; a reader who may not be there is sent away by the same answer as before,
and the one wasted request on that rarest path is refused by the server for exactly the same reason
it refuses the probe. It is not a way in.

**THE TOKEN WARM-UP WAS NEVER A DEPENDENCY.** `/forms/[id]` awaited `getToken()` before asking for
the form, next to a comment saying the form loads fine without it. `refresh()` already holds one
request in flight for every caller, so the `apiFetch` that follows joins it rather than starting a
second - the await bought nothing and cost a full round trip on a cold session.

## 4. The ledger - what is fixed, what is not

Audited 2026-09-22/23 across chat, feed, communities, associations, settings and profile. Every
line below is a verified file:line reading, not a guess. The "shape" column is section 2.

| # | mechanism | shape | state |
| --- | --- | --- | --- |
| 1 | Fil: audience gate, profile cache, per-tab cache, no blanking | 1 | **fixed 2026-09-23** |
| 2 | Chat scroll yanked to the bottom by any inbound frame, in any conversation | - | **fixed 2026-09-23** |
| 3 | Prepends with no anchor compensation: peer scrollback, and the render window stepping up | - | **fixed 2026-09-23** |
| 4 | Post and message media fetched on mount: no viewport gate, no cap, no cancel | 3 | **fixed 2026-09-23** |
| 5 | Optimistic UI missing: poll vote, comment, comment like, follow, unblock, reaction-behind-a-mute-check | 2 | **fixed 2026-09-23** |
| 6 | `apiFetch` carries no `AbortSignal` and no timeout, so every await below is unbounded | - | open |
| 7 | `listAssociations()` uncached across 14 call sites; `listPaymentMethods()` once per product tile | 3 | **fixed 2026-09-23** |
| 8 | Display names re-resolved per row although the payload already carries them (`directory:177`, `AssociationMemberRow:106`, `NotificationRow:166`) | 3 | open |
| 9 | Channel open deletes the local page **before** awaiting the server (`useConversations.svelte.ts:457`) | 1 | open |
| 10 | The global MLS mutex is held across `fetchHistory` HTTP calls (`history.ts:830`..`:1270`) | - | open |
| 11 | Serial page loads: `/calendar` (5 deep), `/documents` (blank until a boolean), `/forms/[id]` (5), `/associations/[slug]` (3) | 1 | **fixed 2026-09-23** |
| 12 | Association edit: every tab switch remounts and refetches | 1 | **partly fixed 2026-09-23** - the directory and the categories were most of what it re-asked for, and row 7's cache covers them. What each tab fetches FOR ITSELF still costs a round trip per switch. |
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
