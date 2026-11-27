# Chat module

**Routes**: `src/routes/chat/`  
**Components**: `src/lib/components/chat/`, `src/lib/components/messages/`, `src/lib/components/sidebar/`  
**Composables**: `useChatSession.svelte.ts`, `useConversations.svelte.ts`, `useMessaging.svelte.ts`

## Responsibilities

- MLS end-to-end encrypted direct messages and group chats.
- Real-time message delivery via WebSocket (chat-gateway).
- Offline message delivery via pull on reconnect (`fetchPendingMessages`).
- Message reactions, edits, deletes.
- Media attachments (images, files — CEK in MLS ciphertext).
  A generic file is a COMPACT ROW (2026-11-09, design audit M6): bubble-tone fill, no border, 36 px tile, ~56 dp tall (was a 70 dp bordered card); the 44 dp download button sets the floor (`MessageMediaRenderer`).
- Read receipts.
- In-chat message search.
- Conversation sidebar with direct messages and group list.

## Composable architecture

The chat module is split across three composables:

| Composable | Responsibility |
|---|---|
| `useChatSession` | Session lifecycle: login, WebSocket, reconnect, MLS init, device sync |
| `useConversations` | Conversation state: create, list, select, paginate, history replay |
| `useMessaging` | Message operations: send, receive, react, edit, delete, media upload |

Conversation state lives in a `SvelteMap<string, Conversation>` local to the composables (not a global Svelte store). Both `MainChatPage.svelte` and `ChatBackgroundService.svelte` instantiate their own instance.

## The conversation's chrome in the phone apps - glass floating over the thread (2026-09-30)

**The user's rule:** *"only static ui element, that are apart from content, should be liquid glass"*,
and for the conversation: *"replace the bar on top of messages with just a back and menu button
that then grows ... to show the other options ... and do the same for the composer"* - then, the
same day, *"only apply it on phone finally, the design is good on web"*.

**Decisions (user, 2026-09-30).**

- **L1 - the header is three pieces of glass:** back on the left, the contact's avatar and name in a
  CENTRE PILL (tap: the conversation's settings/info panel), and a menu on the right that GROWS into
  the actions the header carried - Members (community channels), Media, Search, Settings, and the
  call buttons once `CALLS_ENABLED` returns. The lock and the channel label go with the actions.
- **L2 - the composer's actions become ONE "+" that grows** into Photos and videos, All files, GIF
  and Poll (channels). The chevron fold (`controlsCollapsed`) goes. The text field, the microphone
  and Send stay where they are - and stay WEB on iOS too, the plugin has no native text field.
- **L3 - overruled the same day: the PHONE APPS only.** iOS and Android wear it (native Liquid Glass
  on iOS, CSS glass on Android); the website keeps its classic header and composer at every width,
  a phone's browser included. One predicate decides it, `usesGlassChrome`.
- **L4 (assumed, not asked) - phone width only.** The desktop header has no back button and room for
  its icons; it and the desktop composer are unchanged.

Both halves merged 2026-09-30 and shipped in `v0.18.32`: WP-G1 (#1251, below) and WP-G2 (#1254, the
iOS native glass drawn at the web pieces' rects,
[mobile](../mobile.md#the-conversations-native-glass-chrome)). The iPhone reading of 2026-10-05
(bench build of `77f5e3cc4`): the native glass tab bar refracts the content under it, and in a
conversation back, title and menu are native glass.

This is WP-G1: the PHONE APPS (iOS and Android) at the narrow chat layout, in CSS glass; WP-G2 makes
the same pieces native Liquid Glass on iOS. **The website keeps its classic header and composer at
every width**, a phone's browser included. ONE predicate decides it, `usesGlassChrome`
(`lib/mobile/glassChrome.ts`, `isMobileTauriRuntime`), read by `ChatHeader`, `ChatArea` and
`ChatComposer`.

- **The header is three pieces of glass** (`ChatHeader`, `.chat-header-phone`): back, the
  conversation in a CENTRE PILL (avatar, name - tap opens its settings, **or the peer's profile in a
  direct conversation**, see below), and `GlassMenuButton`
  ("Plus d'actions") growing into the SAME actions as the classic row, under the same conditions -
  calls when their handlers are given, a channel's members first, media, search, settings.
  `ChatHeader.phoneMenu.svelte.test.ts` holds that parity, and that the website draws none of it.
### A person in a conversation opens their profile (2026-11-01)

Owner: *"it would be nice to reach the profile page of someone you click on in a conversation, in the
participants list, or in the header if it's a 1:1"*. Three entry points, all real `<a>` (or a labelled
button for the glass pill), all built by `profileHref` (`utils/users/profileHref.ts`) and drawn through
`shared/ProfileLink.svelte` for avatars:

- **A message**: the sender's avatar (received messages, last of a run) and the name above it in a group
  (`data-profile-link`, `data-sender-profile-link`). Both stop the click, so the bubble's own tap, its
  long-press and the reactions are untouched. Your own messages carry no avatar and no name, so no link.
- **Members lists** (`ChatGroupPanel`, `ChannelMembersList`): the avatar joins the name, which already
  linked. The remove-member control stays. A salon list builds hrefs from ids alone - no profile is
  fetched for a link.
- **A direct header**: desktop - the peer's avatar and name are links, the gear stays. Phone glass - the
  centre pill opens the profile; **settings stay one tap away in the "..." menu** (they already had an
  entry there, so nothing became unreachable). A group or salon pill still opens its settings.
  **The pill fits its content and is centred** (owner, 2026-11-10: the full-width pill of 1.6.9 was
  reverted); a long name truncates. **This reintroduces design-audit M5 as a cost the owner accepted**:
  the native glass pill is drawn at the web button's rect, and its (wider) native system font clipped
  "Canari Test Alpha" at 186 pt with 70 pt of the bar empty. Owed: one iPhone reading of a long name.
- **A deleted or erased account gets no link**, and a pill with no page behind it falls back to settings:
  `isAbsentUser` (`displayName.ts`) is a reactive set filled when the server answers 404/deleted, so a
  link drawn before the answer is withdrawn when it lands. `false` means "not known gone". The profile
  page itself owns visibility (blocks, review cohort), so a link is only a navigation.
- **Scroll on return IS preserved, for the session** (2026-11-13): the thread's position is saved
  when the reader navigates away and restored THROUGH THE ENTRY - see
  [the position of a reader across a profile](#the-position-of-a-reader-across-a-profile-2026-11-13).

Held by `ChatProfileEntryPoints.svelte.test.ts`.

### The position of a reader across a profile (2026-11-13)

The chat route unmounts on navigation, and a profile is a navigation. The thread keeps where the reader
stood by one mechanism with no clock and no scroll listener (`utils/chat/scrollAnchors.ts`):

- **Measured at the leave, committed at the teardown.** `ChatArea` registers `beforeNavigate` (the DOM is
  still mounted): for a navigation that is not a page unload and goes to ANOTHER pathname,
  `measureReaderPosition` takes `{ messageId, windowStart, offsetPx, lastMessageId }` - the first mounted
  row with any part below the top of the visible thread (a binary search, O(log n) rects; the top is the
  scroller's box plus its `padding-top`, the floating chrome), the render window's start, the row's
  offset from that top, and the conversation's newest message id. It is COMMITTED only by `onDestroy`:
  a navigation that is cancelled, or ends with the pane still mounted (`afterNavigate`), commits nothing.
  A reader at the bottom (`isNearBottom`) or still entering saves NOTHING: the usual entry (first unread,
  bottom) is where they belong.
- **Only the IMMEDIATE return is served - decided by facts, never a clock.** At each entry
  (`decideEntryAnchor`): every other conversation's anchor is erased (A -> profile -> DM B ends A's); the
  restore is declined, with a debug line, when the conversation's newest message is not the one saved
  (`newer-messages`: the usual entry puts the reader at the first unread); and the anchor is TAKEN (erased)
  only once the entry has its groups - an entry onto a list still loading leaves it in place, silently.
- **Read by the entry, only.** `resolveEntryAnchor`, a pure function, decides `restore` or `bottom`. A
  `restore` skips `fillViewportThenPin` for `restoreEntryAnchor`: the window opens at
  `min(windowStart, the anchor's group)`, the row is put back at its offset, and the reveal is the usual
  one (`entryWidening`, `widenEntryWindow`, which compensates `scrollTop`). `isNearBottom` is false from
  the entry, so growth after the reveal is `keep-row`. **While the restore is in flight
  (`restoringEntry`) a late merge or catch-up answers `stay`, never `repin-entry`, and the growth observer
  does not treat the pane as entering** - either would pin the bottom and drop the restore.
- **A stale anchor is a signal.** A message gone from a settled list falls back to the usual entry with
  one `Log.w('chat.anchor', ...)` line naming why; a row that is not mounted after the window opened does
  the same.
- **In memory, for the session.** Dropped at sign-out (`clearUserLocally`) and by the two account-erase paths (`eraseAccountRecordsLocally`, `accountLocalWipe`). A conversation not left since
  start has none and opens as before. Known limit: the window's end is the end of the list, so a deep
  anchor mounts every group below it at the restore (the same cost as `navigateToMessage`).
  Held by `scrollAnchors.test.ts` (the decision, the search, the store) and
  `ChatArea.scrollAnchor.svelte.test.ts` (a modelled geometry: back to the same row at the same offset,
  bottom stays bottom, a position is spent once, a cancelled or same-path navigation keeps nothing, another conversation or newer messages decline it, a message arriving mid-restore keeps the row). **Owed: one phone reading** (the rig row of the brief -
  open a profile from a sender name half-way up a long conversation, come back - is a reading, not a test).

- **It floats over the thread.** `ChatArea` puts header, search, polls and pinned into one layer,
  `.chat-chrome-slot`, and publishes its height as `--chat-header-height`, the way the composer
  publishes `--chat-composer-height`. In the apps (`.chat-glass-chrome` on the panel) the layer is
  `position: absolute` and the list (`padding-top`) and the sync banners (`.chat-thread-banners`)
  reserve it; it is `pointer-events: none` except on its controls, since the gaps between the glass
  pieces are the thread. On the website it stays in the flow.
- **The date pill sits under the chrome EVERYWHERE** - a defect found on the way, on every width: the
  pill is positioned against the whole panel, header included, so at `top: 0.85rem` the header
  covered it while it showed. It now reads `--chat-header-height` too.
- **The apps' composer is ONE "+"** (`ChatComposer`, `addMenuItems`): the photo library, the camera,
  all files, GIF, poll ([the one menu](#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)) - each under its classic button's condition. No paperclip, poll or GIF button and no
  CHEVRON FOLD there: one button needs none. The microphone still gives way to Send while typing. The
  website keeps all of it: the paperclip (a phone browser's opens the same photos / files menu,
  `attachMenuItems`), poll, GIF and the fold.
- **`GlassMenuButton`** (`components/shared`) is the growing menu: a round `glass-chrome` button whose
  panel scales out of the button's own corner (`data-popover-side` picks the origin), portalled -
  `backdrop-filter` would otherwise confine a fixed panel to the button - and positioned with
  `bindFixedPopover`, which keeps a panel on its anchor however wide it is (centring is opt-in,
  `centreWhenWide`, for the emoji pickers only since 2026-10-13), since a panel that grows OUT OF its
  button must not be centred. Its `plain` variant is the same menu without glass: the website's phone
  paperclip. An entry with an on/off state (search, members) is a `menuitemcheckbox`.

- **The polls and pinned bars are glass pills too (user, 2026-10-12)** - they were opaque white
  full-width bars across the middle of the glass chrome. In the apps' narrow layout each trigger
  ("N sondages actifs", "N messages epingles") is a pill centred under the title pill: the
  `.glass-chrome` recipe, the pill corner, one step smaller than the title (13px text, 36px tall),
  6px apart. The list it opens (navigate to an item, unpin it) is a glass panel at the larger-card
  corner (`--radius-2xl`), as `GlassMenuButton`'s panel is, and it takes pointer events itself, so a
  touch between its rows no longer falls through to the thread. All of it is CSS on three class
  names `ChatArea` puts on the existing markup (`.chat-chrome-strip`, `.chat-chrome-bar`,
  `.chat-chrome-panel`, styled under `.chat-glass-chrome` in `app.css`); the click handlers are
  untouched and the website, and the apps' wide layout, keep the opaque bars.
  `chatChromeBarsGlass.test.ts` reads the rules and the markup. **They stay CSS glass on iOS, by
  decision:** a native twin is one UIButton, and these open a list with a per-row unpin that no
  native button can carry - doubling the trigger alone would put native glass beside a CSS panel
  hanging from it. Measured on the real `ChatArea` at 390x780, light and dark, with two polls and
  one to three pins; not measured in the apps themselves.

**On iOS the four pieces are real Liquid Glass** (WP-G2): each is doubled by a native glass button
drawn at its rect, the web piece kept as its invisible geometry, and the menus are native
([mobile](../mobile.md#the-conversations-native-glass-chrome)). The polls and pinned bars are not
doubled (above).

**Measured** on the real `ChatArea` with a stand-in group at 390x780, Chromium, light and dark: in
the glass mode the thread scrolls under the three pieces, the menu hangs from the "..." (right edges
at 378), the search bar floats under the header, the "+" menu opens above the "+", and typing swaps
the microphone for Send; on the website the same page draws no glass at all. **Not measured:** the
apps themselves (no WebView here), a real account, and the keyboard on a phone.

## Key components

| Component | Role |
|---|---|
| `MainChatPage.svelte` | Root chat page, orchestrates sidebar + chat area |
| `ChatArea.svelte` | Header + message list + composer |
| `MessageTextBody.svelte` | A message's text, its links, and the link card under it. **The card is capped at `max-w-sm` in a conversation** (2026-09-25): the bubble is `w-fit` with no width of its own, so a long title stretched the card across the thread - one line of title over a band of blurred poster. The title wraps to three lines (a post's is cut at 100 characters upstream). The feed's `PostContent` mounts the card uncapped, at the post's width. |
| `ChatComposer.svelte` | Message input, media picker, reply preview. **One drop rule for every composer** (2026-11-08): `handleComposerDrop` (`utils/composerDrop.ts`) reads a drop as real files, then a withheld local address (toast), then a WEB IMAGE with no file (`webImageUrlsFromTransfer`). **Only an origin the enforced `connect-src` allows is fetched** (2026-11-20): `connectAllowlist.ts` reads the list the runtime is held to - the web page's from `security/cspDirectives.js`, the app's from `tauri.conf.json`, never restated - and that is Canari's own hosts (plus `static.klipy.com` on the web). Every other origin, which is to say almost every picture dragged out of another site, is refused BEFORE any request with the toast `composer_drop_web_image_refused` and no console line: fetching it would only have handed the browser a request its policy is certain to refuse. An allowed address is fetched by `fetchWebImageFile` with no credentials through `webViewFetch` (`utils/fetchRouting.ts`), never the HTTP plugin the Tauri router gives third-party hosts; one that fails gives the same toast and a `[COMPOSER]` warn naming the host and the typed cause. A dragged picture that carries its FILE is attached by rule 1 and never reaches this step; a server relay that would fetch any host for the client is not built; then text. The post sheet (`CreatePostForm`) is one zone through the `composerDropZone` action, and `dropEffectFor` follows the source's `effectAllowed` (forcing `copy` on a move-only web image made the browser refuse the drop). **The drop badge ends at the WINDOW, not the panel** (2026-09-25): a drop on the editor stops propagating (the file is attached once), and a cancelled drag's closing `dragleave` fires wherever the pointer was - so `drop` (capture), `dragleave` with no `relatedTarget` and `dragend` are read on `window`; `ChatComposer.dragBadge.svelte.test.ts`. **A drop carrying only a local file's ADDRESS is refused, not inserted** (2026-09-25): Firefox given a file by Nemo receives its `file:///` URI and path but no `File`, and the editor pasted the name. `localFileAddressesFromTransfer` (`composerTransfer.ts`) recognises it; the editor and the panel insert nothing and toast `composer_drop_file_unreadable` - a page cannot read a local file from its address, so the attachment button is the way. **On a phone the paperclip opens a menu** (2026-09-28, user: *"comme sur messenger"*) - since 2026-10-02 THE one menu, each entry going straight to its picker, and none on an iOS browser where WebKit's sheet is the menu ([below](#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)). A picker is chosen by what the input ACCEPTS - one input taking images, videos, audio, PDFs and archives is a document request, which Android answers with the file browser - so the photos entry is a second input accepting `image/*,video/*` only: the system photo picker where the phone has one, the photo library on iOS, and no gallery permission (Google Play grants that only to apps built around photos, so an in-app Messenger-style grid was declined). A desktop keeps its single dialog. `ChatComposer.attachMenu.svelte.test.ts`; **which Android versions show the photo grid through the WebView's chooser is NOT measured - owed on a phone.** |
| `ChatMessageGroups.svelte` | Groups messages by date, sticky date indicator |
| `MessageBubble.svelte` | Renders a single message with reply, reactions, status |
| `ConversationMediaPanel.svelte` | Side panel showing shared media for a conversation |
| `MessageEmojiPicker.svelte` | Emoji reaction picker (locale-aware FR/EN i18n) |
| `ComposerEmojiPicker.svelte` | Emoji picker for the text input itself, desktop only |
| `Sidebar.svelte` | Conversation list, community/workspace switcher. The community rail supports drag-and-drop reordering (`svelte-dnd-action`); order is optimistic locally then persisted via `ChannelService.reorderWorkspaces` |

### A community in the rail carries a dot when any of its salons has unread messages (2026-10-05)

`Sidebar.svelte` draws a red dot on the rail's community button, a SIBLING of the button because the
button clips its avatar. It is DERIVED, never stored: `communityHasUnread` (`utils/unreadTotal.ts`)
asks `channelUnreadCount` of every salon - the same function the salon row's badge calls, over the
live `conversations` map that `useMessaging` bumps on an incoming message and zeroes on read - so the
dot lights live and clears with the last read, with no second ledger. The state is spoken by the
button's label (`sidebar_community_unread_label`), the dot is `aria-hidden`.

**There is no mute filter, on purpose:** a salon's notification level (`all`/`mentions`/`none`) is a
server-held PUSH preference read one channel at a time by the settings panel; the salon rows' badges
ignore it too, so the dot agrees with what it summarises. Filtering it would need a new bulk read of
a preference, decided with the user, not guessed. Read-receipt settings do not enter: the count is
local and receipts are only what OTHERS see. `Sidebar.communityUnreadDot.svelte.test.ts`.

### Unread counts of salons: the server counts, this device only merges (2026-10-08)

**The chantier these three sections belong to is CLOSED (2026-10-14)**: every path that can move a
salon's read mark, with its evidence, is on [read-receipt-privacy](../../read-receipt-privacy.md).

**Reported by the user** (*"messages marked read though I never opened the community's salon"*), and
**measured before anything was fixed**, with `tools/cross-client-harness/unread-communities.mjs` on the
local estate: ten communities, 2-5 salons each (public, private and not joined), a reader (W2) and an
owner (W1) posting 2 messages into every salon. Every step is read on three ends - the screen, the
server's `channel_members."readMarks"` and nginx's access log of the read endpoints.

| Step | Screen | Server mark of the reader | Read endpoints POSTed by the reader |
|---|---|---|---|
| 38 salons posted into while the reader sat on `/chat` | tab title `(20)`: **only the 10 `general` salons counted**, the other 28 raised nothing | 0 everywhere | none |
| reader walks all ten communities, opens no salon | `general` badge 2 each; salon-a/b/c rows absent from the sidebar (see below) | unchanged | none |
| **reader reloads** | **every badge gone, every rail dot gone** | unchanged (every salon still newer than the mark) | none |
| reader opens ONE salon | that salon only | that salon only, nothing else | exactly one `read-mark` |
| reader walks the communities again | nothing else changes | unchanged | none |

**The reading that was believed is therefore refuted for marking and confirmed for disappearing.** Nothing
in the app marks a salon read that was not opened: the server mark moves only on the receipt effect of
the SELECTED salon (`MainChatPage`, behind the focus and visibility guard), `onSelectCommunity` clears the
selection, and no effect, history load, reconnect or visibility change selects or marks anything. What the
user saw is the other half: **a salon's `unreadCount` was a tally of what arrived while this device was
listening** - salon messages were not stored here (since F4 only a copy of the last loaded page is kept) and the count was never persisted - so a reload, a
cold start, a phone asleep or a socket that was down left every badge at zero while the server's mark
said the salon was unread. The user reads that as "marked read".

**What changed.** `GET /api/channels/unread-counts` counts per salon the messages that are not silent,
not the caller's own and newer than the caller's mark (no mark: newer than the membership and than
`UNREAD_TRACKED_SINCE_MS`, so history from before marks existed is not called unread). The client asks
after every community load and every return of the socket, and `reconcileSalonUnread` sets each salon's
count to the server's count PLUS the messages that landed live after the server counted
(`ChatMessage.serverTimestamp > asOf`: both sides the row's `createdAt`, no device clock). A salon
opened while the answer was in flight is skipped (a counter, not a timer). The receipt now names the
row's own `createdAt` (`serverAt`): the author's `sentAt` is usually earlier, so the newest message stayed
"newer than the mark" for ever - measured, 49 ms on one machine - and would have been counted unread
right after it was read. **Not always earlier**: an author whose clock leads the server's writes a
`sentAt` past `createdAt`, and since 2026-10-12 a salon row is dated by its `createdAt` on every path,
the history load included ([social-service](../../services/social-service.md#read-receipts-in-a-salon)).

**Refuted, not to be re-opened** (each read in the code AND measured):
- *`onSelectChannelConversation` marks on load/visibility.* It runs on a click only; `claimChannelReadSignal`
  only suppresses repeats.
- *`selectedChannelConversationId` survives a community switch.* `onSelectCommunity` clears it and
  `selectedContact`; on the phone layout Back clears `selectedContact` (the sidebar highlight alone may
  outlive it, and marks nothing - the receipt effect keys on `selectedContact`).
- *Opening a community opens its first salon.* Only creating a community (`ensureWorkspaceByName`) and
  accepting an invitation (`openInvitedChannel`) select a salon, both user gestures.
- *`channel.read` of the own mark empties other devices wrongly.* It does so only for a mark the user
  made on another device.
- *The server marks anything.* `readMarks` is written in one place, `advanceChannelReadMark`, on request.

### A selection is not a screen (2026-10-10)

The 2026-10-08 section above refuted "the app marks a salon read it never opened" for the SERVER's
mark and found none. The user's decision of 2026-10-08 (*"communities may mark messages read without
the salon being opened - measure on a ten-community bench, then fix what is proven"*) was re-run on
the local estate (build of 2026-10-08, ten communities `C99 a`..`j`, owner W1, reader W2) with the
selection placed where the first run never put it: **on a page that does not draw a conversation.**

**What marks what, from the code, before the bench.**

| Action | Local count | Server read mark | `POST /read` (banner signal) |
|---|---|---|---|
| click a salon (`onSelectChannelConversation`) | cleared | at once, then one trailing mark per 2 s window, only if focused + visible + foreground | once, if the newest foreign message is new |
| message arrives, salon selected | stays 0 | via the receipt effect, same guard | at arrival, once per message |
| message arrives, salon NOT selected | +1 | none | none |
| open via a notification tap (read in the code, not re-measured) | the tap selects it, which is a real open | only on a select | only on a select |
| community overview, a notification preview | select nothing (read in the code) | none | none |

**Measured** (reader selects `C99 a` / general, walks to `/posts` by the nav rail; owner posts one
message in each of the ten communities):

| Situation | Badge | `POST /read` | `read-mark` |
|---|---|---|---|
| salon selected, on `/communities`, window in front (control) | cleared | 1 | 1 |
| **salon still selected, reader on `/posts`** | **title unchanged**; ten bench: `(40)` -> `(49)`, nine counted of ten | **1, for the salon nobody saw** | none |
| back on `/communities` | the message counted `1 message non lu` | - | - |
| **salon selected, tab hidden (visibility + blur simulated)** | **title unchanged** - the one signal a hidden tab has | **1** | held until the tab is visible again (correct) |
| other salon selected (control) | `+1` on the salon row | none | none |
| ten bench, reload on `/communities` | `(50)`: the server's count restored the missing one | 2 `unread-counts`, 33 and 29 ms | - |

**Cause.** `selectedContact` lives in a global singleton and `beforeNavigate` clears it only between
`/chat` and `/communities`, so a salon stays "selected" across every other page. The unread count and the
read signal asked `ctx.selectedContact === key`; the tone and the notification asked
`readerCanSeeArrival`, which also let a selection stand on any route. "Selected" is a fact about the
store, "open" about the screen. The server mark was never wrong (the receipt effect lives in
`MainChatPage`, unmounted off the messaging routes, and is focus-guarded), so the cost was: a badge
missing for as long as the session lived, no OS notification on a page elsewhere, and a banner
cancelled on the account's other devices for a message nobody read. The cost of the count itself is
what the 2026-10-08 section says: two requests per load, ~30 ms, independent of the number of
communities.

**Fix.** ONE predicate, `readerIsReadingConversation` (`utils/chat/arrivalVisibility.ts`): selected,
app in front, and a route that draws a conversation (`isMessagingRoute`: `/chat` and `/communities`
and their children). `utils/chat/arrivalRuntime.ts` gathers the runtime facts once; the live arrival
path, the batch path and the follower-tab mirror all ask it, and `readerCanSeeArrival` reuses it, so
the tone and notification follow the same rule. The banner signal now also follows the READING: when
the receipt effect marks a salon read it signals the account's other devices if the newest foreign
message was not already signalled (the shared `claimChannelReadSignal` marker, keyed on the newest
FOREIGN message so an own send never signals). Tests: `arrivalVisibility.test.ts`,
`useMessaging.staleSelection.svelte.test.ts` (mutation-checked: three of five fail against the old
predicate).

**Not changed, and why.** The hidden-tab case was simulated (overridden `visibilityState` and a `blur`
event), not a real background tab. `isChatRoute` (the list-beside-the-conversation rule) still names
`/chat` only, so on `/communities` a message for an unselected salon plays no tone; that is a separate
question about the communities sidebar and was not measured. **Owed:** one reading on dev after the
next pre-release - reader on `/posts` with a salon selected, owner posts: the title count rises, an OS
notification is raised, no `POST /read` leaves; reader returns: count cleared, one `read` and one
`read-mark`.

### Mark a whole community as read (2026-10-13)

**Asked by the user** (Discord's gesture): a long press on a community icon of the rail under a
finger, a right click with a mouse (or the Menu key), opens a menu with **Marquer tout comme lu**.
Nothing like it existed before: the app had no context menu on the rail at all, and the only
"Marquer comme lu" was the Android notification action for ONE salon (`POST /api/mls/push/channel-read`,
[social-service](../../services/social-service.md#read-receipts-in-a-salon)), which moves the read mark.

**The decision: clearing a badge is not reading, so no receipt moves.** A salon's read mark
(`readMarks`) is also the "Lu par" heads other members see; the server already refused to SEED marks
for exactly that reason (`listUnreadCounts`), and the receipt waits for focus so "a phone in a pocket
never tells a sender it read anything". A member who clears a community from a menu has not opened a
single message, so the clear moves a PRIVATE mark instead: `channel_members."clearedMarks"`
(migration 082), which `listUnreadCounts` adds to the floor of what it counts, and which is never
published to anyone but the member's own devices. Opening a salon afterwards sends the ordinary
receipt, because that IS reading. (The shade's "Marquer comme lu" keeps moving the receipt: there the
reader saw the message in the banner. Not changed here - and since 2026-10-14 not offered at all on a
BLIND banner, where the reader saw nothing: [read-receipt-privacy](../../read-receipt-privacy.md).)

| Piece | Where |
|---|---|
| The gesture | `actions/longPress.ts` - the hold primitive extracted from `reactorsTrigger` (which now composes it): 450 ms, slop, the click that ends a hold swallowed in capture, the native menu refused; a `contextmenu` that is not a touch hold goes to `onContextMenu` |
| The rail | `Sidebar.svelte`: touch/pen hold and right click open `CommunityRailMenu.svelte`; the mouse's main button is left to the drag |
| One request | `POST /api/channels/workspaces/:workspaceId/unread/clear { upTo }` -> `clearWorkspaceUnread`: one `UPDATE` for every salon the caller may read (`canAccessChannel`) |
| Other devices | `channel.unread.cleared` to the caller alone; each device re-reads `unread-counts` (one request), plus one silent `channel_read` push per salon that moved, which dismisses its banners |

**The bound.** `upTo` is `communityUnreadUpTo`: the later of the last server count's `asOf` and the
newest message held in those salons - both on the SERVER's clock (a salon row's timestamp is its
`createdAt`). The server stores per salon `LEAST(upTo, newest row createdAt)`, merged as
`GREATEST` against the row being updated, so a mark never covers a message that did not exist, never
covers one created after the badge the user cleared, and never falls. Silent rows are not counted
(the count's own rule). This device's badges fall at once (`clearSalonUnreadLocally`: only falls,
watermark untouched); a refusal is a toast and a re-read of the server's counts.

**The rail is also a drag zone** (`svelte-dnd-action`, no touch delay: a 3 px move starts a drag and
the library prevents the `touchstart`, then dispatches its own `click` on `touchend`). The hold asks
the DRAG, not a slop tuned to the library: `consider` with `DRAG_STARTED` sets `railDragActive`, so a
hold the drag took opens nothing, and a hold that turns into a drag closes the menu. The library's
synthetic click after a hold is swallowed by `longPress`.

**Measured in headless Chrome at 390 px with touch emulation** (trusted CDP touches against the real
`Sidebar`, the real library and the real `pressedClickGuard`): a tap selects the community (one
script click, as before); a still 700 ms hold, and one with a 2 px jitter, open the menu and select
nothing; a tap on the entry calls the action once; a 70 px drag reorders and opens nothing; a hold
then a drag opens the menu and closes it at the drag; a community with no salon offers the entry
greyed; a mouse right click opens it; a mouse left hold of 700 ms still just selects.

**Not verified:** a real phone (Android's native long-press `contextmenu`, iOS WebKit's callout - both
handled in code, neither seen); the menu's position on screen (the probe page rendered without the
app's CSS); two devices clearing at ONCE (one connection only: argued, not measured - the `UPDATE`
re-reads the locked row, so the stored mark is right and only the answer's `prev` can be stale, which
at worst repeats an event and a silent push). **The SQL IS run**, by
`channel-unread-clear.integration.spec.ts` (gated on `SOCIAL_IT_DATABASE_URL`, run in CI by
`test-social-integration` since 2026-10-15; at review on PGlite, Postgres 17 in WASM, Docker did not
answer - and it failed on every real PostgreSQL until #1913): microsecond rows clear exactly, a lower or repeated `upTo`
moves nothing, and it found two defects, both fixed. `LEAST` ignores a NULL, so an EMPTY salon took
`upTo` itself as its mark and a future `upTo` hid that salon's next messages; an empty salon now gets
no mark. And the column was off the entity, so `synchronize` (every boot outside production) dropped
it and the count failed locally; it is declared `select`/`insert`/`update: false`. **Measured cost of
the deploy window** (column absent, before 082 runs): a membership read and save work; the unread
count and a NEW membership's insert (its `RETURNING` names the defaulted column) fail until the
migration lands - seconds, nothing at boot. **Owed:** one reading on dev -
clear a community with unread salons on the web, watch the phone's badges and banners go, and check
that no "Lu par" head appears for the clearing member on the sender's side.

### A community joined in-session is listed whole (2026-10-08)

Measured on the local estate (`UNR-11`: three public salons, the joiner a workspace member of all):
after an invitation link the reader's sidebar listed ONE salon and `channel.message.created` for the
others took `Message received for an unknown channel` until a reload.

- **Cause.** `acceptWorkspaceInvite` publishes exactly ONE `channel.member.joined`, for the first
  public salon (`channelRepo.findOne`), whatever the community holds. `onChannelMemberJoined`
  (`ChatBackgroundService`) registered that salon alone. Worse, it made the landing target known, so
  the landing effect's "channel unknown - refreshing communities" fallback never ran either.
- **Fix.** A community this device has never seen (`isCommunityUnknownToEvent`, read before the
  placeholder is made) is hydrated by `hydrateJoinedCommunity`: ONE `loadChannelWorkspacesFromBackend`,
  the path a reload runs, which registers, enters the groups and lists every salon the member may
  read - private ones included, through `enterPrivateSalonGroup` as at startup. It REPLACES
  `registerJoinedChannel` for that event (no double entry); a known community still takes
  `registerJoinedChannel`. A load already in flight answered before the join, so the join is owed one
  more listing, run in that load's `finally` (a flag, not a timer).
- **Not read:** the join through the deep link on a phone, and the Graine entry of a private salon the
  joiner may read right after the join (the listing is the reload's own path, unmeasured live). The
  harness row is `bun unread-communities.mjs run join`; it was written, not run, because W1/W2 were held.

### A salon message that arrives before its seed still raises its badge (2026-11-16)

**Read on two phones.** On the iPhone (`1.6.12-alpha.2`), after an in-session join, the first message of
one salon of two raised no badge, 3 times in 5; on the Mi 9T (`1.7.0-alpha.5`), a private salon granted
AFTER the join raised none for any message until it had been opened once (`salon-priv` for its first,
`salon-priv2` for both of two, still none a minute later), while every message was in the salon on
opening ([device-verification](../../device-verification.md#the-mi-9t-readings-of-2026-11-16-on-170-alpha5)).

- **Cause, read in the code.** A salon's live tally counts a DRAWN row: `channel.message.created` opens
  the frame and hands a body to `addMessageToChat`, which raises the count. A salon granted (or a
  community joined) a moment ago does not yet hold the Graine seed of the messages sent right after:
  the member enters the salon's key group asynchronously (`registerJoinedChannel`,
  `hydrateJoinedCommunity`), so the open throws `GraineSessionUnavailableError`, the frame is
  reported unreadable, asks for its seed and is DROPPED. The repair then re-reads the salon
  (`announceGraineRepair` -> `loadHistoryForConversation`), and a history load merges rows and never
  touches `unreadCount`. So every message sent before the seed landed was shown and never counted, and
  the server's count, which did hold it, was asked only at the next community load or reconnect. Once
  opened, the seed is held, frames open live and the badge works: exactly the reading. Not a race that
  heals - nothing healed it before a reload.
- **Fix.** The frame states in the clear what the server's count asks (`senderId`, `silent`), so the
  decision is taken where the frame is: an unopened frame from another member and not silent calls
  `onSalonArrivalUncounted`, and its badge is the SERVER's count (`noteUncountedSalonArrival` in
  `utils/chat/salonUnread.ts`, through `refreshSalonUnreadForUncountedArrival`). Not a local `+1`: a
  tally of rows nobody can show yet would need its own ledger against a re-delivered frame and the
  repair's load, and the server's count already is that ledger. **The request is never joined to one
  already on the wire** (`joinInFlight: false`): that one may have been counted before the row
  existed. A burst costs at most two requests - the one running, and one after it if an arrival came
  during it (a flag and a loop, no timer). The open salon is left to the receipt effect, a muted one at
  zero, and a follower tab learns the counts from the leader, all as for any reconcile.
- **Tests.** `channelEventHandler.uncountedArrival.test.ts` (real `openChannelMessage`, no seed held:
  another member's frame asks, a silent or an own one does not) and `salonUnread.test.ts` ("an
  arrival this device could not count": the badge from the server, a request in flight never joined,
  a burst of three counted by two requests) - all four fail without the fix, and the two last fail
  each on its own mutation (joining allowed, the owed loop removed).
- **Read on both phones:** the Mi on `1.7.0-alpha.6`, the iPhone's invite-then-burst branch 4 of 4 on
  `1.7.0-alpha.12` ([readings](../../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).
- **Its silent twin, a REACTION before its seed (2026-11-18).** The same unopened frame, when it is
  silent, may be a reaction to one of MY messages, and the repair's history load raises none by
  design - so the first reaction of a reactor's new seed session was announced by nobody in the
  foreground. Its live decision is parked under the row id and taken by the reader that opens it
  ([mobile](../mobile.md#the-frame-trigger-of-a-reaction-2026-11-17), `owedLiveFrames.ts`).

### A salon's badge starts at the grant (owner, 2026-11-16)

**The decision, under principle 3 of [the charter](../../../principes.md)** (*your attention is not for
sale*): a private salon handed to a member counts as unread only what is posted AFTER access was
granted. Its past stays readable (principle 2 is untouched); only the count changes. Before, a member
granted a salon long after joining the community saw a badge of every non-own row since their
community join (or the 2026-10-08 tracking floor), because nothing recorded when access was given.

**The mechanism, server-side and without a migration.** Every write that lets someone see a salon's
past raises that person's PRIVATE floor `channel_members."clearedMarks"[salon]` to the grant instant,
in the grant's own transaction (`ChannelService.floorUnreadAtGrant`, social-service): a grant
(`grantPrivateChannelAccess` - an accepted invite, an admin join, a member added from the panel), an
access rewrite that adds a name to a private salon, and a private salon made public (every member it
did not name). Making a public salon private floors nobody: they all saw it already. The floor is the
one "Marquer tout comme lu" raises ([read-receipt-privacy](../../read-receipt-privacy.md)), so it
claims nothing public - the "Lu par" read mark does not move - and `listUnreadCounts` already reads
it. It is taken on the DATABASE clock (`clock_timestamp()`), the clock that stamps `createdAt`, ONE
MILLISECOND BELOW the grant's: the count keeps a row only when its whole millisecond is above the
floor, so a floor on the grant's own millisecond hid a row posted after the grant inside it (found in
review, failing first); below it, the worst case is one row of that millisecond's past counted. It is
only ever raised (`GREATEST`); a revoke leaves it, a re-grant raises it again. The client needs no
change: a grantee was outside the salon's audience before, so no live message was tallied, and the
count it draws is the server's.

**Locks.** The grant writes the grantee's membership row, so it now reads that row `FOR UPDATE`
instead of `FOR SHARE` (two grants of two salons to one member, each upgrading a shared lock, would
deadlock), and the access rewrite reads the community's membership rows `FOR UPDATE`, in id order,
when it floors anyone. The salon-before-member order of every path is unchanged.

**Tests.** `channel-grant-unread-floor.integration.spec.ts` (PostgreSQL: ten rows of past, a grant,
one row after it - the count is 1, not 11; a higher floor is never lowered; the rewrite's two cases);
`channel-access-announcement.spec.ts` (who is floored per kind of rewrite, and the lock mode);
`distribution-group.spec.ts` (the admin join). The live row is `bun unread-communities.mjs run
grantlate`: the reader's badge after a restart, its floor and its untouched read mark.

### Every member list reads by family name, and a row never moves because its name arrived (2026-10-05)

Asked by the user: the community admin panel listed its members by user id, the group panel and a
channel's member list in the server's order. All three now render through `membersByFamilyName`
(`utils/users/memberOrder.svelte.ts`) - `SidebarCommunityAdminPanel`, `ChatGroupPanel` and
`ChannelMembersList` (inside each of its two sections).

- **The order is ONE pure helper**, `sortByFamilyName` in `utils/users/familyNameOrder.ts`, shared
  with the poster's directory ([carte-vie-asso](../../carte-vie-asso.md)): `lastName`, else the
  printed name, then `firstName`, under `Intl.Collator('fr', { sensitivity: 'base' })` - accents
  and case never reorder, hyphens and particles compare as written - and the id as the last,
  locale-free tie-break. A member nothing names sorts LAST, in id order.
- **The name columns come from the profile** (`fetchUserProfile`), never from splitting the
  "Prenom NOM" string, which guesses wrong on a compound surname. The lookup is the same batched,
  cached request the rows' `UserName` cells already make.
- **No reshuffle.** An id is listed only once its lookup has SETTLED, and its key is then FROZEN:
  until the first one settles the panel shows its loading line; a lookup that failed sorts last and
  stays there when the name later repaints in place; a member who joins appears at their place. The
  community panel stays mounted while closed, so it empties its list on close and the next opening
  re-reads every name. Pinned by `memberOrder.svelte.test.ts`, `familyNameOrder.test.ts` and
  `ChannelMembersList.order.svelte.test.ts`.
- **A newcomer is never absent (2026-10-05, user: they appeared, vanished, reappeared).** The
  group roster is refetched when the invite ends (see the next item for which table);
  the newcomer's profile lookup is still in flight, so the roster HOLDS the id while the ordered
  list does not LIST it. `ChatGroupPanel` hid its "Inviting..." row on roster membership: appeared
  (pending), vanished (roster, not listed), reappeared (listed). `joiningRows` now decides by what
  the list renders: a row stays until the member row replaces it, one hand-over, no timer. NOT an
  MLS ordering problem - commit, welcome and roster were already in order. Pinned by
  `memberOrder.svelte.test.ts` ("a member added while the panel is open").
- **The group's member list is its ROSTER, not its active devices (2026-10-25, seen twice by the
  rig).** A bulk Add of two people in one commit left the creator's open panel at `Membres (2)` with
  a remove button for ONE invitee, while the server held both. `loadGroupMembers` read
  `GET .../members` - devices whose row is `active` - and an Add's commit writes its newcomers'
  rows `pending`: only the NEWCOMER's client activates them, when it opens its Welcome, on its own
  clock. The one read at the end of the Add caught the quick invitee only, and nothing read it again
  in that page (a later document, read after both had activated, listed both). It now reads
  `fetchGroupRoster` (`groupActions.ts`): `dm_group_members` less the seats awaiting a member's
  admission, which the adder writes itself (`registerMember`, awaited before the Add returns) and
  every Remove or departure cuts first. So the list is current when the gesture ends, by
  construction; the panel, its count, the mention picker and a call's avatars all read this one
  list (`convs.groupMembers`). `fetchUniqueGroupMembers` stays for its own question - who is ROUTED
  to (the membership check). Pinned by `useConversations.memberPanel.svelte.test.ts`.

Association rosters (`EditMembersTab`, `AssociationDetailView`) are NOT sorted: their order is the
one the bureau arranges by drag (`sortOrder`), and the president is its first row.

### A removal names its member, and no remove control is live while the order is settling (2026-11-17)

Read on the `1.7.0-alpha.9` bench ([device-verification](../../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha9-both-phones-and-the-rig)):
a community removal aimed at `beta` removed `alpha`, four times out of four. **The removal was
always bound to an identity** - each row's control closes over its own member's id, in the four
paths (group `ChatGroupPanel` -> `useConversations.handleRemoveMember`, community
`SidebarCommunityAdminPanel`, salon access `ChannelSettingsPanel`, association `EditMembersTab`) -
so what moved was the ROW UNDER THE POINTER, which a finger meets as well as the rig.

**The cause is the "a member who joins appears at their place" rule above.** The list draws once ANY
lookup has settled; a member whose lookup is still in flight (the re-invited `alpha`, a cold cache)
is inserted later at their family-name place, moving every row below it. A tap aimed at `beta`'s
control during that window lands on whichever row has taken its place. Not a re-sort on a live signal:
no member list re-sorts on presence, typing or last-seen (`ChannelMembersList` only splits admins
from members; the salon access list and the association roster are in server or drag order).

- **No remove control is live while a lookup is pending** (`removeControlDisabled` in
  `memberOrder.svelte.ts`, used by `ChatGroupPanel` and `SidebarCommunityAdminPanel`, the two lists
  that order by name). A count of lookups, not a clock. **It NARROWS the window and does not close
  it**: rows still move when a newcomer's lookup settles later, or when a member leaves or another
  admin removes one.
- **THE GUARANTEE: every removal dialog names the member** (`confirmMemberRemoval`, `utils/users/memberRemovalConfirm.ts`,
  `{member}` in the four messages, both locales), as the row draws them: the group's nickname there,
  the profile name elsewhere, the id when no name is known (at warn). The name is the one already
  known (the row drew it), so a stalled link never keeps the dialog from opening; the network is
  asked only when nothing is known. A tap that lands on a moved row is read before it is confirmed.
- **The community remove control is named too** (2026-11-18): its `aria-label` is `chat_community_remove_member_label` (`Retirer {member}`, the group panel's shape) from `userDisplayNames`, where every row read "Retirer le membre" to a screen reader.
- **The rig asserts it**: `removeCommunityMember` (`tools/cross-client-harness/comm.mjs`) waits for the
  control to be live and refuses to confirm a dialog that does not name the member it was asked for.

Pinned by `ChatGroupPanel.removeMember.svelte.test.ts` (alpha inserted above beta after beta's row is
drawn: the control is dead until then, and beta's control removes beta),
`memberOrder.svelte.test.ts` (`removeControlDisabled`, both panels) and `memberRemovalConfirm.test.ts`.

### One attachment menu, and a GIF panel in the keyboard's place (2026-10-02)

Two reports from the user on the iPhone 12, with a screen recording. *"Deux menus similaires, n'en
faire qu'un"*, and the menu that *"ne se ferme pas"*; and for GIFs, *"un panneau de la taille du
clavier qui s'ouvre a sa place"* - Messenger's, Discord's, WhatsApp's.

**WHY THERE WERE TWO MENUS - READ OFF THE RECORDING, THEN OFF WEBKIT.** The "+" opened Canari's menu
(the native UIMenu of WP-G2 on iOS); its "Photos et videos" clicked an
`<input type="file" accept="image/*,video/*">`, and WebKit answered with its OWN sheet - Phototheque,
Prendre une photo ou une video, Choisir les fichiers. `WKFileUploadPanel` shows that sheet for every
file input that accepts images or videos and carries no `capture`; no `accept` a page can write skips
it. So it was never a value to tune: on iOS a file input IS a second menu, and one menu means not
opening a file input for the entries that sheet duplicates. The recording also shows the sheet staying
up for fifteen seconds, anchored to an input that was `display: none`.

**THE ONE MENU** (`utils/chat/attachSources.ts`, the table and the reason; `attachSources.test.ts`):

| runtime | Photothèque | camera | Tous les fichiers |
| --- | --- | --- | --- |
| iOS app | **native** `PHPickerViewController` (`tauri-plugin-dialog`, `pickerMode: 'media'`) | **in-app camera overlay** (photos only in a chat) | **native** document picker |
| Android app, Android browser | input `image/*,video/*` | **in-app camera overlay** (photos only in a chat) | input, `accept="*/*"` (a type LIST greys out the rest in Android's picker: a saved `.txt` log was unselectable, 2026-11-07) |
| iOS browser | **no Canari menu**: the paperclip is a `<label>` around one input, and WebKit's sheet is the only menu | - | - |
| desktop | no menu: the paperclip opens the file dialog | - | - |

**BUILT (user, 2026-10-11, D-camera): no native camera.** No `<input capture>`, no capture intent, no `queries` entry: the camera column is ONE "Ouvrir la camera" entry opening the in-app CanaReel camera as an OVERLAY (`components/reels/CameraOverlay.svelte` over `ReelCapture` with `destination="chat"`), in the chat and in the new-post composer alike; the library and files entries stay. **In a chat the camera takes PHOTOS ONLY for now**, and the review button is "Ajouter": the photo is STAGED in the composer through `onFilesSelected`, exactly like a library pick, and the member presses send (an ORDINARY image message, no new wire format). The chat camera opens WITHOUT the microphone (`openPhotoCamera`), so a refused or absent one never blocks a photo; a video filmed in a chat is the reel message ([reels-in-chat](reels-in-chat.md), RC-3..RC-5, not built), whose take will be `chat-reel` (30 days). A post take is a post (post class, [posts](posts.md)). **An iOS phone BROWSER still shows the system sheet of WebKit, "Prendre une photo" included**: a web page cannot remove an entry of that sheet for a file input, and Canari draws no menu there.

- **Android has ONE camera entry now** (it had two, photo and video, because wry's capture intents were one or the other). Nothing reaches wry's camera intents any more: `RustWebChromeClient.onShowFileChooser` launches one only for an input carrying `capture`, and none does. The Kotlin itself is NOT edited - it is wry's `generated/` output, rewritten by wry's build script on every Android build, so an edit there is silently undone (PR #1859 review, 2026-10-14); the frontend having no `capture` input is what closes the path, and the manifest test pins the rest.
- **The iOS app's native picks come back through `take_picked_file`** (`commands/picked_files.rs`): the
  dialog plugin COPIES each pick (PHPicker into `Library/Caches`, the document picker into `tmp/`) and
  returns where; the command reads the copy, deletes it and returns the bytes. It reads and deletes a
  path the page names, so it takes an ALLOWLIST - the canonical caches and temporary directories -
  and compares the CANONICAL path, so neither `..` nor a symlink reaches outside. `nativeAttachPicker.ts`
  names the `File` as the picker did and types it from its extension (the picker gives no MIME type);
  a photo arrives as the library holds it, usually HEIC, which `compressImage` decodes on WebKit.
  **One directory per pick (2026-11-18):** upstream `tauri-plugin-dialog` 2.8.3 copied every PHPicker item to
  `<caches>/<file name>` after deleting whatever held that name, from several threads at once, so a pick of 11
  gave 3 files and 8 "No such file". The crate is vendored (`src-tauri/patches/tauri-plugin-dialog`, the
  `CANARI PATCH` hunks in `ios/Sources/FilePickerController.swift`): `canari-pick-<uuid>/<name>` per item, a
  serial queue for the shared state, the order kept, and the items already copied handed over when another fails; `take_picked_file` removes the emptied directory
  (`remove_emptied_pick_dir`), and `pickNatively` warns with how many files were not taken. The Swift is
  verified by compiling only - owed on the iPhone: a pick of 11.

**THE MENU, THE PANEL AND THE KEYBOARD ARE ONE STATE** (`utils/chat/composerSurface.ts`,
`composerSurface.test.ts` walks every event in every state): `idle`, `menu`, `gif`, and `handoff`.

- **The menu closes** on a pick, a tap outside, Escape (read on `window`, since a tap leaves focus on
  the button), Back, the text field taking focus, and the keyboard opening. `GlassMenuButton` has a
  CONTROLLED mode for this (`open` + `onOpenChange` with the reason); the header's menus are unchanged.
- **Neither "+" nor an entry takes focus** (`keepsFocus`: their `mousedown` is cancelled), so a menu
  opened over the keyboard leaves the keyboard up and the composer where it is. Without it the Mi 9T
  measured the composer's top at 532 -> 877 -> 532 px through "+" then "Envoyer un GIF": focus moving
  onto the button blurred the field, the keyboard fell under a menu that only floats, and the panel
  lifted the composer back. With it, the keyboard and the panel swap in ONE frame (532 px throughout).
- **Back is ONE history entry for the whole surface**, pushed when `menu` or `gif` begins and
  ABANDONED (its popstate absorbed) when it ends any other way - so a pick that opens the poll modal
  never has the modal's own entry popped by ours, and menu -> GIF keeps the one entry.
- **`handoff`** is the panel giving its room to the keyboard after the text field is tapped: the room
  stays reserved until the keyboard has risen into it (`keyboardOpened`), or the field blurs (a
  hardware keyboard - none is coming). It ends on those facts, never on a timer.

**THE PANEL TAKES EXACTLY THE KEYBOARD'S ROOM, AND THE COMPOSER DOES NOT MOVE.**

- **Its height is the keyboard last measured on this device**, per orientation
  (`stores/keyboardHeightMemory.ts`, written by `keyboardViewport` on every open keyboard and kept in
  `localStorage`). `keyboardViewport`'s snapshot now carries `keyboardHeight` = baseline height minus
  the visual viewport height while open - one number for every platform, because each shrinks the
  visual viewport whatever else it does (iOS's native layer resizes the WebView, the Android app pads
  its content, a browser shrinks only the visual viewport). Before any keyboard was seen the panel is
  0.40 of the screen, bounded to 240-420 px (`gifPanelHeight`).
- **The room under the composer is `panelSpacerPx` = reserved height minus what the keyboard covers
  now**, recomputed on the same viewport event that moves the keyboard. As the keyboard falls under an
  opening panel the room grows by exactly what it uncovers; as it rises into a closing one it shrinks
  by what it takes. The panel is the footer's LAST child, so the composer sits on it as on a keyboard.
- **The 0.75rem above the keyboard is the panel's top margin**, and the footer pads nothing while a
  panel is reserved (`.has-keyboard-panel`, `app.css`): the panel reaches the screen's edge as a
  keyboard does and keeps its content clear of the home indicator itself. Putting the margin on the
  panel, not the footer, is what leaves no step when the panel unmounts at the end of `handoff`.
- **While the panel's own search field has the keyboard up**, the panel rides above it at
  `SEARCH_STRIP_PX` (200 px: the search row and one row of results), and keeps its full height until
  the keyboard has risen - the composer rises by the strip, on purpose, since the results must show.

**THE GRID HOLDS EVERY TILE'S SIZE BEFORE IT LOADS** (`GifGrid.svelte`, shared by the phone panel and
the desktop dialog `GifPickerModal`). KLIPY declares `width` / `height` for each rendition;
`mapKlipyItems` (server-side since 2026-10-16, `apps/chat-delivery-service/src/utils/klipy.ts`)
keeps them and LEAVES OUT, counting at warn level, a result that declares none - it could not be
laid out without a shift. `gifMasonry.ts` places every tile (shortest column first) from
those sizes alone, so the grid never reflows, and only tiles near the scrolled window are mounted -
the virtualisation. The next page is asked for near the end. **Each tile is a
[MediaFrame](../media-frame.md) `sizing="intrinsic"`** declared at the box the masonry placed it in,
so the frame IS the tile before and after its GIF loads, with the frame's surface tone underneath
(KLIPY sends no ThumbHash). The masonry takes its ratio from `normalizedAspectRatio`, the clamp the
frame draws with, so the two stay one shape even for a GIF thinner than 1:4. **A tap sends at once,
with the size of the rendition SENT in the URL**: `withGifSize(full.url, full.width, full.height)`
writes `#cn-size=WxH`, and every reader's frame reserves that box before the GIF arrives. That is
the whole of what the MediaFrame contract asks of a picker.

**Verified here:** the transition table, the spacer arithmetic, the masonry, the KLIPY mapping, the
picker table per runtime (`ChatComposer.attachMenu.svelte.test.ts`: which input or native picker each
entry opens, with which `accept` / `capture`, and the menu closing on pick, outside, Escape, Back and
focus), the panel (`ChatComposer.gifPanel.svelte.test.ts`: last in the footer at the remembered
height, tiles sized from declared dimensions, send closes it, Back closes it, the hand-off), the Rust
allowlist (`picked_files.rs` tests) and a source pin that the command is registered.

### The GIF search goes through Canari (2026-10-16)

**Owner decision from a GDPR review.** The picker used to call `api.klipy.com` from the browser:
KLIPY received the search terms, the reader's IP and a random per-install `customer_id` kept in
`localStorage` under `klipy_cid`, so it could tie one install's searches together - and the API key
shipped inside every web and native bundle as `VITE_KLIPY_KEY`.

Now `gifSearch.ts` calls chat-delivery's `GET /api/mls/gifs?q=&page=`
(`controllers/gif-search.controller.ts`), which asks KLIPY with the server's `KLIPY_API_KEY` and
answers `{ gifs: [{ id, preview, full }], hasNext }` - an id, two URLs and their sizes, nothing else
KLIPY sends. What KLIPY can still see is chat-delivery's address, the query and ONE constant
`customer_id` (`canari-server`) shared by every reader. The request carries no header of the
reader's.

- **Authenticated and rate-limited per USER**: nginx's `auth_request`, `HeaderAuthGuard`, then
  `UserThrottlerGuard` (60 a minute), which keys on the proven `x-user-id` - the stock throttler keys
  on the address, and behind nginx every reader has the same one.
- **The query reaches no log line.** chat-delivery logs only its length, and **nginx drops this
  route's whole query** from its access line (`$logged_request_uri` writes
  `/api/mls/gifs?query-redacted`, asserted by `access-log-redaction.test.mjs`) - that line carries
  the reader's address, so writing the query there would rebuild in our own log the very
  association this route removes from KLIPY. The first review of this change caught it. The map
  keys on the RAW `$request_uri`, so a hand-spelled `/api//mls/gifs` or `/api/mls/%67ifs` reaches
  the same location and is logged in clear (measured in a local nginx) - accepted: the app never
  sends it, so only the person typing such a URL exposes their own search.
- **Answers are cached in-process for 10 minutes** (500 entries), failures never, and only an answer
  carries `Cache-Control: private, max-age=300` - a 502 carries none. The cache is shared across
  users, keyed on the query: a hit's latency can tell a reader that SOMEBODY searched the same words
  in the last ten minutes, never who. Accepted: the alternative is a KLIPY call per reader per page.
- **400** on a malformed query or page, **502** when KLIPY did not answer (unreachable, a non-2xx,
  or a 200 that is not JSON - three typed errors, three distinct log lines), **503 with
  `code: 'gif_search_not_configured'`** when the estate has no key, reported once per process. The
  CODE is what the client reads (`GifSearchUnavailableError`, the grid's "not configured"): nginx
  and the edge answer 503 of their own when the service is down, and that is a load failure. The
  GIF button is always offered: whether an estate has a key is the server's fact, so there is no
  build-time flag to drift from it.
- **`klipy_cid` is deleted at startup** by `retiredKlipyCustomerId.ts`, called from the root layout's
  mount - a shim with a removal condition in [legacy-compatibility](../../legacy-compatibility.md).
- **CSP**: `connect-src` no longer names `https://api.klipy.com`; `csp.test.ts` asserts it stays out.
- **A native build installed before this change still calls KLIPY directly** with the key it embeds,
  until it updates. Rotating the key ends that path for them (their search then fails), and is the
  owner's call ([backlog](../../backlog.md)).

### The GIF relay: no reader's browser asks KLIPY for a GIF (2026-10-18)

**Why.** After the search moved to the server, three paths still went from the browser to
`static.klipy.com`, KLIPY's CDN: the picker grid's thumbnails (the searcher's IP, and which results
they were shown), a comment's GIF bytes (the attacher's IP, once), and - the one that mattered - **a
GIF sent in a chat, loaded by every recipient on every render that missed the browser cache**: each
reader's IP, user agent and the moment the message came into view, the leak `previewImageProxy.ts`
had closed for link previews.

**What.** `GET /api/mls/gifs/media?url=<CDN URL>&t=<ticket>` (chat-delivery,
`controllers/gif-media.controller.ts`, policy in `utils/gif-media.ts`) fetches the GIF and streams it
to the reader. KLIPY sees chat-delivery's address and a `User-Agent` - once per 24 h for a GIF
the cache keeps, once per miss for a larger one. The client rewrites at
**render time only**, through ONE helper, `frontend/src/lib/utils/gifMediaProxy.ts`
(`proxiedGifUrl`, `fetchGifFile`), at the four places that draw or read a GIF: `GifEmbed` (the
bubble, via `MessageTextBody`), `ReplyGifThumb` (a quoted GIF, also the composer's reply strip),
`GifGrid` (the picker's thumbnails) and `PostComments.handleGifSelected` (a comment's attach). **A
sent message keeps its ORIGINAL KLIPY URL on the wire**, so a client older than this renders it as
it always did.

- **Its own route, not the link-preview proxy.** That proxy's 3 MB ceiling would have broken one
  `md` GIF in five, and its small-image cache would have re-fetched every larger one per reader.
  MEASURED 2026-10-18 over 144 GIFs (trending and searches): `sm` max 2.9 MB; `md` median 1.1 MB,
  p90 4.4 MB, max 11.7 MB. **Ceiling 12 MiB** (`GIF_MEDIA_MAX_BYTES`), checked on the declared
  length (413 before a byte is read) and on the bytes (the stream is cut, logged `too-large`).
  **The picker never offers a rendition over it, and never retries a 413 (2026-11-13).** A 413 was
  re-sent by the grid tile a moment later (an `<img>` cannot read the status) and the search could
  hand out a rendition above the ceiling. Now the search carries the `bytes` KLIPY declared per
  rendition (`klipy.ts`, `rendition()`), `mapKlipyItems` passes over any whose declared size exceeds
  `GIF_MEDIA_MAX_BYTES` (imported from where it is defined; md -> sm -> xs, never the other way, and a
  result with nothing that fits is left out and counted `oversized`), the client's `pickGridRendition`
  and `commentGifRendition` apply the same test (`fitsRelay`), and `GifTileImage` fails a rendition
  declared over the ceiling at once instead of asking twice. **Only a declared size is acted on**: a
  rendition whose size KLIPY did not state is offered as before, and whether KLIPY states one for
  every rendition is not measured here (no production access when this was written) - the debug line
  `[GIF_SEARCH] N of M results had a rendition over the relay ceiling` counts how often it matters.
- **One host, no query.** `static.klipy.com`, https, no credentials, no explicit port, and NO query
  (400 `query-not-allowed`: KLIPY's paths are content-addressed, and `?x=N` would make every request
  a new cache key) (`parseKlipyCdnUrl`), then the SAME SSRF guard and pinned dispatcher as the preview proxy (`assertSafeExternalUrl`,
  `ssrfSafeFetch`, `OUTBOUND_BUDGET_MS` per leg). **Redirects are refused (502 `redirected`), not
  followed**: the allowlist names a host and a redirect is another. `image/gif` only (415 `not-gif`;
  measured: the CDN answers `image/gif` with a `content-length`).
- **Streamed.** `Readable.fromWeb(body) -> GifByteCounter -> res`, with backpressure: the reader gets
  bytes as they arrive, and a reader who leaves (`res` closes) aborts the upstream request. The only
  copy held is the cache's, and only while the GIF stays under `GIF_MEDIA_CACHE_ENTRY_MAX_BYTES`
  (4 MiB, about nine in ten `md` renditions) - which also bounds a request's memory.
- **A byte cache** keyed on the content URL with the fragment dropped (`TtlCache` with a weight
  budget: 64 MiB in all, 500 entries, 24 h - KLIPY's paths are content-addressed and its CDN says
  `max-age=86400`). A GIF is kept only when it is provably whole: KLIPY declared a length and that
  many bytes came (the debug line says which reason skipped a write). Upstream asked with
  `accept-encoding: identity`, so the bytes counted are the GIF's own.
- **Single-flight and a cap.** Identical misses wait on the ONE fetch in flight
  (`GifMediaController.inFlight`) and are answered from the cache it fills - so a GIF of at most
  4 MiB sent to a group of forty is fetched from KLIPY once per 24 h, even when they open it at the
  same moment. A refusal KLIPY gave (404, not a GIF, too large, timed out) is SHARED with the
  waiters. A GIF the cache did not keep (over 4 MiB, no declared length, a failed stream) releases
  every waiter at once to fetch IN PARALLEL - the Nth reader waits two fetch times, never N - and
  the reader's browser keeps it (`private, max-age=86400`). A waiter follows its leader's pace
  (backpressure), a cost taken for one fetch. At most `GIF_MEDIA_MAX_IN_FLIGHT` (16) fetches run at
  once, released waiters counted, so in-flight memory stays under 64 MiB; beyond, 503 `busy`,
  logged.
- **A deadline on the whole fetch.** `ssrfSafeFetch` bounds only the connect step, so a stalled
  KLIPY body would hold a slot and every waiter on it. `GIF_MEDIA_FETCH_DEADLINE_MS` (30 s, headers
  and body: 12 MiB at ~3.3 Mbit/s) aborts it: 504 `timed-out` before any byte, a logged cut-off
  after.
- **A per-address throttle**, because the ticket is shared and lives a day: `ClientIpThrottlerGuard`
  (keyed on nginx's `X-Real-IP`, the twin of social-service's) at `GIF_MEDIA_LIMIT_PER_MINUTE` (600)
  - generous on purpose: a picker page is 24 thumbnails, and one address may be a campus NAT.
- **A ticket of its own kind, a DAY long.** The URL is an `<img src>` (no Bearer; on
  `tauri://localhost` no cookie), so it is ticket-gated like the preview proxy - but the ticket is
  part of the URL the browser caches under, and the preview ticket's five-minute bucket would have
  given each GIF a new URL, a new download of up to 12 MiB, every five minutes. `gifTicket`
  (`GIF_MEDIA_TICKET_BUCKET_MS`, a different HMAC label) rides on the same
  `GET /api/mls/link-preview/ticket` answer; its value changes once a day. Neither kind opens the
  other's route (`previewTicket.spec.ts`).
- **Every refusal is typed and logged** (`GifMediaRefusedError`, one reason per line: `missing-url`,
  `invalid-url`, `not-https`, `host-not-allowed`, `credentials`, `non-default-port`,
  `query-not-allowed`, `busy`, `blocked-address`, `redirected`, `upstream-not-found`, `upstream-status`, `not-gif`, `empty-body`,
  `too-large`), bodyless like the preview proxy's. KLIPY unreachable is a 502 logged apart; a reader
  leaving is a debug line, told apart from a stream failure by which happened FIRST.
- **The query is not logged by THIS repository's nginx**, which writes the route as
  `/api/mls/gifs/media?query-redacted` (`access-log-redaction.test.mjs`): which GIF a reader loaded,
  beside their address, is what the relay keeps from KLIPY. **Not covered:** the host-level nginx
  in front of it and the Cloudflare edge (legacy names) log the FULL URL, `url=` and `t=` included
  ([nginx](../../infrastructure/nginx.md#the-access-log-never-records-a-token-2026-10-06)) - their
  formats are the host's.
- **The `#cn-size` fragment** is cut from the relayed `url=` (a browser never sends one, and it must
  not make one GIF several cache entries) and put back on the END of the rewritten URL; the frame
  still reads the size off the message's own URL (`measureKey` too, so the size cache does not
  change when the ticket does).
- **No ticket yet: no `<img>`.** `proxiedGifUrl` answers `''` until the ticket lands; `GifEmbed`
  holds its frame empty and `ReplyGifThumb` shows its `[GIF]` label - an empty `src` would fire
  `error` and latch the link.
- **A GIF from ANY OTHER HOST** (`isGifUrl` matches any `.gif` URL, and tenor/giphy pages through
  `getGifEmbedUrl`) **still loads directly, as before** (owner decision 2026-10-18: no regression,
  no detour through the 3 MB preview proxy, no ticket churn). So **a reader of a pasted giphy,
  tenor or other `.gif` link still reaches that host** - how often is UNMEASURED (the picker never
  sends one). Routing them later is one line in `proxiedGifUrl`: return
  `proxiedPreviewImageUrl(rawUrl)` for a non-KLIPY URL.
- **CSP unchanged.** `img-src` stays `https:` (the feed renders arbitrary user-posted images).
  `connect-src` still names `https://static.klipy.com`, which the current bundle no longer needs: it
  serves a web tab still running an older bundle (its comment attach would fail until it reloads).
  Dropping it is a narrowing the owner may take; `csp.test.ts` says so.
- **Not proven here:** that a real browser on a deployed estate makes ZERO request to
  `static.klipy.com` - owed as a network trace on dev after an alpha, and on the phones
  ([the readings owed](../../plan.md#readings-owed)).
- **The KLIPY key is not rotated, and dev reuses the production key** (owner, 2026-10-24). Revisit
  when `minClientVersion` excludes the native builds that still call KLIPY directly (installed before
  2026-10-16).

### The GIF picker loads in a controlled way, and a comment GIF says what it is doing (2026-10-22)

User report: the picker shifted its content, was slow to fill, and GIFs struggled to send. Measured
with a CDP harness (headless Chrome, a modelled relay that answers 503 `busy` past 16 distinct
downloads, a shared pipe slowing each download as more run together):

| | before | after |
| --- | --- | --- |
| relay refusals (blank tiles) | 7 phone / 5 desktop | 0 / 0 |
| downloads in flight at once | 16 | 6 |
| tiles that moved (desktop) | 13 (the scrollbar appearing narrowed the grid) | 0 |
| layout shift (desktop) | 0.0044 | 0 |

- **Weight.** The server adds the provider's smallest rendition as an optional `tiny` when it is
  strictly narrower than `preview` (`klipy.ts`). `pickGridRendition(gif, tileWidth)` draws the
  lightest rendition that still covers the tile, from the declared sizes. A comment attaches the
  small rendition (`commentGifRendition`), not the medium one a chat sends: it is shown at most
  224 px wide, and the medium one (median 1.1 MB, up to 11.7 MB against the relay's 12 MiB ceiling)
  was downloaded only to be re-encrypted and uploaded.
- **Order.** `gifImageGate` lets 6 thumbnails download together, in the order tiles asked (top
  first); a tile that scrolls away before its turn leaves the queue and never asks the network.
  `GifTileImage` retries a failed thumbnail once, then shows an icon instead of staying blank.
- **No shift.** Tiles are always rendered at their declared box (a skeleton tone until the picture
  lands) and the scroller carries `scrollbar-gutter: stable`, so the grid width never changes.
- **Reopening is instant.** `gifSearchCache` keeps the pages read in the last five minutes (the
  server's own `max-age`), in memory only. The query stays the same private, never-logged request.
- **A failed page can be retried**: a button for the first page and under the grid for a later one,
  and a search that does not answer in 10 s counts as failed.
- **Comments.** `fetchGifFile` reads the body as it arrives (progress), under a 25 s deadline, and
  throws a typed `GifRelayError` (`busy` for the relay's 503, `timeout`, `too-large`, `network`,
  `rejected`). The composer shows the chip at once with a progress bar, the cause in words and a
  retry, and holds the send button while the GIF is still arriving. The relay ticket is asked as the
  composer mounts.

### The GIF search is the whole screen, and a quoted GIF is a picture (2026-10-05)

**Two reports from the user.** Typing in the panel's search left the picker as a 200 px strip above
the keyboard with the conversation around it; and a reply to a GIF quoted the GIF's raw URL as text
(Messenger quotes the picture, small and dimmed).

- **The search is the whole screen.** Once the panel's search takes focus, `ChatComposer` sets
  `gifFullscreen` and `ComposerGifPanel` lifts its CONTENT out as a fixed layer
  (`.composer-gif-fullscreen`, `app.css`): `top: --visual-viewport-offset-top`, `height:
  --app-viewport-height` - the box `[data-keyboard-aware-overlay]` already uses, which is the space the
  keyboard leaves on iOS (native resize), the Android app (padding) and a phone browser (visual
  viewport) alike, so no keyboard height is computed here. The panel's own box in the footer is
  untouched, so the conversation lays out exactly as before and its scroll position is never
  disturbed; closing puts it back. The mode is STICKY until the surface ends (a tap on a result
  blurs the search first and must not collapse the layer under the finger); the trailing control is
  then Close (it keeps focus: `mousedown` cancelled), Back and a send close it as ever
  (`DismissReason` `close`). The layer registers with `coversScreen`, so the iOS native tab bar
  stays away. **Owed: one look on an iPhone and an Android keyboard** - happy-dom has no keyboard.
- **A quoted GIF is a picture.** `gifPreviewUrl(text)` (`messageDisplay.ts`) is the ONE test of "this
  message is a GIF and here is its picture" - the list preview (`[GIF]`), the thread quote
  (`MessageReplyQuote`) and the composer's reply strip all use it, over `isGifUrl` and
  `getGifEmbedUrl` that the bubble's `GifEmbed` uses. `ReplyGifThumb` draws it at most 5 rem tall,
  `opacity-60`, boxed from the `#cn-size` fragment, and becomes `[GIF]` if it cannot load. The quote
  text is the sender's stored `preview`, which was cut at 100 characters: a GIF's URL is now kept whole
  (`messaging.ts`); **every other cut goes through `cutReplyPreview` and ends with an ellipsis**
  (2026-10-05: a raw `@[id]` mention weighs ~40 characters but draws short, so a bare cut at 100
  fell under the display's 84 and ended mid-word with no mark; a cut inside a token is pulled back
  before it. Quotes stored before that stay unmarked); a quote already stored cut short is not a GIF URL any more and stays text.
  **Not done: an image or video quote shows no thumbnail** - drawing it needs one the quote does not
  carry; it names what the message is instead ([below](#a-media-message-is-previewed-by-what-it-is-2026-11-20)).

### A media message is previewed by what it is (2026-11-20)

The conversation list read `[Media]` for every photo, video, voice note and file (owner, 2026-11-20,
screenshot: say what it is, the way Messenger does). **Then the owner, same day: "Il faut tout
homogeneiser"** - the list, the reply quotes, the in-app notification and the native push banners say
the SAME words for the same message, in the WhatsApp style the banners already had: a leading emoji.

**ONE table of words, in two copies guarded against each other.** TS: Paraglide `chat_preview_*`
(`messages/{fr,en}.json`), classified by `mediaKindLabel(ref)` and composed by
`previewForMedia(ref, caption)` (`envelope.ts`) for `getPreviewText` (list tile, reply strip, thread
plain text, search, the in-app notification body) and `quoteReference` (the quote a reply stores).
Native: `PushText::render` (`mobile/push_text.rs`), chosen from the proto by `extract_full_message_info`.
**`push_text.rs` reads the two JSON files at test time** (`media_lines_match_the_apps_paraglide_messages`)
and fails `cargo test` if a word, an emoji or a punctuation mark differs on either side.
`chat_preview_media` is deleted.

| What the message is | fr | en |
| --- | --- | --- |
| image | `📷 Photo` | `📷 Photo` |
| image, mime `image/gif` (any case; the proto carries it, field 5) | `🌀 GIF` | `🌀 GIF` |
| video | `🎥 Vidéo` | `🎥 Video` |
| a video declaring `intent: reel-message` | `🎬 CanaReel` | `🎬 CanaReel` |
| audio declared a voice note | `🎤 Message vocal` | `🎤 Voice message` |
| audio, undeclared (an import, or before 2026-09-17) | `🎵 Fichier audio` | `🎵 Audio file` |
| file, named | `📎 Fichier : <nom>` | `📎 File: <name>` |
| file, nameless | `📎 Pièce jointe` | `📎 Attachment` |

**A caption FOLLOWS the kind everywhere** (`📷 Photo : coucou`; `{label} : {caption}` in fr,
`{label}: {caption}` in en) - in the list, in the quote a reply stores (the caption raw there, mentions
unresolved, as a text quote's), and in the banner, which used to show the caption alone for a photo.
A file drops its name when a caption follows, so the line stays short. **A file name is sender-chosen
text:** control, bidi and format characters are stripped (`stripInvisible` in TS, `clean_file_name`
in Rust), whitespace is collapsed first, and it is capped at 60 code points with an ellipsis; a stored
quote is also cut by `cutReplyPreview`. Cosmetic edges (`is_invisible`): Rust strips per character,
TS per grapheme, so a name's emoji joiners (ZWJ), Arabic/Syriac/Indic joiners (ZWNJ/ZWJ) and a
subdivision flag's tag characters (U+E0020-U+E007F) survive in the app and not in a banner. The text-GIF preview (a pasted GIF link) keeps `[GIF]`.
A media envelope holds ONE file (several files are several messages), so there is no `N photos` line.
**A reply quote already stored as `[Média]` stays as persisted:** it is written once, into the reply,
and is not rebuilt. Tests: `envelope.mediaPreview.test.ts`, and `push_text.rs` / `proto_fields.rs`.
**Read on both phones (2026-11-22, `1.7.3-alpha.5`; Mi 9T 2026-11-20 in French, iPhone 12 in English):** the list row, the reply strip and the stored quote, and the native banner give the same words (`GIF`, `Video: caption`, `File: name`; a file with a caption drops its name, `Attachment: caption`).

### A photo or video with text fills its bubble, and a video keeps its shape (2026-10-02)

**Two reports from the user.** *"message avec texte + image -> l'image est au dessus de la bulle,
comme si elle etait envoyee seule avant le texte, pas dans la bulle"*, and *"video -> conserver le
format (actuellement les videos sont crop dans le chat, il faut cliquer dessus pour tout afficher)"*.

- **Bleed.** A photo or video that carries a caption (and no quoted reply, which stacks its own
  bubble above) now fills the TOP of its bubble edge to edge, with the caption under it in the same
  bubble - Messenger's and WhatsApp's layout. It used to sit as a framed, rounded thumbnail inside the
  bubble's padding, which read as a card laid on the bubble. `MessageBubble` computes `bleedsMedia`,
  adds `overflow-hidden` to the bubble (it clips the corners, so the media draws none of its own) and
  passes `bleed` to `MessageMediaRenderer`, which cancels the padding with `-mx-3 -mt-2`.
- **THE WIDTH IS FIXED, NOT A PERCENTAGE.** The first attempt gave the media `w-full`: the bubble is
  `w-fit`, sized by its content, so a percentage width had nothing definite to resolve against and the
  bubble ballooned over the whole row. The media is `w-68` (17rem) and the caption `calc(17rem - 1.5rem)`,
  so a captioned media is always one width - the same lesson as the `w-56` note on the image branch.
- **A video keeps its own shape.** The box reserved the clip's ratio but the video was drawn
  `object-cover`, which cut a portrait clip down to the 16:9 fallback's crop. It is now `object-contain`
  in a box of the clip's real aspect ratio (`mediaAspectStyle`), so past the height ceiling it
  letterboxes on black instead of losing its edges.

Verified in Chromium on the real renderer inside a bubble of the bubble's own classes (landscape and
portrait, a caption shorter and longer than the media). `MessageMediaRenderer.image.svelte.test.ts`
pins the ratio, `object-contain`, the bleed and the rounded frame kept when there is no caption.

### Every photo in a conversation went to a `<video>` (#1229, shipped in `v0.18.32`; fixed 2026-10-01)

#1229 made a FEED video play inline (`InlineVideo`), and its edit to `MessageMediaRenderer` replaced
the IMAGE branch rather than a video one. Every decrypted chat photo was handed to a `<video>` with
`#t=0.1`, which no engine decodes as an image - Firefox said it outright: *"HTTP Content-Type of
image/jpeg is not supported"*, then `playWhileVisible: play() refused NotSupportedError`. The image
branch is back as it was (an `<img>` in a button opening the viewer, the download button over it);
the video branch is unchanged. **No test had ever mounted that branch**: the caption test passes
`blobUrl: null` and stops at the skeleton. `MessageMediaRenderer.image.svelte.test.ts` mounts it with
the bytes decrypted, and was red on the defect.

### Editing a message happens in the composer, not in the bubble (2026-10-02)

*"modification des messages -> pas dans la bulle, dans le composer de message classique"* (user,
2026-10-02). The bubble used to turn into a textarea with Save and Cancel buttons (`MessageEditForm`,
deleted); it now only ANNOUNCES the edit.

- **`MessageBubble` takes `onBeginEdit(messageId, text, captionOnly)`**, not `onEdit`. The toolbar's and the mobile
  sheet's "edit" call it for the author's own message (`canEdit`: not deleted, own, not a poll, a
  parent able to take it) - a media message's edit is its CAPTION's since 2026-11-11, [below](#a-media-messages-edit-is-a-caption-edit-2026-11-11). It is threaded `ChatArea` -> `ChatMessageGroups` -> `MessageBubble`.
- **The field shows the loaded text because the PARENT's text is its only writer** (2026-11-25): `MentionComposerInput.clearEditor` (the clear after a send) used to write the field's own `value`; landing after the parent's clear of a SvelteMap-backed draft (`messaging.draftFor`, Svelte 5.59.1; plain `$state`, a `$derived` of `$state` and a proxy do not show it) that write stayed as a local override and swallowed the next text the parent loaded - the edited message: banner up, field empty, only right after a send (measured on dev in a real Chrome). It now empties the DOM only; `MentionComposerInput.clearThenSet.svelte.test.ts`.
- **`createEditSession` (`utils/chat/editSession.svelte.ts`) holds the state.** `begin` loads the
  message into the composer's text and keeps the DRAFT it replaced; `cancel` and `confirm` give the
  draft back, so fixing a typo never eats the sentence the member was in the middle of. Switching
  from one edit to another keeps the FIRST draft. `confirm` saves only a text that is non-empty and
  changed (`onEdit`, the unchanged `handleEditMessage` path and its ordering rules below). `reset`
  runs when the conversation changes, and **an edit's text never stays as a draft** (2026-10-27):
  `begin` binds a writer to the draft of the conversation it starts in (`bindDraftWriter`), and
  `reset` gives the saved draft back through it - to the conversation the edit began in, never to
  the one now open ([each conversation keeps its own draft](#each-conversation-keeps-its-own-draft-2026-10-27)).
  **It must run on a change of conversation ID, never of the conversation OBJECT** (2026-10-07): the parent
  replaces that object on every incoming message, and an effect reading `conversation?.id` depends on the object, so
  each arrival dropped the banner. `ChatArea` reads the id through a `$derived`, compared by value.
  **Entering an edit focuses the field with the caret at the END** (`ChatComposer`, after a `tick()` so the input has
  rendered the loaded text); `ChatComposer.edit.svelte.test.ts` covers the caret.
- **`ChatComposer` takes `editingText`, `onCancelEdit`, `onConfirmEdit`.** While `editingText` is set:
  a banner (the reply strip's skin) names the message, Send becomes a Save check that stays disabled
  until the text is non-empty and different, **Escape or the banner's X cancels**, and the "+", the
  paperclip, poll, GIF and microphone step aside (`actionsHidden`). `submit()` is the one send path
  for Enter and the button; **an edit does NOT clear the field**, because the parent hands the draft
  back and a clear would reach it after and wipe it.
- **Salons CAN edit since 2026-10-05** (user: *why can I not edit my own message in a community?*). It was never refused on purpose: `MainChatPage` passed no `onEdit` for a channel because nothing had been built, so the bubble was never handed `onBeginEdit`. The mechanism is [below](#editing-your-own-message-in-a-salon-2026-10-05).

Verified in Chromium on the composer in edit mode at 390 and 1000 px. Tests:
`ChatComposer.edit.svelte.test.ts` (banner, Save rule, Enter and button, no clear, Escape and X, the
"+" put away and present otherwise) and `editSession.svelte.test.ts` (draft kept and returned, first
draft kept across two edits, unchanged and empty saved as nothing, reset). **Not exercised:** a real
edit through `handleEditMessage` end to end on a phone.

### A media message's edit is a caption edit (2026-11-11)

Owner, 2026-11-11: a message carrying a photo, a video or a file is editable, **caption only** - the
media stays the same and the bubble shows the same "modifié" mark as an edited text. A poll is not.
**Scope (lead's decision, 2026-11-11):** a CanaReel sent in a conversation stays editable, since a take's
caption is text like a photo's; a **voice note is not** (`mediaRef.voiceNote`): it has no caption to
edit. Until then `canEdit` hid the action on a media message on purpose (`!mediaRef`, and `!hasMedia` in
`MessageBubbleToolbar` and `MessageMobileActions`); both props are gone and the bubble's `canEdit` is
the one rule.

**NO NEW WIRE SHAPE, AND THAT IS THE DECISION.** The frame is the `edit_message` a text edit has
always been, `{ messageId, newContent, editedAt }`, and `newContent` is the caption. Every applier
already writes the text through `applyEditToBody`, whose media branch replaces `caption` and keeps
`media` (blob id, key, iv) and `replyTo` - since #903 (`v0.18.18`), far under the `1.6.6` floor. So
an old client never meets a shape it does not know, and none of them can replace the body with
plain text and drop the photo: the one way that could happen (a whole-body write of `newContent`)
was removed for the reply quote's sake in September. A new field (`caption`, `kind`) would have
bought nothing and made older readers fall back on `newContent` anyway.

**What each reader sees:**

| Reader | Caption edited | Caption emptied |
| --- | --- | --- |
| this build, DM or group | new caption, media kept, "modifié" | photo bare, "modifié" |
| older build (>= `1.6.6`), DM or group | same | **either result, depending on the path the edit took**. Live and replay: **old caption kept, no mark** (the `data.newContent` truthiness check drops `''`). A history bundle carrying the author's signed edit: **photo bare, marked** (`vetRestoredEdit` takes any string and stores `caption: ''`, which the bubble draws bare). So one old build can show either, and two old builds can disagree |
| this build, salon | new caption, media kept, "modifié" | photo bare, "modifié" |
| older build, salon | **old caption kept, no mark**: `applyChannelEdit` refused every non-text target (`not plain text`, logged) | same |

Every row keeps the media. The degraded cells are a stale caption, never a loss, and they end
with the floor passing this release.

**An empty caption.** `editFitsBody(content, text)` (`envelope.ts`) is the one rule, asked by every
applier before `applyEditToBody` - the live path, the replay, the post-save pass, a parked edit
(`pendingMutations`), a restored signed edit and the sender's own write: any text fits a media
message's caption, an empty one included, and only a non-empty text fits anything else (the old
truthiness rule, unchanged for a text message). The live and replay paths now accept a STRING
`newContent` rather than a truthy one, so `''` reaches that rule. `applyEditToBody` stores an
emptied caption as NO caption, the shape of a photo sent without one, so the bubble draws it bare.
In the composer, `editSession.begin(id, text, captionOnly)` records that the edit may be emptied and
`ChatComposer`'s `editingAllowsEmpty` lets Save through on an empty field.

**An edit of a file still queued (DM, group).** The edit goes into the outbox as usual and names the
message, so `dependsOnAny` holds it behind the file: the peers receive the file, then the edit. The
author's own row was the trap: the real envelope swapped in once the upload ends is built from the
QUEUE ENTRY, which holds the caption typed at the tap, so `updateMessageContent` (`outbox.ts`) wrote
the old caption back over the edit - and `persistSent` stored it. Two places fix it, one per half:
- **At rest, the stored row decides** (`sentRowContent`, inside `persistSent`'s compare-and-set). If
  the stored row holds a later edit than the copy on screen (`editSupersedes`), its text goes onto
  the sent body through `applyEditToBody`, so the attachment reference is the send's and the caption
  is the edit's. This matters because the flushing tab may not be the editing one. A leader tab that
  flushes a follower's queued photo holds the tap caption on screen while the follower's edit is at
  rest, and writing the screen's body showed "modifié" over the old caption after a reload. A text
  edited in a follower tab had the same flaw, and the same rule fixes it.
- **On screen**, `updateMessageContent` keeps an edited row's caption over the real attachment
  reference (`[OUTBOX] … keeps the caption edited while it was queued`), and leaves a deleted row
  alone - a tombstone does not get its attachment back.

The edit of a message that then never leaves (withdrawn, or failed for good) is not handled yet:
[backlog](../../backlog.d/p3-an-edit-of-a-queued-message-whose-send-never-happens.md). A salon echo still uploading is not editable at all (`awaitingServerId` withholds every
action addressed by a server id), so the salon has no such window.

**The sender's other devices** receive the edit like any member and apply it by the same rule; the
conversation list follows because its preview is read from the row's body. The push and the native
layers do not render an edit (`proto_fields.rs` silences `edit_message`).

Tests: `envelope.editBody.test.ts` (caption replaced, emptied, media and quote kept; `editFitsBody`),
`systemMessageHandler.captionEdit.test.ts` (live path, in memory and at rest; an empty text on a text
row dropped), `messagingEditCaption.test.ts` (the frame's three keys, the empty string an older
client drops), `channelEdit.test.ts` (salon caption edited and emptied),
`outbox.captionEditedWhileQueued.test.ts`, `editSession.svelte.test.ts`,
`ChatComposer.edit.svelte.test.ts`, `MessageBubble.editAction.svelte.test.ts` and
`MessageMobileActions.row.svelte.test.ts` (Modifier offered on an own media message and a CanaReel,
not on a voice note). `outbox.captionEditedWhileQueued.test.ts` also covers the stored row edited
with the screen stale. **Not
exercised:** a real caption edit between two phones, and a `1.6.x` store build receiving one.

### Editing your own message in a salon (2026-10-05)

**An edit is a SILENT ENCRYPTED CHANNEL ROW, exactly like a reaction** ([channel-encryption 4.7](../../protocols/channel-encryption.md)): a new `EditMsg` (`AppMessage.edit`, field 13: the target's SERVER row id, the replacement TEXT, `edited_at`), sealed under the author's Graine session by `sendChannelEdit` (`channelCrypto.ts`). The server stores an opaque row flagged `silent`, so **there is no new push and no server change, no endpoint, no migration** - and none COULD validate it: it cannot tell the row is an edit or whose message it names.

- **Authorship is checked by every reader**, in ONE function, `applyChannelEdit` (`utils/chat/channelEdit.ts`), used by the live handler (`channelEventHandler`), a history page and the search sweep (`useConversations`) and the sender's own write (`editChannelMessage`). The edit's sender is the ROW's - what Graine v2 proves, unforgeable by the server and by other members - and it must equal the target's author. **A moderator may remove someone's message (`channel.moderate`), never rewrite it.** A refusal is logged (`REFUSED`), silent to the user.
- **"Proven" holds for v2 sessions only.** A row opened under a v1 session has a server-supplied, unsigned `senderId`, so a malicious server or a pre-G2-5 v1 row could forge an edit from the author - the same trust level as DELETE today, not a regression, and deliberately not restricted. It ends with the v1 reader ([channel-encryption 21.5b](../../protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05), [backlog](../../backlog.md)).
- **Paging limit, stated exactly.** `listMessages` returns silent rows only inside `[oldest body of the page, before)`, and the server cannot know which silent row targets which message (opaque), so no clean server-side fix exists. With a `before` cursor an edit made AFTER the cursor is not in that page. Nothing affected today: the history load takes the newest page (no cursor), channels have no older-page load (`loadOlderMessages` returns false), and the search sweep applies edits over ALL pages it collected. Reactions share the limit. Backlog item below.
- It edits a plain TEXT message, and a media message's CAPTION since 2026-11-11 ([below](#a-media-messages-edit-is-a-caption-edit-2026-11-11)): not a poll, a notice or a tombstone (a delete is final). Empty text is refused on a text, and removes a caption. Order is `editSupersedes` (later `editedAt` wins, tie on the text), so two devices converge in any arrival order; the author's own echo is a quiet no-op.
- **The history load applies the edit rows after the page is built**, because a salon is not stored locally: the marker and the new text come back from the same silent rows. The page limit counts non-silent rows and brings every newer silent row, so an edit of a loaded message is always on the page.
- UI: `MainChatPage` now passes `onEdit` for a channel (`channels.editChannelMessage`); the inline edit is the composer's, shared with DMs and groups, and the edited marker is the existing `isEdited`.
- **Old clients** read `AppMessage` with an unknown oneof, which decodes to an empty frame: the row is not rendered and nothing breaks, they simply keep the original text. **Not exercised: two real devices round-trip, and the 365-day retention purge of an edit row whose (pinned) target outlives it** - the edit is then lost with its row, the original text stays.
- Tests: `channelEdit.test.ts` (author, other member, moderator, empty, emoji and newline round trip through the proto, poll/notice/deleted/absent, reply kept, order independence, echo), `channelCrypto.test.ts` (`sendChannelEdit` silent, own row id), `MessageBubble.editAction.svelte.test.ts` (the menu entry only on an own, live, non-poll message with a handler).

### A message body and a media CAPTION are two render paths, and only one of them parsed mentions (2026-09-23)

`MessageBubble` renders `MessageTextBody` under `{#if !mediaRef}`. A message carrying an attachment
therefore never reaches it: its caption goes to `MessageMediaRenderer`, which printed each text
segment verbatim. So a photo captioned `Dans le retro @[7283faf1...]` displayed those 64 hex
characters, and a `#hashtag` in a caption rendered as plain text.

**IT LOOKED LIKE A COLD CACHE AND WAS NOT ONE.** The user reported it as a name that never arrives -
*"le refresh ou le relancement de l'app ne fait rien"* (2026-09-23) - which is the one observation
that rules the cache out. `MessageMentionChip` resolves for itself and re-renders when the name
lands, precisely so a cold cache heals within a frame; a token that survives a full relaunch was
never handed to a resolver. Nothing on the caption path ever called `splitTextWithMentions`.

**THE FIX IS A SHARED COMPONENT, NOT A SECOND CALL.** `MessageInlineText.svelte` renders one
plain-text run - mention chip, hashtag, or text - and both `MessageTextBody` and the caption in
`MessageMediaRenderer` now go through it. A caption and a body genuinely differ in what WRAPS the
text (the `<p>`, the search highlight, the GIF embed, the link preview card) and in nothing about
what the text MEANS; spelling the mention and hashtag cases separately in each is what allowed one
to be written without the other, and a third surface would have repeated it.

`MessageMediaRenderer.caption.svelte.test.ts` asserts the caption, not the parser:
`splitTextWithMentions` was correct throughout and its own tests passed for the whole life of the
defect. **The search highlight is still body-only** - `searchTerm` is not passed to
`MessageMediaRenderer` at all, so a hit inside a caption is not marked. That is a separate gap and
nothing above closes it.

### The @mention picker does not offer you yourself, and that follows from a fact (2026-09-24)

Typing `@` used to list the signed-in reader among the suggestions. Picking yourself inserted a
chip, put your own id in `mentionedUserIds`, and then **reached nothing at all** - which is the
whole argument, because it makes the question a fact rather than a preference:

| Consumer | What it does with a self-mention |
| --- | --- |
| `notifyChannelRecipients` (social-service) | skips `member.userId === input.senderId` BEFORE it looks at any notification level, so no channel notification can result |
| a post comment's notify block | seeds `alreadyNotified` with `data.userId`, so the mention loop skips the author |
| `mentionsMe` in `useMessaging.svelte.ts` | runs only on an INBOUND frame, and your own message is never one - MLS gives no echo of it |
| a mentions inbox | **there is none** - no `hasMention`, no mention filter, nothing in this app that lists mentions of you |

The last row is what closes the only argument for keeping it: some chat apps treat a self-mention as
a way to bookmark your own message, and that needs a surface to find it again from. This app has
none, so the control's only possible effect was on the text. **Offering a control that cannot do
anything is how a reader learns by being ignored what a fact could have told them**, and two pickers
here already excluded the reader for the same reason - `SidebarNewChatModal` and `ChatGroupPanel`.
This was the last one that did not.

**Tab completes the open @mention list (2026-10-13).** `useMentionAutocomplete.handleKeydown` treats Tab
like Enter on a row: the highlighted suggestion, else the first, through the same `select`. Shift+Tab,
a modified Tab, a Tab during IME composition, and any Tab with the list closed or empty are left to
the browser. No string is involved; touch keyboards have no Tab.

**The exclusion lives in `useMentionAutocomplete`, not in its three callers.** `ChatComposer`,
`PostComments` and `MarkdownComposerField` all reach the composable through
`MentionComposerInput`, so threading a prop would have been three components carrying a fact that
`currentUserId()` already publishes globally - and a fourth surface added later could forget it. The
decision is made where the search results are filtered, from where the discriminator is already
known.

**The same change deleted a duplicate filter and pinned the trap under it.** The allowlist half was
an inline `SvelteSet` comparison, reimplementing `filterUserSuggestions`, which the rest of the app
uses and which is case-insensitive on BOTH sides for reasons its own doc comment gives. The two do
not agree about one input: an EMPTY `allowedUserIds` means "no restriction" here and "offer nobody"
there, and the array is legitimately empty while a channel's member list is still loading. So it is
passed only when non-empty, and a test pins that reading rather than leaving it to the helper's

**A conversation with a roster suggests from it, locally (2026-11-06).** `allowedUserIds` filtered
the server's answer, and that answer is the school's top 10 matches: with one letter a small group's
members were rarely among them, so "@M" proposed nobody. `MainChatPage` now passes the group's or
salon's members as `mentionRoster` (ids stamped with when each last spoke here,
`buildMentionRoster`), and the composable filters them itself (`suggestFromRoster`): a bare `@`
opens the list, a word of the name must start with the folded query, latest speakers first then
alphabetical, six rows, no search request. Names come from the display-name cache;
the first open batch-resolves the missing ones and reads the reader's blocks, once per picker. The
reader and the accounts the reader blocked are never offered (the server hides blocked accounts both
ways from search; the client only knows its own blocks). An EMPTY roster, a list still loading,
falls back to the server search, logged. Posts and comments pass no roster and keep the search.
default.

**Typing an `@` looped the roster picker's effect on `1.6.6`-`1.6.8`, and the chat fell to its
boundary (reported on Android `1.6.6`, 2026-11-12).** The caret reaching an `@` changes `start`,
which re-runs the effect `MentionComposerInput` keeps on the roster prop (`refreshRoster`). There,
`suggestLocally` wrote `suggestions` and read it back to set `open`, so the effect depended on the
array it replaced on every run: `effect_update_depth_exceeded` at the first `@`, in a DM and in a
salon alike, right after the blocks read and the name batch the picker's first open asks for. **It
was fixed by #3233 (`v1.6.9`)**, which sets `open` from the local array; a reader on an older build
only has to update. `MentionComposerInput.keystrokes.svelte.test.ts` types "salut @" and "a@b." key
by key through the real component, with the blocks read and the batch answered asynchronously, and
fails with that error on the `1.6.6` shape. The boundary's own line read `[object Object]` in that
log; it now goes through `describeCaughtError` (name, message, three stack frames) at the error
level. On the way: a server search still waiting for its delay ran after the mention had ended
("a@b." typed quickly) and reopened the picker on plain text with nothing selectable; the end of a
mention now drops it.

**"@Prenom NOM" is searchable, and the `@` costs one pass of look-ups (owner, 2026-11-12).** Two
reports, one code path (`useMentionAutocomplete`, `mentionRoster.ts`):

- **Several words.** The query ended at the first space, so a last name could not be typed after a
  first name. `findMentionQuery` now reads letters, digits, apostrophes, hyphens AND spaces after the
  last `@` (never a space right after it, never across a newline, at most 64 characters). The picker
  stays open while somebody matches the WHOLE query: every query word must start a DIFFERENT word of
  the name, in any order, accents and case ignored (`wordsMatchQuery`), so "jean dup" and "dupont
  jean" both find Jean Dupont. A space that leaves nobody ends the mention, and so do Escape and a
  newline; typing on at the same `@` then asks nothing and the text is plain text, until the reader
  edits back to something the ended query no longer starts (`ended`). Without a roster the server
  searches, but its answer to a query of several words is held to the same rule before it may keep
  the mention open (`matchingWholeQuery`): the endpoint ANDs SUBSTRINGS, so "@Jean je le" or
  "@Marie et toi" - a sentence - still found Jean and Marie, the picker swallowed Enter and Tab
  inserted a mention nobody chose (review of #3402). A one-word query keeps the server's fuzzy
  reading. And a mention that ended while the roster's name batch was still on its way (a space
  typed before "Camille" was a known name) is read again when the names land.
- **Speed, measured.** Every keystroke folded every member's name (`normalize('NFD')`) and sorted
  every match: on 5,000 members, about 24 ms for a bare `@` and 28 ms for one letter in vitest on the
  dev machine, more than a frame. `MentionNameIndex` folds a member's name once for the life of the
  picker and again only when that name changes, and the walk keeps the best six rows by bounded
  insertion instead of sorting: 0.8 ms for a bare `@`, 3.7 ms for one letter, 0.9 ms for
  "prenom1 nom". `mentionRoster.search.test.ts` pins the property (5,000 folds across eight
  keystrokes, not 40,000), never a clock.
- **The server search has no timer.** It waited 250 ms after each key and could apply an answer
  that landed after a newer one. Now a key sends at once when nothing is in flight; otherwise its
  query waits, replacing any query already waiting, and goes when the answer returns: at most one
  request in flight, at most one more queued, so the search runs ONCE PER KEY at most and a burst
  of keys costs two requests. Every change of the mention and the composer's destruction
  (`dispose`) bump a `generation`, and an answer is applied only if none came after its request;
  the rows of the earlier query are hidden while the new one is asked, so Enter and Tab never pick
  a row that no longer matches. A roster change drops NOTHING: the live chat re-sends its roster on
  every line (authors added, dropped, reordered), the search asks for the text typed, which a
  roster does not change, and re-reading the roster keeps the rows the audience added and the
  selected row, minus any account a late block list names. A directory search is only the stand-in
  for a roster not loaded yet: once members are there, its answer and any waiting directory query
  are dropped, so the school's top 10 never replaces them. The name index keeps only the current roster's members, keyed once per roster
  array (sorted ids). A failed search - transport or a non-2xx status - warns once per outage, and
  so does the live chat's audience filter. The endpoint already caps at 10 rows
  (`take(10)`), the picker shows six; measured on dev it answers in 90-190 ms, which is now the
  whole wait instead of 250 ms plus that.

### The composer's own emoji picker, and what it shares with the reaction one

`ComposerEmojiPicker.svelte` sits at the right end of `ChatComposer`'s text field, right before the
send button - never behind `controlsCollapsed` (the button row that folds while typing), because
picking an emoji is something a member reaches for mid-message, unlike attaching a file or opening
a poll. Desktop only (`!isMobileViewport`): a phone keyboard already has its own panel.

It reuses `MessageEmojiPicker.svelte`'s positioning mechanism (`bindFixedPopover`, portalled) rather
than a centred modal - anchored to the button, and `computeFixedPopoverPosition` prefers whichever
side has more room, which is ABOVE for a composer sitting at the bottom of the screen. The two
pickers also now share `emojiPickerShared.ts`: the i18n objects (spread onto the library's own
English defaults so a key the library adds later cannot crash the panel the way `skinToneLabel` once
did), the FR/EN dataset resolver, and the recent-emoji list - one localStorage-backed history for
both a reaction and a composed message.

**Picking an emoji closes the panel, inserts it followed by a space, and refocuses the text field;
holding Shift does neither** - the panel stays open and nothing is added after the emoji, so several
picks in a row sit next to each other rather than reopening the panel each time. `emoji-click`'s own
event carries no modifier-key information (it is the library's synthetic event, dispatched from
code), so Shift is read from a separate CAPTURE-phase `click` listener on the same host element -
capture runs before the library's own internal handling, which is in bubble/target phase deep in the
shadow root.

**The panel is rendered INSIDE the element `clickOutside` is bound to, not as a distant sibling.**
`clickOutside`'s `containsThroughPortals` recognises a node moved by `use:portal` as "inside" its
ORIGIN parent - where it was written before the move - never wherever it happens to sit once
mounted. Rendering `<ComposerEmojiPicker>` far from the button (e.g. beside `GifPickerModal`) gives
it an origin outside the anchor, and every click on the panel's own contents - its search box, a
category tab, an emoji - then reads as "outside" and closes it a frame before the pick can register.

### Every keyboard rise moves the composer for a moment, on both phones (measured 2026-10-02, FIXED 2026-10-09, reading owed)

> Since 2026-11-14 (#3556) the Android shell never resizes the WebView for the keyboard: it announces each keyboard change with its duration and curve, and the page lays itself out over the keyboard and rides the composer and the thread on the keyboard's own timeline: [keyboard-and-send-motion](../keyboard-and-send-motion.md#6-android-since-2026-11-14---the-keyboard-covers-the-webview-and-the-page-rides-it).

Found while reading the GIF panel (#1345). The composer's top was recorded on every animation frame
via CDP, with the keyboard opened by tapping the text field. **Both happen on a plain keyboard open
with no panel involved**, so neither comes from the panel's hand-off, though both show through it. The
cause is a different stale number on each phone.

- **Mi 9T (Android WebView).** The top sits at 877 px, then for 60-100 ms at **174 px**, then at
  532 px. During that window `visualViewport.height` reads **230** while `innerHeight` is already
  **588**. 945 - 2 x 357 = 231: the keyboard's height is taken off TWICE for one report, once by the
  resize and once by the visual viewport. `keyboardViewport` follows the visual viewport, so the
  composer jumps 358 px up and comes back. Measured twice (with and without the GIF panel), the same
  numbers. The remembered keyboard height is not polluted: the last write wins, and it is 357.
- **iPhone 12 (iOS 27.0.1).** The top sits at 766 pt, then for ~400 ms at **465 pt**, then at
  487 pt. `visualViewport.height` is 543 from the first frame, but `--safe-area-inset-bottom` stays at
  **34px** for ~400 ms before it falls to 0. `.keyboard-open .chat-composer-footer` pads
  `max(0.75rem, var(--safe-area-inset-bottom))`, so the composer stands 22 pt (34 - 12) too high
  until the inset catches up.

**Fixed 2026-10-09 in `keyboardViewport.svelte.ts`, both halves proven in unit tests only.**
- **Android**: `computeSnapshot` reads a double-reported visual viewport as the layout viewport's
  own height. **Since 2026-10-13 the report is recognised by its SHAPE, not by a height**
  (`isDoubleReport`): the visual viewport stands below the layout viewport by exactly what the
  layout gave up (`winH - vv == baseline - winH`, within 2 CSS px of independent rounding). The
  first version asked the layout to have shrunk by more than the 160 px keyboard threshold, so the
  bench's 90 px ADB keyboard got past it and the composer drew one frame at 702 before resting at
  792 (2 of 5 rises, [check W](../../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)).
  Nothing else has that shape: a pan gives nothing up, a pinch-zoom bails out on `scale`, a settled
  keyboard leaves the viewports equal, and a URL bar plus a keyboard agree only if both are the same
  height to the pixel. The tests replay the bench's LatinIME rise (945 / 588 / 230.3 / 587.9), a
  90 px rise, and keyboards from 40 to 450 px.
- **iOS**: the "must not visibly shrink" comment on the footer rule is about the RESTING state, and
  the resting inset with the keyboard open is already 0 (the footer settles at 0.75rem), so pinning
  `--safe-area-inset-bottom: 0px` inline while an iOS keyboard is open (`keyboardSafeAreaBottomOverride`,
  `pinSafeAreaBottom`) changes no resting state and removes only the ~400 ms transient. The pin puts
  back the inline value it replaced - `app.html` pins `0px` itself outside Tauri. Android is left
  alone: its inset was never measured to lag.

The reading owed is the original one, on both phones ([device-verification](../../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)).
Readings: [#1345](https://github.com/emse-students/canari/pull/1345#issuecomment-5943602239).

## Message pipeline

```
WebSocket frame
    |
enqueueMessage()      <- serialized queue, one message at a time
    |
messageCallback()
    |
connection.ts handler:
  - isWelcome -> processWelcome() -> create conversation -> replay history
  - known group + isReady -> processIncomingMessage() -> decrypt -> dispatch
  - unknown group -> buffer until Welcome arrives
```

See [`protocols/mls-protocol.md`](../../protocols/mls-protocol.md) for full flow details.

### The drain is a single point of failure for ALL inbound traffic (WP-HIDDEN-1, WP-DRAIN-1)

The queue is serialised, and `isDraining` is lowered only when the message callback RETURNS - in a
`finally`, but **behind** `await hooks.onDrainEnd()`. `enqueueMessage` starts a drain only
`if (!draining)`, **and logs nothing when it does not**. So one stuck await inside the checkpoint
stops every inbound message for the life of the tab, with not one line of output. The restart guard
at the end of `processQueue` cannot help: it runs after `drain()` returns, and `onDrainEnd` is what
hangs.

Two different awaits have already frozen all inbound traffic this way, and they are worth keeping as
the two shapes to expect:

1. **A yield that never resolves.** `runSaveEncrypted` opened with `await yieldToMainThread()`, whose
   helper resolved from `requestAnimationFrame` - **which a browser never fires for a hidden
   document**. A backgrounded tab therefore received nothing at all, silently, until refocused. The
   fingerprint is precise and reproducible with ONE tab: message #1 decrypts, logs
   `Bulk ingest done - flushing…` and never renders (the UI flush is buffered by
   `beginBulkIngest({ bufferUi: true })` and released by the `endBulkIngest` that is stuck); message
   #2 is enqueued with no drain and no log; both appear at the exact millisecond of the refocus. Two
   candidates were eliminated by MEASUREMENT rather than by reading - IndexedDB answered an open plus
   read in 1 ms from inside the stuck tab, and the encrypt worker's 60 s timeout would have failed
   loudly and released the drain.

   The fix **races** the frame against a `MessageChannel` round trip rather than choosing between
   them: branching on `document.visibilityState` would still hang whenever a tab is hidden *after*
   the callback is queued, which is exactly what a user does. The fallback is a port message and not
   `setTimeout`, because background tabs clamp timers to about 1 Hz - which would turn a
   hundred-message catch-up into minutes of stalling. `yieldToMainThread` is awaited on six paths,
   including history replay and the PIN-change batches.

2. **A recovery re-acquiring the MLS mutex the drain already holds** - a deadlock, not a slow path.
   Hence the rule that a repair whose result nobody reads (a re-add, a Welcome, an external join)
   must be STARTED, never awaited, and must log how it settles (`startRecovery`; `DeferredRecovery`
   on the Welcome path is the same lesson learnt earlier).

**Each was fixed in place; the SHAPE was not** - nothing type-checked that the next await added
there was safe. That was WP-DRAIN-2, closed 2026-08-11.

#### What closed it, and what it deliberately does NOT do

There is now exactly ONE way to await inside `drain()`: `MlsPerGroupScheduler.guarded(label, work)`,
which arms a repeating 60 s report and clears it in a `finally`. Four awaits go through it - the
lock acquisition, `processMessage`, `yieldToMainThread` and `onDrainEnd` - and each carries its own
label plus the group and queued-message id, so the log names WHICH phase is stuck rather than that
something is. The report repeats every minute with the elapsed seconds, because the elapsed time is
the diagnosis: one line says a phase was slow, twenty say it will never return.

The lock acquisition is guarded SEPARATELY from the work it protects, and they must not nest -
wrapping `runUnderMlsLock` whole made a hung handler report both labels, which is the exact
ambiguity the split exists to remove. Hence `acquireMlsLock` is called directly in the drain loop.

**It reports; it does not cancel, and the flush stays inside the window.** Moving `onDrainEnd`
behind `isDraining = false` was the other option this page used to offer, and it is wrong:
the UI render buffer is ONE buffer, not one per window, so a second drain starting during a live `endBulkIngest` would call
`beginBulkIngest` across it - a UI buffer cleared without being flushed, which is WP-ECHO-1's exact
failure and a strictly worse one. **A freeze loses nothing durable; a lost buffer does.** So the
deadline buys the only thing it safely can, which is evidence.

The per-message watchdog that used to sit in `BaseMlsService.processQueue` is deleted with this:
it covered one of the four awaits, and two watchdogs for one await would have reported the same
freeze twice while still saying nothing about the other three.
`mlsPerGroupScheduler.test.ts > a frozen drain reports itself` pins all four labels plus the
negative control - a healthy drain says nothing.

One methodological consequence, because it retired a PASS: a check that asserts **after** restoring
the tab is asserting after the very act that releases the drain. A single message can never expose
this; the second one is the whole test.

#### Why the drain terminates - the proof `guarded` is the complement of

`guarded` watches the awaits; it says nothing about the loop around them. The loop's own argument is
short and is written on the class: **every iteration removes exactly one message from a bucket, and
nothing in the loop puts that message back.** The single in-loop addition is `releaseWelcomeBuffer`,
which moves a finite buffer at most once per Welcome because it deletes the entry as it goes. So the
loop strictly decreases over the work the scheduler holds, plus whatever genuinely NEW work arrives
while it runs.

**That clause was re-read against the code on 2026-08-25, because `5d7fac13` touched this path and a
proof whose load-bearing sentence is only asserted is worth what the assertion is worth.** It holds,
and by two independent facts rather than one: the entry is deleted BEFORE the frames are moved, and
the frames are pushed straight into `bucket.messages` past `enqueue`, so the release cannot re-enter
the scheduler's admission path and cannot manufacture work. A NEGATIVE, recorded because the next
person to touch the scheduler will ask the same question.

**That last clause is why elapsed time is not evidence.** A drain running ten minutes under sustained
traffic is doing its job; a drain running ten minutes on one message is frozen. Nothing outside the
loop can tell those apart, which is exactly why the deadline may only report - and why a watchdog
that cancelled would be cancelling healthy drains under load.

#### The Welcome buffering window - the one thing the proof does not cover

The proof is about the BUCKETS, and the scheduler holds messages outside them. `pendingWelcomeGroups`
parks a group's frames while its Welcome is in flight, so they are applied **after** the Welcome that
makes them readable. Opened by `enqueue` when a Welcome for a group arrives, closed when that Welcome
finishes.

Three paths used to close it wrongly, and none of them logged a line - which is what made them
survivable, since a dropped frame and a frame that never arrived are identical on screen. **Every
frame at risk is one carrying no `queuedMessageId`, since nothing can re-fetch it** - and that is a
property of the FRAME, not of the channel it came in on. A live WebSocket frame need not carry an id,
but it often does: the gateway forwards the queue row's id when it persisted one, which COMM-4
measured on 2026-08-25 (`[WS RCV] JSON frame` and `[PENDING] Fetched 1 pending messages` handing back
the same `qId`). Read the field; never infer it from the arrival path.

| Path | What it did | Why it is ordinary, not exotic |
| --- | --- | --- |
| A SECOND Welcome for the same group | `set(groupId, [])` - dropped what the first was holding | a re-add, or a server re-delivery |
| A FAILED Welcome | deleted the buffer, assuming the server would re-deliver | true only of a frame carrying a `queuedMessageId` |
| A throwing NON-Welcome of that group | released a window its Welcome had not opened | reachable whenever a frame already picked throws while a later Welcome opens one - the frames were then applied AHEAD of the Welcome, against an epoch the client does not have |

What replaced them is **one exit with one behaviour**: `releaseWelcomeBuffer(groupId, reason)` always
re-queues, for both outcomes, and names the reason in the log. Re-queuing costs nothing when the
group is still unknown - the handler records the frame against that group and
`refetchFramesLeftBehind('unknown-group', ...)` discharges it when a Welcome finally lands, which is
the seam that exists for this case. The third path is simply **deleted**, so the window belongs to
its Welcome from end to end.

`isIdle()` now counts the buffer (`getHeldCount()`), and this is a DEFINITION rather than a bug fix:
the mailbox barrier claims "nothing left to apply", and a parked frame is something left to apply. It
was never observably wrong only because the two closing paths discharged the buffer by throwing it
away. What makes counting it safe - rather than a new way to hang every barrier - is the drain's
closing invariant, `releaseStrandedWelcomeBuffers`: **the buckets are empty and a buffer survives**
cannot be true of a healthy drain at any speed, so reaching it is a defect. It is an `error` naming
the groups and the count, the frames are re-queued, and `processQueue`'s restart guard picks them up.
A proof, not a deadline - it is the one freeze `guarded` cannot see, because nothing is awaiting.

Both halves are pinned: `mlsPerGroupScheduler.test.ts` (the window, the second Welcome, the failed
Welcome, the stranded buffer with two negative controls) and
`BaseMlsService.welcomeBuffer.test.ts`, which proves the parked frame actually **reaches**
`messageCallback` - a frame re-queued into a bucket nobody drains again is dropped just as
thoroughly as one deleted.

### Two channels, one row - a delivery's identity (2026-08-25)

An inbound frame reaches this client by two independent routes, and **nothing about either makes them
one event**: the gateway pushes it live, and `/pending` returns everything not yet acknowledged. Both
end at `enqueueMessage`, and until COMM-4 both were free to hand the drain the same server row twice.

That is not a wasted cycle. **An MLS ratchet secret is single-use**, so the second decrypt of one row
fails with `SecretReuseError` - a duplicated DELIVERY is indistinguishable, at the decrypt, from a
corrupt MESSAGE. The client then took the only branch it had: declared a perfectly good frame
unreadable for good, acknowledged it, and healed. The user lost the message and the log said the loss
was handled. Measured in full on 2026-08-25:

```
[WS RCV] JSON frame: senderId=d82cd226…, groupId=56215a1b…, isWelcome=false, protoLen=472
[QUEUE] Processing message group=56215a1b… sender=d82cd226… qId=d4ecf0fe…
[GRAINE] absorbed 1/1 seed(s) …                      <- the frame was fine
[PENDING] Fetched 1 pending messages (1 so far)
[QUEUE] Processing message group=56215a1b… sender=d82cd226… qId=d4ecf0fe…   <- the SAME row
	SecretReuseError
[GRAINE] frame on 56215a1b... is unreadable for good (secret-reuse) - acknowledged
```

**The fix names the row's identity and puts the check at the one seam both routes pass through.** A
delivery is identified by its `queuedMessageId` - the server's queue id, which is exactly what makes
two arrivals the same row - and `admitDelivery` refuses a repeat inside `enqueueMessage`, before any
bucket. The classifier was deliberately NOT widened: `SecretReuseError` stays `severe` in the harness,
so if the failure ever arrives by a route this does not cover, it is still a defect and still says so.

Four properties, each of which would be a defect if dropped:

| Property | Why |
| --- | --- |
| A frame with **no** id is always admitted | the server holds no row for it, so nothing can be a repeat of it |
| `queued` and `done` are kept apart | different answers to a repeat: the other route is mid-flight, versus it is settled and should be ACKed again (the peer channel is still asking) |
| A delivery the drain left **unacknowledged** is FORGOTTEN | a Welcome that could not be processed yet must come back, or `refetchFramesLeftBehind` becomes a lie |
| The memory is bounded (512 ids, oldest evicted) | a per-tab Map that only grows is a leak on a long-lived session |

`BaseMlsService.deliveryIdentity.test.ts` pins all four plus the base case, driving the real drain
through `enqueueMessage` rather than asserting on the Map.

### One pull at a time, and the one asked meanwhile is owed (2026-11-04)

`done` records that this device DECIDED to acknowledge a row; the ack naming it leaves only when the
whole drain ends (`onDrainEnd`). Two pulls used to run side by side at boot - the reconnect's, then
`refetchFramesLeftBehind`'s re-fetch for the conversations the restore had just seeded - and the
second listed rows the first one's drain had settled but not yet acknowledged. The repeat met `done`
and was accused as an ack the server forgot: two `[QUEUE] delivery ... arrived twice` lines after each
launch on the Mi 9T (`1.6.4-alpha.3`, dev).

The overlap is deleted, not classified. `fetchPendingMessages` is SINGLE-FLIGHT WITH ONE OWED RE-RUN:

- asked while a pull is fetching, the queue is draining, or a row a PULL listed is still queued
  (`hasQueuedFrom('pull')`: held by a commit, or parked behind a Welcome - PENDING, not merely
  runnable), it starts no request - the pull is OWED (`owePull`), the caller's groups are added to it
  (an ask naming none makes it `'all'`), and the caller's promise settles when it has run;
- the owed pull is issued (`issueOwedPull`) in the tick `onDrainEnd` announces the drain's ack (its
  flush chains behind that ack), or at the end of a fetch or of `processQueue` when no drain runs -
  never while a pull's row is still queued: a commit-held row's drain starts at the commit's end
  (`resumeFramesHeldByCommit`), and its `onDrainEnd` issues it;
- the owed record is consumed when it is issued, so a burst of asks is one pull and nothing is timed;
  the issue re-checks the gates of an ask (resolved user, leader tab, client not destroyed), and
  `destroy()` drops the record, releasing its askers with nothing pulled.

It is NOT chained into `pendingPullInFlight` (that held every barrier behind the whole drain).
`waitForGroupQueueIdle` waits on the owed pull's listing only for a group it was asked for, or for
every group when an ask named none (a reconnect, a barrier, a re-enrolment: the whole mailbox);
`mailboxListedOnThisLink` - and so `isGroupDrained` - reads false while a pull is owed. A held live
key-group frame (`holdLiveKeyGroupFrame`) just asks for its group's pull.

One crossing no pull can be ordered against is left, and it has its own shape: a row the SOCKET handed
in, listed by a pull whose flush left before that row's ack. Every ack request carries a serial
(`announceAck`), each delivery remembers the channel that admitted it and the serial of the ack naming
it, and a pull records the serial of its flush (`listedAfterAck` on `DeliveryArrival`):

| The repeat | Shape | Line |
| --- | --- | --- |
| pull lists a row the socket took in, ack not sent before the pull's flush | `pull:crossed-live-ack` | `log`, once; not acknowledged again - that ack covers it |
| pull lists a `done` row whose ack failed | `pull:done` | `log`: the `[ACK]` failure above |
| pull lists a `done` row a PULL took in, ack landed before | `pull:done` | `warn`: nothing routine explains it |

`BaseMlsService.singleFlightPull.test.ts` drives both through the real pull, scheduler and drain:
two asks during a drain give exactly one second pull, after the drain's ack, and no repeat.

### Adds to one conversation are NOT serialized, so an add renders onto the row as it is now (2026-11-23)

Asked after the review of #3987: does anything serialize `addMessageToChatOnce` per conversation? **No.**
The MLS drain applies one frame at a time (`MlsPerGroupScheduler.drain`, one borrower at a time under
a commit's loan), so two FRAMES never interleave. But many writers call `addMessageToChat` outside the
drain: a send and its placeholders (`useMessaging` send paths, `messaging.ts`), own visible notices
(`visibleNotices.ts`, `removalNotice.ts`, `deviceNotices.svelte.ts`, `callSystemMessages.ts`), the
outbox's own lines (`outbox.ts`), and the salon event handler (`channelEventHandler.ts`). An inbound
add awaits the store (`getMessagesByIds`, then `settleWithPending`) between reading the conversation
and rendering, and it used to render by spreading the copy it read at ENTRY: a message another writer
showed in that gap - an own message just sent, a second arrival - was erased from memory along with its
unread count (it stayed in the store, so it came back at the next load).

The fix is the one the batch path and the preview upgrade already used: re-read after the last await
and render onto the row as it stands. The effects after the write (the other tabs' seed, the
notification's watermark) read the live row too. No lock and no timer: every writer that awaits
re-reads, and the ones that do not await before rendering cannot hold a stale copy.

**What the entry decided is decided again when the gap changed it (review of #3988).** Two facts read
at entry can be false after the store read, and neither may be answered by the new-arrival path:

- **the id is now shown** by another writer (a push preview, a redelivery). The add is not a new
  arrival: the live path re-enters and its entry-time duplicate/upgrade branch answers - a preview
  takes the body (`mergeMessageUpgrade`), a body or a tombstone is left - and none of the arrival's
  effects run (no second count, tone or banner). The batch path does the same for its late-held ids:
  a preview is reshown upgraded WITH what waited for the body (a deletion, an edit, reactions -
  `resettled`, the same settlement the stored row gets; `messageReactions`, which the bubble reads
  first, follows the row shown), the row is written as an UPGRADE (compare-and-set onto a stored
  preview, `mergeShownUpgrades`, inserted only where none stands), and only the messages actually
  added are counted and announced;
- **the conversation left the map.** Storing its rows would resurrect a deleted conversation, so
  both paths hand the messages to the orphan buffer, as the live path's entry does, with a WARN. The
  writes that run BEFORE that check - the upgrade of a stored preview (`settleStoredBodies`), the
  live upgrade whose conversation left during it, and a kept write retried by a checkpoint's hold -
  all go through `writeBatchRows`, which asks the map ONCE, after the merge's await and before every
  insert and `saveConversation`: the compare-and-set onto a row that stands still runs, nothing is
  inserted, the rows are dropped with their frames at WARN, and the write reports success so the
  hold it refused is released rather than retried for ever.

**And a removal is ordered after the writes that already asked (follow-up of #3988).** The map check
in `writeBatchRows` is followed by awaits (the inserts, `saveConversation`), and `purgeConversation`
cleared the STORE first and took the row out of the map last: a write that asked the map before the
removal inserted after the clear, and the rows of a removed conversation came back at the next
restore. Closed by construction, no clock (`conversationRowWrites.ts`): the writer asks the map and
registers its write in ONE synchronous step, releasing it in a `finally`; `purgeConversation` and
`purgeLocalConversationRecord` take the conversation out of the map FIRST, wait for the writes
registered under its key, and only then clear the store. A write that asked before the removal lands
before the clear, which takes it; one that asks after finds no conversation. (The DM merge moves its
loser's rows to the winner's key and re-homes a kept write by `homeOfWrite`; the restore prune and
the landing preview touch only the map.)

**Every row writer keyed by a conversation, and why it cannot land after a purge (review of #3992):**

| Writer | Ordering |
| --- | --- |
| `writeBatchRows` (live batch, stored-preview upgrade, kept write retried by a hold) | asks the map and registers in one step |
| the own-send pair `saveMessageWithOutboxEntry` (`addMessageToChatOnce`) | asks the map and registers in one step; out of the map, refused as a `ConversationGoneError` at WARN - neither row nor entry is written, and both send paths STOP on that type (no `enqueueOutboxMessage`) and tell the member (`chat_send_conversation_gone`, `chat_media_conversation_gone`). Never a `MessagePairWriteError`, whose callers hand the entry to the queue to write its own row |
| the outbox's write-back of a queued text's missing row (`outbox.ts`) | re-asks the map after its store read and registers in one step |
| the outbox's whole-row write of a SENT message whose compare-and-set found no row (`persistSent`, re-keyed mid-send) | an insert: after its awaits it asks the map for the group's conversation and registers in one step; none holds it, the row is not written (one WARN) |
| edits, deletions, pins, reactions, pending-mutation settlement, `updateMessage` (`persistLocalMutation`, `reactionFrame`, `systemMessageHandler`, `pendingMutationStore`, `history`, `outbox` marks) | `mergeMessages` / `updateMessage` are compare-and-set onto a row that STANDS: after the clear there is none, and nothing is inserted |
| `saveConversation` (`useConversations`) | reads the map and writes nothing for a key not in it |
| the push-preview cache (`fcmCache.ts`) | not a stale writer: it writes the conversation's own placeholder row with the preview - an ARRIVAL re-creating a conversation, by design |
| the native outbox mirror adoption (`outboxMirror.ts`) | adopts only for a conversation the STORE holds, read just before; a removal in that gap is not ordered (it is keyed by group id, not the map key) - see the limits below |
| a salon's page (`useConversations` `channel` page write) | salons are removed by the community paths (`useChannelWorkspaces`, `ChatBackgroundService`), not by these two purges - see the limits below |
| the DM merge (`conversations.ts`), the legacy migration (`migration.ts`) | move or seed rows at boot, before any purge can run |

On SQLite (the phone apps) a message row also carries a FOREIGN KEY onto its conversation row, so an
insert after `deleteConversation` fails at the store; IndexedDB has no such key, which is why the
ordering above is what holds there.

**Known limits, stated rather than hidden:**

- **A conversation re-created under the same key during the purge's wait** (a Welcome for the same
  group landing in the milliseconds a write is in flight) has its new writes waited for too, and the
  purge's clear then takes them. Accepted for now because the window is one in-flight write long and
  needs a re-creation of the very conversation being removed; it is not proven harmless. It would be
  closed by giving
  the purge the row OBJECT it removed and, after the wait, clearing only if the map does not hold a
  newer one under the key - which needs the clear to tell old rows from new (a per-conversation epoch
  on the stored row).
- **What a purge leaves in the outbox depends on who removed the conversation.** The member's own
  delete or leave settles the queue BEFORE its server step: `drainOutboxForExit` sends what still can
  go and withdraws the rest, and the owed exit it recorded first makes every later enqueue for the
  group refuse itself and every flush withdraw the group's rows - so an entry the purge's wait let
  land is withdrawn, never sent. The other purges (a deletion by this account on another device, a
  never-admitted ask that ended, a phantom the server confirms absent, the local delete of a
  `deletedRemotely` row) do not touch the outbox; an entry they leave meets the group's own answer:
  its POST refused as deleted (`group-deleted`), or - the tree dropped - the unsendable branch, which
  HOLDS it and asks for a re-add on every flush and every start, for ever. `requestReAdd` does not
  stop for a purged row (its `removed` guard reads the row, and the row is gone), and with the
  account's seat still held its external join would build the thrown-away conversation back. An
  absence from the map is NOT proof of removal and nothing retires on it: a DM re-keyed onto a new
  group by a Welcome (`setupMessageHandler`, `moveDirectConversationRows`) also leaves its old group
  held by no conversation, and its queued entries are not moved with its rows - retiring them would
  lose a live DM's unsent message (review of #3992). Both halves - entries following a re-key, and a
  removal withdrawing its group's entries on its own evidence - are
  [p2-outbox-entries-follow-their-conversation](../../backlog.d/p2-outbox-entries-follow-their-conversation.md).
- **The mirror adoption and a salon's page** are not registered: neither runs through these purges'
  key (group id vs map key; salons have their own removal), and closing them means registering their
  removers too.

The live path's re-entry cannot loop: both branches it lands in return, and nothing is awaited
between the read that sent it back and the re-entry's own.

An own act has the same shape: `handleEditMessage` awaits the control act's enqueue, then re-reads
the conversation and writes under the key the edit STARTED on (never the selection of the moment), as
`tombstoneLocalMessage` does.

**INVARIANT: an add that awaits between reading the conversation and writing it back re-reads it
after its last await, and takes the entry's decisions again if what they read has changed.**
`useMessaging.interleavedAdds.svelte.test.ts` holds the store read of one arrival open while a second
arrival, then an own send, lands: both are kept and counted. `useMessaging.shownDuringRead.svelte.test.ts`
shows a preview of the same id, then removes the conversation, during the store read, on both paths:
one message, counted once, upgraded on screen and on disk (with a pending deletion, edit or reaction),
nothing announced; nothing stored into a removed conversation, a kept write retried after the removal
included, and a purge racing a write held after its map check (out of the map at once, the store
cleared only after the insert, nothing left; the registry itself in `conversationRowWrites.test.ts`).
`useMessaging.editRereads.svelte.test.ts` lands a message and moves the reader
during an edit's send. Each fails on the entry-copy code.

## Outbox (outbound delivery)

`utils/chat/outbox.ts` owns every outbound message. A send is persisted first and transmitted
second, so the queue - not the network call - is what guarantees delivery. The flusher re-encodes
the proto against the *current* epoch at send time (epoch changes are transparent), is idempotent
on the stable `messageId` (a re-send after a crash is deduplicated by the receiver), and never
sends into a group that is not healthy.

**The barrier before every flush is a correctness device, not an optimisation.**
`waitForMessageQueueIdle()` lets the *incoming* queue drain first: `fetchPendingMessages` (on
reconnect or resume) only enqueues the missed frames, and applying them - the commits that advance
the epoch - is asynchronous. A flush triggered by `online` or `visibilitychange` that skips the
barrier can send at a stale epoch, which up-to-date peers cannot decrypt. That is a silent loss:
the sender sees a delivered message and the recipient never receives one.

### Only the leader tab flushes

The queue is shared across tabs - it is in IndexedDB - but **encryption belongs to the leader tab
alone**. `runFlush` returns before anything else when `getIsTabLeader()` is false and posts
`outbox_flush_request` on `canari-tab-messages`; the leader drains on the follower's behalf and
answers `outbox_entry_sent` so the follower can settle the echo it is showing as `pending`. Only the
instruction crosses the channel, never the message, so a lost nudge costs a retry and nothing else.

This is not tidiness. Two tabs hold two MLS clients loaded from one snapshot, so a send from the tab
whose ratchet is behind is encrypted at a generation the peer has consumed and is dropped on arrival
as a duplicate - 4 losses in 9 sends when measured, 9/9 after the fix (WP-MULTITAB-1). The guards are
`outbox.test.ts` and `tabLeadership.test.ts`; nine green sends do not prove a follower stopped
encrypting, so the mechanism is asserted from BOTH tabs' logs - the follower's
`Queued <id>` (with, once per page, `Follower tab - every flush is asked of the leader tab`; until
2026-11-10 a `Flush skipped - follower tab` line on every trigger) and the leader's `Flush requested
by a follower tab` followed by its `<id>… sent`, which is also what proves the shared IndexedDB
queue is the transfer.
The same reasoning is why a follower promoted to leader **reloads** rather than picking up where it
left off: the gate froze its in-memory state at load time while the leader kept advancing the one on
disk.

**BUT A FOLLOWER IS THE AUTHORITY ON ONE THING, AND SAYING NOTHING ABOUT IT COST A RENDER
(TAB-4b, measured 2026-09-05; fixed 2026-09-24).** With two tabs of one account open, a message sent
from the SECOND tab rendered there and reached the peer, and did NOT appear in the first -
`tab1: 0` against `tab2: 1, peer: 1`. The reverse direction worked (TAB-4c) and an inbound message
reached both (TAB-4a), which is exactly the asymmetry to expect: **`canari-tab-messages` carried
conversation updates in one direction only.**

It was never loss. The outbox row is in IndexedDB, which both tabs share, so reloading the leader
showed the message - the leader's IN-MEMORY list was simply never told. The three outbox events on
that channel could not close it either: `outbox_entry_sent` is a STATUS echo, and settling a row
needs `findMessage` to succeed, so it repairs only a row the receiver already shows.

| | who may publish | why |
| --- | --- | --- |
| `message_added`, `messages_batch` | the **leader** only | it alone receives inbound frames, and it alone can speak for `unreadCount` |
| `own_message_composed` | a **follower** only | whichever tab composed the message is the only one that knows; the leader's own copy already travels as `message_added` from the same call site |
| `conversation_read` | **either role** | reading happens in whichever tab is showing the conversation - see below |
| `read_state`, `unread_counts` | the **leader** only | one moved read mark, or salon counts with the leader's own mark, that it RECEIVED (socket, server answer), which no follower can - [the census](#read-state-between-devices---the-census-2026-11-02) |

The new event carries **no `unreadCount`**, and the receiver leaves that field alone: a follower
cannot speak for what the leader has read, and has nothing to say about it either, since an own
message is never unread. The receiver takes it **before it reads its own role** - every other event
on the channel must be ignored by a leader, and this one is the single exception - and deduplicates
on the message id, which is what makes it safe to accept from anywhere: the row is already in the
shared queue, so whichever copy arrives first is the same row. `publishOutboxEntryCancelled` was
already ungated for the same shape of reason, a cancellation originating wherever the user pressed
delete.

**TAB-4b does not assert this**, so the row passed throughout - it expects the sending tab and the
peer. The guard is `tabMessageSync.test.ts`, where the two publishers are pinned as exact mirrors:
asserting only the new half would pass just as well if the old one had quietly inverted.

**READING WAS THE SAME GAP, THE OTHER DIRECTION (reported 2026-09-28, fixed the same day).** The
paragraph above already says a follower "has nothing to say about" `unreadCount` - true for a
message it composes, but a read is a fact of its own: the user marks a conversation read in
whichever tab has it open, either role, and until this fix that only zeroed `unreadCount` in the
tab's own memory. A second tab of the same account - or the same conversation read from a phone,
via the badge shown there - kept counting the conversation unread until that tab happened to select
it itself. `conversation_read` closes it: **ungated, like `publishOutboxEntryCancelled`**, since
reading, like a cancellation, originates wherever the user acted. It carries `readAt`, the
conversation's `lastMessageAt` at the moment it was cleared, and a receiver only zeroes its own
`unreadCount` when its own `lastMessageAt` is no newer - a message arriving in the gap between the
read and the broadcast keeps its unread state rather than being swallowed by a stale watermark.

**A related, separate gap in the same report: a system notice merged from the FCM cache counted as
unread even when the current user's own action produced it** (e.g. the `memberAdded` notice an
invite writes). `mergeFcmMessagesIntoConversations` (`fcmMemoryMerge.ts`) gated unread on `isOwn`
alone; a system notice's `senderId` is always `'system'`, never the actor's own id, so `isOwn` is
false for it regardless of who caused it. The canonical gate, `isUnreadForUser` (`readState.ts`),
already excludes `isSystem` for this reason - the live socket path already used it and was never
affected. The FCM merge path now mirrors that exclusion.

**The election is awaited once, however many flushes are waiting on it.** Leadership has three
states, and `runFlush` awaits the decision when it reads `undecided` rather than treating it as
"another tab will do it" (WP-OUTBOX-2). Boot, though, asks for a flush per recovering conversation,
per enqueue and per wake-up: on a device coming up with twenty-two conversations, twenty of those
requests landed in the election gap and each awaited it on its own, logging its own resolution -
twenty `Leadership decided as leader after N ms` lines inside one second, differing by their start
offset so nothing deduplicated them (measured on HEAL-REVOKE-5, 2026-08-29). `flushing`/`rerun`
coalesces the WORK, but it sits after this gate and so could never reach the WAITING. The waiters
now share one promise, `theElection`, created by whichever flush arrives first: one election, one
deferral line, one decision line. It is never reset because the election does not reopen - once
decided, the `undecided` guard returns before the promise is read at all. Nothing about correctness
changed here; every waiter always resumed. What twenty lines cost is the reader.

### The lead goes to a tab that can serve: a hidden leader hands it over (2026-11-10)

**The report (owner, Firefox 159 on Windows, web 1.6.9, 2026-11-10):** a photo sent from one tab
stayed a blurred ThumbHash with the image icon and one check mark, in every tab and across reloads.
It went out the instant the owner brought the main (leader) tab, hidden for hours, back to the front.
**The owner's log export:**
- The visible tab was a follower after each of four reloads (`[TAB] Another tab is active - read-only
  mode (Web Locks)`).
- The photo was `Queued 7b577fbb… (media)`, and the follower asked the leader about twenty times.
- The export holds no `Flush requested by a follower tab` after 18:04.
- The leader's last exported line is `[QUEUE] Processing message` at 19:43:58, in a hidden tab that
  was still receiving socket frames and raising notifications.

**That silence is NOT proof that the leader ignored the asks.** The in-app log is written to
IndexedDB in batches (`appLog.ts`): every 200 lines or 32 KB, when the page leaves the screen, and
before an export. Only the EXPORTING tab flushes before the export. Another tab's last batch, up to
199 lines, is still in that tab's memory and is not in the file. What is certain: the leader, hidden,
did not finish the send, and finished it at once when shown. Its own `onVisible` runs a flush. The
exact await it was held on while hidden is not in the export. Owed: the leader tab's own export,
taken from that tab.

**Three defects, each needed for that picture:**

1. **The lead stayed with a tab that could not serve.** A hidden tab is a weaker runner in every
   engine. Chromium FREEZES some background tabs: they run no task until thawed, BroadcastChannel
   messages included, while the Web Lock stays held. The Chrome docs say "release any held Web
   Locks" at `freeze`
   ([Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
   [freezing on Energy Saver](https://developer.chrome.com/blog/freezing-on-energy-saver)). **Firefox
   and Safari implement no Page Lifecycle events** (`freeze`, `resume`), so on the owner's Firefox
   nothing told the leader to let go. A Firefox tab that unloads under memory pressure is gone,
   and so is its lock. A throttled one still runs events, as the owner's leader showed by processing
   socket frames while hidden. **Now, two paths, both from facts and never from a clock**
   (`tabLeader.ts`):
   - **The hand-over (every engine).** A VISIBLE follower whose shared queue holds an entry that is
     due posts `leader_handover_request` on `canari-mls-tab` with every flush it hands over
     (`requestLeaderHandover`, from `runFlush`'s follower branch). It says so once per visible
     stretch. **Never while it is offline** (`connectivity.isOffline`, review of #3321): the entry
     then waits on the link, not on the leader, and the two reloads a hand-over costs would find no
     network to load the app from.
   - A leader that is itself HIDDEN answers. It first decides `follower`, then posts
     `leader_handover_granted` naming the asker, then hands over: its socket is paused (handlers
     detached, so the old copy reads and acknowledges nothing) and its reload is scheduled. **Never
     while a lead hold is in flight** (fourth review of #4053, M1): deciding `follower` makes the
     latch refuse the checkpoint an external join or a group's first publish owes. The ask then
     waits for the holds to settle (`onLeadHoldsReleased`) and is answered if the tab still leads
     and is still hidden.
   - A VISIBLE leader ignores the ask: it is serving.
   - The asker, and only it, then STEALS the lock (`steal: true`). Releasing the lock into the queue
     would grant it to whichever tab queued first, possibly another background one. It steals only
     while holding the serving lock (`canari-tab-serving`, `ifAvailable`, below): no tab serves
     while the steal runs, so it can never take the lock from a leader loaded as such. The asker's
     promotion reloads it onto the state the old leader left, and that reload waits for the lead.
   - **The freeze (Chromium).** At `freeze`, or at `pagehide` into the back/forward cache, a leader
     decides `follower` and releases the lock to the queue. A frozen leader cannot answer an ask,
     and this hook needs none.
   - A frozen follower withdraws its queued request and queues again at `resume`, because a lock
     granted to a frozen page would be held by a document that cannot run the promotion.
2. **A stored page erased the queued row's `pending`.** `mergeMessagePage`'s `reconcile` took the
   stored row verbatim, and no stored row has a `status`, because status is derived in memory. So
   the login's `pending` on the queued photo was lost when the conversation's stored page was drawn
   (`[HISTORY] ... stored page drawn`, 20:04:20). With no `mediaId`, no status and its entry in the
   queue, the bubble fell through to the bare image placeholder: a picture "loading" over a file
   nobody had sent. **Now:**
   - `reconcile` keeps the status that memory holds.
   - `MessageBubble` decides an own attachment with an empty `mediaId` from the DURABLE queue too.
     If the entry is present, the bubble shows the queued upload view with its label and its cancel.
     If it is absent, the bubble shows the orphan or its stored reason, as before.
3. **The follower's line repeated on every trigger.** `Flush skipped - follower tab` appeared twenty
   times in three minutes, hiding the one fact that mattered (nothing was sent). The role changes
   only through a reload, so the follower now says `Follower tab - every flush is asked of the leader
   tab` once per controller. Each entry keeps its own `Queued` line.

**The single writer holds across a hand-over.** Every path decides `follower` synchronously, before
the lock moves. A send that began while the document led and resumes after it stopped leading is
refused at its last synchronous step before the ratchet moves:
- `BaseMlsService.sealPastOwedBurns` reads `refusesCommitsHere()` right before `encryptForSend`
  (`FollowerTabSendError` with refusal `lead-lost`, an expected refusal logged at warn, nothing
  sealed);
- the outbox checks `refusesCommitsHere()` at its last look before the send and leaves the entry
  queued for the leader (`skip`, no attempt counted).

A commit is refused at its entry (`FollowerTabCommitError`); one already past it when the lead
leaves is held by its stage checkpoint, which every commit awaits before its first request: refused
at the put (below), the stage is cleared and nothing is sent; landed before the lead left, the stage
is on disk and the new leader's settle resubmits it, as after a kill. The new leader reloads before
it serves, so it reads the state the old leader left - and **a checkpoint the old leader was sealing
when the lead left stores nothing**: the write latch reads `refusesCommitsHere()` again at the put,
inside the IndexedDB transaction (`MlsStateWriteLatch.holdsNoLead`, outcome `follower-tab`). Without
it, a put landing after the new leader's load would leave the disk ahead of the leader's memory -
the fork the single writer exists to prevent. What that write held is what any kill loses, recovered
by the send ledger's burn and the inbound replay.

**Why this is one writer and not a race that heals (re-read with #3371, 2026-11-14).** A put lands
only if its verdict, inside its IndexedDB transaction, reads the document as owning the state. The
old leader decides `follower` before it lets go or grants, so every verdict it runs after that
refuses, and every put it landed before belongs to a transaction created before the grant - which
IndexedDB finishes before the new leader's later read of the same store starts. The new leader
writes nothing until its reload reads the disk (`promotedSinceLoad`). So the two documents' writes
never interleave: nothing reconciles them afterwards, the overlap does not exist. The old leader
also keeps RUNNING after a hand-over (unlike an unload), and its tails had to be closed:
- **an ack never runs ahead of the disk where the disk is the only copy** (`DrainAckHold`,
  review of #3321). An ack deletes the row from the server, and a drain used to acknowledge a COMMIT
  or a WELCOME at its end while the checkpoint holding it was still sealing: a kill there - and, with
  the hand-over and the freeze, a ROUTINE lead change, whose old leader's checkpoint is refused at the
  put - reloaded a state behind a commit the server no longer had. Now every drained id carries the
  count of frames applied when it was (`inboundApplied`); a checkpoint claims the count read before
  it EXPORTS and raises `durableApplied` once it lands. A commit or Welcome is acknowledged only once
  a landed checkpoint holds it - the drain's own, which `endBulkIngest` started; the ack chain waits
  for it, the drain never does. An application frame needs no checkpoint (the history archive is its
  second copy, read by the replay), but it is acknowledged only once the drain's window closed and
  its row is STORED ([rows before ratchet, the ack](#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19))
  - and held like a commit when this document no longer owns the state by then. A held id whose checkpoint is refused or fails
  stays on the server (`[ACK] N id(s) not acknowledged: no landed checkpoint holds what they
  changed`) and the tab that writes the state reads it; an id a LANDED checkpoint holds is
  acknowledged whatever the lead, so the new leader never meets a frame its disk has spent
  (`SecretReuseError`, a false `LOST frame` and a history-diff repair). This is why neither the
  hand-over nor the freeze waits for a checkpoint before the lead moves: nothing the old leader did
  is lost, only what it did not make durable is done again by the new one. The cost: a pull issued
  behind a drain that applied a commit waits for that drain's checkpoint (`ackInFlight`). A withheld
  id is remembered on its delivery (`heldForDisk`): the next pull lists the row again, and the
  re-ack of that repeat waits for a checkpoint covering it too (`reAckHold`, second review) - it
  used to delete the row at once, reopening the window the hold had just refused;
- **the old leader reloads only once its ingest windows have closed** (`whenBulkIngestsClosed`,
  second review): a drain stores its rows when its window closes, while a checkpoint that landed
  before the lead left may already hold those frames' ratchet advance and seen marks. A reload in
  between - 50 ms after the demotion, now routine - lost the message for good: the new leader can
  neither decrypt it again nor replay it. It waits for the windows open AT the demotion only (third
  review): a drain restarting behind each close would otherwise hold it for good. What remains is a
  window that never closes - a hung handler or observer, which `guarded` reports every minute - and
  then this document, out of the election (`leaving`), stays a stale copy until it is reloaded by
  hand. The loss itself is closed by an order, not by this wait: [rows before ratchet](#rows-before-ratchet-a-checkpoint-stores-the-buffered-rows-first-2026-11-17);
- **a lead handed over and not yet taken is released at `freeze`**: the old leader is a follower
  from the grant, but holds the lock until the asker steals it, and an asker that closed in between
  never will. Frozen with that hold, it left every tab a follower until it was thawed;
- **a promotion request granted and then withdrawn by a freeze does not lead**: the abort lands
  after the browser granted it, so it is ignored; the callback reads its own aborted signal, lets the
  lock go, and the page queues again at `resume`.

**The cost, accepted:** the asking tab reloads once it is promoted, as every promotion does. A tab
switch reloads nothing unless the queue holds a due entry and the leader is hidden.

**What the log shows now:**
- in the hidden leader: `[TAB] Hidden leader asked for the lead by a visible tab (<id>) - handing it
  over.`, then `Leadership released - reloading as follower`;
- in the asker: `[TAB] Visible follower with a message waiting on the leader - ...`, then `[TAB] Lead
  handed over by the hidden leader tab - promoted (Web Locks).`, its reload, and the entry's `sent`;
- on Chromium after a freeze: `[TAB] Page suspended by the browser (freeze) while leading ...`.

**Still not covered:**
- a leader whose main thread is wedged, which runs no handler and answers nothing;
- a leader in an engine that suspends it without dispatching `freeze`, which also cannot answer;
- **the send ledger across the move**: a frame the old leader encrypted and sent after its last
  landed checkpoint is repaired by the new leader's burn of the ledger, a `localStorage` entry written
  before the frame left. `localStorage` is not ordered with `BroadcastChannel` or a Web Lock across
  processes, so that the new leader's reload reads the entry is not PROVED - it reads it after a
  steal, a reload and a login, the same exposure an unload release always had. A checkpoint before
  the grant would narrow it but not close it (a send between that export and the decision);
- **the steal does not know whom it takes the lock from**: if the old leader released a hand-over
  at a freeze before the asker stole it, the lock may already be another queued tab's, which the
  steal then demotes (one extra reload). Since 2026-11-24 that tab is never one that SERVES: the
  steal runs under the serving lock ([below](#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)).

No clock is added for either: a timeout would be a guess about a live document.

**Seen in the same log, fixed separately:** a follower tab wrote MLS checkpoints, and the version
guard refused the leader's (`MLS state write REFUSED as stale`) - closed by #3371, see
[mls-protocol](../../protocols/mls-protocol.md#a-follower-tab-wrote-its-copy-of-the-mls-state-over-the-leaders---fixed-2026-11-11).

**Pinned by:**
- `tabLeader.freeze.test.ts`. Two documents (two instances of the module) share one lock manager
  with its queue, its abort, its steal and its release, and talk over the real channel. The cases:
  - the hidden leader hands the lead to the ASKER, not to the tab first in the queue, and is a
    follower first;
  - a visible leader keeps the lead;
  - a hidden follower does not ask;
  - the ask is said once and answered once the leader is hidden;
  - a frozen leader releases the lock and the waiting tab is promoted;
  - the resumed former leader does not take the lead back;
  - a frozen follower withdraws its request and queues again at `resume`;
  - `pagehide` into the back/forward cache releases the lock, a plain one does not;
  - with each document's own `stateAuthority` (#3371): at every grant after the first, NO document
    may write - the old leader's latch is shut before the new holder starts, and the promoted asker
    writes nothing before its reload;
  - a lead handed to an asker that never takes it is released at `freeze`, and a stolen hold is
    forgotten.
- `BaseMlsService.leadLostAck.test.ts`: a commit is acknowledged only after the drain's checkpoint
  lands, and stays on the server when it is refused; the message beside it is never withheld (it
  rides the same request, so it waits for that checkpoint without depending on it); once the
  lead left, an uncovered message is withheld and a covered one acknowledged; a checkpoint claims
  what it held at its export; the drain wires it through the persister; the repeat of a withheld
  commit is re-acknowledged only behind a checkpoint covering it; and `whenBulkIngestsClosed`
  settles only once the last window's observers have returned, and is not held by a window opened
  after it asked.
- the send seam (`BaseMlsService.sendSeam.test.ts`): a lead that leaves mid-send seals nothing.
- `outbox.test.ts`: the line is said once, a lead lost during the gates leaves the entry queued, and
  an offline follower does not ask for the lead.
- `messageMerge.mergePage.test.ts`: the status is kept.
- `MessageBubble.orphan.svelte.test.ts`: a queued photo with no status says it is queued.

**Owed:** two-tab readings on dev in Firefox (hide the leader, send a photo from the other tab, and
see it promoted and the photo sent) and in Chrome (freeze the leader from `chrome://discards`).

### A leader whose own session ended gives the lead up (2026-11-24)

**The report (owner, screenshot, web, desktop browser, 2026-11-24):** in a second tab, "Nouvelle
discussion" with a recipient selected answered *"L'onglet principal de Canari n'est pas prêt
(verrouillé ou déconnecté) : déverrouillez-le, ou faites-le depuis cet onglet."*. The owner added
that tabs behave oddly in general, especially when some of them go to sleep.

**The case it hit.** That sentence is the follower's rendering of `leader-unavailable`, which a
leader answers when its readiness is `unavailable`: no live session and no login running. Such a
leader still held `canari-tab-leader`. The election takes the lock in a login and held it until the
document unloaded, whatever became of the session afterwards. A session ends in place, with no
unload, in three ordinary ways:
- a failed login puts the PIN keypad back up after the election;
- a sign-out;
- an expired session: a tab asleep for hours wakes, its reconnect is answered
  `SessionExpiredError`, and `gotoLoginAfterExpiry` is a client-side navigation.

From then on that tab served nothing and kept the lead, and no other tab could take it. Every
gesture a follower handed over was refused, for as long as that tab stayed open. The same fact had
a mirror: a follower whose own login failed stayed in the lock's queue, so when the leader closed,
the lock could go to a tab at the keypad, and stay there.

**The fix: the lead belongs to a tab whose session can serve it** (`setTabLeadEligibility`,
`tabLeader.ts`). Eligibility is computed from the session's two flags by their one writer
(`publishDelegationReadiness` in `useChatSession`), the same readiness that already told a
follower's request how it would be answered. Nothing is decided from a reply that does not come,
and no clock is used:
- **eligibility falls** (`unavailable`): a leader decides `follower` first, then releases the lock
  into the queue. The browser grants it at once to the next tab that asked, and only a tab whose
  session can serve is ever in that queue. A follower withdraws its queued request. A hold handed
  over and not yet stolen is released too. From then on the document holds no lock and no request.
  Its demotion handler is told `session-cannot-serve` and does NOT reload: there is no live session
  to tear down, and a reload would throw the member out of the keypad or a recovery screen.
- **eligibility returns** (a login starts, `starting`): the document runs the election again, and
  the login awaits it as its own (`initTabLeadershipAsync` reads the memo). Running it twice is safe
  here and only here, because the document holds nothing and so cannot be its own rival
  ([the 2026-09-21 rule](../../durable-rules.md#mls-state-and-keys---mls-protocol-auth)).
  It leads if the lock is free and follows otherwise. A promotion that lands after its state was
  loaded as a follower is `promotedSinceLoad`, which reloads as before.
- **the lead first, then the answer**: eligibility is published BEFORE the delegation readiness, so
  the drain that the readiness change starts runs in a document that no longer leads. That drain
  answers nothing (`answersFollowerCommits` is false). A record it was deciding is left `pending`.
  A record it had already claimed is handed back to `pending` under its run lock, since nothing ran.
  The tab that took the lead runs it, instead of the follower being told `leader-unavailable`.
- **the lead stays while MLS work that needs it is in flight** (`leadHolds.ts`, reviews of #4053).
  The write latch refuses a put from a document that no longer leads, so giving the lead up at the
  instant the flag fell refused the very writes the session still owed. Such work is COUNTED while
  it runs, at the places where the state changes, so no path can be forgotten:
  - **the MLS mutex holds the lead from its grant to its release**
    (`MlsPerGroupScheduler.grantMain`): every frame, Welcome, commit, catch-up, rejoin and settlement
    runs under it, with the checkpoints they await inside. Taken at the GRANT, never at the request,
    so a commit queued behind a busy drain holds nothing; handed from one holder to the next without
    the count touching zero;
  - **an external join holds it from its build until its structural checkpoint settled**: between
    its two lock sections the commit is on the wire with no lock held. Without it, a session that
    expired during a wake-up rejoin gave the lead up, the server took the commit, the checkpoint was
    refused, and the next leader joined again from the new base - a fork;
  - **a key-package mint, and the identity rotation a revocation starts in it**;
  - **a distribution group this device creates, from its creation until a checkpoint covers its
    published base** (`ensureDistributionGroup`): the base is published outside the MLS mutex, so a
    session ending between the publish and a checkpoint left a base on the server whose creator's
    keys were in memory only;
  - **a checkpoint, from its export until its put settled** - not across the row waits before the
    export, which end when the row writes they wait for settle; a checkpoint that must not be
    refused (a commit's, a join's) runs inside one of the holds above, which covers them. A
    structural checkpoint asked by the drain (`persistNow`) takes no hold of its own: what asks for
    it is inbound, acknowledged only once a checkpoint lands, so a refused one is redelivered;
  - **the final checkpoint of an ended session** (`endSessionStatePersister`).

  The session's eligibility (`createLeadPublisher`, `leadPublisher.ts`) stays `true` while the count
  is above zero and is published again when it returns to zero; a session that ends with holds in
  flight says so ONCE, at warn, naming them. Each hold settles on success AND on failure (a
  `finally`), never by a clock. What a hold can wait on ends by itself: a request in an answer or a
  transport failure, an IndexedDB put in success or error, the encrypt worker's round trip in a reply,
  an `error`, a `messageerror`, or its termination - a job still QUEUED behind it when the worker is
  disposed is rejected too, never run on a worker made after. A wait OUTSIDE the MLS state - a
  delegated salon seal waiting on the salon's send gate - holds nothing: the delegated executor takes
  no hold of its own, and an expired session refuses those waits at once (`resetSalonSendGate`), as a
  sign-out does.
- **an ended session's persister ends first** (`endSessionStatePersister`,
  `sessionStatePersisterEnd.ts`), before the session flag falls, on BOTH paths that end a session in
  place: a sign-out (`tearDownLiveSession`), and an expired session (`attemptReconnectImpl`, which
  used to leave the persister installed and the client in the holder). Its final checkpoint is a
  hold; the persister is unregistered once that write settles, so it schedules no further
  checkpoint of the ended client. What fences a write ALREADY under way is not the registry but the
  write latch (read at the put) and the state's version guard. The sign-out that follows the expiry
  finds no live session and retires the client behind the LAST ended session's write
  (`whenEndedSessionStateWritten`) - not a chain of every one, so one put that never settles cannot
  stall every later sign-out.
- **a follower's request waits through all this**: while the leader's readiness is `unavailable`, a
  request is left `pending`, because that leader gives the lead up as soon as its holds settle and
  the next leader runs it. A claim made before the session ended is handed back. Both are narrated,
  not warned: this is the designed hand-back.
- **the asker may be the tab the lead goes to.** A promotion reloads that tab, and the reload frees
  the requester lock of every request it made as a follower, so the new leader used to delete them
  as "the tab that asked is gone". The tab now carries its requester identity across that one reload
  (`carryTabCommitRequesterAcrossReload`, `sessionStorage`), read and removed synchronously when the
  module loads, and honoured only by a page whose navigation IS a reload - a tab duplicated in that
  window copies the key, but its first page is a navigation, so it never adopts. The new page
  ADOPTS its own earlier requests (`onAdoption`):
  - run: a conversation created, a member invited or removed, a key group entered, and a frame the
    member sent - a forward, a channel invitation, a notice, an edit or a reaction. None of those
    callers keeps a durable queue, so dropping the frame lost the gesture (charter principle 2). It
    is sent; what the asking page would have done with the answer (a forward's own echo, the time
    the server took it) died with that page, and that is said at warn;
  - a salon message's seal, decided by its CALLER, not by its kind (third review of #4053): only the
    salon text queue (`messaging.ts`) sends a seal again after a reload, under the same client id,
    and it says so (`resentByQueue`), so its seal is dropped. Every other caller - an edit, a
    reaction, a poll, a media forward, a member-added notice - has no queue: its seal carries what
    it is posted with (`postIfAdopted`, a `SalonPost`), and the adopting leader seals AND posts it
    (`postSealedChannelMessage`, `channelPost.ts`, the one place a salon row is built);
  - not run: a call's transport frame (the call ended with the page that held it).
- **a promotion reload leaves NOTHING behind that a live tab waits on** (third review of #4053). In
  the gap between a promoted tab's two pages, no page of that tab exists: it holds no lock, answers
  nothing, and is indistinguishable from a tab CLOSED during its reload. An earlier fix marked the
  reload durably (`localStorage`) and made a live tab granted the lock in the gap pass it on: a tab
  closed mid-reload left that mark behind, and a later tab granted the lock read it and handed the
  lock to nobody - every tab without a leader (charter principle 2). Nothing marks it any more.
- **no loaded leader is ever stolen from: a promotion reload WAITS for the lead** (fourth review of
  #4053, M1). The reloaded page used to reclaim the lock with a steal. Two tabs promoted in place
  reload one after the other, so the second page's steal took the lock from the first, already
  loaded as the leader and possibly mid-way through an external join or a group's first publish -
  whose checkpoint the latch then refused: a fork or a ghost leaf. A plain queue is not enough
  either: the tab granted in the gap was promoted IN PLACE, on a copy loaded as a follower, so it
  reloads too, and two reloaded pages queued after their loads would trade the lock forever. What
  separates the two kinds of leader is a fact the leader lock cannot carry, so a second lock
  carries it:
  - **`canari-tab-serving`** is held by a document exactly while it leads on a copy it loads, or
    loaded, as the leader: taken BEFORE the lead is decided by an election grant whose login loads
    after it (the first election, a waiting reloaded page) or when a later login is handed the lead
    (`serveIfLeading`), announced (`leader_serving`), and dropped by `decide('follower')` before the
    leader lock moves on every path. A tab promoted in place never takes it;
  - **the reloaded page reads it** (`navigator.locks.query()`, after its channel listens). A tab
    serves: this page follows it, with an ordinary queued request. None serves: it queues and its
    login WAITS (`waitForTheLead`) - granted, it leads and loads as the leader; a tab that starts
    serving first (`leader_serving`) ends the wait, and the page follows with its request kept.
    A `leader_serving` heard WHILE the query is still unanswered (the browser answers it on a later
    task) counts as a tab serving: the page remembers it (`servingHeard`) and follows, rather than
    queue behind that tab with its login waiting for good (fifth review, B1);
    Both ends are facts, never a clock: each tab promoted in place reloads once, in queue order,
    and the first reloaded page granted serves and ends every other wait;
  - **a login whose session comes back in a gap** (a quick PIN retry) runs its election as any
    other: nothing steals the lock any more, so if it wins, it serves and the reloaded page follows
    it. The in-memory deferral of the third review, and `noteTabSessionLive`, are gone with the
    steal they guarded against;
  - **the one steal left is the hand-over's**, taken under the serving lock (`ifAvailable`): an
    election grant takes that lock before deciding to lead, so while the asker holds it no tab
    serves, and a lock that moved to a serving page before the steal is not taken - the asker says
    so and stays a follower. A FREEZE releases rather than steals, but **work in flight is still
    LOST on a freeze**: the release decides `follower` whatever the lead holds, and a page about
    to freeze runs nothing more, so an external join or a first publish in flight there has its
    checkpoint refused. Only the hand-over waits for the holds; the freeze cannot
    ([above](#the-lead-goes-to-a-tab-that-can-serve-a-hidden-leader-hands-it-over-2026-11-10)).
- the grant callbacks (a queued promotion, the hand-over's steal, the first election) read
  eligibility too. A lock granted to a document whose withdrawal raced the grant is passed on
  rather than held, and a follower that cannot serve asks no hidden leader for the lead.

**What the member sees now:** the gesture works from the tab they are in.

**The promotion reload is visible, and it is deliberate.** When the lead goes to the tab the member
is using, that tab RELOADS (`reloadForPromotion`), as every promotion does
([why](#the-lead-goes-to-a-tab-that-can-serve-a-hidden-leader-hands-it-over-2026-11-10)): it loaded
its MLS state as a follower, and the old leader has advanced that state since. The member sees the
page blink and come back on the same route, typically right after they unlocked, signed out, or let
a session expire in ANOTHER tab. A gesture the tab had handed to the old leader is adopted and run
by the reloaded page (above). The reload goes away only with the browser-wide worker of `1.9.0`,
where one worker holds the state and no tab needs to reload to lead
([design](../../backlog.d/a-browser-wide-worker-holds-the-mls-state-instead-of-a-leader-tab.md)).
`leader-unavailable` remains in the four branches listed
[above](#a-follower-tabs-commits-are-run-by-the-leader-2026-11-08) (an asker signed out, an asking
session ended, and two account mismatches); an engine without Web Locks hands nothing over in the
first place (`not-delegable`).

**The log:**
- the old leader: `[TAB] This tab's session cannot serve (session unavailable) while leading - the
  lock is released so a tab that can serve takes the lead.`;
- the tab that serves: `[TAB] Promoted to leader (Web Locks).` and its reload;
- the old leader at its next login: `[TAB] This tab's session can serve again (session starting) -
  it rejoins the election.`;
- a page reloaded after its promotion: `waiting in the queue for the lead, which no tab serves` then
  `Leadership acquired after the promotion reload`, or `another tab serves the lead - this page
  follows it`, or `Stops waiting for the lead (another tab serves the lead)`;
- a hidden leader asked during MLS work: `... while MLS work needs it - answered once that work
  settles.`;
- a session ending with work in flight: `session unavailable, N MLS operation(s) still in flight`,
  then the release when the last one settles;
- the new leader adopting its own earlier request: `asked by this tab before its promotion reload -
  adopted and run here`.

**Still not covered, unchanged:**
- a leader whose main thread is wedged;
- an engine that suspends a page without dispatching `freeze`
  ([above](#the-lead-goes-to-a-tab-that-can-serve-a-hidden-leader-hands-it-over-2026-11-10));
- MLS work in flight in a leader that FREEZES: the release decides `follower` whatever its lead
  holds, so that work's checkpoint is refused.

A tab asleep in Firefox or Safari keeps the lead while it lives and is answered for by the
hand-over. The owner's decision of the same day is to replace the leader tab with one browser-wide
worker in `1.9.0` ([design](../../backlog.d/a-browser-wide-worker-holds-the-mls-state-instead-of-a-leader-tab.md)).

**Pinned by:**
- `tabLeader.cannotServe.test.ts`, two documents sharing one lock manager
  (`tabLeaderDocuments.test-helper.ts`, now shared with `tabLeader.freeze.test.ts`):
  - a leader whose session ends releases the lock, and the ready follower is promoted;
  - the old leader is a follower first, refuses commits, and is not queued;
  - it rejoins at its next login as a follower, and is promoted when that leader's session ends;
  - a locked follower withdraws, so a closing leader never hands the lock to it;
  - a lone tab leaves the lock free and takes it back without queueing behind itself;
  - repeating a state is a no-op;
  - a follower that cannot serve asks for no hand-over;
  - the channel there delivers on a later task, as the real one does (`FakeBroadcastChannel`).
- `tabLeader.reclaim.test.ts`: two tabs promoted in place reload in turn - the first reloaded page
  granted leads and serves, the second follows it, nothing is stolen; a waiting page stops waiting
  when another waiting page is granted and serves; a lone reloaded page takes the free lock; a hidden
  leader asked for the lead while a lead hold is held answers only once it settles; a reloaded page
  whose query answers after another tab was heard serving follows that tab (the fake lock manager
  answers `query()` on a later task, as the browser does); the serving tab DIES (the fake's `kill`:
  everything it held released, everything it queued dropped, none of its code run) and a waiting
  page is granted, serves, and ends the other waits.
- `mlsPerGroupScheduler.leadHold.test.ts`: the mutex holds the lead from grant to release, a waiter
  holds nothing, the hand-over never touches zero, a throw releases.
- `BaseMlsService.externalJoin.test.ts`: the lead is held while the join's commit is on the wire and
  until its checkpoint settled.
- `tabCommitDelegation.test.ts`: a leader that gives the lead up between the claim and the run
  hands the record back, and the next leader runs it; an `unavailable` leader leaves the request
  `pending` for the next one; a promoted asker adopts and runs its own gesture and its visible or
  mutation frame (said at warn), drops a call's frame, runs as adopted a salon seal that carries its
  post and drops one a queue re-sends, and still removes another tab's orphan.
  A delegated salon seal parked on its send gate holds no lead.
  `tabCommitDelegation.carry.test.ts`: the carried id is adopted on a reload only.
- `channelSeal.followerTab.test.ts`: an adopted seal that carries its post is sealed AND posted with
  it, and nothing is posted when the lead left during the seal. `channelCrypto.test.ts`: every caller
  carries its post into the seal except one that says a queue re-sends it;
  `messagingChannelRefusal.test.ts`: the salon text queue says so.
- `BaseMlsService.distributionGroup.test.ts`: a created distribution group holds the lead through
  its publish and until its checkpoint.
- `BaseMlsService.rowsBeforeRatchet.test.ts`: a checkpoint holds the lead from its export to its
  put, and none while it waits on the row writes before it.
- `leadPublisher.test.ts`: eligibility before readiness; the lead kept while a hold is in flight and
  given up when it settles, on success or failure, after the last of several holds; one warn naming
  the holds of an ended session.
- `sessionStatePersisterEnd.test.ts`: the final checkpoint holds the lead, the persister is removed
  once it settles (also on failure), the worker is kept for a newer session's persister, and a hung
  older put never stalls a later sign-out.
- `sessionConnection.test.ts`: an expired session ends its persister and refuses the salon sends
  waiting on its gate before its flag falls.
- `mlsEncryptWorkerSession.test.ts`: the round trip rejects on termination, `error` and
  `messageerror`, and a job queued behind it is rejected on termination too.
- `tabLeadership.test.ts`: no reload on `session-cannot-serve`.

**Owed:** a two-tab reading on dev with the web rig. Lock the leader tab (the keypad), or let its
session expire, then start a conversation from the other tab.

### A follower tab's commits are run by the leader (2026-11-08)

**Decided by the owner on 2026-11-08: the permanent "Messagerie chiffrée active dans un autre
onglet." banner is gone, and every gesture a follower tab refused is possible from it.** A follower
still never commits - its MLS state is a copy loaded once ([mls-protocol](../../protocols/mls-protocol.md#a-follower-tab-hands-its-commits-to-the-leader-2026-11-08))
and `FollowerTabCommitError` stays at the service as the guard - but it no longer stops there: it
HANDS THE GESTURE to the leader, exactly as it hands its sends (above). `tabCommitDelegation.ts`.

**The follower's connection pill (`tabLeaderLink.svelte.ts`, fixed 2026-11-10).** A follower holds no
socket, so its pill reads the leader's, which the leader publishes on the tab-messages channel. Every
event is stamped with the account and a receiver drops another account's. The follower's query used to
go out once at module start with `currentUserId() ?? ''`, before the user id was known: the leader dropped
it as another account's and the second tab read "Hors-ligne" while the account was online. Now nothing is
sent before the account is known, and `announce()` runs when the account becomes known AND when the
election is decided, in either order: a follower asks, a leader republishes its socket (so a follower whose
query the leader could not answer still hears it). A promotion reloads the page, which runs it again.
Pinned in `tabLeaderLink.svelte.test.ts` by the boot order (no account, then the account).

| Gesture in a follower tab | Handed over as | Run by the leader as |
| --- | --- | --- |
| create a group | `create-group` | `createNewGroup`, saved to the store before answering |
| start a direct conversation | `start-direct` | `startNewConversation` (silent), saved before answering |
| invite into a group | `invite` | `inviteMembersToGroup` - the follower reports the `BulkAdditionOutcome` as its own |
| remove a member | `remove` | `removeMemberAndBroadcast`, its thrown type turned into data (`recorded-not-committed`, `not-removed`) |
| create a community, join a salon | `enter-community-key-group` | `ensureCommunityDistributionGroup` |
| create or join a salon | `enter-salon-group` | `enterPrivateSalonGroup`, with access |

**The role is read BEFORE anything is asked** (`getTabLeadership() === 'follower'` at the gesture),
never learnt from a commit the service refuses - the refusal is still handled, for a tab demoted
between that read and its commit, and says "do it from the other tab".

**The transport is the outbox's: a durable record, and only a signal on the channel.** The follower
takes the record's REQUESTER LOCK (a Web Lock it holds while it waits), writes the record as
`pending` to its account's IndexedDB (`CanariDBTabCommit_<userId>`, `tabCommitStore.ts`), and posts
`tab_commit_requested` only once that write has COMMITTED; the leader drains every record, decides
each under its RUN LOCK (a Web Lock), marks it `running`, runs the executor, writes `done` with the
outcome and posts `tab_commit_settled`; the follower reads the outcome and deletes the record. Every
state change is a read-check-write in ONE IndexedDB transaction, re-read under the run lock: a
`pending` is claimed once, a `done` is never overwritten. A signal lost to a tab not yet listening
costs the next drain: the leader drains when its executors register, when its session leaves
`starting` (`setDelegationReadiness`), and on every signal.

**Why IndexedDB and not `localStorage`** (review of #3160): a `localStorage` write is not ordered with
a `BroadcastChannel` message or a Web Lock across renderer processes, so the signal could beat the
record, and a drain's read-then-write could overwrite a `done` another document had just written.
**Private like the account's other data**: one database per account, listed in
`accountIndexedDbNames` so the account wipe deletes it, and a sign-out ends this tab's requests and
deletes their records (`abandonDelegatedCommits`, from `forgetAccount`). The account wipe closes the
account's store first and marks it wiped for the document (`forgetTabCommitAccount`): a drain drops
that account and its store refuses to open (`TabCommitAccountWipedError`), because an
`indexedDB.open` would re-create the database the wipe just deleted; signed in here again (a revoked
device's account still exists), it is readmitted. The records are NOT sealed
under the device key, like the publish queue's: a record carries what the gesture carries - a group
name, user ids - which the conversation rows of `CanariDB_<userId>` already hold in the clear, it
lives only until the answer is read, and a seal would strand every request in flight across a PIN
change.

**Only a state LOADED as the leader runs a request** (`stateAuthority.ts`). A follower PROMOTED IN
PLACE leads from that instant, but its copy is the one it loaded as a follower, behind everything the
old leader committed, until its promotion reload. So the login notes the role the state is loaded
with (`noteMlsStateLoaded`, right after the election in `sessionAuth`), and: a document runs a
follower's request only if it leads AND loaded as the leader (`servesFollowerCommits`); a leader
whose login has not loaded a state yet may only ANSWER one (a refusal, a death -
`answersFollowerCommits`); a promoted-in-place document does neither, and its reloaded successor
does both. The service guards read the same fact (`refusesCommitsHere`), so a promoted-in-place
document refuses its OWN commits too until its reload - an external join built on a stale copy would
leave a leaf on the server whose private state exists nowhere - and so does every key package
(`generateKeyPackage`, `FollowerTabKeyPackageError`): its private half would live only in that copy.
**A promotion DURING the login** (after the state was loaded as a follower, before `isLoggedIn`) is
not lost to the promotion handler, which reloads only a live session: the login reads
`promotedSinceLoad()` synchronously before going live and, when it holds, throws
`LoginStoppedForPromotionError`, releases its client and reloads through the handler's own path
(`reloadForPromotion`) - so no pull, ACK or key package ever runs on that copy, and the reloaded page
serves (`signOutDuringLogin.test.ts`, "a tab promoted to leader during its login").

**The leader closing mid-request cannot double-commit.** A record found `running` whose run lock is
FREE was claimed by a document that ended without settling it: the browser releases a lock when its
document goes, so the free lock is the proof of death, no heartbeat, no clock (the `salonUnsent.ts`
rule). It is answered `leader-gone` and **never run again**: the dead leader may have reached the
server - a removal recorded, an Add staged or sent - and its kept-commit machinery settles that at
the next connection; running the gesture a second time is how a removal or an Add would be committed
twice. The member is told the main tab closed and to check before retrying
(`chat_error_main_tab_gone`). A record still `pending` - no leader started it - is run by whichever
leader drains next, the one a handover elects included. A request whose run lock is HELD is waited
for on the lock itself (a stolen lock's old leader still finishing), never judged.

**A request is ANSWERED while its follower lives - and a request nobody waits for is never run.** The
leader's readiness decides how. It is set by the ONE writer of the session's two flags
(`useChatSession`'s `setIsLoggedIn` and both `setIsLoginInProgress` setters, through
`sessionDelegationReadiness`), so it follows every login start and every end - success, early
return, failure, sign-out - whoever flips the flag; a component effect could not, since
`isLoginInProgress` is a plain boolean no effect re-runs on (`delegationReadinessWiring.test.ts`): `ready` (a live session) runs it; `starting` (a login actually running) keeps it `pending`
until the login ends; `unavailable` (the PIN keypad up, a sign-out, an expired session) keeps it
`pending` TOO since 2026-11-24 - it used to be answered `leader-unavailable` at once - because such a
leader gives the lead up as soon as the MLS work holding it settles, and the tab that takes the lead
runs the request ([below](#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)). Nothing
waits on `whenMlsReady` any more, so no request blocks the drain behind it; instead the readiness,
the load fact and the account are read AGAIN after the claim, right before the executor runs: a
session that ended, or a lead that left, in between hands the claim back to `pending` (narrated),
and builds no MLS client for a session that is ending.
A kind no executor in the leader runs is answered `not-delegable`. A `pending` record whose REQUESTER
LOCK is free - its tab closed, or signed out - is deleted under the run lock and never run, with a
line saying so: the gesture is nobody's any more, and a same-account sign-in afterwards never runs a
previous session's request. **A leader tab that cannot serve gives the lead up** - a hidden one hands
it to the visible tab that asks, a frozen one releases it at `freeze` ([below](#the-lead-goes-to-a-tab-that-can-serve-a-hidden-leader-hands-it-over-2026-11-10)), one whose own session ended
(the keypad, a sign-out, an expired session) releases it once its in-flight MLS work settled ([below](#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)), so a waiting request is run by the
tab promoted in its place; a discarded tab is gone, and its locks with it. What is still not covered:
a leader whose main thread is wedged, which runs no handler, and no clock is added to cut that wait
short - a timeout there would be a guess about a live document. **And right after a deploy**, a leader tab still
running the build before #3160 does not listen for `tab_commit_requested` at all: a new follower's
request waits until that tab reloads (and is then run, or deleted unrun if its follower has gone).

**The other refusals, all typed and said with Paraglide.** `not-delegable`: the engine has no Web
Locks, or the leader tab is signed in to ANOTHER account (the leader lock is per browser) - said with
the old `chat_error_follower_tab` sentence, which is exactly the instruction left. `leader-unavailable`
(`chat_error_main_tab_unavailable`) is answered by EXACTLY four branches of `tabCommitDelegation.ts`,
none of them a leader that can still hand the lead on:
- the asking tab is itself signed out (`createDelegationClient`, before anything is stored);
- the asking session ended (`abandonDelegatedCommits`, at its sign-out): its waits end so;
- the record's account differs from the leader's and the leader has NO account while its session
  reads as serving (`ready` or `starting`, decided before the claim): a state the flags' one writer
  does not produce, kept typed rather than left waiting;
- after the claim, the leader's account is no longer the record's (another account signed in between
  the claim and the run): the gesture belongs to a session this leader no longer has.

`failed`: an executor threw instead of answering by value - the visible
end of a defect, logged ONCE, at error, in the leader (`chat_error_main_tab_failed`). A creation says
every one in its modal (`leader-gone` and `leader-unavailable` are `ConversationRefusal`s). A
gesture with two entries (joining a salon: the community's key group, then the salon's) stops at the
first refusal, so the member is told once.

**Engines without Web Locks.** Every browser this app supports has them (Chrome 69, Firefox 96,
Safari 15.4); the desktop and mobile shells are one document, always the leader, so they never
delegate. An engine without them cannot prove a leader dead, so a follower there hands nothing over
and answers `not-delegable` - and has no takeover either, since "Prendre la main" is gone. That is
accepted: such an engine is a browser older than 2022, and its tab election falls back to the
heartbeat path whose followers already could not commit.

**"Prendre la main" is gone with the banner** (`requestLeadershipTakeover`, `requestTabTakeover`,
`releaseLeadership` and the `request_takeover` listeners): nothing needs the lead taken by hand any
more. A demotion still happens when a hand-over's asker steals the lock (`onLeaderLockRejected`);
since 2026-11-24 a promotion reload no longer steals ([why](#a-leader-whose-own-session-ended-gives-the-lead-up-2026-11-24)).

Guarded by `tabCommitDelegation.test.ts`, which models what the guarantees live in rather than
stubbing it - per-account databases whose writes become visible to another document only once
committed, turns later; locks owned by documents and released when a document dies; a channel that
never delivers to its poster and delivers to the others a turn later: every gesture run once and
answered; a repeated signal and concurrent drains run once; two documents that both believe they
lead run once between them; a request asked before any leader is run by the one that comes; a
promoted-in-place document runs nothing and its reloaded successor runs the request; a starting
leader keeps it and runs it once ready; a locked leader leaves it `pending` and the next leader runs
it; a leader that gave the lead up between the claim and the run hands the record back for the next
leader; a leader killed mid-request answers `leader-gone` and runs nothing again; a
request held by a live document is waited for; a pending request whose tab closed is deleted, not
run; a signed-out session's request is never run for the next one; another account and a signed-out
leader refuse; a throwing executor is said once, at error. `stateAuthority.test.ts` for the load
fact, `followerTabKeyGroup.test.ts` for the key-group gestures.
**Owed: the two-tab readings on dev**, an entry of [the readings owed](../../plan.md#readings-owed).

### The flusher resolves its token, and does not run while offline

Two rules about *when* the queue is allowed to try, both learned from the offline-unlock work
([auth](auth.md#what-happens-on-reconnect)):

- **An access token is time-bound, so a COPY of it passed down a component tree is a bug waiting for
  the TTL.** Resolve it at the fetch, through `getToken()`. Where a component still takes an
  `authToken` prop, that prop means "the session is authenticated", never "here is the credential to
  use" - a value captured at mount is stale by the time a queued entry flushes an hour later.
- **The retry ladder must not run while offline at all.** Every failed attempt raises the backoff,
  so a queue that keeps trying against an absent network is slowest exactly when connectivity comes
  back. `canFlush: () => !ctx.isOfflineSession()` holds it, and `promoteOfflineSession` calls
  `flushOutbox()` **after** the token is refreshed and the connection re-established - never beside
  it. **The reason is not that some earlier listener would beat it to the punch**, which is what this
  said until 2026-09-13 and what the code's own comment said: `canFlush` is shut until the promotion
  opens it, so nothing the outbox hears for itself can drain the queue at all. The ordering matters
  because step 1 OPENS that gate without being the moment to send - a token is not a socket. See the
  trigger table below.

### Nine sites raise a flush, and there is ONE flusher (R-D8, refuted 2026-09-13)

The MLS audit counted the call sites and read them as a duplicate path. They are not one, and the
count is accurate - which is why the refutation is written down rather than deleted with the row.
Whoever counts them next should find this before they find nine things to fuse.

Every trigger reaches `runFlush`, and every gate lives there and nowhere else: the tab election, the
leader gate, `connectivity.isOffline`, `canFlush`, and the per-conversation lane claim (below). There is no
second flusher. **FIVE sites are internal wake-ups**, each bound to the one condition it is the seam
for - `connectivity.onReconnect`, `visibilitychange`, a follower tab's `outbox_flush_request`, the
backoff timer, and `enqueue`. **FOUR are external moments nothing inside the module can observe:**

| Site | The moment, and why the outbox cannot see it |
|---|---|
| `promoteOfflineSession` step 4 | a session unlocked offline now has a token AND a socket |
| `sessionAuth`'s `onGroupReady` (`announceGroupReady` -> `resumeOutboxGroup`) | one GROUP became sendable; the network never changed |
| `sessionAuth` after `initializeConnection` | login finished, which is not a reconnection |
| `MainChatPage`'s off-screen handler, under `holdWhileLeaving` (2026-11-02) | the iOS background task must last until the owed read marks' send SETTLES; the enqueue raises a flush but hands nobody its end, and `flush()` coalesces with it, so it adds no send |

**The fusion that looks obvious is a REGRESSION.** `connectivity.onReconnect` binds a flush to
`isOffline` clearing, so binding one to `canFlush` opening reads as the same move. It would fire at
`promoteOfflineSession`'s step 1, where the token is set, three steps before `initializeConnection`
gives it a socket - every entry burning an attempt and a longer backoff on a send that never had a
chance, which is the exact defect `canFlush` was added to prevent. A gate answers *may I send*; a
trigger answers *now*; only the promotion knows the second.

Two comments asserted otherwise until this was checked, and both are corrected in place. The login
flush claimed to *cover reconnection, which re-runs `initializeConnection`*: it does not -
`initializeConnection` has exactly two call sites, each running once per session, and a reconnect
goes through `attemptReconnectImpl`, which never calls it. Believing that comment makes the login
flush look redundant and the reconnect path look uncovered, which are wrong in opposite directions.

`outbox.test.ts` drives the five internal triggers plus the two external doors (`flush`,
`resumeGroup`) over ONE table, asserting for each that the same gate refuses it shut and drains it
open, and a source check pins the four external sites so a fifth has to be argued for rather than
added.

### A group becoming ready RESUMES what was held for it, and a re-admission holds (2026-10-31)

Four defects of one seam, found by a read-only review and fixed together:

- **A message sent during this device's own re-admission was failed for good (P2).** A
  re-admission is a Remove then an Add, about 3 s apart. After the Remove the group is held, its
  epoch gap cleared (`isGroupHealthy` yes) and `isGroupActive` false; `retireIfEvicted` has
  already read `reAddInFlight` and written the row `pending` (`markAwaitingReAdmission`). The send
  gate then took `failPermanently(..., 'evicted')`, and `recordEviction` retired the row, posted
  the removal notice and deleted the entry - three seconds before the Welcome re-admitted the
  device. Now **the Remove half DROPS the evicted state** (`retireIfEvicted`'s `reAddInFlight`
  branch: `dropGroupState`, `deferred` checkpoint under the commit mutex, THEN
  `markAwaitingReAdmission`), so the row is the ordinary awaiting-Welcome one: a `pending` row over
  a group this device does not hold. A send in the window meets an unsendable group and is HELD
  (`holdForGroup`) with a re-add asked - a file too, since it is queued at the tap like a text
  ([below](#a-file-is-queued-at-the-tap-like-a-text-2026-11-01)).
- **And the wait ENDS on an answer, never a clock (review of #2804, F1).** The first version of this
  fix kept the evicted state and held on a local guard (`awaitsReAdmission`). Over a HELD group
  `requestReAdd` stands down ("already in WASM") and the watchdog reads the group healthy, so a
  re-admission whose Welcome never came was waited on for ever behind a `pending` bubble. With the
  state dropped, every pass reaches the server: a Welcome owed is waited for, a seat with none is
  joined, and NO seat retires the row (`stopRecovering` on the roster's 403). The outbox reads the row
  AFTER its `requestReAdd` and fails a held entry on a `removed` row (`failPermanently(...,
  'removed')`: the row's banner tells the member, the bubble goes `error`, nothing is re-recorded).
  The guard and its three readers (`recordEviction`, `verifyCurrentUserMembership`, the outbox) are
  deleted. **What the drop costs:** nothing the user sees - past messages are stored decrypted, and
  the Welcome installs on nothing as a fresh join does, keeping the row and its messages; a frame of
  an epoch before the Remove that arrives AFTER it is undecryptable locally, which server order makes
  rare and the inviter's history push covers.
- **A kill can leave any pair of (row, state), and the restore is what is total over them (review
  of #2808).** The merged Remove reaches disk through checkpoints the commit path does not order -
  its own `persistNow`, a flush on backgrounding, another group's structural checkpoint, one already
  running - because a checkpoint takes no lock against the commit path; the row lives in another
  store. No write order on that path can therefore guarantee anything, and an `active` row over the
  evicted state survives some kills, with `reAddIsInFlight` (memory only) gone. It was read as
  `active` and the next send retired the conversation. `reconcileRestoredLifecycles`
  (`admissionState.ts`) now reads membership for EVERY row over a held group (together, one local
  read each): `true` promotes a `pending` row; `false`, on an `active` or a `pending` row, DROPS the
  evicted state and leaves the row `pending`, so the recovery asks the server, whose answer is right
  for both readings of the Remove (a Welcome owed is waited for, a seat is joined, no seat retires
  the row); `null` changes nothing. The reads run at most eight at once (one IPC call each on
  native); the drops share ONE awaited checkpoint, since each is a full encrypted save (~1.7 s on a
  phone) and this runs before the connection opens; and `applyRestoredLifecycles` writes every row it
  changed, so the verdict is durable. The row is still marked before the drop at run time, only so
  no in-memory reader sees `active` over no state.

  **A DELIBERATE TRADE:** a row whose eviction a kill left unrecorded now waits for the server's
  answer instead of retiring locally - offline included, where it stays `pending` until a connection
  answers. Nothing local separates a real eviction from the first half of this device's own
  re-admission once `reAddIsInFlight` is gone, and retiring the second is the defect this fixes.
- **The boot restore undid that row.** It promoted any `pending` row whose group
  `getLocalGroups()` listed, and an evicted group stays listed: the promotion now reads membership,
  as above.
- **The Welcome did not flush a held entry (P3).** `onGroupReady` called `flushOutbox()`, and a
  flush skips an entry whose `nextAttemptAt` is in the future unless it is RESUMED - so delivery
  after a Welcome waited for the backoff, up to 60 s, while the docblock claimed the opposite.
  Every hold for the group writes the entry into `repairHeld` (in memory, like `transportHeld`);
  `resumeGroup(conversationId)` moves that group's ids, and only those, into `resuming` and drains.
  A group that becomes ready INSIDE the attempt that holds it (an external join landing within the
  `requestReAdd` that attempt awaited) is caught by a per-group count of ready announcements read at
  the gate and again after the hold: when it moved, the hold resumes itself and the lane re-runs. A
  count of events, not a clock.
- **A successful external join raised nothing (P3).** It set the row `active` and called
  `notifyConversationAvailable`, and never the group-ready seam. `RecoveryDeps.onGroupReady` is now
  REQUIRED and raised on every landed join; `sessionAuth`'s `announceGroupReady` is the ONE
  implementation both a Welcome and an external join reach (resume, statuses, deferred welcome
  requests, the debounced invitation sweep).
- **And it announces only into the session that started the work (review of #2808).** Every step of
  `announceGroupReady` reaches module-level state, so a Welcome or a join landing after a sign-out
  and the next sign-in acted on the NEXT session. The function is no longer exported: the session
  registers it in `groupReadyAnnouncer.ts` with the outbox, and EVERY `onGroupReady` - the message
  pipeline's, the in-session `makeRecoveryDeps`, `verifyCurrentUserMembership`'s and
  `startNewConversation`'s repairs - is `captureGroupReadyAnnouncer()`, taken when its deps are
  built. That one check forwards only while the registration it captured is still live. A session
  ended since is an ordinary sign-out (`info`); work built with no session live is a `warn`. A
  source test pins that no `onGroupReady` goes around it.

Pinned by `outbox.test.ts` (held then sent on `resumeGroup`; held then failed `removed` once the
recovery retires the row), `recovery.test.ts` (the Remove half drops the state and a server with no
seat ends the row `removed`; a landed join raises `onGroupReady`), `eviction.test.ts`,
`admissionState.test.ts` (an `active` row over a group this device is out of waits on the server),
`groupReadyAnnouncer.test.ts` (no announcement crosses a session) and `setupMessageHandler.test.ts`
(`onGroupReady` on both Welcome paths).

### A salon attachment is drawn at the tap, and its row carries its upload (2026-11-02)

**The report (owner, 2026-11-02):** a file sent in a conversation, a heavy one above all, disappeared
for a long time and came back, with nothing in between. **The cause, in a community salon:** the
channel branch of `handleSendChat` uploaded the whole file INLINE (`encryptAndUpload`, no progress)
and drew NO row: the staged file left the composer at the tap and the message existed on screen only
when the server's `channel.message.created` frame came back - the POST's reply was discarded. The only
sign of life was a spinner on the attach button (`isUploadingMedia`), which a phone-width web viewport
does not show at all. Every platform took this path (web, Android, iOS share it).

**Now (`utils/chat/salonAttachmentSend.ts`):**

- **At the tap** the salon ECHO is drawn (the salon text's `awaitingServerId` row, memory only) with
  the placeholder envelope (`mediaId: ''`, the caption, the ThumbHash), and the send returns.
- **The upload is the row's.** The module waits for the salon's send gate (the row says `queued`),
  then uploads with the real transfer's events written into the SAME upload view the DM outbox writes
  (`uploadProgress.svelte.ts`): one ring, one caption, one `UploadAction` for every attachment. One
  upload at a time per salon, in tap order, because the server dates a row by its arrival.
- **Its real envelope is swapped into the echo BEFORE the POST** (`SalonEchoChange` `content`), so
  whichever answer settles the echo first - the reply or the broadcast frame - leaves a row naming its
  blob. The sealed message is then handed to the salon text's machinery (`deliverSalonAttachment` ->
  `deliverSalonSend`): the offline hold, `unconfirmed`, Retry and Discard are the text's.
- **Until that hand-off the module owns the row's Retry and cancel** (`setUploadOwner`): a salon echo
  has no delete (no server row), so the bubble's cancel is the owner's (`uploadCancelOf`). A cancel
  aborts the transfer and withdraws the row; a late progress event of the aborted request is dropped.
- **A failure is classified at its throw and the row stays:** no answer while offline is `waiting`
  and owed to the reconnect (`salonOwed.ts`), no answer online is `stalled`, a status is `refused`
  (the banner says the server's reason), a body DELIVERED with no answer in time
  (`UploadAnswerTimeoutError`) is `unanswered` - never a stall, the server may hold the file and a
  Retry uploads a second one - and anything else is a local `error`. Each offers Retry and cancel.
  `SessionExpiredError` is a session end: the row goes, nothing is sent.
- **"Offline" is known because the upload is counted.** `fetchUpload` (every media upload: this one,
  the DM/group outbox's, a form's file) settles its request through `trackRequestOutcome`, the half
  of `trackedFetch` that feeds the connectivity store. Before, only `trackedFetch` did, so a link lost
  mid-upload left `isOffline` false and the reconnect retried nothing (review of #2944).
- **The account that tapped is carried** (`signOutGeneration()`, read at the tap): an attempt checks
  it before its start, after the gate and after the upload, and a signed-out generation withdraws its
  row and sends nothing, as the DM branch drops its write.
- **Not offered:** "put back in the composer" (`takeBackSalonSend` refuses an attachment - it could
  give back the caption, not the file). **Memory only**, as the salon text in flight: a reload
  mid-upload loses the row and the file together, never a row naming nothing.

`useMessaging.salonAttachmentVisible.svelte.test.ts` holds the upload open with a promise and asserts
the row from the tap through each progress event to the re-keyed server row, plus the refusal with
its Retry, the cancel, and the gate wait; on the code before, the send never returned while the
upload was held and no row existed.

**The DM / group path left one sub-second window**, out of this change: the file is read
(`File.arrayBuffer()`, bounded by the 50 MB ceiling) BEFORE its placeholder is drawn, because the
placeholder and its entry are one write in `addMessageToChat`. Drawing first needs that function to
adopt a row already drawn, which waits for the rewrite of its storage path (#2936).

### A file is queued at the tap, like a text (2026-11-01)

A DM/group attachment used to wait, in `handleSendChat`, for `waitForMessageQueueIdle('media send')`
and a `verifyCurrentUserMembership` round trip BEFORE anything was written: 18 s on a stalled link
(2026-10-31), with no bubble and no clock on screen, and a refusal ("session establishing") for a row
awaiting re-admission. That barrier answered the questions this queue already asks before every send,
earlier and slower, and its answer could go stale before the flush ran. It is deleted, with its
refusal, its sentence (`chat_send_session_establishing`) and `MessagingContext.verifyCurrentUserMembership`.

- **At the tap**: the staged files are claimed before the first await (a second Send finds nothing),
  each file is READ, then its `mediaId: ''` placeholder and its media entry (`fileBytes` included) are
  written in ONE write (`saveMessageWithOutboxEntry`, `alreadyDurable`), as a text's echo and entry
  are. A failed pair write lets the queue write its own row (`MessagePairWriteError`); a conversation
  that left the map before the write is refused as `ConversationGoneError` - nothing written, nothing
  queued, the member told (review of #3992); a refused
  enqueue (`OutboxEnqueueError`) withdraws the placeholder and re-stages the file; a
  `MessageWrittenError` (the row is on disk, the live queue refused it) keeps both - the next flush
  sends it. The one refusal left is the text path's: a `removed` row takes nothing new.
- **"Pair" is atomic on IndexedDB only.** SQLite through `tauri-plugin-sql` cannot hold a transaction
  across two statements ([sqliteBatch](../../../../frontend/src/lib/db/sqliteBatch.ts)), so it writes the
  entry first and a tear after it throws `OutboxEntryWrittenAloneError`; `MessagePairWriteError.entryWritten`
  carries it to both send paths, which then tell the queue the row is durable instead of writing it
  a second time (a second blob in its slot) and giving the file back (a duplicate). Review of #2874, M2.
- **The account is asked before EACH write**, not once at the tap: `enqueueOutboxMessage` reaches the
  module's ACTIVE controller, so a sign-out inside the read or the pair write would hand the file to
  the NEXT account's queue, which sends it as itself. On a sign-out since the tap the file is dropped
  with a log line, nothing is re-staged, and the caption is not sent (review of #2874, M1).
- **A caption belongs to the first file**: a refused first file given back to the staging takes it
  back too (the send answers `false`, the composer restores the draft) instead of sending it alone as
  a text that captions nothing (L3). A file DROPPED because the member moved on (below) still lets its
  caption go, so the words are not lost with it.
- **A refusal after the member moved to another conversation drops the file** and says so on the
  banner of the conversation now on screen (`chat_media_dropped_other_conversation`); re-staging it
  where the member is not looking was judged worse. Accepted as is (review of #2874, L4).
- **What the barrier guarded is the flush's**: the queue-idle barrier before any lane (the file is
  sealed at the current epoch), then per entry `isGroupHealthy` (a re-admission is HELD, its bubble
  showing `repairing`, and resumed by its Welcome), the deleted-group read and `isGroupActive` (an
  evicted group retires it) - all before the upload is paid, so a file for a group that cannot take it
  costs no transfer. **And again for an uploaded file, BEFORE the gates** (`outbox media seal`): the
  flush's barrier is an upload back, and a lane woken by the upload's end does not pass it again (L1).
  Its place is the fix, not a re-check: taken after the gates, a Remove it drained (a real eviction,
  or the Remove half of a re-admission) was invisible to them and the send learnt it by FAILING - the
  file retired as `evicted-late`, a false "the Remove commit never reached it", a permanent removal
  notice before the Welcome. Taken first, the gates read the drained state and nothing is awaited
  between them and `sendMessage`. A re-admission's Remove has its group state DROPPED by
  `retireIfEvicted` (the `reAddInFlight` branch) before the barrier returns, so `isGroupHealthy`
  reads false and the file is HELD for the Welcome; a real eviction leaves the state held and
  `isGroupActive` false, so it retires as `evicted` (evidence `membership-check`) (re-review of #2874).
  The CEK is still
  generated on the device, by the upload the flush starts (`encryptAndUpload`); the entry holds the
  plaintext under the device key until then.
- **A file the group will never take says why in its bubble.** Retired for `group-deleted`, or for
  `evicted`/`evicted-late`/`removed`, its bytes go with the row and the bubble read "refused by the
  server", the file's failure and not this one. `failPermanently` now records an `UnsentReason`
  (`uploadProgress.svelte.ts`) and the bubble says `upload_unsent_group_deleted` or
  `upload_unsent_not_a_member` in the place of `upload_failed_label` (M4). **Durable**: the reason is
  written on the stored message row (`StoredMessage.unsentReason`, inside the encrypted payload)
  before the entry is deleted, and the bubble of an own attachment absent from the queue reads it
  (`storedUnsentReasonOf`) before it draws the orphan's "never completed"; a follower tab holding the
  message is told live (`outbox_entry_retired`). The write is READ BACK: `updateMessage` writes
  nothing, and says nothing, for an absent or undecryptable row, so every way the reason fails to
  reach disk is logged. Re-review of #2874.
- **A send never rides the orphan buffer.** A conversation that left the map since the tap has two
  answers before the write. A DM RE-KEYED by a duplicate-group merge (the Welcome path of
  `setupMessageHandler` moves the row to the group just joined) is FOLLOWED: the file goes to the new
  key, found by `findDirectConversationByPeer`, the one predicate the merge itself uses (a live row only:
  a retired DM is never a destination). A
  conversation truly GONE (deleted, left) drops the file and TELLS THE MEMBER
  (`chat_media_conversation_gone` on the send banner); with nothing sent the send answers `false`, so
  the caption goes back to its draft. And `addMessageToChat`'s orphan buffer strips
  `outboxEntry`/`onPairWritten` - and an own send's tap-time `pending` - from what it keeps, so a
  replay (`drainOrphanMessages`) never writes, and so never sends, an entry a second time; the
  replayed own row then takes its status from the durable queue (`applyOutboxPendingStatuses`), as
  at a reload. The buffer is cleared by `forgetAccount`, so nothing replays under the next account.
- **An uploaded file retired unsent stays on the server.** There is no client route that deletes an
  ordinary chat upload (`DELETE /media/:id` is server-to-server; the user route covers only the
  sender's own chat reel), so `failPermanently` names its `mediaId` at `console.warn` and in the
  in-app log, and the object waits for its retention class's sweep (`ephemeral` for a chat upload).
  Owed if that is ever too slow: a sender's delete route for its own unsent upload (L2).
- **Order**: every file of one tap is dated by the tap (`tappedAt + index`), so a text typed while a
  long write runs is dated after all of them; a text sent before the file goes out before it. A text
  sent AFTER it may still be accepted first while the upload runs (WP-OFF-9, below).
- Pinned by `useMessaging.mediaEnqueue.svelte.test.ts` (no barrier, tap-then-kill durability, order,
  the refusals, the sign-out and the caption), `sqlitePairWrite.test.ts` (the torn SQLite pair) and
  `outbox.test.ts` ("a file queued at the tap": kill and resume, both barriers, a Remove drained by
  the seal barrier, the held, evicted and deleted group and their persisted reasons, the follower,
  the orphaned upload, failure then retry), `MessageBubble.orphan.svelte.test.ts` (the reason after a
  reload) and `messagePayload.test.ts` (its round trip).

### One lane per conversation, three frames on the wire at most (WP-OFF-5, 2026-10-09)

The flush used to walk the whole queue awaiting one entry at a time, so a send that never answered
(the MLS POST had no deadline) froze every message in every conversation behind it. `runFlush` now
claims **one lane per conversation** (`lanes: Map<conversationId, Promise>`, checked and set with no
`await` between them, so two wake-ups cannot start two lanes and send an entry twice) and each lane
drains its own entries oldest first. Rules that came with it:

- **Order is per conversation and kept by construction**: an entry that must retry or is backing off
  holds its successors; `sent`, `gone` (withdrawn) and `error` (permanent) let the next one go. The
  old loop attempted later entries after a failed one, so a failed message could be overtaken.
- **A wake-up while a lane runs does not start a second one**, it marks the lane to look at the queue
  once more (`laneRerun`), which is how an entry enqueued mid-send is still picked up.
- **`MAX_CONCURRENT_SENDS = 3`** frames on the wire across lanes (a slot is handed to the next waiter,
  never freed and re-raced): enough that one stalled lane freezes only itself, few enough that a
  50 kbit/s uplink is not cut into slivers that each miss their deadline.
- **An attachment's UPLOAD runs outside the lane and holds no send slot** (WP-OFF-9, 2026-10-18): the
  lane starts it and moves on, so a text written after a big file is not held by it; only the media
  message's small MLS send takes the lane once the upload ended. Display order is the server's
  acceptance time ([below](#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31)); the
  rules and the order semantics are in [offline-and-weak-network 13.8](../offline-and-weak-network.md#138-wp-off-9-built-the-upload-runs-outside-the-lane-2026-10-18).
- The send POST is under a `write` deadline ([offline-and-weak-network](../offline-and-weak-network.md#11-wp-off-5-shipped-a-deadline-a-slow-state-and-lanes)),
  so a stalled lane ends as `DeliveryUnreachableError` and takes the ordinary backoff.

### A resume is prompt, bounded and idempotent (WP-OFF-6, 2026-10-09)

`connectivity.onReconnect` arms every entry whose last failure was a missing ANSWER to skip its
backoff once, and the store probes `/api/version` on `online` instead of waiting for an unrelated
request to prove the server reachable: 2.4-2.9 s down to 5-13 ms on a good link, one probe round trip
on a weak one. Refusals keep their clock. The reasoning, the bounds and the numbers are in
[offline-and-weak-network](../offline-and-weak-network.md#12-wp-off-6-shipped-a-prompt-bounded-resume-exactly-once-in-effect).

### A deploy's "not now" is not a send failure (R05, 2026-11-09)

**The defect** ([backlog](../../plan.md#readings-owed)).
A production deploy answers `502`, `503` and `504` for its few seconds - the estate's nginx writes
its own in JSON (`@api_error_502/503/504` in `infrastructure/local/Dockerfile.frontend`), so they
read as `gateway` answers - and a reset connection is a transport failure. Two paths turned that
into a failure the member saw:

- **A DM or group text**: `postApplicationMessage` typed every 5xx as `SendServerError`, and the
  outbox COUNTED it toward `MAX_CONSECUTIVE_SERVER_ERRORS` (the user's decision of 2026-10-18, for
  a server that keeps failing): five "not now" in a row parked the text as `error` ("Echec" +
  "Reessayer"), each one held a one-minute floor (`SERVER_ERROR_HOLD_MS`) whatever the server did
  next, and no reconnect resumed it.
- **A salon text** (`deliverSalonSend`, `utils/chat/messaging.ts`): any 5xx with the link up was
  `unconfirmed` - "Pas de reponse du serveur : ce message n'est peut-etre pas parti" - and waited
  for the author's Retry, for good.

**Classified at the throw, by the status the answer carried** (`utils/unavailableAnswer.ts`, the
one predicate): `502`, `503` and `504` say "not now" - a proxy about the service behind it, or a
service that could not ask a peer (chat-delivery's `entitlement_unavailable` while social-service
restarts). None refuses the MESSAGE. Every other 5xx is the service answering that IT failed, and
keeps the 2026-10-18 policy. The delivery API raises `SendUnavailableError` (a `SendServerError`
still, so every reader of a 5xx reads it as one); the salon reads `isUnavailableAnswer` on the
`ChannelApiError` the channel service threw.

**Held, deterministically, and ended only by an answer:**

| | DM / group (`outbox.ts`) | Salon (`messaging.ts`) |
| --- | --- | --- |
| "not now" | held on the PLAIN ladder (`retryLadder.ts`: 2, 5, 15, 30, 60 s, or the server's `Retry-After`), never counting toward nor resetting a run of real 5xx; in `transportHeld`, so a reconnect sends it at once; counted in the row (`unavailableAnswers`) | `pending`, held for the server (`holdForServer`): owed to the reconnect AND one ladder step of the same ladder, whichever comes first - a deploy that rotates one service drops no connection, so no reconnect would ever come; counted in its unsent ledger entry |
| a reset / no answer | unchanged: `transportHeld`, the reconnect | unchanged: owed to the reconnect when the link is known down |
| what ends it | the send (2xx), a REFUSAL (410, a 403, the 5th real 5xx), or the 12th "not now" in a row: `error` ("Echec" + "Reessayer") | the row, a refusal (`error`, its Retry), or the 12th "not now" in a row: `unconfirmed` (Retry, Discard, Restore) |
| what the member can do meanwhile | delete it | Retry now, or Discard (`salonEchoSettleable`) |
| what the bubble says meanwhile | "En attente du serveur..." / "En attente du reseau..." | the same |

**Bounded by answers, never by a clock (review of #3189).** A "not now" is uncounted toward the 5xx
run only while there is evidence the service is alive, and the evidence is the send's OWN 2xx -
which ends the send. `MAX_UNAVAILABLE_ANSWERS` (12, `retryLadder.ts`, the one constant both paths
read) answers in a row with no 2xx between leave the wait; a websocket reconnect proves the link,
never the send route, and resets nothing. Twelve on the plain ladder span about eight minutes: a
rolling deploy ends with a success long before, and a dead route hands the message back to the
member. The reasoning: [offline-and-weak-network section 17](../offline-and-weak-network.md#17-a-text-the-server-keeps-failing-becomes-failed-with-a-retry-user-2026-10-18).
The DM park writes `MAX_CONSECUTIVE_SERVER_ERRORS` into `serverErrors`, so the one terminal predicate
(`isServerFailureTerminal`), the one Retry and every tab read it as before. The DM count is never set
back below a multiple of 12 (`unavailableRunStart`): a Retry owes twelve FRESH answers before the next
park, and a count above 0 stays the withdrawal's evidence (below). The salon count is reset by the
author's Retry (`resetUnavailableAnswers`); an attachment's run is its page life's hold.

**Exactly once.** Every repeat carries the first attempt's client id: the DM receivers drop a
second frame with a `messageId` they hold (`addMessageToChat`), and social-service answers a salon
repeat with the row it stored (migration 090, `findByClientMessageId`). A salon repeat is held for
the server at once: the proof this page once waited for (`salonRepeatProof.ts`) was retired on
2026-11-22, every estate carrying 090 since `v1.3.0` ([below](#a-salon-is-received-in-the-order-it-was-written-one-lane-per-salon-2026-11-22)). One lane per conversation keeps a DM entry off the wire twice,
and a salon redelivery is serialised by `retrying` and cancels its own ladder step when it starts
(`takeServerHoldStep`). The frame of a salon send - in the tab that composed it as in another -
ends it (`forgetDeliveredSalonSend`, called by `channelEventHandler.ts` where the echo is re-keyed):
its hold, its ladder step and its debt to the reconnect go, so a delivered message is never POSTed
again. A text answered "not now" and then deleted lets the delete travel as an event: a `502` after
an upstream reset, or a `504`, may come after the frame was stored - read from the DURABLE row
(`unavailableAnswers > 0`, SQLite migration v19), so a reload and a follower tab decide the same.
MLS state and crypto are untouched: each attempt is sealed exactly as before.

**The label** is the hold's typed reason, written where the hold is decided: a TEXT has no upload,
so it is not an upload phase but its own record (`TextWait`, `setTextWait` in
`uploadProgress.svelte.ts`, dropped with the message's view and at a reconnect). The outbox writes
`network` or `server` for a DM text, the salon `server` for its text, and `MessageBubble` hands
`waitingOn` to `MessageMetadata`; a device known offline says the network first. An attachment's
"not now" is its MLS post, made after its upload, so it writes no upload view; its upload's own
`502`/`503`/`504` is a `MediaUploadError`, held as `retrying`. A `403` after a "not now" drops the
stale label (the 403 parking clears the view).

**The ladder is not a clock that decides anything.** A step only ASKS again; its cost when wrong is
one request answered "not now", bounded by the 60 s top step; a reconnect skips it. What ends the
wait is always an answer. Tests: `outbox.test.ts` ("a deploy outage is not a send failure (R05)":
503 then 200, eleven "not now" then sent, the 12th failing the text, a reconnect not resetting the
count, the count across a reload, a Retry owing twelve fresh answers, the plain ladder, the
reconnect, a reset then the reconnect, a reconnect racing two flushes sending once, a 410 still
failing, a "not now" neither counting nor resetting a run of 500s, the delete travelling - also
after a reload, the reviewer's probe - and a 403 after a 502 dropping the label),
`useMessaging.salonQueue.svelte.test.ts` (the salon twins: reconnect, ladder step with no reconnect,
both at once sending once, a long deploy, a 403 after a 503, a 400 at once, the author's Retry
ending the hold, the proof, the 12th "not now" unconfirmed, a Retry restarting the run, Retry-now and
Discard while held, the frame ending the hold), `channelEventHandler.salonEcho.test.ts` (the frame
calls `forgetDeliveredSalonSend`), `salonEcho.test.ts` (`salonEchoSettleable`),
`mlsDeliveryApi.forbidden.test.ts` (the type at the throw, both origins), `unavailableAnswer.test.ts`,
`MessageMetadata.waitingOn.svelte.test.ts` (the label, and the held row's actions),
`sqliteMigrations.test.ts` (v19), `outboxClearPatch.test.ts` (the count written in place). **Owed:** a deploy drill on dev with the two bench
phones sending throughout (no "Echec", no "Non confirme", each message once on the peer).

### A salon is received in the order it was written: one lane per salon (2026-11-22)

**The defect** ([backlog](../../backlog.d/p3-salon-texts-held-by-a-502-are-posted-out-of-order.md)).
Read twice on the iPhone 12 (S5 on `1.7.0-alpha.12`, then `1.7.3-alpha.5`): dev's social-service
stopped about 80 s while `T1`..`T8` were written in one salon, and the server stored
`T1 T6 T7 T8 T2 T3 T4 T5` - live, and again after a terminate and relaunch, since that IS the
server's order. Each text arrived once and none failed, so R05's contract held; only the order broke.

**Why.** Each held salon text owned its own retry: its ladder step (`holdForServer`), its debt to the
reconnect, and a fresh text POSTed at once whatever waited before it. After the return, the first
POST answered was whichever asked first: the texts typed after the restart (`T7`, `T8`), and the one
whose step happened to end next (`T6`), went before `T2`..`T5`, still on 15 to 60 s steps. The DM and
group outbox never had this: its lanes keep order by construction since WP-OFF-5 (above, and
[offline-and-weak-network section 11](../offline-and-weak-network.md#11-wp-off-5-shipped-a-deadline-a-slow-state-and-lanes)).

**The fix: the salon send gets the outbox's rule** (`utils/chat/salonSendLane.ts`, driven from
`deliverSalonSend` in `utils/chat/messaging.ts`). Each salon has ONE ordered lane of its unsent
messages, and only the first may be on the wire. A text written behind it is drawn `pending` and
waits its turn (`WAITS ITS TURN` in the log); no timer, no reorder afterwards. The order is the
order of WRITING, fixed where it is known:

- a fresh text takes its place in `queueSalonSend` BEFORE its first await, so two taps in a row are
  placed in tap order whatever their echo writes do;
- what a past page life left is placed when the ledger is read (`reserveSalonLaneTurns`), in the
  LEDGER's order - which `recordUnsentSalonText` now keeps when it re-records an entry instead of
  moving it to the end - ahead of every text of this page life that has not taken its turn yet, and
  behind the one that has (it may be on the server already).

**A message holds its place exactly while the machine will send it again by itself**: in flight,
waiting for its salon to load, owed to the reconnect, or held for the server. Each turn returns a
typed outcome (`SalonTurn`: `holds`, or leaves with its `why`), classified in the branch that decides
it rather than read back from the registries. It leaves - and the message written next is delivered
at once (`releaseSalonTurn`) - when it is settled (its answer, or its frame: `forgetDeliveredSalonSend`),
deleted, refused (`error`), or handed to its author (`unconfirmed`: the 12th "not now", an unknown
outcome with the link up). That is the outbox's own rule for a parked entry: a message waiting on a
HUMAN does not make the ones after it wait too, so a Retry of it later sends it at the END of the
lane, after what was waiting. A message that leaves also stops being owed to the reconnect, so a
refused text is never re-POSTed by a later reconnect. A text waiting its turn says so: "En attente du
message precedent..." (`TextWait` `turn`, `msg_waiting_for_previous`).

**A HEAD THAT NEVER ANSWERS HOLDS THE WHOLE SALON, by design - as the outbox's lane does.** A POST
with no answer at all is bounded by the request deadline (WP-OFF-5), then classified like any other
outcome; until then every text written after it waits. That is the price of the order, and the
same price the DM path has paid since WP-OFF-5.

**The traffic stays what it was, and typing speed decides nothing.** Before, a text written during an
outage POSTed once and climbed its own ladder; now, a text written behind a head held for the server
asks the HEAD again at once instead (`askHeldTurnAgain`, which takes the head's ladder step). So the
outage costs the server no more requests than before, and a text typed after the return drains the
salon immediately rather than waiting up to a minute for the head's next step: `T7` brings `T2`
through, and `T3`..`T8` follow in order. **A "not now" answered to a turn asked from behind is NOT
counted toward the head's `MAX_UNAVAILABLE_ANSWERS`** (`askedFromBehind`): only the head's own ladder
steps and reconnects are. Counted, twelve texts typed in six seconds against an instant 502 handed the
head to its author and let all twelve overtake it (review of #3964, B1). With nothing typed after the
return, the head's ladder step or the reconnect drains the salon the same way. An uncounted "not
now" still re-arms the head's step at its FULL current delay, so steady typing keeps postponing the
next counted step - but every counted answer still comes from the head's own step or a reconnect, so
the head stays bounded by `MAX_UNAVAILABLE_ANSWERS` once the typing stops.

**The repeat proof is retired, because the order needs every unsent text to keep its place.**
`salonRepeatProof.ts` made a send that MAY have landed (a POST lost as the link went down, an entry a
past page life left, a "not now") wait `unconfirmed` until some answer of this page life echoed a
client id, proving the server carries migration 090. With the lane, that wait broke the order exactly
when it mattered: the proof starts unproven in every page life, so a reload during an outage handed
`P1`..`P3` to their author and the first text typed after the return went first (`NEW P1 P2 P3`), and
an outage before the page life's first send gave `D A B C` (review of #3964, S2). **The mechanism the
proof guarded against is gone:** a social-service without migration 090. It shipped in `v1.3.0`
(`apps/social-service/src/migrations/090_channel_message_client_id.sql`), the `prod-released` and
`dev-deployed` markers both contain it, and Canari runs those two estates only. So every repeat now goes
like a first send, and `channelCrypto.ts` ACCUSES an answer that does not echo its client id
(`console.error`, "this server predates migration 090") instead of quietly learning from it.

**Every salon post that is a message joins the lane.** A text and a salon attachment through
`deliverSalonSend`; a POLL (`MainChatPage.handleCreatePoll`) and a FORWARDED FILE
(`useMessaging.forwardMessage`; a forwarded text already goes through `sendChatMessage`) through
`runInSalonTurn`: it waits for its turn, posts ONCE, and leaves whatever the answer - nothing sends it
again by itself, so it holds its place only while in flight. **Such a post has no echo and no ledger
entry, so it NEVER waits on a held message** (principle 2, the essential is never lost): queued behind
a text held for the server or the link, it would sit unseen, and a reload would lose it. So it is
REFUSED (`SalonLaneHeldError`) when the message ahead of it is held, or becomes held while it waits
(`refuseWaitingPosts`); the poll modal keeps its draft open and says "Des messages de ce salon
attendent encore d'etre envoyes : reessaie une fois qu'ils seront partis" (`salon_post_waits_for_held_messages`),
and a forward says the same. Behind a message merely IN FLIGHT it waits for that answer, which the
request deadline bounds. A session ending during the wait rejects it with `SalonTurnAbandonedError`,
which both callers swallow silently (a debug line, no banner): the member signed out. This was chosen
over a pending poll echo as the simplest path that loses nothing - an echo would need its own
durable entry to survive a reload. **Deliberate exceptions:** an EDIT (`channelCrypto` edit, owed per key
by `salonOwed.ts`) changes a message that already has its place, and every reader orders it by its
own clock against the message it names (`editPrecedence.ts`), never by its row; a REACTION, PIN or VOTE
likewise names its target. A MEMBER-ADDED NOTICE (`useChannelWorkspaces`) is posted by the admin's
gesture of adding someone, not by anything this member wrote, so there is no written order for it to
keep.

**What can still overtake, said plainly.** A text typed while a PHOTO or video of the same salon is
still UPLOADING goes before it: the attachment joins the lane only when its post is due, after the
upload (WP-OFF-9's rule - a file uploading holds nothing back, as in the DM outbox). Lanes are per
salon: two salons never wait on each other. The lanes are memory only; the durable order is the unsent
ledger's.

**The seal is untouched**: each attempt seals afresh, so a retried text spends a NEW `messageIndex`,
and an edit or a reaction (outside the lane) can seal between two texts. The server's
`messageIndex` order therefore says nothing about the written order, and nothing reads it as such.

**MLS.** Nothing here touches the DM and group path: its lanes already hold a retrying or backing-off
entry's successors, so an MLS application message cannot overtake an earlier one of the same group,
across an epoch or not.

Tests: `useMessaging.salonOrder.svelte.test.ts` - the drill against a fake server that is down then
up (`T1`..`T8` stored in order, each once, no failure drawn - failing without the lane); the ladder
and the reconnect each draining in order; a POST in flight holding the next; a refused head and a
discarded head letting the next go; a past page life's entries POSTed in the ledger's order; and the
review probes of #3964 in a fresh page life: B1 (`H X1..X12 Z`, failing when the answers asked from
behind are counted), A (`A B C D`), C (`P1 P2 P3 NEW`), the "waiting for the previous message" sign,
a poll waiting behind a held text, a refused poll leaving the lane. `salonSendLane.test.ts`,
`salonUnsent.test.ts` (re-recording keeps the place), `channelCrypto.test.ts` (the accusation).
**Owed:** the same drill on a phone (the backlog entry's reading).

### Everything the outbox swallows, it logs

The queue is deliberately best-effort at every step - a storage write that fails must not take the
send down with it - and that makes silence the default failure mode. Each such branch therefore
logs, because these are the only traces available when a message is accepted locally and never
arrives (see WP-FWD-1):

| Branch | Why silence there is dangerous |
|---|---|
| Reading the queue | A failure is indistinguishable from an empty queue, so the entry is simply never flushed |
| The idle barrier | Failing it means sending at a possibly stale epoch - the silent loss above |
| Group not sendable | Holds the message indefinitely while `requestReAdd` recovers; from outside it looks delivered |
| Backoff skip | Explains a message sitting in the queue with nothing else happening |
| Delete after send | Leaves a *sent* entry queued, so the next flush sends it again |
| Backoff not persisted | Loses the attempt count, so the entry retries at full speed |
| Media ref not persisted | A crash before the send re-uploads the same file |

### A 413 ends the entry (2026-10-08)

The relay's nginx on the old VM answers `413` to any request body above exactly 1 MiB (its default `client_max_body_size`, behind Cloudflare, [cloudflare-edge](../../infrastructure/cloudflare-edge.md#a-request-body-over-1-mib-is-refused-with-a-413-on-the-legacy-names---it-is-the-relays-nginx-not-cloudflare-measured-2026-10-07-cause-found-2026-10-09)), and the media upload sends
the whole ciphertext as ONE body up to 50 MB (chunking starts at `CHUNK_SIZE = 50 MB`, `media.ts`).
The ladder used to re-post such an upload once a minute for ever (attempt 806). Now `MediaUploadError`
(an `ApiRefusalError`, status carried at the throw) is read through `refusalStatus(e) === 413` in the
flush catch: one `console.error` + `[OUTBOX]` line, `failPermanently(..., 'too-large')` - bubble to
`error`, entry deleted, a system line in the thread (`outbox_upload_too_large`, Paraglide), metric
cause `too-large`. No banner and no eviction: the group is unchanged. Only 413 is permanent here; a
5xx still backs off. The cause of the 413 (the edge limit) is NOT fixed by this: see the P1 in
[backlog](../../backlog.md). Pinned by `outbox.test.ts`.

### A picked file is read at the pick (P1 of 1.8.1, 2026-11-26)

**The defect.** On Android, every attachment a member picked IN the app was queued with zero bytes
(`[OUTBOX] ... payload read in 53 ms (0 file bytes)`), then failed `the queued attachment holds no
bytes to upload` six times on the ladder until they withdrew it - five picks over three days - while
the same member's share-sheet sends of the same day went out (`305207 file bytes`).

**The cause, from the code.** The Android composer's pickers are `<input type="file">`
(`attachSources.ts`: only the iOS app goes native), so the `File` the WebView hands back is a VIEW
of another app's `content://` URI (wry's `RustWebChromeClient.onShowFileChooser` returns the
picker's URIs as they are), not bytes. `prepareMediaFiles` (`useMessaging.svelte.ts`) never read it
for a non-video - the compressor's decode of an empty view fails and `keepOriginal('decode-failed')`
stages the view itself - and the bytes were read ONCE, at the Send tap
(`new Uint8Array(await entry.file.arrayBuffer())` in `handleSendChat`), after the picker's round
trip through the background. That read RESOLVED with zero bytes instead of throwing (had it thrown,
the send's catch would have re-staged the file and no entry would exist), so the entry was written
with `fileBytes` empty and nothing between the pick and the upload could tell. A view reads back
empty when its provider states no length or streams nothing, or when its grant has lapsed. The
share sheet never met this: `IncomingShare.kt` copies the stream into the app's cache at once
([sharing](../sharing.md)), and the iOS app's pickers read every pick whole into memory
(`nativeAttachPicker.ts`, `take_picked_file`).

**The file was a Canari log export** (owner, 2026-11-26: `[APPLOG] exporting 22967 lines`, then the
in-app pick 11 s later). **Bench reading (Mi 9T, Android 16, 2026-11-26)**, a probe `<input
type=file>` in the app's WebView reading each pick at the pick and 10 s later:

| Pick | On disk | Provider states | `File.size` | Bytes read |
| --- | --- | --- | --- | --- |
| local screenshot (Photos) | 519 226 | - | 519 226 | 519 226 |
| Google Photos cloud item (system picker) | - | - | 4 276 039 | 4 276 039 |
| log export of 1.8.2-alpha.4, saved in "Mi 9T > Download", picked at once | 2 129 645 | 2 129 645 (MediaStore `_size`, within 3 s of the save) | 2 129 645 | 2 129 645 |
| log export of 1.8.2-alpha.7, saved in "Telechargements", picked at once | 2 141 102 | 2 141 102 | 2 141 102 | 2 141 102 |
| `canari-log-1.2.7-alpha.2-...-1210.txt`, saved before #3028, listed "0 octet(s)" in "Telechargements" | 269 916 | **0** | **0** | **0** |
| `canari-log-1.2.9-alpha.4-...-1312.txt`, same | 2 147 637 | **0** | **0** | **0** |

So **the WebView's `File` takes its length from what the provider STATES and reads exactly that
many bytes**: a provider stating 0 hands the composer an empty file whatever the disk holds - the
member's symptom, byte for byte. Today's save path (`write_staged_document`, #3028) leaves the
provider stating the real size on this phone, in both roots; the member's phone (not identified)
evidently did not, or he picked an export an older build had saved. Either way the read cannot be
trusted to a provider's statement, so the bytes are taken by reading the stream to its end.

**The fix.**

- **The Android file chooser hands the page a COPY** (`PickedFiles.kt`, called from wry's
  `RustWebChromeClient.showFilePicker`, patched in `patches/wry` and its generated copy): each picked
  stream is read to its END into `cache/picked_inbox/<pick>/<index>/<name>`, exactly as
  `IncomingShare.kt` copies a share, and the page gets this app's FileProvider URI for the copy,
  whose stated size is its real length. Refused like a share (not `content://`, our own authority, a
  grant the member gave Canari, a non-video over `ShareRules.pickCeiling`) or unreadable, a pick is
  handed over EMPTY under its name, so the page refuses it at the pick and says so. **A video has no
  ceiling there** (review of #4154): its encoder reads the source by ranges and stages its own output,
  so the composer always took a camera clip over 200 MB; only the disk bounds its copy. The hunk in
  wry is asserted by `wry-main-pipe-patch.test.mjs`, which a rebase dropping it fails. A stated size that
  differs from the bytes read is an ERROR line (`pick N copied: ..., but its provider states S`). The
  copies are swept by the next process (`PickedFiles.sweepOnce`), never under a page that may still
  read one (a video's encoder runs after the pick).
- **A save says what the provider records** (`write_staged_document`): the stream is flushed and
  closed, then `OpenableColumns.SIZE` is read back; a recorded size short of what was written is an
  ERROR, natively, in Rust and in the page (`[download] the provider took N bytes but records R`),
  and a provider stating none is a warning.
- **The bytes are read at the pick** (`ownPickedFile.ts`): every non-video is read whole once and
  replaced by a `File` backed by those bytes, so what is compressed, staged, queued and uploaded is
  what was read, and nothing downstream depends on another app's grant. A video already was: the
  encoder reads its source at the pick and stages its own output.
- **A pick with no readable byte is refused AT THE PICK** - `PickedFileUnreadableError`, typed
  `empty` or `unreadable` at the throw - with `chat_media_unreadable` on the composer's banner and a
  `[MEDIA] refused a picked ...` line; it is never staged, so it can never be queued. The ceiling is
  asked of the reported size before the read and again of the size read when the two differ.
- **The send proves it before writing anything**: a staged file that reads empty at the tap is the
  same typed error, nothing is written, the file is NOT given back (a second Send would refuse it
  again), and the banner says so.
- **The outbox fails an empty attachment for good at its first meeting.** It was a
  `LocalAttachmentError`, COUNTED toward `MAX_UNEXPECTED_ATTEMPTS` and retried on the ladder; it is
  now `OutboxAttachmentEmptyError`, classified at the throw, settled by `failPermanently(...,
  'empty-attachment')`: bubble to `error`, entry deleted, `outbox_attachment_empty` in the thread,
  metric cause `empty-attachment`, and an accusing line - reaching it means an enqueue path skipped
  the proof. A raw chat-reel take with no bytes keeps its counted `LocalAttachmentError`.

Pinned by `ownPickedFile.test.ts`, `useMessaging.mediaEnqueue.svelte.test.ts` ("a picked file is
read at the pick"), `outbox.test.ts`, `fileDownload.test.ts` and the gallery plugin's `commands.rs`
tests; the native copy is verified by compiling only until the reading below. The reading owed on the bench phone is
[a backlog entry](../../backlog.d/reading-picked-file-sent-from-the-gallery-and-a-cloud-item.md).

### What the picked file's copy tells the page (2026-11-26)

Follow-ups of #4154, from its review and the alpha.8 sittings.

- **A provider stating no size is not a warning.** Google Photos cloud items state none; the copy is
  read to its end, so nothing is lost, and every such pick logged a WARN. It is one debug line now,
  with the bytes read.
- **A pick over the ceiling is said as too large.** The page only ever receives an EMPTY file for a
  refused pick, which cannot tell "over 200 MB" from "unreadable", so the native side dispatches
  `canari-pick-copy` (`phase: refused, reason: too-large, name, limitMb`) on the WebView and the
  page (`pickCopyState.svelte.ts`) remembers it by file name; the pick's refusal then says
  `chat_media_pick_too_large`. A pick whose provider STATES more than the ceiling is refused before
  a byte is copied. Nothing is guessed from the empty file.
- **The copy's progress is drawn.** The chooser answers only after every copy is done, so a large pick
  showed nothing: the same event carries `start` and each whole percent of `progress` (only when a
  size is stated; a function of the bytes read, no timer) and `end`, and the composer draws one line
  (`chat_media_reading`, `chat_media_reading_percent`).
- **A video over 200 MB is still copied, deliberately.** The provider's stated size cannot be proved
  (it was 0 for the Downloads logs), so the stream is the only truth; the copy is sequential disk I/O,
  the encoder then reads it by ranges, and the progress line is what the member was missing. A copy
  that runs out of disk is refused as unreadable, said in the log.
- **One fact, one line for a save's recorded size.** Kotlin, Rust and the page each logged the
  mismatch at error; the page (`fileDownload.ts`) is the layer that knows the member's save and is
  the only one that accuses. Kotlin and Rust say it at debug.

Pinned by `pickCopyState.svelte.test.ts` and `useMessaging.mediaEnqueue.svelte.test.ts`; the native
half by compiling, then [a reading](../../backlog.d/reading-the-picked-file-copy-progress-and-too-large.md).

### A 2xx a captive portal answered is no answer (2026-10-25)

Under a captive portal every request is answered `200 text/html` without reaching the server. The
send read that as "accepted, its answer unreadable": the outbox dropped the entry, the sender saw a
sent bubble, and the copy stayed undated, so no history answer ever carried it either - a message
lost for good (cross-client rig, `1.4.1-alpha.3`, 2 of 2). **Who answered is now read before
what was answered**, in ONE helper (`utils/apiJson.ts`, `readApiJson` / `assertAnsweredByApi`):

| A 2xx with... | Read as |
| --- | --- |
| no JSON content type (a portal's HTML, an empty `204`) | `NotFromApiError`, the body never read |
| a JSON type, a body that does not parse (empty, truncated) | `NotFromApiError`, the parse error as its cause |
| the API's JSON of an unexpected shape | the API's answer - the caller reads what it needs |
| the send's JSON without `receivedAt` (a server predating it) | accepted, undated - the legacy reading, kept |

`NotFromApiError` is a `TransportFailureError`, so `isTransportFailure` reads it and every caller
already does the right thing: the send throws `DeliveryUnreachableError`, the entry stays `pending`
and goes again on the outbox's backoff ladder (up to 60 s after the portal ends - connectivity never
left "reachable", see [backlog](../../backlog.md)), and receivers deduplicate on the inner messageId.
The same reading covers the commit gate (kept and resubmitted, never a refusal), `GET` and `POST
/group-info` (never "no base", never `stored: false`), the key-group base on social-service, the
Welcome, both key-package publishes, the ACK (ids kept, then persisted), the pending pull (a non-JSON
or unparseable page fails at once instead of halving nine times), the push registration (not
counted, so it registers again), the media `complete` and the payments onboarding.

**A PURGE IS NEVER READ FROM A NON-ANSWER.** `getGroupServerStatus` answered `absent` - which purges
the local conversation and its MLS state - for any 2xx body that did not parse, so a portal's page
erased a conversation. `absent` now comes only from the delivery service's JSON. The server spells
a missing row `{ found: false }`, and "nothing stored" on `GET /group-info` `{ groupInfo: null }`,
because a handler's bare `null` leaves Nest as an empty, untyped `200` that a portal can send too.
Every older client already reads both objects as before. An empty untyped `200` is now `error`
(doubt, nothing purged). So is a **404**: the handler never sends one, so a 404 is an edge, a portal
or a misrouted deploy, and a route-level 404 would have purged EVERY group at once. `absent` is an
allowlist of one answer. Only the 404 is logged as an accusation; any other non-2xx or a portal's
`200` is the same answer for every group of a sweep, so `getGroupServerStatus` keeps it at debug and
`discoverMissingGroups` says it ONCE: `[DISCOVERY] <n> group(s) kept - server status unanswered,
nothing purged: <groups>`.

The same review of status-only arms changed four more places, each to the rule "a status decides
only when the API said it":
- The 403 behind `NotAGroupMemberError` (`fetchGroupInfo`, `getGroupMembers`) counts only with the
  gateway's JSON. A caller retires the conversation on it, and an edge's HTML 403 (a WAF ban page)
  says nothing about membership.
- `deleteGroupOnServer` no longer reads a 404 as "already gone". The route never sends one, so a
  delete for everyone was reported done with nothing deleted. A non-API 2xx is now no answer.
- An owed exit (`classifyExitFailure`) is forgotten only on the delivery service's own 403, carried
  as `GroupExitRefusedError.origin`. A 404 never forgets it (neither exit route sends one), and an
  edge's 403 or 404 keeps the row. `removeMemberFromServer` and `dismissGroup` read a non-API 2xx as
  no answer too, so a portal cannot clear an owed leave.
- A profile 404 (`isAbsentUserError`, which sends the session to the login page) counts only from
  core-service.
- The refresh's 401/403 latches the cookie dead and signs out only when core-service sent it. An
  edge's 403 is transient, like a 5xx.

The discriminator is the
content type `responseOrigin` already used for an edge refusal, plus the parse - facts the
response carries, never a guess from its words. **Where the reading DESTROYS something** (the
refresh's sign-out, the membership 403, the profile 404, the exit 403) the header is not enough: the
estate sits behind an edge that can answer an API client in JSON too. There `refusalOrigin` reads
one of the two shapes our services write: Nest's error envelope (`statusCode` equal to the HTTP
status, which every `HttpException` built from a string and every guard refusal carries because no
service installs an exception filter), or a coded refusal `{ code, message }` (`refusalBody`),
which Nest sends WITHOUT `statusCode` and which is believed only when `code` belongs to the shared
contract (`isContractRefusalCode`, `utils/refusalCodes.ts`). The membership refusals a removed
member meets (`NOT_A_MEMBER`, `MEMBERSHIP_NOT_ALLOWED`) are coded: an envelope-only first draft read
them as the edge's, so a removed member kept the conversation and an owed leave replayed for ever.
Any other JSON body (a CDN's `{ type, title, status, detail, error_code }`, an unknown code) is the
edge's, except the delivery service's 409 `{ error: 'awaiting_admission' }` to a pending member,
recognised (`isAwaitingAdmissionBody`) so its label is true although nothing destroys on it. The
gateway's own error pages (nginx) imitate the envelope for 413/429/5xx and for a 404 under
`/api/media/public/live/`; no destructive reader acts on those statuses or on that route. A refused
exit also carries the service's `code` (`GroupExitRefusedError.code`), which changes no outcome and
names the answer in the drain's log (`KEY_DISTRIBUTION_GROUP` has its own line). A best-effort
server delete nothing retries (a failed creation's orphan, a merged duplicate) logs its failure
through `logBestEffortGroupDeleteFailure`. `getGroupServerStatus` reads `absent` from `{ found:
false }` alone; any other JSON without an id is `error`. The remaining header-only readers (the send's edge refusal, media, live, resumable upload)
only choose between retrying and reporting, so a misread there costs a retry, not a state. The log line an operator reads is
`[DELIVERY] send to <group> answered 200 with no answer of the delivery service - not accepted, kept
for a retry: NotFromApiError: POST /api/mls/send (group <group>) answered 200 with text/html... -
not the API, read as no answer`.

**Not covered**, each in [backlog](../../backlog.md): a 2xx a caller believes WITHOUT reading
anything (`renameGroup`, most `apiFetch` writes), the Android background
senders, and connectivity's reading of a portal as "reachable". Pinned by `apiJson.test.ts`,
`mlsDeliveryApi.notFromApi.test.ts`, `mlsDeliveryApi.groupStatus.test.ts`,
`ChannelService.notFromApi.test.ts`, `outbox.test.ts` and the two chat-delivery controller specs.

`enqueue` logs too: it is the first trace of a message on this device, and without it a send that
never reached the queue cannot be told apart from one the queue accepted and lost. Correlating a
loss needs `[OUTBOX]` from the sender and `[QUEUE]` from the recipient at the same moment.

## Message envelope

All messages are serialized as a `MessageEnvelope` union before MLS encryption:

```typescript
type MessageEnvelope =
  | { type: 'text'; content: string; replyTo?: MessageReference }
  | { type: 'media'; mediaId: string; fileName: string; mimeType: string; cek: string }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | { type: 'edit'; targetMessageId: string; newContent: string }
  | { type: 'delete'; targetMessageId: string }
  | { type: 'system'; event: string; data?: unknown }
```

`appMsgToEnvelope()` (`utils/chat/messageUtils.ts`) is the canonical decoder (protobuf AppMessage ->
MessageEnvelope).

### A voice note declares itself, because nothing downstream can tell

**A recording and an imported `.m4a` are the same bytes with the same mime type.** By the time a
message is read there is no inspection that separates them, and the only remaining difference is the
`vocal_<timestamp>` file name the recorder happens to choose - a distinction carried in prose, which
the next file manager breaks and which `ChatComposer.isAudioFile` already refuses to read for exactly
that reason.

So the sender declares it, at the ONE point in the application where the gesture is known:
`sendVoiceNote` stamps `voiceNote: true` on the staged file, and it travels the whole way -
`MediaRef.voiceNote` in the envelope, `MediaMsg.voice_note` (field 11) on the wire, and
`OutboxMediaPayload.voiceNote` through the queue for the MLS path, which re-encodes the proto long
after the composer is gone. `kind` stays `MEDIA_KIND_AUDIO` either way: this says how the audio was
PRODUCED, not what it is, and the two are orthogonal.

**Absent is UNKNOWN, never "imported".** protobuf decodes a missing `bool` as `false`, so both
decoders drop a `false` rather than write it into the envelope - a message from before 2026-09-17
says nothing about its provenance, and must keep the behaviour it has always had. That is the whole
reason the field is written as `...(x ? { voiceNote: true } : {})` in four places instead of a plain
assignment.

**What it decides today** is the shared-content panel: `aggregateSharedContent` drops a declared
recording and keeps everything else (user, 2026-09-17: *"Les vocaux ne doivent pas s'afficher dans
l'onglet 'Medias' d'une discussion. +1 s'il est possible de mettre les fichiers audios qui ont ete
importes pour les differencier des audios enregistres directement dans la conversation."*). A voice
note is a turn in the conversation, like the sentence it replaces; a file someone picked from disk
is something they chose to send, and it stays under Fichiers where it was.

**An import cannot say so on the wire, and the file-name rule is load-bearing.** `voiceNote` travels
as `true | undefined` and never as `false` (`envelope.ts` emits the key only when true), so an import
is always UNDECLARED, and `isVoiceNote` separates it from an undeclared OLD recording by the
`vocal_<digits>` name. An audio file a person happened to name that way is hidden from the tab. The
fix is sender-side - the import path declares `voiceNote: false`, or the flag becomes a
`source: 'recorded' | 'imported'` the sender must set - and nobody has hit the collision, so it is
not built. Do not delete the name rule as a heuristic: it is what keeps pre-2026-09-17 recordings
out of the tab.

**A push reads the field, and words its sentences in the app's language (WP-PUSH-I18N, built
2026-10-18, not shipped).** The Rust push scanner (`mobile/proto_fields.rs`,
`extract_full_message_info`) decides WHAT a decrypted message is and reads `voice_note` (field 11)
beside the `MediaKind`: a declared recording is announced `Message vocal` / `Voice message`, an
undeclared audio (an import, or a recording from before 2026-09-17) `Fichier audio` / `Audio file`.
Every sentence it composes - the system events, `a réagi {emoji}`, the media placeholders (a
CanaReel's included since WP-RC-7, declared by `MediaMsg.intent` the same way:
[reels-in-chat](reels-in-chat.md#push-text)), the poll line, the two call lines and the
`événement de groupe ({event})` trap - is written ONCE, in both
languages, in `mobile/push_text.rs` (`PushText::render`): a closed enum whose exhaustive `match`
refuses to compile a sentence written in one language only, and a test that writes out all of them.
The text somebody TYPED passes through untouched.

**The language comes down with the call, it is not looked up.** Each native caller passes the
`locale` it already read from `push_context.json` (the mirror `set_push_context_locale` writes) to
`nativeDecryptMessageWithKey`, `nativeDecryptMessageWithCommitsWithKey` and `nativeOpenGrainePush`
on Android, and to their three `canari_native_*` twins on iOS (the NSE and `canari_push.mm`).
`PushLanguage::from_tag` reads `en`/`en-*` as English and everything else - the empty tag of a device
that never mirrored its choice included - as French, the base locale. Android's own tables fall back
to the OS locale in that one case, so the two may disagree on a device that has never opened a build
that mirrors the locale; a device that has, cannot. Why Rust and not a KIND worded natively: the text
is what the FCM cache persists as a message body, and one implementation keeps Android and iOS from
diverging ([mobile](../mobile.md#the-language-a-notification-speaks)).

### "Format non supporte" names its cause in the log (2026-10-18)

`VoiceMessagePlayer` draws "Format non supporte / Telecharger" on ANY `error` event of its `<audio>`
element, and four causes reach that event: an abort (`MediaError` code 1), a revoked or unreadable
blob URL (2), bytes the engine cannot decode (3), a container it does not know (4). Two voice notes showed the label
on the Mi 9T on 2026-10-06 while an iPhone listed them, and the branch logged nothing, so the cause
could not be read. It now writes one `[voice] the audio element refused its source` warning carrying
the code and its name, the engine's message, the type the message declares and the engine's
`canPlayType` answer for that type: `canPlayType` "no" means the engine lacks the format, a
"maybe"/"probably" with code 3 or 4 means the bytes are not what the message declares. **Owed: the
line from the Mi 9T on that conversation** ([backlog](../../backlog.md)).

### A system event is executed, never displayed

**`appMsgToEnvelope` returns `null` for a `system` AppMessage, and that null is load-bearing.** Every
call site that can receive a control event is written as `if (envelope) { display } else if
(msg.system) { handle }` - `handleKnownGroup` and the Welcome buffer in `setupMessageHandler`, the
replay in `history.ts`. Make it return an envelope and those handler branches become dead code: the
event is never applied and its JSON payload is rendered as an ordinary message attributed to the
sender. That is exactly what a `msg.system` branch added to it in `7e9d66e8` did until 2026-08-03.

### A salon's membership notice carries ids (2026-11-16)

A **channel** notice is the one system message that travels as pre-rendered text: `inviteMemberToChannel`
sends `mkSystem('memberAdded', <localized sentence>)`, freezing the inviter's language and a display
name into the frame. Its replacement is `{ "newUsers": [id] }` - the group's own `memberAdded`
payload - still SILENT (neither unread nor a ring), and it ships in TWO releases, reader first:

- **The reader (`1.7.0`).** A channel has no per-event handler, so the two decode sites -
  `channelEventHandler` (`channel.message.created`) and `decodeChannelMessageRow` (history + search) -
  call **`channelSystemEnvelope`** (`utils/chat/channelNotice.ts`), which classifies the data AT THE
  SOURCE: a JSON object is the id shape, drawn by the ONE notice rendering (`visibleNoticeContent`,
  the actor being the ROW's sender, never a payload field); anything else is a legacy sentence,
  wrapped by **`appMsgToChannelSystemEnvelope`** as before. Ids that name nobody draw nothing and say
  so once per decode. `channelNotice.readers.test.ts` runs both decode sites on an id frame.
- **The writer.** `channelMemberAddedData` sends `{ "newUsers": [id] }`, always. It sent the
  inviter's localized sentence until the floor reached the first stable carrying the reader (`1.7.0`):
  a build older than the reader draws `system.data` as text, so an id frame would have reached its
  screen as raw JSON ([legacy-compatibility](../../legacy-compatibility.md#entries-170-retires-the-floor-raise-of-both-estates-once-both-stores-serve-170)).

Both shapes are attributed to `'system'` with `isSystem: true`, so the row renders centred and
neutral. `ChatMessageGroups` centres on the ROW flag; the `system` envelope kind only gives the pill.
A sentence row is never rewritten, so the legacy branch of `channelSystemEnvelope` stays for as long
as an archive holds one.

The archive replay of a group stream (`historySystemEvents.ts`) parses `system.data` in its own guard:
unparseable data is skipped with one `[HISTORY_REPLAY]` line, as the live handler does, never thrown and
never read as an event with no data.

### `memberLeft` had a reader and no writer, for as long as it existed

The table above lists FIVE live branches today and listed four until 2026-09-16. `memberLeft` was
the missing one, and nothing about it looked broken from either end: `leaveGroupAndBroadcast` sent
the frame, the archive held it, `applyReplaySystemEvent` rendered it, and `strayLeaves` even carries
a paragraph saying it broadcasts nothing itself **because "the leaver already sent `memberLeft` and
every remaining member rendered it"**. No member ever had. A departure drew nothing at the moment it
happened, and then appeared on that member's next archive replay - at its place in the scrollback,
which reads as something that happened days ago.

**It is the shape of defect a per-event branch invites**: an unknown event is ACKed and ignored by
design, so the only way one is missing is by reading the two paths against each other. The frame's
own id (above) is what makes adding the branch safe - the live notice and the replayed one are the
same row rather than two.

**The branch owes one check the others do not.** `memberRemoved` names its target in a payload
field, and the party that may send it is the admin doing the removing; `memberLeft` names the
LEAVER in a payload field, and the only party who may announce that is the leaver. The identity MLS
authenticated is `senderNorm`, so the branch refuses any frame whose `userId` is not its sender -
otherwise any member could announce any other member's departure to the whole group. The replay
makes the same comparison against the stream row's `sender_id`, so the archive cannot render what
live delivery refused. Same principle as `mutationIsAuthorised` one screen up: **a payload field is
a claim, the MLS sender is a fact.**

**And it draws nothing for our own departure.** MLS never returns a frame to the client that sent
it, so a `memberLeft` naming us can only come from another of our own devices - which is about to
lose the conversation anyway, because leaving de-registers the USER and `verifyMembership` then
retires the row on every device. Telling that device "you left the group" first would write a notice
into a conversation about to disappear.

### "Envoyer l'historique des messages" under a member's addition (owner, 2026-11-25)

Under a `memberAdded` notice of a ready private group, `MessageBubble` draws one button per added user
the caller offers (`offerHistoryTo` = `useConversations.canSendHistoryTo` = `canOfferHistoryTo`: still
on the roster, not the viewer, and the served `minClientVersion` at or above
`HISTORY_GRANT_NOTICE_FIRST_VERSION` - every admitted build draws the notice, principle 1). It opens `HistoryGrantDialog` (24 h, 7 days, 30 days, everything, or
a past date), whose send is `grantHistoryToNewcomer`; a `historyGranted` notice carries an "En savoir
plus" disclosure. The mechanism, its checks and its settled design points:
[history-reconciliation](../../protocols/history-reconciliation.md#a-member-may-send-their-history-to-a-newcomer-owner-2026-11-25).

### A visible system notice needs an identity the SENDER minted

A notice the members are meant to SEE - a member added or removed, a rename, a new photo, a deleted
group - is written by **two paths that never meet**, and copied between devices by a third:

| path | where |
| --- | --- |
| live delivery | `systemMessageHandler.ts`, the `memberAdded` / `memberRemoved` / `memberLeft` / `groupRenamed` / `groupImageChanged` / `groupDeleted` branches |
| archive replay | `historySystemEvents.ts`, the same events re-read from `history:{groupId}` |
| a peer's `history_bundle` | `serializeForBundle` copies the row, **with the id that peer stored** |
| the acting device itself | `sendVisibleNotice` (`visibleNotices.ts`) writes its own row under the frame's id once the frame is accepted, since MLS never hands it that frame (2026-10-25, [history-reconciliation](../../protocols/history-reconciliation.md#the-acting-device-writes-its-own-notice)) |

**Every deduplication in the application compares ids** - the bulk-ingest check in
`addMessageToChat`, the bundle's `existingIds` set, the post-save merge. So a notice with no id
cannot be deduplicated by anything: `addMessageToChat` ends on
`normalizeMessageId(options.messageId) ?? crypto.randomUUID()`, and each of the three paths minted a
different one for the same event.

**What that cost, measured on production 2026-09-16.** A 31-member group, one `memberAdded` commit,
**one** frame in the archive - and four identical notices on a member's screen, durable, on disk. The
multipliers were in the same ten minutes: 13 full `after=start` archive walks and 37 reconciliation
answers. Ordinary messages were untouched, because they have carried a `message_id` since they were
introduced; the notices were the only rows in the conversation with no identity at all.

**The fix is `mkVisibleSystem` (`proto/codec.ts`)**, which mints `messageId` and `sentAt` at the send
site exactly as `sendMessage` does for a text frame. Both readers then use it: the live path takes it
through `SystemEventContext.messageId`, the replay through `parsed.messageId`.

**Why the sender's id and not a derived one.** An id derived from the event payload collides when the
same person is added twice; an id derived from the ciphertext agrees between the live and replay
paths of ONE device and disagrees between two, because MLS re-encrypts per recipient - and agreeing
between devices is precisely what the bundle needs. A sender-minted id is the only one that
converges everywhere. `channel_invitation` is the exception that already worked: it derives from
`channelInviteMessageId(channelId, inviteeId)`, which both sides can compute because the invitation
names exactly one invitee.

**A channel notice never had the problem.** Channel messages are server-authoritative, so
`decodeChannelMessageRow` takes `id: String(row.id)` - one identity, issued by the server, shared by
every reader. **The salon's own `memberAdded`** (`inviteMemberToChannel`) is a frame the SENDER writes,
and it too goes through `mkVisibleSystem` since 2026-11-23 (an id-less one had nothing to dedupe on
across a replay or a re-fetch); `useChannelWorkspaces.svelte.test.ts` pins the minted id.

**The salon seams of the push cache and of the history page** (2026-11-23). `fcmMemoryMerge.ts`
refuses a `channel_` id with a warning: the native side never caches a salon push, so the guard is
defence in depth for a seam that would otherwise invent an MLS-style placeholder row for a salon.
**ACCEPTED RISK, written down rather than guarded:** the live frame and the history page key a salon
row by the same field (`messageId` alone, #2248). Should the server ever give ONE row two ids, the
first path to open it claims the key and the other is refused as a replay - a duplicate-free
outcome, with the row drawn once; there is no second id to guard against today.

Pinned by `systemMessageHandler.noticeIdentity.test.ts`, which asserts the convergence property
directly: one frame handed to both paths produces one id. Old frames carry none and stay
duplicate-prone - [legacy-compatibility](../../legacy-compatibility.md).

### A visible notice is dated by its FRAME, never by when this device learnt of it

**The sender's id was half of what the frame owed the row; its date was the other half, and the
live path dropped it.** `mkVisibleSystem` mints `sentAt` beside `messageId`, and the delivery says
when the server accepted the frame (`queuedCreatedAt`) - yet every notice branch of
`handleSystemEvent` wrote `{ isSystem: true, messageId }` and nothing else, so `addMessageToChat`
(`resolveMessageTimestamp`) dated the row `new Date()`: THIS device's clock at the moment its drain
reached the frame. The live receiver was the visible defect, but not the only one: the acting device
(`sendVisibleNotice`) wrote `frame.sentAt` with NO `serverTimestamp`, so its copy was ordered by a
different key than every member's, and the archive replay wrote no `serverTimestamp` either and fell
back to `new Date()` on an unreadable history time.

**What that cost (owner, v1.6.0, iPhone, 2026-11-01).** A group created on the PC with two members,
a conversation in it, and the phone opening the group for the FIRST time: its queue drained the
`memberAdded` frame hours late, the notice took that instant as its order key, and "X a ajouté A, B
au groupe" sat BELOW every message that followed the addition. The messages themselves were right,
because a received text row has always carried its `sentAt` and `serverTimestamp`. The row was
written once and the replay deduplicates by id, so the wrong date was durable.

**The fix is `receivedNoticeTime(sentAt, queuedCreatedAt)` (`visibleNotices.ts`)**, read through ONE
writer in `handleSystemEvent` (`writeNotice`) by every notice branch - the five membership notices,
`groupDeleted`, and both channel invitation cards. It dates the row exactly as a received text row is
dated: `timestamp` the frame's `sentAt` (the server acceptance for an older frame that carries none),
`serverTimestamp` the server acceptance, which is the order key (`messageTime`). Both
`setupMessageHandler` call sites (the live frame and the Welcome buffer) pass `sentAt` in the
context. **With neither time the row is NOT drawn**, refused at ERROR (`[NOTICE] REFUSED to draw`):
every delivery route of this build carries the server time, so reaching it means a route lost it, and
the local clock is never a stand-in for when an event happened.

**Every copy of a frame's notice now carries the same order key.** The acting device's own row takes
`serverTimestamp` from its send's answer (`SentFrame.receivedAt`), exactly as an own text row gets it
through `patchServerTimestamp`; an answer with no receive time is reported at ERROR. The archive
replay (`historySystemEvents.ts`) dates through the same `receivedNoticeTime(sentAt, <history row
time>)` and is REFUSED at ERROR (`[HISTORY_REPLAY] REFUSED`) when neither time is readable.

**A row this device derives from SOMEONE ELSE's event is dated by that event - each with a named
authority, and refused at ERROR when it has none. Never the local clock.** (A row recording this
device's OWN act - an outbox failure line, a channel invitation it sent, the older-messages notice - is
dated by that act, which is this device's clock by definition; it is out of this rule.)

| Row | Authority | No authority |
| --- | --- | --- |
| Device line, uninvited-entry line (`deviceNotices.svelte.ts`) | The commit log row (`mls_commit_log.createdAt`) of the commit that admitted the device: `baseEpoch = event.epoch - 1`, read through `GET /api/mls/commits/:groupId/accepted-at` (members only, and never a commit older than the one that admitted the requester - a newcomer is not handed the past). **The floor is the commit that ADMITTED the requesting device, recorded on its seat by the commit gate** (`dm_device_group_memberships."admittedByBaseEpoch"`, migration 044, owner 2026-11-02): written with the advance on every admission - a member's Add (`admits`, and the target of the Welcome it carries), an external join (the committer's own commit), the group's creation (`0`), and a key group's creating publisher (the published epoch, only on a seat with none) - and never cleared by activation. Both kinds of group are floored per DEVICE. **It replaced a clock**: the floor was "the last commit accepted at or before the arrival" (the open stretch's `admittedAt ?? joinedAt`, a key-group row's `createdAt`), and both arrivals could predate the admission - a group conversation's `joinedAt` is written by the enrolment before the Add, so the floor landed one commit early, and a device kicked and re-added kept its first row, so it was answered the commit times from while it was out (review of #2890, LOW-D; acceptance times only, never content). A re-add now moves the floor past them. **A kick clears the admission** (`deactivateDeviceMembership` with `removedFromTreeAt`), a demotion with no kick (the stale-device cron, a self-report) leaves it, the leaf being still in the tree; a commit's DECLARED admission (`admits`, a Welcome target) is written on a `pending` seat only, so it cannot raise an active seat's floor. **An ACTIVE seat with no recorded admission is floored at its group's CURRENT epoch, and that is written once** (`admissionInferred = true`, refuse rather than leak, never refused for ever): migration 044 did it for every active seat at the deploy - the cost being that a line about a commit accepted before the deploy and merged after it is settled undated - and `commitFloorOf` does it at the first ask for an active seat the backfill could not reach (admitted by a replica still on the old code during a rollout, an aborted rollout, a rollback, or a seat the cron demoted and a report re-activated with no commit), ERROR once; the write is conditional on the seat still being active, unkicked and floorless, so a kick mid-ask wins. **A PENDING seat is never inferred** (owner's review, 2026-11-02): enrolled and not yet admitted, an inferred floor would hand it every commit time until its Add - the past a newcomer is not handed. It is floored only by the admission the gate wrote while it waits (`admittedAtEpoch - 1`, also 044's exact backfill), and otherwise refused quietly (`log`), as is a kicked seat. A refusal before an inferred floor is said at `log` (it refuses by design), before a recorded admission at WARN. Also refused at `log`: a member whose device holds no seat (a pending seat the 14-day cleanup purged while its owner stayed on the roster - it never processed a Welcome, so it has no commit of its own to ask about). **A rollback across 044 is the accepted cost, with a named roll-forward**: the old code neither clears a floor on a kick nor records one on a re-add, so a seat kicked and re-added while it ran keeps a stale LOW floor, and nothing distinguishes it afterwards - rolling forward means setting every floor back to NULL and re-running 044's two UPDATEs, a data change the owner approves then. Asked with no `X-Canari-Device` (either kind) is a 400. The floor is one row read by its unique key; no commit-log walk any more. Chosen over the commit frame's own `queuedCreatedAt` because it is ONE answer on every device and survives a restart, where the delivery time exists only for a device that drained the commit live (a Welcome-joined device never did). **A contact line in a DM or a group is dated by a commit of ANOTHER group** - the one where the device was first seen, often a community's key group - so it sits at the instant the device was admitted anywhere, not at an event of the conversation it is written in. Asked once per commit for the session (`cachedCommitInstants`): a log row never changes | The four answers are typed at the throw (`ServerInstant`, `serverInstant.ts`). No row (`none`): `[DEVICE_NOTICE] line settled UNDATED`, at the level of the server's `reason` - `pruned` at log (the retention working), `not-yet` at warn, `hole` (or no reason, an older server) at error. A 403 (`refused`: left the group, or a commit before the requester's arrival): settled, no warning - asking again could only be refused again. A 404 (`unserved`: this server does not serve the route, a build that shipped before its backend): ONE `[COMMIT_AT]` error for the session, the line PARKED - owed, not asked again. No answer (transport, 5xx): owed to the next delivery. An uninvited entry is reported (`[MLS] UNINVITED ENTRY`) only once its time is answered, so an entry kept owed is not accused at every drain |
| Eviction notice (`recordEviction`) | The Remove commit's delivery time (`remove-commit` delivered live), or the removal announcement's (`system-event`). Every other evidence - a Remove commit applied through the replay (`commitReplay.ts` carries no delivery time), `inbound-frame`, `membership-check`, `outbound-refusal`, `server-refusal` - asks the server for its OWN seat's removal: `GET /api/mls/groups/:groupId/own-removal`, the person's closed membership stretch (`leftAt`) or this device's kick (`kickedAt`). It reads only the requester's own rows, so a removed device may ask; the members-only commit log could not answer it | The server holds no record (`none`, `refused`): `removal notice REFUSED`, said once per group (only the call that retired the row speaks), settled, and not asked again this session. **No answer - `unserved` (404), a throw, or a write that failed - leaves the line OWED, durably** (`removalNotice.ts`, `ACCOUNT_KEY.owedRemovalNotices`): the retired row receives no further evidence, so the next evidence for the group asks again and, at the latest, `drainOwedRemovalNotices` asks after the next session's restore (dropping a group re-admitted or gone). One write runs at a time per account and group, and **the row is re-read after every await**: the line is written only while the row is still `removed` and holds no line of THIS removal (the lines the thread held when the evidence retired the row are an earlier removal's, and kept in the owed record so the next session tells them apart), so a removal undone during the ask (a Welcome installing, which `retractEvictionNotice` cannot yet see) writes nothing - the 2026-09-22 rule kept across the ask - and two evidences landing together, whose instants differ (the Remove commit's delivery, the announcement's), write one row. The id is `evicted:<groupId>:<removedAt>`. An answered "no instant" is remembered per account and per session (cleared by the sign-out, said when it skips an ask), and the restore drain stops when its session ends; a live evidence whose row leaves the map during the ask (a sign-out clears it) keeps the line owed rather than settling it, and the next drain decides. The eviction itself and its banner never wait on either |
| Call record (`callSystemMessages.ts`) | A received signal: its frame, `receivedNoticeTime(sentAt, queuedCreatedAt)`. This device's own act (`CallService`): the ONE instant the act is stamped with, shared with the frame's `sentAt`, plus the send's `receivedAt`. **The end record is written AT THE ACT, never held for the hangup's send** (a catch-up gate or an epoch barrier can hold a send for minutes, and a kill meanwhile left the row unfinalised); the server's acceptance is patched in when the send answers (`onCallEndAnswered` -> `patchCallRecordServerTime`, like `patchServerTimestamp`). **The duration is measured on ONE clock** (`callDurationMs`): the server's acceptances of the invite and of the end when both are known; otherwise, only for an end that is this device's own act (`ownAct`), its own two instants - the start row's `startClocks.local` and the act's stamp. Never the clock at finalisation: a remote end drained hours late would measure hours. The hangup's server time is patched only onto a row the END wrote (no started row on this device), never onto a started row whose invite's send answered none. **Known imprecision**: `startClocks.local` is when THIS device wrote its start row, so a callee launched cold by a native ring (iOS) starts its clock at the drain, possibly after the answer - its own-end duration then reads short by the cold launch, whenever the server time is missing on either side. `startedAt` is the inviter's clock, and subtracting this device's end from it measured one phone against another | A received signal with neither time: `[CallRecord] ... REFUSED`, no row. A duration with no single clock (a start row with no `startClocks`, which only a build before `1.6.2` wrote and the floor retired; or a received end with no server time) mixes two clocks and says so at `console.error` |

A row already written with the wrong date by an older build keeps it. Pinned by
`systemMessageHandler.noticeTime.test.ts` (a group drained six hours late keeps its notice above the
conversation, in either processing order), `setupMessageHandler.noticeTime.test.ts` (both entry
points of the pipeline, live and Welcome-buffered, and a call signal), `visibleNotices.test.ts` (the
own row and the replay), `deviceNotices.svelte.test.ts` (each of the four answers),
`serverInstant.test.ts` (the classification and the cache), `recordEviction.onePolicy.test.ts` (every
site dated, and the refusal said once), `callSystemMessages.outcome.test.ts` (two skewed clocks) and
`removalNotice.test.ts` (an unanswered removal kept owed and written by the next evidence or the next restore, one line for two evidences), and the server's `messaging.commit-log.spec.ts` (the arrival floor failing closed, the reasons, the own removal) and `commit-time.integration.spec.ts` (the floor against PostgreSQL: a key-group admission and a publisher that cannot lower it, a group admission whose enrolment predates the Add, a kick then re-add, and migration 044's backfill of the pre-column rows).

### A mutation event is authorised on RECEIPT, by the MLS sender

`delete_message` and `edit_message` name a target by `messageId`. `handleSystemEvent` resolves it and
then calls **`mutationIsAuthorised(target, senderNorm, kind, log)`** (`systemMessageHandler.ts`),
which applies the mutation only when `target.senderId === senderNorm` (case-insensitive; an empty
`senderId` never matches). A refusal returns `true` - the event is consumed, not re-queued - and logs
`[MLS] Refused an edit|a delete of a message owned by … - only the author may mutate it`.

**Why the receiving side.** `isOwnMessage` gates the edit/delete controls, but it runs on the device
that SENDS the event: it decides what an honest client puts on the wire and nothing about what a
modified one can. Until 2026-08-12 the handlers applied the mutation by id alone, so any member of a
DM or group could delete or rewrite any other member's message on every device in it. A channel is
different - the server owns channel content and checks ownership itself - and that asymmetry is the
trap: DMs and groups are exactly the places where the server *cannot* check, being unable to read
them.

`senderNorm` is the identity **MLS authenticated for the frame**, which is what makes the check
sufficient rather than advisory: a member can lie about the message id, never about who it is.
Covered by `systemMessageHandler.mutationOwnership.test.ts`.

### And then it is ORDERED, because two devices can edit at once

Authorisation says whether an edit may apply. It does not say which of two edits wins, and until
2026-08-22 nothing did: `edit_message` was applied on arrival by all three paths that apply one - the
live handler, the history replay (`historySystemEvents.ts`) and the sending device's own optimistic
write (`useMessaging.handleEditMessage`). "Whatever arrived last" is a different answer per device.
Two devices of one account edited one message; each applied its own, then took the other's; they
ended on OPPOSITE bodies and never moved again. No error, nothing on screen. The campaign's MUT-18
exists for this and caught it.

**`editSupersedes(next, held)`** (`utils/chat/editPrecedence.ts`) is the total order, and all three
paths consult it: strictly later `editedAt` wins, a tie goes to the greater content string. A row
carrying no `editedAt` has no edit to defend, so anything supersedes it. A refusal in the live path
logs `[MLS] Dropped an edit of … - the row already holds a later one`.

**Why a wall clock is acceptable here**, when this repo distrusts them everywhere else. Convergence
does not need the RIGHT winner between two concurrent edits - there is no such thing - it needs the
SAME winner on every device. `editedAt` is stamped by the editing device, so two skewed clocks change
WHICH edit survives and cannot make two devices disagree, because each decides from the same pair of
values. Arbitrary-but-agreed is a correct rule; arrival order is not a rule at all. The tie is broken
on content for the same reason: two devices must reach one answer from one pair.

**The same act carries ONE instant.** `editMessage` takes `editedAt` from its caller and
`handleEditMessage` writes that same value locally. Both used to read the clock separately, so the
sending device stored a timestamp milliseconds off the one it broadcast - invisible while the value
was only displayed, and a device able to lose to its own frame once it decides the winner.
`handleTogglePin` had always done this correctly and says so in place.

**A DELETE OUTRANKS EVERY EDIT, whatever the order.** `edit_message` never checked `isDeleted`, and
the tombstone is carried in `content` - so an edit landing on a deleted row restored the deleted text
on screen, italic and faded, which is the one thing a delete exists to prevent. It is reachable the
same way the ordering defect was: two devices of one account, one deleting while the other edits.
The live path and the replay now both refuse an edit of a deleted row (`a tombstone is final` in the
log), which is the rule the archive's post-save pass in `history.ts` has always had
(`if (deletion) ... else if (edit)`) and the campaign asserts for merges in MUT-7. Three appliers,
one invariant, and it was in one of them.

**THE FOUR APPLIERS, enumerated 2026-08-22**, because an invariant held in one of them is not held.
Every place a message mutation is written was found by grepping the writes themselves
(`isEdited: true`, `isDeleted: true`), not by reading the paths one expects:

| Applier | Ordering | Tombstone |
| --- | --- | --- |
| `systemMessageHandler` live path | `editSupersedes` | refuses an edit of a deleted row |
| `historySystemEvents` replay | `editSupersedes`, plus the deletes seen earlier in the page | same |
| `history.ts` post-save pass | last edit in the page | `if (deletion) ... else if (edit)` - always had it |
| `systemMessageHandler` `history_bundle` merge | `editSupersedes`, body taken ONLY from the author's own bundle | replaces the body with the tombstone (D5) |

The bundle merge is the interesting row. Any member's bundle may set the `isEdited` FLAG and fill a
missing `editedAt`, but the edited BODY is taken only when the peer that answered the history request
IS the message's author - the check the live path makes with `mutationIsAuthorised` - and then
ordered with `editSupersedes`. Taking any peer's body on a date comparison would let one member
rewrite another's message on the receiving device: `editSupersedes` decides which edit wins, never
who may edit (2026-10-04, `systemMessageHandler.bundleEdit.test.ts`). A device handed the edit by a
NON-author still shows the pre-edit body marked "edited"; closing that needs the author's own signed
edit on the wire.

`pinStore.supersedes` is the same pattern for the pin register, and predates this: the argument was
written down there before it was applied here. Covered by `editPrecedence.test.ts` and
`systemMessageHandler.editPrecedence.test.ts`, the latter asserting the convergence property by
replaying one pair in both orders.

### An edit carries a TEXT, and the reply quote lived in the BODY (2026-09-21)

`edit_message` carries `{ messageId,
newContent, editedAt }`, and `newContent` is what the author typed. All four appliers wrote it
straight into `content` - which is the SERIALIZED ENVELOPE, and the envelope is the only place a
reply reference exists: `toMessagePayload` has no `replyTo` key and `mapStoredMessagesToChatMessages`
never rebuilds one, so editing a reply DELETED its quote from the row. The editing tab went on
showing the quote out of the in-memory `ChatMessage.replyTo` set at send time, so the loss looked
like a peer-side defect - it was reported as one, two screenshots of one message, quoted on its
author's PC and bare on the peer's - and one reload would have lost it there too. `applyEditToBody`
(`envelope.ts`) is the one implementation: it parses the stored body, replaces the text (or a media
envelope's caption - reachable from the UI since 2026-11-11, [below](#a-media-messages-edit-is-a-caption-edit-2026-11-11)), and
re-serializes, so every field the edit does not carry survives it.

**THAT MADE THE TIE-BREAK READ THE ENVELOPE TOO**, and it is the part worth keeping. `editSupersedes`
broke a tie on `next.content > held.content`; once the held side is a serialized envelope and the
incoming side is raw text, the two devices holding one pair compare different kinds of string, both
refuse, and each keeps its own body for ever - MUT-18 again, re-entered through the storage shape
instead of the arrival order. Both sides now go through `envelopeBodyText`, so the rule compares two
replacement BODIES, which is what it always meant. `editPrecedence.test.ts` runs each pair both ways
round with the held body stored as an envelope, which is the shape a row actually has.

**AND THE ROWS ALREADY DAMAGED ARE REPAIRED ON A REPLAY, which is the only occasion their original
frame is in hand again.** The batch write of a replay had two claims on a body - the frame just
decrypted and the row already held - and gave the whole body to the held row whenever it was
flagged `isEdited`. That was right while an edit wrote a whole body. `replayedRowBody`
(`history.ts`) splits it instead: the TEXT is this device's, because the event that produced it may
already be in `seenCipherHashes` and will never replay again, and the BODY is the archive's, which
is where the reply reference still exists. A row edited before this fix therefore gets its quote
back the next time its conversation is replayed; nothing repairs one that is never replayed, and
nothing can - the reference is not in any copy this device holds.

The quote itself also had a left padding and no right one, so its text ran into the bubble's edge;
`MessageReplyQuote` was padded on both sides. **That component is no longer a strip inside the
bubble at all since 2026-09-22** - it is a second, receded bubble stacked flush above the reply,
under a caption row naming who answered whom (worded by `utils/chat/replyCaption.ts`: when the sender header is already drawn above, the caption drops the replier and reads "A répondu à <quoted author>" / "A répondu à son message"; without a header it names both; an unknown quoted author gives the name-less form), measured off the reference in both themes:
[design-reference section 37](../design-reference.md). Nothing above changes: an edit still has to
preserve the envelope's `replyTo`, and the quote is still drawn from it.

Covered by `envelope.editBody.test.ts`, which owns the body rule, and by one case in
`systemMessageHandler.editPrecedence.test.ts` asserting that an edited reply keeps its quote in
memory AND at rest - the second half is the one that matters, since the row is all a reload gets.
`historySystemEvents.test.ts` covers the replay applier and `history.replayedBody.test.ts` the
repair, including the shape a damaged row actually has.

### Channel invitation card

Inviting someone to a community sends a `channel_invitation` system event into the 1:1 MLS DM, and
BOTH sides render the same `channelInvite` card in that conversation:

| Side | Envelope built by | Copy | Join button |
|---|---|---|---|
| Invitee | `mkChannelInviteEnvelope` | "{inviter} vous a invité..." | yes |
| Inviter | `mkChannelInviteSentEnvelope` | "Vous avez invité {member}..." | no |

`channelInvite.invitedName` is the discriminator: **present = the inviter's copy**, and its presence
is what suppresses the Join button. Never set it on the invitee's copy.

The card has **three** producers - `inviteMemberToChannel` inserting the inviter's local copy, the
live `channel_invitation` branch of `systemMessageHandler` on their other devices and on the
invitee's, and `applyReplaySystemEvent` when the frame is only read back from the stream (an
invitation that arrived while the device was offline). All three id the bubble with
`channelInviteMessageId(channelId, inviteeId)`, so they converge on one card instead of stacking
three; `addMessageToChat` dedupes on that id. Its sibling `channel_key_distribution` is deliberately
NOT replayed: `hydrateChannelHistoryKeys` pulls every epoch key from the server when the channel is
opened, so the MLS delivery is an optimisation, not the only source.

`channelInvite.workspaceImageMediaId` carries the community's cover so the card shows the real logo;
absent (no cover, or an envelope written before the field existed) it falls back to the community
initials via `GroupAvatar`.

The Join button routes through `openInvitedChannel`, which is also what an accepted invite **link**
(`/c/join/[token]`) uses. Both must go to `/communities` - a channel target cannot be displayed by
`/chat`, and routing there is what once made the button look inert. Selection is left to the pending
target effect in `ChatBackgroundService`, which refetches the communities **once** when it does not
recognise a channel: a just-accepted invitation is never in the loaded sidebar, and
`openNotificationTarget` refuses a channel it cannot find.

### Deep-linking into a channel

Every deep link publishes its target to `notifNav` and navigates: the invite card's Join button, an
accepted invite link, a tapped message or channel notification. All of them have to survive the
same two hazards.

**The target is held until it is displayed, not until it is selected once.** Selecting it once is
not enough, because the conversations map is emptied and rebuilt wholesale by the IndexedDB restore
(`loadExistingConversations`) and pruned on every community refetch, so a target selected while the
map is still filling is dropped moments later. The selection watchdog in `useConversations` then
nulls it, which is what made *every* deep link land in the right tab with nothing open. So:

- `ChatBackgroundService` **owns the landing** and is the only place that runs it. It is mounted on
  every route and reads the same `globalConvs`/`globalChannels` singletons a page would, so a
  second copy inside `MainChatPage` only released the target early.
- The effect re-runs on every mutation of the conversations map and **re-asserts** a lost
  selection, then stays idle once the target is on screen - otherwise a plain incoming message
  would re-select it and refetch its history.
- The watchdog keeps a selection that IS the landing: absent from the map means "not there *yet*"
  while a landing is in progress.
- **A target is a group id; a selection is a map key, and for a DM they are different strings.**
  Only a community channel is keyed by the very id that names it - a DM or group is keyed by its
  display name and carries the group id in `conversation.id`. So neither of the two comparisons
  above may be made on the raw strings: both go through `resolveConversationKey`, the single
  id -> key lookup (direct hit, then a scan on `conversation.id`) that `openConversationFromId`
  itself is built on. Matched raw, `endLandingUnlessTarget` read the landing's own
  `selectConversation(key)` call as the user opening something else and ended the landing at the
  instant it succeeded, so the restore dropped the selection a moment later and the tap arrived on
  the right tab with nothing open; and the idle guard never recognised a landed DM, re-selecting it
  and re-requesting its history on every mutation of the map. Pinned by
  `openConversationFromId.test.ts`.
- `landingRecovery` / `landingAfterRefresh` decide when to stop: refetch the communities once for
  an unknown channel, retry if that refetch was dropped by the loader's in-flight guard, and
  abandon (releasing the target) when a real refresh still does not know it, or when a DM is absent
  from an already-restored map. Abandoning matters as much as holding - it is what lets the
  watchdog clear a channel whose access was revoked.
- **`addChannelToWorkspace` is an UPSERT, and it used to be an add-if-absent.** The full re-read
  calls it once per fetched channel, so an entry already on screen kept whatever it was created
  with for the rest of the session - every reload silently discarded. That hid the administrator
  join (`joinPrivateChannelAsAdmin`, which re-reads on purpose rather than flipping a local flag):
  the server answered `viewerHasAccess: true` and the row went on offering "Rejoindre". It now
  MERGES the fetched fields over the entry in place - merged, not replaced, because `unreadCount` is
  owned by the live event path and is not part of any reload, and the entry keeps its position so a
  refresh never reorders the sidebar under the reader. Found on prod by COMM-13 (2026-08-20), whose
  four other assertions all passed: the join was complete in the database, in the key service and in
  the member list, and absent only from the screen.
- `loadChannelWorkspacesFromBackend` retries transient failures internally: up to 3 attempts with
  backoffs of 1 s, 3 s and 7 s. It keeps the existing sidebar list on every failure and exposes the
  final error in `globalChannels.workspacesLoadError`. Auth failures (401/403) are not retried.
  `ChatBackgroundService` listens for `online` and `visibilitychange`: when the user is logged in and
  `workspacesLoadError` is set, it retries the load automatically, so a notification or deep link
  that arrived offline eventually lands once the connection returns. The landing itself reads that
  error through `landingAfterRefresh({ refreshFailed })`: a refetch that failed returns `retry`, not
  `abandon`, because the list the target would have been in was never fetched.
- The landing ends when the user opens another conversation, backs out of the thread, or leaves the
  target's route.
- **The landing routes BEFORE the session is up, and before it selects only the local preview (F1,
  2026-10-12).** The route step needs a pending target and a signed-in user on this device, not
  `isLoggedIn`: `/chat` without a session is the opaque connecting panel, and behind the PIN the
  gate covers it. The target is drawn from the local store by `previewLandingTarget` as soon as the
  login holds the device key and the open store, and the pre-session pass selects it through
  `previewSelect` (overlay entry, nothing else) only when the route has been reached - the same
  `landingStep` precondition as the real selection. When the session comes up, the next pass ends
  the preview and runs the ordinary `openNotificationTarget` over the same row, once: the "already
  on screen" idle guard does not apply to a previewed selection. `notifNav` itself is unchanged
  (`pending`, `landing`, `enRoute`, `markArrived`, `clear` keep their meaning); a landing cleared
  before the session also discards the preview, and leaving the chat page while the preview is
  selected discards it and clears the landing (`clear`, i.e. abandoned). The rules, the guarantees and the numbers are on
  [notification-to-conversation-latency](../notification-to-conversation-latency.md#f1---the-conversation-is-drawn-from-the-local-store-before-the-session-is-up).

`/chat` and `/communities` are **separate route components**, each rendering its own
`MainChatPage`, so moving between them remounts it. Its route-mode switch clears the selection so
the previous tab's thread does not leak across - but a deep link publishes its selection *before*
navigating, so an unconditional reset wipes precisely what the link asked for. Both a pending
target and an existing selection are checked with `selectionBelongsToRoute`: one whose
`chatDeepLinkRoute` already matches the incoming mode can only have come from a deep link, since a
genuine tab switch carries one made under the mode being left. Entering the *other* mode ends the
landing. Pinned by `notificationRouting.test.ts`.

The invite link resolves its landing channel from `getWorkspaceBySlug`, which returns only channels
the caller may read; it prefers a **public** one, so a fresh joiner lands in the open room rather
than in whichever private channel happened to sort first.

The inviter's copy is inserted **locally** by `inviteMemberToChannel`, because MLS never hands a
device back its own application message. The `senderNorm === userId` branch of
`systemMessageHandler` builds the identical envelope, and only ever runs on the inviter's *other*
devices. Pinned by `systemMessageHandler.channelInvite.test.ts`.

### Opening from another page: a conversation, or the DM with a person (fixed 2026-11-11)

Another page hands the chat page something to open through `sessionStorage`, and there are two KINDS,
each with its own key (`utils/chat/pendingChatOpening.ts`):

| Key | Written by | Names | Answered by |
| --- | --- | --- | --- |
| `canari_pending_contact` | the posts mini panel, the multi-tab reload (`selectionAcrossReload.ts`) | a conversation's MAP key (its group id) | `selectConversation`, if the map holds it |
| `canari_pending_direct_peer` | a profile's "Message" button | a PERSON (their user id), and the account that asked (`{ owner, peer }`) | `startNewConversation`: the DM in the map, else the server's, else a new one; a refusal is a toast (`conversationRefusalMessage`) |

**The defect (production web `1.6.10`):** the profile button wrote the person's USER id into the
conversation key. No conversation is keyed by a user id
([one key per conversation](#one-key-per-conversation---the-a-dm-has-two-keys-premise-audited-and-refuted-2026-10-04)),
so the selection watchdog dropped it in the same frame - `[SELECT] <id> is not in the conversation
map - selection dropped, nothing opens` - and "Message" opened nothing, whether a DM with the person
existed or not. A second defect sat under it: the key was applied **600 ms after login**, a guess at
the restore's length; on a slower restore the map was still empty and even a real key was dropped.

**Now:** the opening is applied when the map is authoritative (`conversationSourcesSettled`, the gate
the notification landing uses), never on a clock, and is not consumed before then. Pinned by
`pendingChatOpening.test.ts` (an existing DM opens, a DM restored after the press opens once
restored, no DM creates and opens one, a refusal reaches the reader, a conversation key waits for
the map). Logged under `[OPEN]`.

**What is never lost or misapplied.** The ask is removed from storage before the DM path is awaited,
so a THROW there (no MLS client, a follower tab's delegation) would have lost the press in an
unhandled rejection; `landPendingChatOpening` never rejects - a throw reaches the reader as
`creation-failed`, like a refusal. sessionStorage outlives a sign-out in the same tab and no sign-out
hook clears it, so a DM ask names its OWNER and is dropped, with a warning, for any other account -
otherwise B signing in after A's tap would start a DM between B and A's pick. A conversation ask
pending beside a DM ask is dropped with a warning (the DM ask, the later tap, wins). The conversation
key carries no owner: it can only select a key the map already holds, never create anything.

### Being removed from a channel or a community

Removal is pushed, not polled, so the person removed sees it happen without reloading. The server
sends `channel.member.kicked` (a channel kick, a community kick, or someone leaving) and
`channel.member.removed` (the channel settings panel) to **everyone still in the community as
well as the target**, which makes the payload - not the arrival of the event - the thing that
decides what happens locally. `channelEventHandler` normalises both onto one callback, and
[`removalOutcome`](../../../../frontend/src/lib/utils/chat/memberRemoval.ts) turns it into one of
four answers:

| Outcome | When | Local effect |
|---|---|---|
| `ignore` | `kickedUserId` is not the local user | none - it is someone else's removal |
| `community` | no `channelId` (community-wide kick) | purge the whole workspace + toast |
| `channel` | private channel | drop that channel + toast |
| `public-channel` | public channel | none - every member still reads it |

The two traps this encodes are worth restating, because both shipped as bugs: acting on a
broadcast without checking the target made *every* member's client delete a channel when one
person was kicked from it, and a community kick carries no `channelId` at all, so a handler that
started with `if (!event.channelId) return` did nothing for the very person being removed.

A purged community goes through `dropCommunityLocally` in `ChatBackgroundService`, shared with
`workspace.deleted`: it reads the doomed channel ids **before** the purge, because clearing the
chat panel afterwards needs to know whether what was on screen belonged to the community that
just vanished.

### A community's own names for its three roles (owner, 2026-11-08)

The "Roles" tab of the community settings (`SidebarCommunityAdminPanel`) opens with `CommunityRoleNames`,
one field per role (admin, moderator, member), mounted only when the server said `viewerCanManage`.
The default name is the placeholder; saving a blank field resets it. **Labels only**: the three roles,
their permissions and their holders are untouched, and the stored role `name` stays the identity the
client folds through `canonicalRoleOf` - a label is never read for a decision. Every place a role name
is drawn (member badges, invite and role pickers, the permission grid headers) goes through the ONE
resolver `resolveRoleLabel` (`utils/chat/communityRoleLabel.ts`), fed by `globalChannels.roleLabels`
(by role id), which the listing fills and the `workspace.role.permissions` event (it carries `label`)
keeps current for every member without a reload. Server side, column choice and refusals:
[social-service](../../services/social-service.md#a-community-may-name-its-three-roles-owner-2026-11-08).

### Leaving: a private channel, or the whole community - never a public channel

`ChannelSettingsModal` offers "Quitter le salon" only when `selectedChannel.isPrivate`. A public
channel is readable by every member of the community and keeps no per-member access, so there is
nothing there to give up: the server answers `400`, and leaving is a community-level action
(`SidebarCommunityAdminPanel` -> `leaveCurrentWorkspace`). Hiding the button is convenience; the
refusal is the gate. The scope rule behind it, and the defect that made it necessary, are on
[social-service](../../services/social-service.md#a-channel-scoped-action-never-touches-community-membership-2026-08-17).

`leaveCurrentChannel` mutates nothing local until the server has answered, so a refusal leaves the
sidebar exactly as it was and surfaces as a toast - the divergence between "gone here" and "still
there on the server" is what made the original defect invisible.

### Channel message identity

A channel bubble is keyed by the **server row id**, everywhere. Live delivery
(`channelEventHandler`) and history loading (`decodeChannelMessageRow`) must agree, because every
server-side operation - delete, pin, poll vote, reaction - addresses a message by that id. The
AppMessage id carried inside the ciphertext is deliberately NOT used: a channel send has no
optimistic echo to reconcile (`sendChatMessage` returns straight after the POST and lets the
`channel.message.created` broadcast render the bubble), so keying on it only made a live message
unaddressable until the next reload.

### The channel notification level is shown only once the server states it

`ChannelSettingsModal` holds `notifLevel: ChannelNotificationLevel | null`, and the radiogroup does
not mount while it is null. That is not caution about a spinner: the control used to be seeded `all`
and to keep its previous value across reopens, so a member stored at `mentions` was SHOWN `all`
before the read landed. Anything that skips a click because the level already looks right then
skipped it - COMM-14 measured `asked=all stored=mentions` on production on 2026-08-25 - and since
`channel_members.notifLevels` is jsonb where an absent channel genuinely defaults to `all`, the same
seed also made a FAILED read indistinguishable from a real answer, because `catch` substituted `all`
for the value it had not obtained. A failed read now logs and leaves the control unmounted, so
nothing is chosen on the member's behalf, and the group's PRESENCE means the server answered.

### Reactions: two mechanisms

| | DM / group | Community channel |
|---|---|---|
| Transport | encrypted MLS system message (`add_reaction`/`remove_reaction`) | encrypted channel message, sealed under the sender's Graine session (WP-40, 2026-08-18) |
| State | `useMessaging.messageReactions`, a `ReactionsByConversation` keyed by conversation and message id like the stored row (the bubble reads `.of(conversation)`) | `stores/reactionStore.svelte.ts` |
| Server sees | nothing | nothing - it stores one boolean, `silent`, saying whether the row may ring a phone |
| Live update | replayed to every member by MLS | the ordinary `channel.message.created` fan-out |

**The cleartext tally is GONE**, endpoint, `channel.reaction` broadcast and
`channel_messages.reactions` column alike: a server that could not read "j'arrive" could still see
that eight people put a heart on it. Both sides now merge frames with the same convergent rule
(`applyReaction`, last-write-wins per `(user, emoji)` pair on the sender's `at`), so the order a page
is read in cannot change the result and a frame seen twice changes nothing. Full reasoning:
[channel-encryption](../../protocols/channel-encryption.md).

`MainChatPage` picks the map per conversation type; below that, the component chain is identical,
so a reaction pill looks and behaves the same on both sides. Toggling is optimistic and rolled
back by re-applying the same toggle, which is its own inverse.

### A control event is applied twice, on two different devices

Every message mutation - reaction, edit, delete, pin, read receipt - travels as a **control event**
in the durable outbox (`enqueueControlEvent`), and lands on peers through `systemMessageHandler`,
which applies it to the conversation AND writes it to the encrypted store.

The sender's device never runs that handler: **MLS gives no echo of your own message**. So the
issuing device has exactly one code path - the optimistic update in `useMessaging` - and that path
owns *both* halves. Updating `ctx.conversations` alone makes the mutation look applied until the
next load, at which point the store answers with the pre-mutation row and the change appears to
have been rejected. That was WP-EDIT-1: an edit that reverted on refresh while every peer showed
it correctly.

`persistLocalMutation` is the one place that writes a locally-applied mutation. It is best-effort
and logs on failure - the control event is already durable in the outbox, so a failed write costs
a stale local row, never a lost mutation for the group.

#### A delete is a CANCELLATION until the frame has left (MUT-19)

`delete_message` is the only mutation whose target may still be sitting in the queue beside it, and
that is not a variation on the rule above but its opposite. Both legs were ordinary outbox entries,
so deleting a message composed offline **sent it and then withdrew it**: the peer received the text,
rendered it, and only then received the tombstone. Ordering the two entries could not have fixed
that - the text still goes out - and neither could a delay, which would only move the window.

`deleteMessage` therefore asks the outbox first. `cancelPending` answers the one question only the
queue can answer - *is the frame still on this device* - and returns it as a boolean the caller acts
on, rather than letting the caller learn it by watching a send happen. `true` drops the row and
sends nothing at all; `false` means the peers have it and the `delete_message` event travels, which
is the case that event exists for.

Three things make the cancellation deterministic rather than probable, and each closes a window the
others cannot:

- **the durable row** is deleted, which stops every FUTURE flush and survives a reload;
- **an in-memory `cancelled` set** stops the flush that is ALREADY running, whose loop is walking a
  snapshot of the queue read before the user pressed delete;
- **`outbox_entry_cancelled`** carries the same fact to the other tabs - not leader-gated, unlike
  every other event on that channel, because a cancellation originates wherever the user pressed
  delete while the tab that would send it is the leader.

`inFlight` is what makes the answer honest rather than optimistic: the id inside `sendMessage` right
now cannot be withdrawn, so `cancelPending` returns `false` for it and the delete travels as an
event. Claiming a cancellation there would lose the delete outright - the caller would skip the
event, and the peer would keep a message the user deleted.

The mirror is refreshed on the way out. Leaving a withdrawn entry in it lets the native background
sender deliver from Android what was cancelled here, which is the same defect one layer down.

##### And the sender's own row must go with it (fixed 2026-08-16)

The first version of this fix stopped one line short. `deleteMessage` knew which of the two branches
it had taken and returned `void`, so `handleDeleteMessage` did the same thing either way: mark
`isDeleted`, persist the patch, keep the row. **A withdrawn message therefore left a durable
tombstone on the sender for something no other device had ever received** - the peers have no row to
mark, the server never held a frame, and nothing will ever produce one.

The outcome is now a type (`DeleteOutcome = 'withdrawn' | 'broadcast'`) carried out to the caller,
which is the same rule as `cancelPending`'s boolean one level up: the fact is KNOWN where the
decision is made and must not be re-derived, or lost, above it. On `withdrawn` the row is dropped
from memory and from the store (`IStorage.deleteMessage`, which invalidates the conversation's cached
history-state key like every other message write); on `broadcast` the tombstone stays, because it has
to survive a reload and stand for something the peers really do hold.

**It was found as four "lost" messages, not as a UI complaint.** `recon.mjs` compares device stores
id by id, and a row only one device holds is exactly what it reports as a loss - so every MUT-19 run
manufactured one, permanently. The attribution was a causal test rather than an argument: one
`mut.mjs --only 19`, one new row (measured 2026-08-16, four became five). MUT-19 now asserts the
sender's store as well as the peer's pane, because a tombstone and a dropped row look identical on
screen and differ only at rest. See [cross-client-testing](../../cross-client-testing.md).

#### The same rule applies to the message itself, and a UI buffer broke it (WP-ECHO-1)

`addMessageToChat` is the single writer for the sender's own copy, for the same reason: no echo. It
opens with a bulk-ingest early return that holds the message in `bulkIngestBuffer` and returns
**before `saveMessage`**, so that a large inbound drain re-renders the list once instead of per
message. Three facts turn that optimisation into a loss:

- `bulkIngestActive` is raised by *every* inbound drain, not only a long one, so the window is
  ordinary rather than exceptional;
- `beginBulkMessageIngest` and `resetMessageCatchupState` both `clear()`ed the buffer without
  flushing (until #4054), so a second drain starting mid-window discarded what the first held;
- the outbox cannot repair it, because `persistSent` resolves the message through `findMessage`,
  which only scans `conversations` - a buffered message was never there, so it returns silently.

Result: a message composed during any drain window was rendered by the peer and gone from the
sender at its next load, with nothing logged. It also explains why the offline path was always
correct - offline there is no inbound drain, so the echo took the live path (MSG-10).

Fixed 2026-08-07: `if (bulkIngestActive && !isOwnMessage(senderId, ctx.userId))`. An own message was
never deferred; one extra rendered item is not what the buffer exists to prevent. **Narrowed
2026-11-24** to an own message THIS DEVICE COMPOSED: one decrypted from a frame (this account's other
device) is held like a peer's, and a buffered row leaves the buffer only for a store (or a sign-out)
([a catch-up lands in one render](#a-catch-up-lands-in-one-render-2026-11-24)). **The general rule: a UI buffer in front of a persistence call is a
persistence bug.** Buffer after the durable write, or the early return skips the writer.

The at-rest projection of a message is shared by both storage backends
(`db/messagePayload.ts`): a field that is not in `toMessagePayload`/`fromMessagePayload` does not
survive a reload, whichever backend is in use. `editedAt` was missing from both for exactly as long
as it existed on the in-memory type.

##### Verified on hardware, 2026-08-11 - and the check had to be rebuilt twice to be worth anything

The unit half (`useMessaging.bulkIngest.svelte.test.ts`, 4 tests, 3 of which fail when the fix's
condition is reverted) pins the rule. The device half asks the different question of whether the
whole chain - composer, MLS, outbox, SQLite - keeps the message on real hardware, and answering it
cost three harness rewrites, each of which is a general lesson:

1. the first run counted 25 s after a reload while drains were still arriving, so "missing" could
   not be told from "not re-rendered yet" - it reported FAIL and was **VOID**;
2. the second read logcat after the fact, by which time the ring buffer had overrun and the
   deciding lines were gone;
3. the third printed **PASS and proved nothing**: its seven sends were at 13:20:23-13:20:39 and the
   run's first drain opened at 13:20:42, so not one of them was inside the window under test.

**The window cannot be aimed at with a delay.** It opens on `[QUEUE] Drain start`
(`onBulkIngestStart` -> `beginBulkMessageIngest`) and closes on `[MLS] Bulk ingest done`, and on A1
that measured 15 ms to 1.4 s depending on the decrypt. The check therefore ARMS the composer, waits
for the app's own log to show a new window opening, and fires into it - and then proves after the
fact which sends were inside one.

**The discriminator is exact, not statistical.** `[ADD_MSG] ✓ Message added` is logged by
`addMessageToChat` alone; inside a window an inbound message returns early into the buffer without
logging it, and the flush that later renders it goes through `batchAddMessages`, which never logs
that line at all. So an `[ADD_MSG] ✓ Message added` inside a window is necessarily a message that
took the live path while `bulkIngestActive` was true - i.e. an own message through the branch this
fix added.

| own message | added at | window | verdict |
| --- | --- | --- | --- |
| `80e9927e` | 11:28:39.582 | opened 39.193, closed 39.601 (408 ms) | inside |
| `050725aa` | 11:28:43.654 | opened 43.397, closed 44.790 (1393 ms) | inside |
| `1537acbd` | 11:28:53.383 | opened 53.283, closed 53.612 (329 ms) | inside |
| `bcba272f` | 11:28:59.295 | opened 58.874, closed 59.323 (449 ms) | inside |
| `dde24b01` | 11:29:21.429 | opened 20.999, closed 21.464 (465 ms) | inside |
| 6 others | - | between windows | outside |

11 sent, 25 windows opened over the run, **5 inside**, and after the reload and a quiescence gate
(no `Drain start` for 20 s) **11 of 11 still present**. PASS.

The run also surfaced a harness artifact worth keeping in mind for any marker count: one attempt
failed to submit and left its text in the box, the next `Input.insertText` appended to it, and the
app faithfully delivered ONE message carrying TWO markers - twelve markers on screen for eleven
sends. The app was right and the count was wrong; the harness now clears the composer before arming.

#### A catch-up lands in one render (2026-11-24)

**What the owner's log showed** (Android `1.7.3`, production, 2026-11-24; counts and timings only):
a resume with one DM open, the socket back in 0.2 s, a pull of 148 frames, and the drain ran from
`Drain start ... messages=1` to `Drain complete` in **~10 s**. Per-frame time read from `Processing`
to `messageCallback`, by what the frame was:

| frames | what | path | per frame | total |
| --- | --- | --- | --- | --- |
| 34 | the peer's texts, all of them already shown as push previews | live (`Preview upgrade during a bulk ingest - taking the live path`) | ~80 ms | 2.7 s |
| 23 | texts written on the owner's OTHER device | live (own message, WP-ECHO-1's exemption) | ~90 ms | 2.1 s |
| 34 | reactions (`applyReactionFrame`, one store write each) | - | ~75 ms | 2.5 s |
| 51 | read marks (the peer's: one `saveConversation` each, ~65 ms; this account's: ~2 ms) | - | ~34 ms | 1.7 s |
| 6 | commits, Welcome, other notices | - | - | 0.5 s |

The decrypt itself is 2-8 ms per frame (`Processing` to `Message decrypted`): **the time is the
store**, a read and a write per message on the live path, a write per reaction or read mark. And not
ONE text of the drain went through the bulk buffer: the two exemptions covered all 57, so the open
pane took them one row at a time, and the stick-to-bottom flag fell three times in three seconds
(`left the bottom with no finger on the pane`, 133 to 236 px from the end), **each 70-80 ms after an
own message from the other device was added by the live path** - inserted in the MIDDLE of the
thread, above the previews of the peer's later messages. No fall followed an upgrade alone, and none
happened in the rest of the drain.

**What changed.** `bulkWindowHolds` (`bulkIngestAdmission.ts`) is the one rule for what a window
holds, and two arrivals that used to bypass it now wait for its flush:

- **an own message DECRYPTED FROM A FRAME** (`frameId`, no `outboxEntry`). WP-ECHO-1's exemption is
  for a message THIS device composed, whose only writer is the call itself; one written on this
  account's other device reaches this one as a frame like a peer's, and its ack waits for the close's
  store like a peer's ([rows before ratchet, the ack](#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)).
  An own send and a `soleWriter` notice still take the live path;
- **an upgrade of a shown push preview.** It first fell through to the live path because the ack
  ran when the handler returned ([mobile](../mobile.md)); the ack now waits for the close, and
  `batchAddMessages` upgrades a shown preview by the same compare-and-set (`mergeShownUpgrades`).

So a drain changes the open conversation's row ONCE, at the window's close - one store read and
one write per conversation, one change of the pane's list and so one anchor decision - instead of a
render and two round trips per message. Pinned by `useMessaging.bulkIngest.svelte.test.ts` (a mixed
catch-up of an upgrade, a sibling message and a new one: one `conversations.set`, one batch write,
one `saveConversation`; an own message from a frame buffered; the upgrade held and written at the
close) and `bulkIngestAdmission.test.ts`.

**What is NOT claimed.** The exact layout step that moved the pane 133-236 px up with its reach
unchanged was not isolated: the scroller already turns the engine's scroll anchoring off
(`observeThreadGrowth`), and a headless Chromium of an append, a trim of the window's top and the
pin in one task keeps the end. The change removes the per-row path every fall followed; the reading
below says whether a fall survives one render per drain, from the exported log (the fall line is
INFO).

**What holding more made load-bearing (reviews of #4054).** Five facts had to change with it:

- **a buffered row leaves the buffer only for a store.** `resetMessageCatchupState` (called from group creation, possibly
  mid-drain) cleared the buffer and lowered the window, so the close stored nothing and the dropped
  frames - in no ledger - were acknowledged and deleted by the server; a window opening and a window
  closing also `clear()`ed. True of a peer's text since the buffer existed, and this change would
  have extended it to upgrades and other-device messages. Now the reset touches the UI flags only,
  only a store takes rows out of the buffer (`storeBufferedRows`), what a store did not take is
  carried to the next one with one WARN (`noteBufferedRowsCarried`), and **every buffered frame is in
  `framesLeftUnstored`**, so its ack is withheld until a store takes it. The store takes each
  conversation's rows at its own turn (a throw between two leaves the rest in the buffer), a close
  ends only ITS window (`openBufferingWindows`, a count: windows overlap), the drain's end closes
  its window in a `finally` (a synchronous throw before it left the window open for the page's
  life, `BaseMlsService`), and a sign-out
  (`forgetAccount`) forgets the leaving account's buffer, kept batches and kept writes, said in one line;
- **a row is written where its thread lives NOW.** A Welcome folding a duplicate DM onto the group it
  joined re-keys the thread mid-window, and the close found the old key "vanished" and dropped the
  rows - then acknowledged their frames: an upgrade stayed a caption for good. The re-key is now a
  FACT (`recordConversationMove`, `utils/chat/conversationMoves.ts`), written by both writers that
  re-key a thread (the Welcome's fold and the boot merge), and ONE resolver (`homeOfRows`) answers
  for the buffer, the framed orphans, the kept batches and the kept writes: the key itself, else
  where it moved, else nowhere. **Never by a message id** (third review, principle 1): the resolver
  also took "the conversation that shows one of these ids", and an id is chosen by its SENDER - a
  member of two conversations sending into one an id the other shows, with the first removed
  mid-window, sent every row it held, a third member's included, into the other: shown, stored,
  acknowledged and passed on in its history. The kept batches' "anchors" went with it.
  With no home, the rows are held as framed orphans (`orphanHeldMessages`, also where
  `batchAddMessages` sends a batch whose conversation is gone), dropped - said with their frames -
  only on a real removal (`ORPHAN_REMOVERS`);
- **a follower tab takes the upgrades.** The flush relayed only the NEW rows (`messages_batch`), so a
  tab showing the caption kept it: the relay now carries the upgraded rows as shown, and the follower
  merges them with `mergeRelayedBatch` (insert what it lacks, upgrade a shown preview, leave the rest);
- **"my message was just added" means composed HERE** (`ownMessageAppended`): a flush ending with a
  message from this account's other device used to read as "I just sent" and pull a reader who had
  scrolled up to the bottom. A composed message carries its send state (`status`) from the moment it
  is drawn; an arrival carries none - the forwarded medium now says `sent` too;
- an upgrade held in the window still meets the reaction and the edit that follow it in the same
  drain (both settle onto the row by id after the flush's write - pinned).

**The banner says the catch-up.** "Réception des messages en attente..." was raised only for a
window whose drain STARTED with several frames (`showOverlay: pendingCount > 1`), and a resume's drain
starts on the first frame of the pull (`messages=1`) while the rest are queued behind it: ten
seconds, no banner. The buffer's own count (`OVERLAY_MIN_MESSAGES`, decrypted messages, never
ciphertexts) now raises it from ANY open UI window, and the window's close - the drain's own
completion, no clock - lowers what it raised. `isMessageCatchupActive`, which the concurrency guards
read, is unchanged.

**One summary line per drain**, INFO: `[QUEUE] Drain complete: N frame(s) in T ms` - the frames
handed to the handler (counted as they are handed, so one whose handler threw is counted too; a
frame put back behind a commit is not) and the time from the start to the window's close, `onDrainEnd` included
(`drainCompleteLine`, `mlsPerGroupScheduler.test.ts`). The rig's `[QUEUE] Drain complete` count reads
the same prefix.

**Expected gain**: the 57 texts' ~4.8 s become one batch (a store read and a write for the
conversation, ~0.1-0.3 s by the per-operation cost above), so this catch-up goes from ~10 s to
~5 s. **What remains is per frame and not batched here**: a reaction stores itself and a peer's read
mark saves the conversation row before its handler returns (~4.2 s of this drain); batching them is
the next step ([backlog](../../backlog.d/per-frame-store-writes-of-a-catch-up-batched.md)); the
reading on the Mi 9T PASSED on `1.8.1-alpha.2` (2026-11-25: 136 frames drained in 2245 ms with the pane at the end; scrolled up, 67 frames in 1985 ms, `scrollTop` unchanged, banner gone with the drain). The unread pill showed no count after it: [backlog](../../backlog.d/reading-owed-the-scroll-to-bottom-arrow-counts-a-catch-up.md).

#### An open lands once: a change above the reader never glides (2026-11-25)

**What the owner's recordings showed** (own Android phone, production `1.8.0`, two DMs, read frame by
frame at 60 fps; the recordings are private and are not kept): on three opens the thread was drawn
correctly at its end for ~67 ms, then **yanked about one screen up** (older rows, a voice note still
its grey placeholder), the round down-arrow appeared, and the thread **slid back down over 300-600 ms,
not monotonically** - in one open it rose again mid-way; in the other DM two yanks 0.25 s apart. At
rest it was at its end, but **the arrow stayed**, and a day pill naming a date from far up the history
stayed under the correct one.

**The cause, read in the code and reproduced in the component test** (the modelled pane, 40 px rows):
after the reveal, `widenEntryWindow` mounts the older rows ten groups per step ABOVE a reader at the
end. The growth observer (`observeThreadGrowth`) answered each step `follow-bottom` - right - and then
asked `appendGlidePx` whether to glide the pin's jump, and that predicate took ANY change of `rows`
under a reader at the end, by up to half the pane, for an arrival. So every step under half a pane
(the 240 px last step of the model) played the thread's glide: all the rows drawn that much LOWER,
i.e. history crossing the screen, then slid back to their place; a second step mid-glide chained onto
it (`glideTravel`), hence the long, non-monotonic descent. A voice note above the fold turning from its
placeholder into its player is a `rows` change too, and glided the same way. **The voice note and the
image were not the cause of the yank** - their late heights were already followed by the observer -
only the glide drew them where the reader could see them.

**And the widen was a second writer.** It wrote `scrollTop = prevTop + (scrollHeight - prevHeight)`
after each step, on top of the observer's pin, from heights a glide in flight inflates (a translated
row counts in the scroller's overflow). The note in `observeThreadGrowth` already said a prepend is
kept by the observer "and only here"; the widen was the copy that predated it.

**What changed:**

- **only what grew BELOW the reader's top row glides.** The observer measures how far the row at the
  top of the viewport moved in layout (`offsetTop`, before and after) and `appendGlidePx` glides the
  pin's jump MINUS that: an arrival keeps its glide, a prepend, a widen step or a row settling above
  the fold is a plain pin (Messenger shows nothing moving there either). A change whose top row left
  the document cannot be placed, and jumps. One debug line per such pin (`pinned without a glide`);
- **the widen writes no `scrollTop`**: the observer is the one writer of a prepend, for a reader at
  the end (pin) and one in history (row anchor);
- **a glide's end re-measures the pane** (`onGlideEnd`, on the animation's own `finish` event): a
  measurement taken mid-glide reads a `scrollHeight` past the real end and separators drawn lower than
  they stand, and the end of a glide fires no `scroll`, so the flag behind the arrow and the day pill
  decided then outlived it. The re-measure corrects or withdraws a pill a scroll raised, and never
  raises one (`measureScroll('glide-end')`).

**The review of #4095 closed three edges:**

- **every end of a glide is an end**: its `finish`, a suspend that finds it past its end before that
  `finish` arrived, and the keyboard ride taking it off (`takeThreadGlideOff`) each tell `onGlideEnd`
  once. A suspend to measure and replay is not an end, nor the teardown. The notice waits for the
  task that ended the glide (a microtask) and is dropped if that task started another glide, whose
  own end tells it;
- **a glide's end is not a scroll**: `measureScroll('glide-end')` revises the flag and the pill and
  nothing else - it never asks for older history (the `OLDER_TRIGGER_PX` branch answers a scroll),
  never raises a pill, and never puts the pane back for the engine's keyboard move (that move's own
  `scroll` does);
- **no glide from rounding**: `anchorMovedPx` is two integer `offsetTop` reads against a fractional
  `scrollTop`, so up to 1 px of travel is measurement, not motion (`ANCHOR_ROUNDING_PX`): a travel at
  or below it jumps.

**Pinned by** `threadAppendGlide.test.ts` (a change above the viewport, an arrival with a trim, a lost
anchor), `threadGlide.test.ts` (three widen steps under a reader at the end play no glide; an arrival
after a prepend glides its own height; `onGlideEnd` once per glide that ends, never for one replaced),
`ChatArea.entryWindow.svelte.test.ts` (one `scrollTop` write per widen step, the observer's) and
`ChatArea.scrollAnchor.svelte.test.ts` (the entry glides nothing; a glide's end withdraws an arrow a
mid-glide measurement raised, and so does the keyboard ride taking it off; it raises no pill and
asks for no history).

**What only a phone proves** - happy-dom lays nothing out, so the tests prove the decisions, not the
frames: that no frame above the end is drawn at an open, and that the arrow and the stale pill are
gone at rest. **Not proved from code:** the exact interleaving that left the flag down at rest (the
two writers and the inflated overflow can produce it; the exported log's INFO line `left the bottom
with no finger on the pane` would name it if it survives). The reading is
[backlog](../../backlog.d/reading-owed-a-dm-opens-at-its-end-in-one-render.md).

#### The trace of the passes inside a glide (2026-11-25)

**Why.** iPhone 12, iOS 27.0.1, 1.8.2-alpha.1: an IMAGE arriving at a pinned DM drops the pane
150-230 px 45-70 ms after the row is added, reach unchanged (Reduce Motion OFF 6 of 6, ON 0 of 2, short
and 12-line texts 0 of 3 each). The glide and an image row are both necessary; which step lowers
`scrollTop` is not known: (a) WebKit's native anchoring on the transform cancel, (b) a clamp against a
transient content size, (c) a stale `held.px` replayed. Code reading does not prove (c): the replay is
a transform and writes no `scrollTop`. Backlog:
[the reading that closed it](../../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch).

**What is written** (`GlideTrace` in `threadGrowthObserver.ts`): **INFO only with the fall line, nothing at
pass time** - every ordinary message makes a glide, so a line per pass would be noise forever. The
`follow()` passes that start or find a glide wait in a ring of `GLIDE_TRACE_MAX_LINES` (8, older ones
counted), with the `scroll` moves after the last pass (a passive listener armed for the glide only:
ms into the glide and `scrollTop` delta, the async case, no forced layout). When the pane's
measurement finds a fall inside a glide, `ChatArea` prints them right after the `left the bottom`
line (`describeGlideFall`), e.g. `glide pass 2 (box, +55ms): top/height/box previous end 910/1310/400,
suspended 910/1430/400, pinned 1030/1430/400; held 70px with 53px left; follow-bottom, new travel 0px,
replay 70px at 55ms`. `top/height/box` is `scrollTop/scrollHeight/clientHeight`, read only where the
layout is clean (`suspended`, after the transforms are cancelled; `pinned`, after the pin and before
the replay). Native anchoring (a) moves `top` at `suspended` with the height unchanged; a clamp (b)
with a shrunk height; stable pass numbers and a later scroll move are (b) or an engine move outside
the passes - not "nothing found"; (c) is only a visual offset. The fall line carries NO "now top/height/box": the scroll-move lines carry the top. A glide cancelled by a pass whose replay is refused is an end too (`endUnreplayed`: the trace listener is disarmed and `onGlideEnd` fires). Pinned by `threadGlide.test.ts`.

**Pins made outside `follow()` are traced too, and the lines are merged in time order.** A third ring
holds every `pinThreadToEnd` write inside the glide (`glide write by <writer> (+Tms): top/height/box
...`, read after the write, transforms off), and `describeGlideFall` prints passes, writes and scroll
moves in RECORDING order, which is real time - never sorted by the `+Tms` label, since a second arrival
restarts the glide's clock and its pass reads `+0ms` after lines of `+55ms`; the header counts all three
(`N follow pass(es), W write(s) outside follow and M scroll move(s) in this glide`). A write between two
passes is a second writer.

#### The cause: a second writer pinned inside the glide (2026-11-25)

**Read from the 1.8.2-alpha.3 trace on the iPhone 12.** The arrival's `rows` pass pinned the layout end
and started the glide. A tick later the new-message effect ran its own `scrollToBottom()` - a plain
`scrollTop = scrollHeight` with the glide's transforms ON the rows. A transformed row counts in the
overflow by `max(0, offset - padding-bottom)`; the padding is the composer band (86 px on the phone),
so an image row of ~250-300 px inflated `scrollHeight` by ~160-210 px, exactly the falls measured. The
effect wrote that overshoot and called `placedAt` with it. The image's `box` pass then took the
transforms off (`suspend`), the engine clamped `scrollTop` back to the layout end, and the next
`measureScroll` read a top below the last placed value: `left the bottom`, the flag down for the rest
of the glide (the arrow could flash, and growth in that window was answered `keep-row`). It is
intermittent because only a travel over ~206 px crosses `THREAD_BOTTOM_SLACK_PX` (120) past the
86 px padding; a text row never does, and Reduce Motion plays no glide.

**The fix is every pin against the layout - no timer, any thread size.**

- `pinThreadToEnd(scroller, writer)` (`threadGrowthObserver.ts`) is the pane's only way to write its
  end: it takes a running glide off (`suspend`), writes `scrollHeight` against the layout, and replays
  the glide at the same time and distance (`play(held.px, held.time)`), or ends it once
  (`endUnreplayed`) if the replay is refused - exactly what `follow()` does around its own pin. The
  pin is registered per scroller by `observeThreadGrowth` (a `WeakMap`, like the glide); an
  unobserved scroller gets the bare write and a `Log.w` (`<writer> pinned a pane no growth observer
  follows`), since the pane always has one. `ChatArea.scrollToBottom()` is
  `placedAt(pinThreadToEnd(chatContainer, writer))`, so every caller targets the layout end.
- **The new-message effect's pin stays, for every `follow-bottom`.** Under a reader at the end it now
  lands on the same layout end the observer's pass wrote and replays the glide - no overshoot, no
  clamp. It is not redundant: while an older page loads (`isLoadingOlder`, the short-thread fill
  included) `threadGrowthResponse` answers `keep-row` and the observer writes nothing, so this pin is
  what shows the arrival. Removing it (the first draft of #4105) left the message under the composer.

**Pinned by** `threadGlide.test.ts` (`pinThreadToEnd`: with an 86 px padding and a 300 px row, the
modelled overflow is inflated, the pane pin lands on the layout end and no placed value passes it; a
pin mid-glide replays at the same time and px; a refused replay is one `onGlideEnd`; the write line
sits between the passes; the lines keep recording order across a restarted glide clock; a plain write
instead fails four of them) and `ChatArea.scrollAnchor.svelte.test.ts` (an arrival under a reader at the
end writes only the layout end and logs no `left the bottom`; with an older page pending it still
reaches the end; the reader's own message sent from history still pins once). No
real-layout bench exists in the repository for this (the media-frame bench of 2026-10-02 was not
committed), so the overflow is the measured model above. **Read on the iPhone 12, `1.8.2`:** three
image arrivals, no fall ([the reading that closed it](../../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)).

#### Rows before ratchet: a checkpoint stores the buffered rows first (2026-11-17)

**The defect (P1, second review of #3321).** A live drain decrypts each frame and holds its row in
the UI buffer above until its window closes (`endBulkMessageIngest`). A checkpoint was not ordered
behind that close: one started by a send, by an earlier window, by the persister's coalescing - and
by the window's OWN close, since `BaseMlsService.endBulkIngest` runs the persister observer (registered
in `setupMessageHandler`) before the UI one (registered in `sessionAuth`) - exported the frame's
ratchet advance and its seen mark (staged INTO the state, KILL-2) while the row was only in memory. A
kill there (a browser closed, a crash, an app swiped away) lost the message from the device: the
generation is spent on disk (`SecretReuseError`) and the frame is marked seen, so it is neither
decrypted again nor replayed. Principle 2 of the [charter](../../../principes.md): the essential is
never lost.

**The fix is an order.** `persistCheckpoint` asks every bulk-ingest observer that holds rows
(`BulkIngestObserver.holdRowsForCheckpoint`, implemented by `useMessaging.holdRowsForCheckpoint`)
to store them BEFORE it stages the ledgers and exports, and keeps the hold until its write settled
(on native the export runs inside the command, so releasing at the capture would not be enough).
While a hold is taken, an inbound message does not enter the buffer: it takes the live path, whose
handler stores its own row - which is what makes the wait end after ONE store of what is held,
without a clock and without racing a drain that keeps refilling the buffer. Every store of the buffer
(the hold's and the window close's) goes through ONE chain (`storeBufferedRows`), so a hold that
meets a close already storing waits for that store's rows too. Nothing in the hold waits on a drain
handler, so a handler that awaits a checkpoint (a commit's structural checkpoint) cannot deadlock it.

**A row that could not be stored refuses the checkpoint (review of #3786).** `batchAddMessages`
renders a batch and then writes it, and a failed write was only logged: the hold resolved and the
export went through with the rows in memory alone. A failed write is now kept whole
(`unstoredRowWrites`, the batch's own `writeBatchRows` seam), whichever path wrote it - the hold's
store, a window's close, a restore. A hold retries every kept write ONCE, puts back in the buffer a
conversation whose batch threw, and rejects (`BufferedRowsNotStoredError`) while anything stands;
`persistCheckpoint` then refuses (`MlsCheckpointNotWrittenError` at step `rows`) and the persister
keeps the state dirty. One refusal per trigger, no timer: the next checkpoint's hold retries. The
window's close only logs, as it always did - it is not a checkpoint. A retried write that lands
SETTLES what arrived meanwhile (`settlePendingFor`, as the batch does after its own write): an edit,
a deletion or a reaction that met the row shown and not stored was kept "for its write", and the
snapshot the retry stores predates it (re-review of #3786). A kept write is written under the
conversation that SHOWS its rows now - its own, or the group a 1:1 was re-keyed onto at a Welcome -
and dropped only when none does (deleted, purged). Each write's failure is said once, by the batch;
a retry says ONE line for all its writes, with the first cause. A batch that THREW (before it
rendered anything - nothing after the render may skip the write or throw, so the announcement and
the settle after the write are guarded) is kept too (`unstoredBatches`), whichever path took it, and
run again first by the next store of EITHER kind - a close shows it without waiting for a hold -
each on its own, so a later message of that conversation never joins a batch that keeps failing; it
is said once per batch, and replayed under the key that shows its thread now (the ids it showed when
kept anchor it across a re-key). **A batch that always throws blocks every checkpoint - commits,
joins and sends - and a reload does not end it** (its frames are withheld, so they are decrypted
again after the reload and the same batch is built again); said once per page as the cause. Only a
WRITE failure is classified (a poison row is dropped, [below](#a-poison-row-is-dropped-not-kept-2026-11-19));
a batch that throws before its write carries no store error to classify.
**The chain never rejects:** a step that throws resolves `false` with one line, and the hold gives
its counter back in a `finally` - one exception costs one store, never every later checkpoint and
close of the page.

**What a refused checkpoint leaves, exactly.** The state on disk stays behind those frames, and a
reload repairs it from what still holds them: a frame the server still lists (a commit or a Welcome,
held by `DrainAckHold`, or one not acknowledged) is decrypted again - and since 2026-11-19 an
APPLICATION frame is acknowledged only once its row is stored, so a row the store refused keeps its
frame on the server too ([the ack](#rows-before-ratchet-the-decrypt-half-and-the-ack-2026-11-19)).

**A hung row write holds every checkpoint.** An IndexedDB write that never settles leaves the hold
pending: that checkpoint never exports, and the persister's in-flight one (`inFlightEncrypted`)
never clears, so no later checkpoint starts either. No timeout, deliberately - exporting past a row
write that has not answered is the loss this order exists to prevent; the hung store is the defect,
and every other write to it hangs too.

**A store that keeps refusing the rows TRANSIENTLY blocks every checkpoint too** - commits and joins
included (`externalJoin` awaits one), until a write lands; said once per page as the cause (`[ADD_MSG]
Rows of applied frames cannot be stored (a transient failure) - every checkpoint is refused until they
are ...`). Accepted for the same reason: a checkpoint that lands past them is the loss. **A reload
does not end it** (corrected 2026-11-19, review of #3851 - this page said "or the page reloads"):
since the ack waits for the row, the frame is still on the server, so the reload decrypts it again
and writes the same row again; a failure a retry can pass ends when the store takes it, and a row the
store refuses for what it IS no longer reaches this state at all - it is dropped
([a poison row](#a-poison-row-is-dropped-not-kept-2026-11-19)).

**One observer, every hook required.** Each page hands the session ONE object,
`useMessaging.bulkIngestObserver(msgCtx)` (`SessionCallbacks.messageIngestObserver`,
`Required<BulkIngestObserver>`), so the window's open, its close and the checkpoint's hold are
registered together or not at all; `messageIngestObserver.wiring.test.ts` pins both pages and the
session's registration.

**What it costs.** A checkpoint that lands inside an open window renders the buffered messages at
that moment instead of at the close, and messages arriving while it writes render one by one (the
live path). The persister defers its own checkpoints inside a window, so this is the rare case. The
log says it once per hold that stored something: `[ADD_MSG] A checkpoint is about to export: storing
the N buffered message(s) first, the window stays open`.

**Pinned by** `useMessaging.rowsBeforeRatchet.svelte.test.ts` (the buffered rows are in the store
when the hold resolves, the window still open - the simulated kill; a message during the hold is
stored by its handler; buffering resumes after release; a hold waits for a close already storing; a
failing store rejects the hold and the next hold retries it, from the hold's own store and from a
close's; the observer's hold is the messaging hold) and `BaseMlsService.rowsBeforeRatchet.test.ts`
(rows stored, then export, then write, then release; released on a failed write; a failed hold
refuses the checkpoint and exports nothing).

**What it did not close** - a row not yet STORED when the export is taken, and an application
frame acknowledged before the close stored its row - is closed by the section below; the last
window, the orphan buffer, by [the one after it](#rows-before-ratchet-the-orphan-buffer-2026-11-20).

#### Rows before ratchet: the decrypt half and the ack (2026-11-19)

The step above stores what the BUFFERS hold. Its first follow-up, a poison row told from a
transient failure, is built [below](#a-poison-row-is-dropped-not-kept-2026-11-19); the other, a metric
for the withheld acks, is [a backlog entry](../../backlog.d/p2-rows-before-ratchet-withheld-ack-metric.md). Two windows of the same class were left (the
backlog entry, raised by the review of #3786), each
milliseconds long - and the [charter](../../../principes.md)'s second principle does not count in
milliseconds.

**1. A frame between its decrypt and its row.** A handler that decrypted an application frame has
spent the generation (the advance is in the state an export takes) and has not reached
`addMessageToChat` yet (web: an `await` between the two; native: a decrypt command already issued),
or reached it and its write is in flight - on the drain's live path and outside any drain alike. No
buffer holds that row, so the hold above could not store it. **The fix is the same order, one step
earlier** (`RowsOwedLedger`, `frontend/src/lib/mls-client/rowsOwed.ts`):

- the handler marks the row OWED (`IMlsService.oweRow`) immediately before the decrypt, with nothing
  awaited between the mark and the decrypt's call, and settles it once the row is stored, buffered
  or kept as a failed write - or at once when the frame carries no row. **Whether a frame is marked
  at all is the SERVER's word**: the delivery's `isCommit` flag (a commit takes no mark, since it
  carries no row and awaits checkpoints of its own). A frame flagged a commit that is in fact an
  application message would carry its row outside the ledger; one flagged an application message
  that is a commit takes a mark it settles at once (no payload);
- `persistCheckpoint` holds the ledger FIRST: from that instant no new mark is taken (a decrypt that
  has not marked waits at the gate, BEFORE it decrypts), and the hold resolves when every mark taken
  before it settled. THEN the observers' hold stores the buffers those handlers may just have filled,
  THEN the export. The gate reopens at the export's CAPTURE where the platform has one - the web,
  whose `save_state` runs in the synchronous part of the write's call (`checkpointCapturesAtCall`) -
  and only once the write settled on native, where the export runs inside the command (review of
  #3851: holding it through the web's seal and put made every decrypt wait out the whole write).

**Why it cannot deadlock, and terminates without a clock.** The set of marks is closed when the hold
is taken, and each is settled by its own handler on a path that never awaits a checkpoint: a commit
takes no mark (it carries no row, and awaits checkpoints of its own); a call signal and every system
event OUTSIDE an allowlist settle BEFORE their dispatch (a removal or a group deletion drops the
group's state, which awaits a checkpoint; a notice resolves display names over the network); the
`catch` settles FIRST (an eviction does the same); a message settles when `addMessageToChat`
returned, a reaction when it is applied, and the system events that WRITE a row - `edit_message`,
`delete_message` (`SYSTEM_EVENTS_OWING_THEIR_ROW`, review of #3851) - once their dispatch returned:
their paths were read for a checkpoint AND for a request, and await the store only. An allowlist, so
an event added later settles early by default; adding one means reading its path first.

**`history_bundle` is NOT on it** (second review of #3851, which first listed it): its messages are
written only after HTTP lookups - `dropOwnExcludedMessages` reads the group's withheld windows and
exclusions (`getGroupWithheld`, `getGroupExclusions`), and `vetBundle` may check an author proof
against the server (`checkRecordedAuthorship`). Held through them, one hung request held every
checkpoint, and every checkpoint's closed gate every inbound decrypt. Its mark settles before the
dispatch, like any event outside the list. What that costs, stated: a kill between a checkpoint that
exports the bundle frame's advance and the write of the messages it carries loses those messages from
this device until the next history exchange for the conversation asks for them again - a bundle
answers a diff of what the device HOLDS, so what it did not store is what the next one carries. Their
order (the lookups need the decrypted bundle) leaves no way to do the network part first. The only things inside a mark are the decrypt and the row's
store, neither of which awaits a checkpoint. The checkpoint itself takes no MLS lock, so a decrypt
waiting at the gate while its drain holds the frame's lock blocks nothing the checkpoint needs. The
Welcome's replay of the frames it buffered (`handleWelcome`) marks each the same way.

**And a live-path write that FAILS is kept.** `addMessageToChat` wrote the row and only logged a
failure, so the row was shown, not stored, and the next export went through. It now writes through
the batch's own seam (`writeBatchRows`, via `writeOrKeep`) and keeps a failed write in
`unstoredRowWrites`, which the next hold retries and refuses on, exactly as a batch's. **So do the two
UPGRADE writes of the live path** (review of #3851): the upgrade of a SHOWN push preview in
`addMessageToChat` and the upgrade of a STORED one in `settleStoredBodies` caught, logged and went on,
so the frame was acknowledged while the stored row was still the notification's caption. Both are
`upgradeRows` of a `BatchRowWrite` now (a compare-and-set, `mergeShownUpgrades`), kept on failure. **A
failed CONVERSATION-row write withholds too**: `writeBatchRows` ends with `saveConversation`, and a
write is stored only once that landed, so a refused conversation row keeps its rows' frames on the
server like a refused message row. **A reaction whose write onto its stored row
fails is kept too** (`applyReactionFrame`): parked as a pending mutation, which the next look writes
onto the row, instead of a log line and a reaction gone at the next reload (review of #3851).

**2. An application frame acknowledged before its row is stored.** A leader tab acknowledged an
application frame at the drain's end - `announceAck` runs in `onDrainEnd` BEFORE `endBulkIngest`
stores the window's rows - and a kill between the two left the row nowhere on the device and the
frame gone from the server; only the history archive brought it back. **Now the ack chain waits on
the close's store as it waits on a checkpoint** (`DrainAckHold.rowsStored`, the drain's `closed`),
then reads WHICH FRAMES the observers left with rows shown and not stored
(`BulkIngestObserver.framesLeftUnstored`: the queued ids of the failed writes' and the thrown
batches' rows). **Per frame** (review of #3851): each row carries the queued id of the frame it was
decrypted from (`AddMessageToChatOptions.frameId`, set by `handleKnownGroup`, kept in
`BatchRowWrite.framesByRow` and in a kept batch's messages), and only the ids in that set are withheld
(`[ACK] N id(s) not acknowledged: M frame(s) have rows not stored (shown and not stored, decrypted orphans, or a write in flight)`, said ONCE per episode;
the acks withheld after it are counted, and the first read that finds no such frame ends the episode
with one line carrying the count - a repeat re-listed by every pull used to print a line per frame per
pull): they stay on the server, and the repeat a later pull brings is re-acknowledged under the same
rule (`reAckHold`). Every other application frame is acknowledged. The first build counted rows across
the PAGE, so one row that could not be written withheld every ack of every conversation - and since the
frame survives a reload (it is withheld), the reload rebuilt the same row and the same stall. An
observer that cannot answer withholds every application id, at ERROR. An id a LANDED checkpoint
already holds is acknowledged whatever is left - that checkpoint stored every row before it exported.
The ack's request now leaves after the window's close (a few ms later than before), and the owed pull
still chains behind it.

**What it costs.** A checkpoint that meets a frame mid-handler waits for its row (`[ROWS_OWED] A
checkpoint waits for N decrypted frame(s) to store their rows before it exports`, said only when it
waits), and the drain's next application frame waits for the capture (`[ROWS_OWED] A decrypt waits
for N checkpoint(s) to take their export first`, at log once per wait - at debug, the one line naming
the cause of a stalled drain was filtered out) - on native, for the whole write.
**The decrypt wait is ordinary in a burst, not rare** (measured in S14, `1.7.1-alpha.6`, the Mi 9T's
log of the sitting): a live drain of ONE frame ends with its own checkpoint (the persister's at the
window's close), and so does each read mark the open thread sends; on the phone that checkpoint took
226-461 ms. A peer typing a burst lands frames ~0.56 s apart, so the next frame often meets the
previous drain's checkpoint still writing: 6 of the 12 burst arrivals of that log waited, each for the
REST of that one write (25-280 ms), then decrypted, stored and closed normally - no stall, no frame
waiting on two checkpoints. Expected, and the cost of the order on native, where the export runs
inside the command: the gate cannot reopen before the write ends. What would be a defect is a wait
not followed by its `Message decrypted` line, or one counting more than one checkpoint. Two widenings, stated (review of #3851): the send counts
a checkpoint declares durable are read BEFORE these holds, so the wait widens the window in which a
send lands after the read - which costs one burnt generation too many at the next load, never too
few; and a FOLLOWER tab's checkpoints are refused before any hold is taken, so it never retries its
`unstoredRowWrites` until a reload (its acks wait for the leader's coverage anyway).

**THE LIVENESS COUPLING, stated.** While a hold stands, no application frame is decrypted. So a row
write that never settles holds every checkpoint, as a hung buffered write already did, AND that
checkpoint's closed gate holds every inbound decrypt behind it; on native a hung checkpoint command
does the same, while on the web the gate reopens at the capture, so a hung seal or put never stops
the drain. No timeout, deliberately: exporting past a row not stored is the loss itself.

**Pinned by** `rowsOwed.test.ts` (the gate, the wait, a release that reopens only with the last hold,
a waiter re-reading the gate), `BaseMlsService.rowsBeforeRatchet.test.ts` (owed row, then buffered
rows, then export; a decrypt asked during the write waits for it; a refused checkpoint reopens the
gate; on the web the decrypts resume at the capture), `setupMessageHandler.rowsOwed.test.ts` (marked
before the decrypt and owed through the add; the frame id reaches the row; a checkpoint during the
add waits; an event outside the allowlist - a history bundle included - settles before its dispatch,
an edit or a deletion after it; a decrypt throw settles; a dispatch throw settles, is NOT acknowledged
and asks no re-add; a commit takes none; the Welcome's replay marks each buffered frame the same way, and its replayed row carries that
frame's id; a system event's writers stamp the frame id),
`reactionFrame.unstoredWrite.test.ts` (a failed reaction write is kept),
`systemMessageHandler.unstoredWrite.test.ts` (a failed edit or tombstone write is parked),
`BaseMlsService.leadLostAck.test.ts` (the ack waits for the close; only the frame whose row is
unstored is withheld, said once per episode; an observer that cannot answer withholds all; a landed
checkpoint acknowledges), `useMessaging.rowsBeforeRatchet.svelte.test.ts` (a failed live write is
kept, refuses the hold, and the next stores it; the frames the ack reads, per frame; a poison row is
dropped, alone or isolated in a batch, with its metric; a bare `DataError` and a conversation-row
`DataCloneError` are transient; a thrown inbound add is kept and stored by the next hold; a batch-path
row withholds its own frame; both upgrade writes are kept on failure; a notification that throws runs
after the row is stored; a kept add's rerun asks the store; a mutation parked against a stored row
lands at the next hold, lets it through while it cannot - said once at ERROR - and an entry waiting
for its body is not said stuck; a store-decided rerun shows what it wrote and announces nothing),
`useConversations.settleLoadedRows.svelte.test.ts` (an edit parked against a stored row lands when an
older page loads it),
`rowWriteFailure.test.ts` (the classes, never a message; the store raises `RowRefusedError` at the
refused row and lands nothing of its write; a page holding a poison row stores every other row) and `tabMessageSync.test.ts` (a refused post
never throws into its caller).

#### Rows before ratchet: the orphan buffer (2026-11-20)

The last window of the class ([charter](../../../principes.md), principle 2). `addMessageToChat` keeps
a message whose conversation is not in the map in an in-memory buffer (`bufferOrphan`) until a
Welcome drains it (`drainOrphanMessages`). Outside every checkpoint's hold: if the message was
decrypted from a queued frame, an export could claim that frame's ratchet advance while only memory
held its row, and its frame was acknowledged once the handler returned.

**Who reaches the buffer, measured.** Both `[ADD_MSG] conversation ... introuvable` lines now say
their SOURCE (`orphanSource`: `decrypted frame <queued id>`, own send, own notice, push preview,
local notice, own or unframed message). In every device log of the 1.7.1 sittings at hand (the Mi
9T's of S14, the iPhone's two rings of S13, the Mi's logcat of S10) the buffer was reached ZERO
times; only the unit tests write the line. Statically, a DECRYPTED message reaches it in one way
only: `handleKnownGroup` refuses an absent conversation BEFORE it decrypts (`absent-conversation`,
not acknowledged), the Welcome's re-key moves a 1:1 under the MLS lock the frame's handler holds, a
restore's prune and re-seed are one synchronous loop, and the Welcome's replay inserts its
conversation before it replays - so the conversation LEFT the map while the handler ran. What takes
one out while the pipeline runs is a closed list (`ORPHAN_REMOVERS`, named in the drop line): the
reader's local deletion or a group deleted by its admin (`purgeConversation`), a removal or a leave
the server states (`purgeLocalConversationRecord`), a creation rolled back (`groupCreation`), and a
restore pruning a row the store no longer holds. Every other writer that can meet an absent
conversation (an own send, an own or local notice, a call notice, a salon event) has no MLS advance
behind its row.

**A backup import no longer clears the map** (review of #3887). `importUserBackup` cleared it and
then asked for a reload, and the settings page passed a reload that did nothing: the list stayed
empty until a restart, and a frame meeting that empty map was an orphan dropped as removed although
its conversation was coming back from the store. The import now only asks the session's own restore
(`loadAndRestoreConversations`, through `restoreAfterImport`), which prunes and re-seeds the map in
one synchronous loop; a tab with no session callbacks shows the imported rows at its next restore.
**The import's outcome is the store merge**: a restore that then fails (a group list the server did
not answer) is logged as the restore's failure and caught up by the next restore - reported as the
import's, it had the reader import again a file already in.

**The shape: the orphan buffer is counted in the hold, by kind.** Storing the row at buffering was
refused: the row would belong to a conversation the store does not hold (the restore and the sidebar
would have to learn to skip it), and the evidence says the conversation was REMOVED - a row to drop,
not to store. So:

- a FRAMED orphan (it carries a `frameId`) is settled by every store - a hold, a window's close, a
  drain - in ONE pass first, and AGAIN at the end of the store's step before it counts
  (`settleFramedOrphans`): its conversation in the map again, it is stored through the batch path (a
  failed write kept, a throw kept as a batch, both refusing the hold like any other row); not in the
  map, it is DROPPED, said at WARN with its frames and the removers (`[ORPHAN] N decrypted orphan
  message(s) dropped (<origin>) ...`), and never blocks the hold - writing it back would resurrect
  what was removed. No wait for a Welcome that may never come, so the hold terminates without a clock;
- the second settle is what keeps an orphan ARRIVING during the step (a history bundle's row, whose
  mark settles before its dispatch) from refusing a commit's or a send's checkpoint and from spending
  the once-per-page "Rows of applied frames cannot be stored" line on something the next settle drops.
  One arriving after that second settle still refuses the hold, on its own line (`[ORPHAN] A
  checkpoint is refused: N decrypted orphan message(s) arrived while its store ran`). A step that
  THROWS is a third case, carried as a type (`StoreStepOutcome.threw`): the hold is refused on a line
  naming the throw, neither the orphan line nor the failing-store one, and the settle reads the map
  before it touches the buffer, so a throw there leaves every orphan where it was;
- while it stands its frame is withheld from the ack (`framesLeftUnstored`), and the cap of 50
  waiting messages binds the unframed only: a framed orphan is a decrypted message, never refused by
  the cap, and it cannot accumulate since every store settles it;
- an UNFRAMED orphan keeps waiting for its Welcome: nothing a checkpoint exports stands behind it.
  **The drain is a step of the store chain** (`bufferedRowsStored`), and takes its entries IN the
  step, not at the call: the Welcome's own `persistNow` follows the drain at once, and its hold
  resolves only once the replayed adds returned. The framed entries of the drained key go through the
  settle; the own-send status re-read runs after the step, outside it.

**A row is counted until its write has landed** (review of #3887, the same mechanism in three more
places). A store took its rows out of the ledger the ack reads BEFORE writing them - the drain at its
call, the retry of a kept write (`unstoredRowWrites.splice`), the rerun of a kept batch, the flush of
the bulk buffer - so for the length of the write the frame was in no ledger, and a re-ack read then
(it does not wait for a store) acknowledged a frame whose row then failed again. Each of them now
counts its rows' frames as being stored (`framesBeingStored`, read by `framesLeftUnstored`) from the
take to the outcome: landed, kept again, or dropped.

**Pinned by** `useMessaging.rowsBeforeRatchet.svelte.test.ts`, "the orphan buffer": a checkpoint
does not export past a still-buffered decrypted orphan; one for a removed conversation is dropped
and said, and never refuses a hold; `drainOrphanMessages` stores its row before a hold taken right
after it resolves; the drain's frame stays withheld while its write is in flight; so do a retried
write's (during the retry, and after it fails again) and a kept batch's rerun's; an orphan added
while a hold's step runs is settled by that step without spending the failing-store line; a drop at
a window's close; one key holding both kinds; a settle whose write fails or that throws keeps the row
and refuses the hold; the cap does not refuse a framed orphan.

#### A poison row is dropped, not kept (2026-11-19)

**The defect (review of #3851).** A kept write is retried by every checkpoint's hold, and while it
fails every checkpoint is refused - commits and joins included - and its frame's ack withheld. That is
right for a failure a retry can pass (a full disk, an aborted or inactive transaction, a store closing
under a reload) and wrong for a row the store refuses for WHAT IT IS: such a row fails at every retry
and after every reload, so it stalled the device for good.

**Classified at the throw, by type** (`frontend/src/lib/db/rowWriteFailure.ts`): the store wraps the
refusal of ONE message row's own request - the `add` in `saveMessagesIfAbsent`, the `put` of the
message merge - into a `RowRefusedError` carrying the row and the refusal's `DOMException` name, and
aborts that write whole (no half batch lands). `classifyRowWriteFailure` calls POISON only a
`RowRefusedError` whose name is `DataError` (a key the store cannot take) or `DataCloneError` (a value
it cannot clone) - IndexedDB raises both synchronously at the refused request. Everything else is
TRANSIENT, deliberately, and is kept: withholding costs a re-listing, acking past a row a retry could
store costs the message. **A name read off whatever reached the writer is NOT enough** (second review
of #3851, which caught the first build doing it): `crypto.subtle.importKey` raises `DataError` for an
empty device key, which sign-in paths hand the store on purpose, so every row of the page would have
been dropped as poison and its frame acknowledged; and a `DataCloneError` on the CONVERSATION row
(`saveConversation`, after the message rows landed) would have blamed rows that were stored. Both are
transient now. A message is never read.

**Native never classifies a failure as poison.** The SQLite store (`db/sqlite.ts`) raises no
`RowRefusedError` - its refusals come back over IPC as strings with no type - so on Android, iOS and
desktop every failed row write is transient: a row SQLite refuses for good stays kept, its frame
withheld, and every checkpoint is refused for it - per frame, not per page, so other conversations
still acknowledge, but no commit, join or send's durable state lands until the row does. That is the
stall the web build no longer has; it is the side this rule errs on (keeping costs a re-listing,
dropping costs the message), and typing the native refusal at its throw is what would lift it.

**A writer that hands over a whole PAGE isolates the same way** (third review of #3851). The store
aborts a write whole when it refuses one row, so the archive replay (`utils/chat/history.ts`) and a
re-key's write of the rows only memory held (`rekeyStoredDirectRows`) lost the page to one poison row.
Both go through `saveMessagesIfAbsentIsolated` (`db/rowWriteFailure.ts`): the page first, and on a
poison refusal each row on its own (`writeRowsIsolatingRefused`, the ONE isolation `writeOrKeep` uses
too), the poison rows said at ERROR and left out, a transient failure thrown to the caller as before.

**What a poison row owes instead of a retry** (`writeOrKeep`, `useMessaging`): a single-row write is
dropped; a multi-row write is ISOLATED - each row written on its own, once, so the rows the store takes
are stored, the poison ones dropped, and one that now fails transiently is kept on its own. One pass,
no retry loop. Each drop is said at ERROR with its frame (`[DB] POISON ROW ... DROPPED from the rows
kept`), counted on the page (`#N this page`, and `logMlsMetric({ kind: 'row_write_poison' })`), and
the row leaves the rows kept: it no longer refuses checkpoints, and its frame's ack goes out.

**What is lost, and why it is accepted.** The row is shown in memory and nowhere else: its frame is
acknowledged and the next checkpoint makes its generation durable and marks it seen, so the message
is lost FROM THIS DEVICE at the next reload. The sender and every other device still hold it, and a
history exchange for the conversation that names what this device holds would carry it again - and
meet the same refusal. The alternative was the stall: no checkpoint (no commit, no join, no send's
durable state) and a frame never acknowledged, for good, for one row nothing on this device can ever
store. A poison row is a defect in the row's construction, so it is said where a reader sees it, and
its rate is owed ([the metric](../../backlog.d/p2-rows-before-ratchet-withheld-ack-metric.md)).

**A frame that decrypted and whose DISPATCH threw is not a decrypt failure** (review of #3851).
`handleKnownGroup`'s `catch` was written for decrypt failures; a throw from `addMessageToChat`,
`applyReactionFrame` or `handleSystemEvent` reached it, was classified `unknown`, asked a re-add of a
healthy group and acknowledged the frame - the message lost. The dispatch now has its own `try`, which
rethrows as `InboundDispatchError` (classified at the throw, by position): the `catch` says it at ERROR,
asks NO re-add, and does NOT acknowledge (`dispatch-failed` in the unacked tally, kept off the work
list - no event discharges it). The reachable trigger the review named is closed at its source: the
cross-tab announcement `addMessageToChat` makes between showing a row and storing it
(`tabMessageSync.post`, a `BroadcastChannel.postMessage` that can throw `DataCloneError` or
`InvalidStateError`) never throws into its caller any more.

**Withholding alone was not enough, so a MESSAGE whose add threw is KEPT** (second review of #3851;
principle 2 of the [charter](../../../principes.md)). The frame's generation is spent (`noteConsumed`
ran before the dispatch), so the next checkpoint made it durable, after which the frame the server
still held could never be decrypted again - its next copy reads as a duplicate. `useMessaging.addMessageToChat`
now catches a throw for an inbound message that carries a `frameId` (and no outbox entry) and keeps
the message as a batch that threw (`unstoredBatches`, origin `dispatch`), then rethrows: the frame is
withheld (`framesLeftUnstored`), the next store of either kind runs the message again, and every
checkpoint's hold is refused while it cannot be written - so the advance never becomes durable
without its row. What is left - a dispatch of a frame carrying NO message (a reaction, a system event,
a call signal) that throws - is [a backlog entry](../../backlog.d/p2-rows-before-ratchet-dispatch-throw-redelivery-reads-as-duplicate.md).

**The row is written or kept BEFORE any effect that may throw** (third review of #3851). The live add
rendered the message, then announced it to the other tabs, signalled a salon read, played the tone and
raised the notification, and only then wrote the row. A throw from any of those left the message on
screen and off the disk; the rerun of the kept message met it in memory, called it held, and the frame
was acknowledged - the message lost at the next reload. The order is now render, WRITE (or keep), then
each effect on its own (`afterTheRow`, which says a throw at ERROR and goes no further): a failed tone
or banner never costs the message. And the rerun of a message a live add kept decides "stored" from
the STORE, never from memory (`KeptBatch.storeDecides`, `batchAddMessages(..., { storeDecides })`): a
row on screen and not on disk is written as it is shown, and shown as written once what waited for it
(a deletion, an edit, reactions) is settled in. **That rerun is SILENT BY DESIGN**: the message is not
new to the reader - its first add rendered it and ran (or tried) its effects - so it raises no second
notification, tone or announcement. What a batch shows anew - an upgrade, a store-decided refresh -
is decided again against the row shown WHEN THE BATCH APPLIES, never only the snapshot it read before
its awaits (`Reshown`, `reshowOnto`; fifth review of #3851): a live edit or reaction that landed
meanwhile is kept, where it was overwritten by the older body until the settle after the write
repaired it.

**Every row a decrypted frame writes carries that frame's id** (second review of #3851: a row kept
WITHOUT one released its frame's ack, where the page-wide count had withheld it). The handler wraps
the row writers once per frame (`framedRowWriters`, `setupMessageHandler`), so every row written by
the frame's dispatch is stamped with its queued id unless the caller named one. The paths, audited
2026-11-19:

- a live message, reply or media (`handleKnownGroup` -> `addMessageToChat`): stamped;
- a system event's rows - a visible notice (`addMessageToChat`), a history bundle's restored messages
  (`batchAddMessages(..., 'restore')`): stamped through `framedRowWriters`. The bundle frame is thus
  withheld while any message it restored stands unstored;
- the Welcome's replay of the frames it buffered (text through `batchAddMessages` or
  `addMessageToChat`, system events through `handleSystemEvent`): stamped through `framedRowWriters`
  with the buffered frame's own `deliveryMeta`;
- a reaction (`applyReactionFrame`), an edit or a deletion of a STORED row (`applyEdit`,
  `applyDeletion`): no row is kept in memory - a write that fails is parked as a pending mutation,
  which is on disk, and written onto the row at the next look. The edit and the tombstone used to be
  logged and dropped (second review of #3851); they are parked like the reaction now;
- a commit's eviction notice (`retireIfEvicted`): a commit is a structural id, acknowledged only once
  a LANDED checkpoint covers it, and a checkpoint is refused while any row stands unstored;
- outside the ledger, filed below: a community key frame's seed, the history catch-up's archive frames
  (never acknowledged: they are not the mailbox's).

**A mutation parked against a row that STANDS is retried at every checkpoint's hold** (third review of
#3851). Parking an edit, a tombstone or a reaction whose write onto its stored row failed kept the act
on disk - but its frame is acknowledged, and `settlePendingFor` ran only when that row was written
again, which a stored row never is: nothing drained the parked entry. The store of pending mutations
now notes every target this session parked for (`pendingMutationStore`, `parkedThisSession`), and the
hold retries them next to the kept rows (`retryParkedMutations`): a target whose message has not
arrived, that does not open here, or whose entries settled leaves the ledger; one whose row STANDS and
still refuses its entries - or whose store could not be read to say - stays for the next hold, and is
said at ERROR ONCE per stall under its own cause (forgotten when the target settles, so a later stall
is said again), with the classified failure (`[PENDING] A
PARKED MUTATION CANNOT BE MERGED ONTO ITS STORED ROW ... (transient|poison)`; `settlePendingFor`
resolves those targets as `stuck`, each with its failure). The ledger is the session's; across a
reload, the rows a page LOADS settle what waits for them (`useConversations.settleLoadedRows`, one
indexed read per page, in the background - settling twice changes nothing).

**A parked mutation NEVER refuses a checkpoint** (fourth review of #3851, which reversed the third's
brief). An id enters the ledger only once its entry is WRITTEN to the pending store: the act is durable
before it is noted, its frame's ack loses nothing, and a reload's load of the row applies it. Refusing
the checkpoint for it would protect no copy of anything - it would only stop commits, joins and a
send's durable state, for the whole session when the merge fails deterministically (a refused row, a
store that cannot be read), under a line blaming "rows of applied frames". So the retry runs at every
hold, what stays stuck is said, and the checkpoint goes through.

**A mutation with no server time is not parked, and its frame is acknowledged** (`parkPendingMutation`,
said at ERROR). Withholding that frame would not keep the act: its generation is spent, so the
redelivered copy reads as a duplicate ([the entry above](../../backlog.d/p2-rows-before-ratchet-dispatch-throw-redelivery-reads-as-duplicate.md)).
It is not reached by a queued frame: the time is `queued_message.createdAt`, a NOT NULL column the
gateway forwards on every live frame and refuses at ERROR when its type is unexpected
(`apps/chat-gateway/src/subscribers.rs`), and a pull carries it from the same row - so the branch
names a defect upstream, where it is said, rather than an ordinary path.

**Left outside the ledger, filed** (review of #3851): a community key frame's seed (closed
2026-11-25 by keeping the plaintext in the decrypt's own mutation, no owed-row mark needed:
[mls-desync-prevention section 11](../../protocols/mls-desync-prevention.md#11-client---a-key-group-frame-is-kept-until-its-handler-succeeds-2026-11-25)), the Tauri resume's
live-ahead persist ([entry](../../backlog.d/p2-rows-before-ratchet-tauri-resume-live-ahead-persist.md)),
`changeDeviceKey` ([entry](../../backlog.d/p2-rows-before-ratchet-change-device-key.md)) and the history
catch-up decrypt sessions ([entry](../../backlog.d/p2-rows-before-ratchet-history-catch-up-decrypt.md)).

### Forwarding

`forwardMessage` crosses freely between the two worlds: a channel message can be forwarded into a
DM and a DM message into a channel. Only the transport differs (MLS group vs channel epoch key);
a media forward re-sends the same envelope in both cases, so no blob is re-uploaded and the CEK
travels with it.

## What a failed search leaves behind

`ChatArea.svelte` carries the whole in-conversation search UI and, until 2026-08-31, no logging of
any kind. Two of its branches discarded a failure in silence, and in both the discarded value
collided with a value the happy path returns on purpose:

| Branch | On failure it became | Which also means |
| --- | --- | --- |
| `onSearchAll(convId, q)` | `ids = null` | "this is a channel - nothing is persisted locally, use the loaded window" |
| `onRequestOlderFromPeers()` | `'unavailable'` | one of the three answers that call returns deliberately |

So the two were indistinguishable at every consumer, and both landed on the same
`searchLimitedToLoaded = isChannel`. A user reporting that search found nothing left no trace
anywhere saying whether the query ran, threw, or ran against a truncated corpus.

**The UI still collapses them, and that is correct** - there is one thing to tell the user either
way. The LOG is where they stay apart: both branches now `console.warn` naming the conversation and,
for the search, how many messages were actually looked at.

**One `catch` in that file is deliberately left silent.** `searchableText`'s
`catch { return message.content; }` fires when `parseEnvelope` rejects a plain-text body, which is
the ordinary case for most of a conversation - logging it would put a line on every search over
normal history. It is named here so the next reader does not re-open it.

## The search bar opens on the field and lands on the first match (2026-11-11)

- **Typing takes the reader to the match the counter calls 1, which is the NEWEST** (lead
  decision, 2026-11-11, reversible: landing on the oldest forced a long scroll and loaded old
  history on every search; Messenger and WhatsApp land on the newest). `searchMatches` is held
  newest-first (`onSearchAll` answers oldest-first and is reversed). `refreshSearchMatches` ends by
  calling `navigateToMessageEnsureLoaded(searchMatches[0])` once the list for the current term is
  known - a superseded query returns before it (the `searchSeq` token), so a keystroke whose list
  is still being computed never moves the view, and no timer is involved. An unloaded match pages
  older history in exactly as the arrows do. **Directions:** the up arrow and Shift+Enter go to
  OLDER matches (`jumpSearch('older')`, counter rises), the down arrow and Enter toward NEWER ones
  (counter falls, wrapping from 1 to the oldest). The icons did not move: up is up the conversation.
- **The tap focuses the field.** `openSearch` sets `showSearch` and calls `flushSync()` so the input
  is mounted inside the tap's own call stack, then focuses it: iOS raises the keyboard only for a
  focus made in the gesture, so a `tick()` or a `setTimeout` focus would lose it.
- **Escape (or the toggle) closes** through `closeSearch`, which resets the search and calls
  `ChatHeader.focusSearchToggle()` to return the focus to the magnifier. Test:
  `ChatArea.search.svelte.test.ts`.

## One fold behind every search box (2026-08-31)

Seven places in this app removed accents from a string, each with its own spelling of "which marks",
and the search boxes removed none: they folded CASE only, with a plain `String.toLowerCase()`. On a
corpus that is French, "reunion" could not find the word it is the unaccented spelling of. The
campaign's SEARCH-5 was written to record exactly that, and PASSED by asserting the defect.

`$lib/utils/textFold.ts` is now the only copy, and everything goes through it:

| What | Uses |
| --- | --- |
| the in-conversation matcher (`ChatArea.svelte`), the local-store one (`MainChatPage.svelte`), the store search (`useConversations.svelte.ts`) | `foldForSearch` on BOTH sides |
| the highlighter (`splitWithHighlight`, `chat/messageDisplay.ts`) | `foldWithIndex`, and slices the ORIGINAL |
| the sidebar filter (`conversationMatchesQuery`, `chat/conversations.ts`) | `foldForSearch` on BOTH sides |
| the admin user filter (`routes/admin/users`) | `foldForSearch` |
| five slug builders - workspaces, QR file names, `admin/carte`, `associations/new`, `lists/new` | `slugify` |
| the native-string guardrail's own comparison (`nativeStrings.test.ts`) | `foldForSearch` |

**BOTH SIDES, ALWAYS.** Folding only the query is the half-fix that looks like it works: every
unaccented query still finds every unaccented word, and the defect shows up only on the text this
app actually carries.

### Why the highlighter needs a MAP and not a length assumption

The matcher and the `<mark>` highlighter are the same seam, and the highlight must land on the
characters that matched. Folding is not length-preserving: a precomposed `e-acute` folds one
character to one, but the same letter written as `e` + U+0301 folds TWO to one, and one string can
hold both spellings. An offset found in folded space and used against the original is therefore
wrong by the number of accents before it - a drift that is invisible in tests written in ASCII and
visible in every French message.

So `foldWithIndex` returns `sourceIndex`, mapping each folded character back to the offset it came
from, plus an end sentinel so a match running to the last character still has an addressable end.
`splitWithHighlight` finds in `folded` and slices `text`, with two cursors rather than one derived
from the other. It walks CODE POINTS, so an emoji is one unit and never two halves of a surrogate
pair.

### The five slugs disagreed, and one of them was reachable

Three of the five stripped `[U+0300-U+036F]`, one `\p{Mn}`, one `\p{Diacritic}` - three different
character sets for one idea, so the same association name could slug differently depending on which
screen created it. `slugify(label, maxLength?)` is the single answer, and its `maxLength` trims
AFTER truncating: two of the five cut to 48 and one of those left the trailing `-` the trim exists
to remove.

**What is owed:** SEARCH-5's five runs asserted the pre-fix behaviour and are VOID. The runner's
prediction is flipped and the row needs `W1 W2` only - no hardware.

## Pooling history between devices

**Read [history-reconciliation](../../protocols/history-reconciliation.md) first.** It is the
specification - the model, the two boundaries, the exchange, the scrollback, and every decision
behind them, none of which is re-derived here. This section covers only what a reader of THIS module
needs: the digest's arithmetic, and the traps in the three legs it travels on.

A history exchange used to be all-or-nothing: `sendFullHistoryBundle` shipped the responder's ENTIRE
store and the receiver deduped by id, one way, with neither side knowing what the other held. It is
now a diff, and since 2026-08-12 the diff is itself behind a **state key**: a 64-bit fold of what a
device holds in its window, compared first, so the common case - the two devices agree - costs one
small frame and no store read on either side. A digest is exchanged only when the keys differ.

**The algorithm already existed and was tested** in the QR sync engine (`sync/syncEngine.ts`, since
deleted with that feature): a sorted manifest of message ids per conversation, and a symmetric
difference over two of them. What was missing was the TRANSPORT, and that is what
`utils/chat/historyManifest.ts` (pure) plus `utils/chat/historyDigestRendezvous.ts` now carry - this
time between the account's own devices, with no user gesture at all.

**THE DIRECTION IS FLIPPED against the obvious design - deliberately, do not restore it.** The
obvious design has the RESPONDER send the digest and the REQUESTER diff. It ships the other way
round: the **requester states what it wants, the elected responder diffs**. It costs one round trip
fewer, because the responder's reply already carries the data instead of asking for it.


**The legs as built.** Leg 1 is the WS `history_request` - server-side election is what keeps one
responder instead of a storm. Leg 2 is the **probe**, sent inside MLS by the requester, and it is one
of three asks on the same rendezvous: `history_state` (the key), `history_digest` (the manifest, only
after two keys came out different) and `history_range` (the scrollback). Leg 3 is the responder's
answer: it compares, sends a `history_bundle` filtered by id for what the requester lacks, and sends
`history_pull {to, ids|prefixes+depth, since}` for what IT lacks. A pull is answered by a bundle and
a bundle asks for nothing, so the exchange cannot re-enter itself - the WP-RETRANSMIT-1 lesson,
applied by construction.

**Leg 4 is a statement about the ANSWERER, not about the messages.** `history_coverage
{from, to, since, coveredFrom}` closes the exchange when - and only when - the responder's own
history begins later than the `since` it was asked for. It is the fourth reconciliation trigger: a
phone keeping five years asking a browser keeping ninety days gets a clipped answer every time by
construction, and without this frame that is indistinguishable from "the conversation has no more
past". The asker then elects again, EXCLUDING every member that has stated a coverage, and stops
when the server reports `no_peer_online` with a positive `excludedOnline` - every reachable member
has answered. The walk removes one member per step and the proof is delivered rather than inferred,
which is what makes it terminate without a clock. Full reasoning in
[history-reconciliation](../../protocols/history-reconciliation.md#the-fourth-trigger-an-answer-that-does-not-reach-far-enough-back).

**Its sibling, `history_cannot_repair {from, to, since}`, answers an asker that PROVED itself
incomplete** - its probe carried `incomplete: true` because it holds frames it cannot read - when
the responder holds nothing it lacks (keys equal, or a digest leaving nothing to send). It replaces
the coverage line in that case, and the asker excludes that member until a repair lands
([HEAL-repair](../../protocols/history-reconciliation.md#the-fix-the-walk-advances-on-an-answer-built-2026-11-17)).

**Every ask states its own window and the answer is clipped to it.** `since` rides on all three
probe kinds and on the pull. Four rules hold the whole thing together and none may be undone: it is
STATED by the asker and never recomputed by the answerer (the window slides, so two devices deriving
it a second apart disagree by whatever was sent in between); the DIGEST is not clipped, because it
says what a device HAS while `since` says what it WANTS, and a device must be able to serve a peer
whose window reaches further back than its own; the clip is on the ANSWER and never on the
COMPARISON, which is why it lives in `sendHistoryBundleForIds` alone; and each leg states its OWN
window, or every device in a conversation ends up capped at the shortest one in it.

**The rendezvous, and why it does not guess.** The two halves travel by different transports and
nothing orders them: the elected responder can be handed the WS request before or after the probe
reaches its inbound MLS queue. That used to be covered by a 3 s `HISTORY_DIGEST_GRACE_MS`, which is
exactly the shape of timer this codebase treats as a defect - it could not tell "the probe is a
moment behind" from "this peer will never send one". The responder now WAITS for the probe, bounded
by `DIGEST_TTL_MS` (60 s) because beyond that a probe describes a store that has moved and would be
refused anyway. Reaching the bound means the MLS frame never arrived, and a responder that was told
nothing answers nothing - a device that cannot say what it wants is not owed a full store.

**The requester ASKS BEFORE IT DESCRIBES ITSELF.** The election goes out first and the probe only
once the server reports a responder was elected - a probe sent first is an MLS frame every member
decrypts, for a repair `no_peer_online` may be about to refuse outright. `historyReconcile.test.ts`
pins the ORDER, not merely the presence of both.

A stored probe is CONSUMED on take - a later request must compare against a fresh snapshot, never a
minute-old claim (TTL 60 s).

**Two digest modes, by size.** `ids` (the sorted id list) below `DIGEST_ID_MODE_MAX` (1000), `range`
above it: the id space is cut into `16^depth` slices and each carries a count plus a truncated
SHA-256 of its sorted ids.

**The unit is a slice of the ID SPACE, and it used to be a MONTH - that change (2026-08-10) is the
one thing to understand here.** A month is cut from a message's stored TIMESTAMP, and the two devices
do not agree on it: the sender's clock against the server's puts a message either side of midnight
UTC, so on one device it is in July and on the other in August. Both months then read as different,
both are re-sent wholesale - and they do so again at the next exchange, forever, because nothing the
exchange does can make the two timestamps agree. The diff therefore never empties, and the empty diff
is the only thing entitled to clear the durable awaiting-history marker. At a few hundred messages
that is waste; at scale it is a permanent broadcast that never terminates, which is the same class of
defect as WP-RETRANSMIT-1. A message id is the same string on every device by construction, so a
slice of the id space holds the same members on both sides and an exchange that equalises it keeps it
equal. `historyManifest.test.ts` pins this directly: the same store with wildly skewed timestamps
produces a byte-identical digest.

Four details are the whole correctness of it:

- **The partition hash and the content hash are different functions on purpose.** `historyRangeOf`
  is FNV-1a plus a MurmurHash3 finaliser, synchronous, and decides only WHICH SLICE an id is
  compared in - a collision or an uneven spread there costs a fatter slice, i.e. bandwidth, never a
  message. `hashIdList` fingerprints a slice's CONTENTS and is SHA-256 truncated to 64 bits, because
  a collision there declares a slice identical that is not and loses the messages in it silently and
  permanently. The finaliser is not decoration: without it, 64 ids differing only in a trailing
  counter landed in 5 of the 16 depth-1 slices.
- **The DEPTH travels on the wire and the reader re-slices at the SENDER's depth.** Depth is derived
  from a store's size (`rangeDepthFor`, targeting ~64 messages a slice, capped at 3), the two stores
  have different sizes, so a reader using its own depth would compare different regions of the id
  space and everything would disagree. The `history_pull` carries it for the same reason.
- **Ids sort by CODEPOINT, never `localeCompare`.** The sort feeds the hash, so a locale-dependent
  comparator makes every slice disagree between two devices. The sort is part of the protocol.
- **A differing slice is requested in BOTH directions.** A fingerprint proves the slice is not
  identical, never which side is short; guessing drops messages, over-asking costs bandwidth and the
  receiver already dedupes by id.

**What the cap buys, and what it costs.** `MAX_RANGE_DEPTH = 3` bounds the digest at 4 096 slices
(~180 KB for a million messages, ~14 KB for five thousand). Past the cap slices get fatter rather
than the exchange gaining a round trip: still exactly one, still terminating, just more over-sent per
difference. That is deliberate - a recursive refinement would be smaller on the wire and would put
multi-round-trip state back into the one mechanism this whole area was just simplified down to.

**Silence is the fast path, and it needs no flag to say so.** Two agreeing keys send nothing at all,
so an empty bundle no longer has to carry what its emptiness MEANT - `vouched` and the three-way
`EmptyBundleMeaning` were deleted with the marker they existed to discharge. A responder that holds
nothing of a SUBSET it was asked about also stays silent, for the same reason it always did: it has
answered nothing about the rest.

**A failed store read is not an empty store.** `readHistoryEntries` returns `null` rather than `[]`
on a read error, and the responder then says nothing at all - an empty store is a fact worth telling
a peer, a failed read is a claim we are not entitled to make.

**Deletions are a non-problem**, verified in code: a deletion keeps a TOMBSTONE row (`isDeleted`), so
the id stays in the manifest, and both stores import non-destructively (`INSERT OR IGNORE` / IDB
`add`). Bulk row deletion exists only for CHANNELS and for a whole conversation. On merge a tombstone
WINS over a body, or a peer that missed the deletion undoes it.

**Metadata**: the digest rides inside MLS, so the server learns nothing it does not already hold.
Co-members learn which ids this device kept, hashed per slice in range mode. Accepted.

**Two traps, both now handled.** Every leg is a GROUP broadcast, so the pull carries its target
(`digestIdentity(userId, deviceId)` - the DEVICE, so a user's other two devices do not answer a pull
addressed to the first) and non-targets ignore it. And the REPLAY path (`historySystemEvents.ts`)
ignores `history_digest` / `history_pull` through an explicit `REPLAY_IGNORED_EVENTS` set - transient
negotiation, meaningless when re-read days later, and naming them means adding a branch later has to
be a decision rather than an accident.

#### The bundle is INGESTED by everyone and ANSWERS one device

The third leg is a broadcast too, and it was the one that lost messages. `history_bundle` carries a
`to` (the requester's `digestIdentity`, set by `bundleFrame` on every send path - full store, id
diff, and both flavours of empty bundle), and the receiver splits what it does with it in two:

- **the messages are taken by every member** - the merge dedupes by id, so over-delivery costs
  bandwidth and nothing else;
- **the addressing decides who it was FOR**, which used to matter far more than it does now: the
  answer once discharged a durable marker, so one repair between two peers permanently cleared the
  marker of every other member, and whatever was missing on those devices stayed missing. That whole
  class went with the marker - a device that finds itself short simply asks again on its next
  connection - but the field stays, because a bundle a device did not ask for is still a bundle it
  cannot interpret as an answer about its own store.

A bundle with **no `to`** is a bundle nobody solicited: the invite push sends one, and so does a
client too old to address it. It is ingested like any other and answers nothing.

**Why not address the frame itself.** The obvious fix is the `recipients` field of `POST /send`.
Do not: MLS re-encrypts per recipient set, and narrowing it on an application message burns the
sender ratchet budget (`sender_ratchet_config()` is `(2000, 2000)`) into a generation gap the other
members cannot close - `forgetGroup` and a re-Welcome. `to` is addressing, not secrecy, and must
never be read as the latter.

The responder half is symmetric: `history_pull` is answered with a bundle addressed back at the
puller, whose claimed `from` is cross-checked against the authenticated MLS sender exactly as
`history_digest` is. An unusable `from` is dropped rather than answered to nobody.

**A digest names a device, and a member can only misreport its OWN.** `systemMessageHandler`
cross-checks the `userId` a `history_digest` claims against the authenticated MLS sender before
recording it; the device half is unverifiable and harmless (the worst a member can do is answer for
the wrong one of its own devices).

**Scope is DMs and groups only.** Channel rows are wiped and re-fetched from the server tally at
every load, so pooling would fight the refresh (`isChannelConversationId`).

This subsumes the `no-local-history` clause of the current marker: "awaiting history" becomes "my
diff with at least one peer is non-empty", which empties itself.

#### A row sent by `system` is a system row, and the SEAM derives that (2026-09-16)

Two renderings of the SAME `memberAdded` were photographed in one thread on production: a centred
grey pill, and directly beneath it the same sentence as an ordinary left-aligned bubble under a
**"Utilisateur"** header. The second is what a system notice looks like when `isSystem` is false -
the renderer draws a normal message, and no display name resolves for the `system` sentinel, so the
sender label falls back to the unknown-user string.

`serializeForBundle` is the writer that produced it. A bundle row carries the sender, the body, the
id, the two timestamps, the reactions, the tombstone and the edit instant - and has never carried
this flag, for a good reason: **`isSystem` and `senderId === 'system'` are the same fact, and
putting both on the wire is where they get to disagree.** The flag was never missing from the
bundle. It was missing from the READER.

`isSystemSender`'s own docblock already stated the invariant - *every seam that MATERIALISES a row
derives it from here instead of restating it* - and the 2026-09-14 fix honoured it in the REPLAY's
`pushPendingMessage` only. The LIVE bundle merge in `systemMessageHandler` does not go through that
function: its `toAdd` rows are handed to `batchAddMessages`, or to `addMessageToChat` one by one
when the batch path is unavailable, and BOTH of those restated the caller's flag. Half an invariant
is not an invariant. Both now derive:

```ts
const isSystem = options.isSystem === true || isSystemSender(senderId);   // addMessageToChat
const isSystem = pm.isSystem === true || isSystemSender(pm.senderId);     // batchAddMessages
```

It widens the answer rather than replacing it: a row its writer flagged stays flagged whatever its
sender is.

**THE RENDER IS THE SMALLEST OF THE THREE THINGS THIS FLAG DECIDES**, and that is why the defect was
worse than the screenshots show. The same value gates the unread badge, the arrival tone and the OS
notification, so a group notice restored through a bundle **rang a phone, raised a count and pushed
a banner for a line nobody sent** - on a device that had merely reconnected. A rendering bug is what
got reported; three of the five tests in `useMessaging.systemSender.svelte.test.ts` fail without the
fix, and one of them is the notification.

**NOTHING IS OWED TO THE DEVICES THAT ALREADY SHOWED IT, AND THAT IS A PROPERTY OF THE SCHEMA RATHER
THAN OF THE FIX.** `StoredMessage` HAS NO `isSystem` COLUMN, so `mapStoredMessagesToChatMessages`
derives it on every read from IndexedDB and always has. The wrong value only ever existed on the
in-memory row, for the life of the session that received the bundle - which is also why the
photograph could show both renderings of one event side by side. A reload was already the repair.
There is no migration here, no collapse pass, and no destructive control to gate.

This is independent of [the notice-identity fix](#a-visible-system-notice-needs-an-identity-the-sender-minted),
which gives a notice ONE id across the three paths that can write it: that one settles HOW MANY rows appear, this one settles their SHAPE however they
arrived. A correctly deduped notice could still be a "Utilisateur" bubble, and was.

#### A system notice is not conversation activity (user, 2026-10-27)

"X added a device" moved its conversation to the top of the list. The sidebar key is
`conversationRecency` (`utils/chat/conversations.ts`, also read by the share targets, the mini panel
and the persisted `updatedAt`) and it read the newest row of `messages`, notices included. It now
skips every row for which `isSystemRow` (`messageOrder.ts`) is true - `isSystem` OR the `system`
sender, the same fact in its two forms - and every writer of the `lastMessageAt` seed goes through
`advanceLastMessageAt`, which ignores notices too (`addMessageToChat`, `batchAddMessages`, the FCM
cache merge, the channel join notice). A conversation holding notices only keeps its seed, then
`startedAt` (the server's creation instant), then 0: never the arrival time of a notice.

**A CALL RECORD IS ACTIVITY (decided 2026-10-27)**: a system row carrying a `callEvent` envelope (missed,
ended, declined) still moves the conversation, as on Messenger and WhatsApp; `isNoticeRow` is the
predicate every consumer uses (notice = system row that is not a call record). Tab-sync events omit
`lastMessageAt` when there is no seed (`tabSeed`) instead of writing 0. A conversation created on
this device is seeded with its creation moment (`lastMessageAt`, group / DM / channel creation and
the channel join), NOT `startedAt`, which stays the server's write-once fact that the sweep
backfills. The boot stub seeded from an old `meta.updatedAt` (written while notices counted) is
transient: the first load of messages replaces it, no migration.

**The preview line is unchanged** and still shows the newest row, notice included: it is a text, not
a position, and hiding it would show a stale sentence. Read receipts and unread counts already
ignored notices. Not changed: native notification previews (they raise only for inbound messages).

### What ended the wait, and why there is no wait left

Kept because the shape recurs, not because the code is still there. The exchange used to be gated by
a durable marker recording that a group was short of history AND the evidence for it - a
**presumption** (`no-local-history`) void the moment any message landed, or a **proof**
(`unreadable-frames`, `peer-holds-more`) that other messages arriving could not unlearn - and only an
empty **vouched** bundle from a responder entitled to claim completeness could discharge it.

That argument was about the DATA, and it quietly assumed some peer was entitled to vouch. Once BOTH
peers of a DM carried a marker and their stores were equal, the difference was zero on both sides,
both stayed silent, and neither marker could ever clear (WP-HISTBANNER-1). It was patched once - a
three-way `EmptyBundleMeaning` separating what a responder MEASURED from what it may CLAIM - and
measured again on 2026-08-12 still holding markers 1.9 days old on both devices of a DM.

**The whole gate is deleted.** The reason it existed was that asking was expensive: a full-store dump
had to be justified by evidence. A state key costs one small frame, so a device simply asks on every
connection and believes the answer, and there is no durable claim left to discharge, vouch for or
rank. `EmptyBundleMeaning`, `vouched`, `REASON_RANK`, `isProvenAwaitingReason` and the 30-day horizon
are gone with it.

**Two claims made about that defect were wrong and are recorded because the error is instructive.**
The banner was said to latch "for the life of the tab": it did not, because the 15-minute sweep
re-solicited on a visible tab. And "Nouvelle tentative automatique" was called a lie left over from
the deleted retry ladder: deleting the LADDER had not deleted the SWEEP, and the string was accurate
throughout. **A claim that a user-facing string is stale must name the mechanism that would honour it
and show that mechanism gone** - one grep for the sweep constant would have refuted both before they
were written.


### There is ONE repair, and deleting the other one is what fixed the escalation (2026-08-10)

For a while there were two, with a ladder between them: a narrow `decrypt_failed` asking peers to
re-send the last two minutes out of an in-memory ring, and the diff. Every question about the ladder -
how often may the narrow rung fire, when does it give up, when do we escalate - was answered with a
duration, and there were nine of them across three files. That is the shape to recognise: **a
mechanism whose semantics are decided by clocks cannot be reasoned about, only tuned.**

The ladder is gone because the narrow rung is. Three properties of it, each sufficient on its own:

- It could not NAME what it wanted. The frame never decrypted, so its id was never seen, so the
  request could only be a period of time - and a request addressed by time is a broadcast.
- Its single trigger is a sender whose ratchet went backwards, so it asks precisely the peer that
  cannot answer: the re-encryption happens at the same rewound ratchet and collides identically.
- Therefore its only mode of success was the sender burning past our high-water mark while answering.
  That is recovery by exhaustion, and it is indistinguishable from repair in a log.

Measured twice on the browser: it fired with 1, then 5, 15 and 25 payloads and delivered none, while
the diff repaired the conversation completely (`32 to send, 1 to pull`). Measured on production
2026-08-10: ~450 frames/min across three devices for over ten minutes, nothing repaired. The
`decrypt_failed` branch survives only to IGNORE the event from a peer running an older build.

What replaces the ladder is not a better ladder. A detected loss reconciles the group, with nothing
rate-limiting it beyond the 30 s coalescing of an identical burst. Termination is a property rather
than a budget: each exchange strictly reduces the difference between the two stores, so the sequence
converges on two matching state keys - and matching keys send nothing at all.

#### The idempotence was briefly asked of the wrong witness (FIXED 2026-08-10)

The first cut of the above read "solicit **unless this group is already being reconciled**", and
implemented "already being reconciled" as `if (isAwaitingHistory(userId, groupId)) return`. The
reasoning - the durable marker IS the idempotence, so nothing needs rate-limiting - is right about
the marker and wrong about the question.

**The marker answers "is this group short of history". It was asked "have I already asked".** Those
differ in exactly the way that matters here: the marker is DURABLE, survives sessions, and is cleared
only by an empty diff, while an attempt lasts 30 s. So on any group that had ever been broken the
marker was already standing when the next frame was lost, and this trigger - the only one that fires
on the loss itself - returned silently. What was left was the 15-minute sweep, i.e. the floor
pretending to be the mechanism.

Measured on prod 2026-08-10 with `heal-web.mjs`: twelve `LOST frame` lines on the receiver, **zero**
solicitations in 139 lines of log, `escalated=false, history diff ran=false`, `PARTIAL - 2/14`, and a
standing "history pending" banner with no attempt behind it.

The witness had to be one that expires with the attempt, not with the problem. Pinned by
`setupMessageHandler.lostFrame.test.ts`, whose negative control against the guard is
`Number of calls: 0`. The successor keeps that shape and drops the durable half entirely: what
coalesces a burst today is a 30 s in-memory note per group, which cannot outlive the session and
re-opens the moment an ask fails to go out.

Same class as WP-GHOST-1's `updatedAt` and as an epoch verdict answering a generation question: **a
piece of durable state is evidence only for the question it was written to answer.** The general form
is in CLAUDE.md's DURABLE RULES; what this instance adds is that the two questions can differ only in
their LIFETIME and still make the substitution wrong.

Two durations remain in the whole mechanism and neither schedules traffic: `DIGEST_TTL_MS` (60 s),
which is how long a probe describes a store that has not moved, and `PROBE_COALESCE_MS` (30 s),
which only decides whether the NEXT edge is a duplicate. Re-asking rides on state EDGES - see the
trigger table above - and there is no sweep under them any more.

### Three defects that belonged to this work, or to nothing (FIXED 2026-08-07)

Left out of WP-HIST-2 on purpose, because each is only worth fixing once the exchange is a diff.
All three are now fixed, and the rule each taught outlives it:

- **The client ignored the `no_peer_online` the server already returns.** `deliveryKeepalivePost`
  swallowed the response body, so the requester waited on a question that had been answered
  immediately. It now returns the parsed body, and `sendHistoryRequest` surfaces
  `{ noPeerOnline }`. The name matters: the function returns `null` for a transport failure, a
  non-2xx, a non-JSON body and a JSON array alike, and **`null` means "no answer", never "no"** - a
  boolean would have made silence read as a negative and cancelled a legitimate retry.
- **Nothing re-solicited when a peer came back**, even though presence is polled every 10 s.
  `onPeersCameOnline` now fires `reconcileGroupsAwaitingResponder` for every group whose last attempt
  found nobody online.
  It is an **EDGE, not a level**: only offline -> online, so a user already known online says
  nothing new and a user seen online for the FIRST time is not "back" - treating the level as the
  edge would re-solicit on every page load. Its registration guards on `ctx.getStorage()`, because
  `ctx.ensureMls()` CREATES the service when absent and a background callback must never do that.
- **`checkPresenceNow` had no in-flight guard.** On a bad link it stacked 4-5 concurrent
  `/api/presence` calls, each measured at 32 s. Concurrent callers are now COALESCED onto the running
  request rather than turned away, so `await checkPresenceNow()` still means "presence is fresh" for
  everyone.

### When a device compares - the triggers, and what stops it asking twice

There is no periodic comparison and no durable evidence gating one. Asking costs a single frame, so a
device asks whenever something could have changed the answer:

| Trigger | Where |
|---|---|
| every (re)connect, over every local group | `initializeConnection.ts` -> `reconcileAllGroups` |
| a frame proved lost during a replay | `history.ts`, `sawUnreadableFrame` -> `reconcileGroup` |
| a frame proved lost live | `setupMessageHandler.ts` -> `reconcileGroup` |
| a fresh Welcome join | `sessionAuth.ts`, `onWelcomeProcessed` |
| a re-add recovery completing | `recovery.ts` |
| a peer coming back online | `sessionAuth.ts` -> `reconcileGroupsAwaitingResponder` |

Every row is an EDGE, and the list has no sweep in it - the 15-minute one is deleted. Two notes in
`historyReconcile.ts` keep it from turning into traffic, and **both are in memory and both describe a
MOMENT rather than a conversation**, which is precisely what the durable marker did not:

- **`PROBE_COALESCE_MS` (30 s)** collapses a burst of identical triggers into one ask. It SCHEDULES
  nothing: the window only decides whether the next edge is a duplicate, and it re-opens at once if
  the election went out but the probe did not, because the responder is then waiting for a key that
  will never arrive.
- **the awaiting-responder set** answers exactly one question - "did the last attempt find nobody
  online?" - and it is what the presence edge retries. It is written ONLY on an explicit
  `noPeerOnline` from the server; an election that never left the device (offline, DNS, a 502) writes
  nothing, because none of those is an answer about anybody else. That distinction is the whole
  lesson of the marker it replaces, which was written on exactly this path and then outlived the
  outage by thirty days.

Both are dropped per conversation by `forgetGroupReconciliation` (leaving a group, purging a
conversation) and wholesale by `resetHistoryReconciliation` at logout. State describing a
conversation may not outlive one.

### What happens when nobody is online

The election returns `no_peer_online`, nothing is sent, and the group is noted as awaiting a
responder. Nothing retries on a schedule: the next connection asks again anyway, and a peer coming
back online retries only the groups that found nobody - re-asking every group on a presence edge
would put the mechanism straight back where the sweep it replaces was.

A group this device no longer holds is dropped from that set rather than re-elected: there is
nothing to reconcile it against, and asking the server about a group we are not in is a question with
no honest answer.


### Devices compare identities, never counts

Worth stating because the intuitive design is a message count, and a count is a guaranteed false
negative: two devices that each lost a different message agree perfectly on the total. The digest
carries the sorted ids below 1000 messages, and above that one line per slice of the id space with a
count AND a truncated SHA-256 of that slice's ids. The hash is exactly what catches "same count,
different messages", and `historyManifest.test.ts` pins that case.

### One writer for a conversation's retirement (`retireConversation`, WP-HISTGHOST-1)

The awaiting-history marker must be cleared whenever a conversation ends, and the first fix wired
that cleanup into `markConversationDeletedRemotely`, whose five call sites were all checked. It
shipped and FAILED on production, because `lifecycle: 'removed'` was also written INLINE in five
OTHER places - a `groupDeleted` system message, being excluded from the group, discovery, and a
re-add finding the group tombstoned - while a sixth path purged the row outright, orphaning the
marker with no row left to reach it.

The lesson generalises: **grep for the STATE, not for the function that is supposed to own it.**
Then collapse every writer into one - `retireConversation` in `utils/chat/conversations.ts` is now
the only thing that may write that lifecycle - and lock it with a test that reads the SOURCE
(`conversations.retire.test.ts`), because no unit test can observe a seventh path that does not
exist yet.

### The orphan purge compares two reads, and their ORDER decides whether it destroys a new group

`discoverMissingGroups` forgets the MLS tree of every local group the server's list did not mention.
That is only sound for groups that already existed when the server was asked, and until 2026-08-30 it
was not: the server list was `await`ed (and `getDismissedGroups` after it), and only then was
`mlsService.getLocalGroups()` read. **A group created inside that window is absent from the snapshot
by construction**, so the sweep deleted it on evidence that could not have mentioned it.

It is not a theoretical window. On prod a group was created at `22:31:31.905` and its creator logged
`[MLS] forgetGroup 50799ae8… (absent from server)` inside the same second, with the `dm_groups` row
still present and `deletedAt` null. What makes it worse than a lost cache is that **the tree is not
re-fetchable**: the creator held the only copy, so `min_epoch=0, re-Welcome expected` names a Welcome
nobody is left to send, and the base for an external join was never published - `no_base_published`
is the app's own report of that. Devices created afterwards were counted as members by the server and
could never open the conversation.

The local set is now captured **before** the server is asked.

**AND THE SENTENCE THAT STOOD HERE WAS WRONG, WHICH IS THE MOST USEFUL THING ON THIS PAGE.** It said
`initializeConnection`'s sweep had taken both reads at one instant since WP-GRAINE-1 and said so in a
comment, so only this copy of the decision needed fixing. The comment said that; **the code did the
opposite**, reading `getLocalGroups()` after awaiting `getUserGroups`. The audit cleared that site by
reading its prose, and it went on to destroy a group 291 ms old the following night - see the section
below. A comment is a claim about code, never evidence of it, and an audit that accepts one has
audited nothing.

**The asymmetry is what makes the fix free.** Capturing early can only SPARE a group: one that really
did disappear during the fetch is simply swept on the next pass, while one that was just born is no
longer destroyed. A purge whose two error directions cost a delayed sweep and an unrecoverable
conversation should always be biased towards the first.

### A group must be NAMEABLE by the server before it is HOLDABLE here, or every sweep is a hazard

The purge above was one of two readers with the same inversion, and fixing readers one at a time was
the wrong shape of answer. The window they were all falling into is opened by the ORDER OF CREATION
ITSELF.

`createNewGroup` used to run `createRemoteGroup` -> `createGroup` (local MLS) -> `registerMember`.
Only the third call writes `dm_group_members`, and that table is what `GET /api/mls/users/:id/groups`
answers from - the single list every sweep consults to decide whether a local group still belongs to
anything. **Between the second and the third call the group exists locally and cannot be named by the
server**, which is indistinguishable, to any reader, from a group that is genuinely dead.

Measured by HEAL-REVOKE-7 on 2026-08-30, on the creator's own console and one clock only (prod's
timestamps are a different clock and are deliberately not subtracted from these):

```
44.572  [RUST::INFO] create_group: 8868be1c...
44.830  [RUST::INFO] add_members_bulk to group: 8868be1c... (2 key packages)
44.863  [RUST::INFO] forget_group: 8868be1c..., min_epoch=0
44.870  [SYNC] WASM removed (conversation row held with no membership left): 8868be1c...
44.901  Error syncing own devices: Group not found: 8868be1c...
44.969  [OK] Group "HGRPejyu9" created.
```

The consequences are the ones the section above already describes, and they are permanent: the
creator answered `welcome_request` with `Group not found` every 60 s for twenty minutes to two
different devices, `externalJoin` refused `no_base_published`, and the group sits on prod alive with
its creator `active` and every other device `pending`. The adjacent run five minutes earlier, same
build, created its group cleanly - the race is real and it is not rare.

**The membership is now registered before the local group is created**, in the group path and in the
direct-conversation path both, so `getLocalGroups().includes(id)` implies the server already names
it. There is no interval left to reason about.

**A DISCRIMINATING EXTRA READ WOULD NOT HAVE WORKED, AND IT IS WORTH KNOWING WHY.** The obvious fix
is to give the destructive reducer the signal its milder sibling already has: `decideAbsentGroupFate`
takes `isStillUserMember` and keeps a group on `true` or `null`, naming this very hazard - *"may be
stale for a group we just created/joined"*. But `getGroupUserMembers` reads `dm_group_members`, the
table `registerMember` had not yet written, so inside the window it returns a genuine empty 200 and
the reducer would have forgotten the group with more confidence, not less. **A second read that
races the same write is not a discriminator.**

**The branch's own sentence was the last piece, and it was a rename, not a guard (2026-08-31).** It
read "conversation row held with no membership left" while reducing no membership at all - its whole
input is a `dm_groups` row and a local predicate. That is the sentence a reader reaches for after a
group has been forgotten and nobody knows why, and it sent them to `dm_group_members`, which had
nothing to say. It now states the two facts it has and separates the two server states it used to
collapse: `dm_groups row alive, naming no distribution scope, absent from our group list` and
`dm_groups row tombstoned and naming no distribution scope`. **Every log line quoted in this section
predates that rename and is left verbatim** - it is evidence of what a run printed, not a claim about
today's code.

**Creation also stopped announcing success it cannot back.** The catch around the bulk add tolerates
one device's failed Welcome on purpose; it was also swallowing the group's own disappearance, which
is how `[OK] Group created.` came 68 ms after the state was gone. Both paths now assert the fact the
announcement claims before making it, and a failure there hands the outer catch a server-side orphan
to delete - no group at all being strictly better than an unusable one.

### The conversation row is the recovery ladder's input, so publishing it early ARMS the ladder (2026-09-01)

The section above closed the window where a group is holdable before it is nameable. This is the
same window seen from the other end, and it survived the fix because the two halves are written in
different functions.

`startNewConversation` published its conversation row - and SELECTED it, putting it on screen -
immediately after `createRemoteGroup`, before `registerMember` and before the local MLS group
existed. But the conversation map is not a view model: `startSyncWatchdogImpl` reads it every 5 s and
treats every row as a group that must have local WASM state, driving `requestReAdd` for the ones that
do not. **The instant the row exists, the group is a recovery candidate.** Inside that window
`group-info/:id` is gated on `dm_group_members` and answers 403 to the group's own creator, which the
recovery seam correctly types as `NotAGroupMemberError` - a TERMINATING answer, whose termination is
`stopRecovering` -> `retireConversation`.

So the creator of a brand-new DM was shown *"Cette conversation a ete supprimee"* on a conversation
nobody had deleted. It was reported on 2026-09-01 for prod group `ab47add3`, whose `dm_groups` row is
alive, whose two members are both in `dm_group_members`, which has no tombstone, no dismissal and one
commit. The message he typed **was delivered**: two writers of `lifecycle` were racing and the retire
happened to land after the activation, which is why the defect looked cosmetic and was not.

The row is now written ONCE, already `active`, after every prerequisite - the same shape
`createNewGroup` has had since 2026-08-30. A field written once cannot lose a race for it, and there
is no intermediate state left for a reader to catch.

**What hid it for a day was a comment.** The DM path carried *"SAME INVARIANT AS `createNewGroup`"*
above the early publish, and `groupCreation.order.test.ts` - the test named for this exact
invariant - covered only the group path. The rule about a comment citing a precedent applies to a
comment citing a SIBLING FUNCTION just as hard: the guarding test now asserts the order on both
paths.

### Between the registration and the row, a creating group looked LOST to the connection sweeps (2026-11-16)

The two sections above leave one interval by design: from `registerMember` on, the server LISTS the
group for its creator and holds a `pending` invitation row for each of the creator's other devices,
and the conversation row is written once, at the end. Two leader-tab sweeps read exactly that shape -
listed, rowless - as a group this device lost, and both acted on it. Measured by LEAF-REFRESH-1 on the
web rig (the row creates a group about a second after a reload, inside the connection pass), on the
owner's console, one clock:

```
11.660  [RUST::INFO] create_group: db92be7a...
11.793  [PENDING] 13 pending invitation(s) to process
11.828  [RUST::INFO] add_members_bulk to group: db92be7a... (13 key packages)
11.859  [READD] db92be7a... attempt starting
11.860  [PENDING] Group db92be7a... absent locally -> recovery requested
11.866  [DISCOVERY] Placeholder db92be7a... created.
11.940  [READD] db92be7a... already in WASM - skip (call forgetGroup before recovery if out of sync)
12.526  [OK] Group db92be7a... created.
```

Nothing was lost - the creation's own Add admitted the 13 devices and its row overwrote the
placeholder - which is the shape of a race that heals, not of a design.

**NOT AN `1.7.0-alpha.3` REGRESSION, though it was filed as one.** Every LEAF-REFRESH-1 run of that
night ran the SAME client bundle, `9ca790c3b` (`1.7.0-alpha.2`): the tabs were never reloaded onto
`dev.68983e3`, so only the estate changed between the two series (`results.ndjson` records both, as
`build` and `estateBuild`). And two of the four alpha.2-estate runs show it too (one of the other two
ended `ERROR`): a placeholder in one, `absent locally` and a placeholder in another. The window has existed since the registration moved first (2026-08-30); a creation inside a
connection pass is what opens it, and the rig is the first caller that creates there routinely.

**The overlap is deleted with the creation's own state, not with a delay** (`groupsInCreation.ts`).
Both creation paths mark the group synchronously after `createRemoteGroup` and BEFORE
`registerMember` is sent, and release the mark in their `finally`, after the row is written or the
server group deleted. A sweep can only see the group in an answer produced after the registration was
committed, so any sweep that sees it sees the mark: `ensureConversationForServerGroup` answers
`in-creation` and writes no placeholder (discovery also leaves it out of its "missing locally" count),
and `processPendingInvitations` takes the group's rows out before it counts them (no `[PENDING] N
pending invitation(s)` line for them) and reports the group `onGroupNotSwept`: they are left to the
creation's own Add, and any row it does not answer - the Add is best-effort (a failed device read, a
device not admitted, one registering after the read) - waits for the next sweep. Both say so at
debug. Discovery reads its rows after its last await, in the same synchronous turn as the marks. `groupCreation.sweepOverlap.test.ts` runs the two real
sweeps at the step where they overlapped - inside `registerMember`, and while the Add is staged - on
both paths, and fails with the mark removed (`created` instead of `in-creation`).

**The same window held a third overlap, with the history audit.** The connection pass audits, once,
every local group this device has never asked a member about (`groupsOwingAudit`). A group created
here was local from `create_group` on and unaudited, so the pass asked about it inside the creation
(`11.723 auditing 1 group(s) that never have been`, `11.781 [HISTORY_RECONCILE] no member online for
db92be7a... - will ask when one returns`) and asked again on the next connection. Two halves now:

- **While the creation runs, the pass leaves the group out by its mark.** `initializeConnection`
  filters `getLocalGroups()` through `isGroupInCreation` in the same turn, before choosing between a
  full sweep and the audit, so neither mode asks (`initializeConnection.test.ts`, both modes).
- **Once it has SUCCEEDED, the group is recorded audited** (`noteGroupsAudited`, after the row is
  written and before the mark is released): a group this device created has no past anybody else
  could hold. Never earlier - a tab that died mid-creation while the server group survived comes back
  to a group it rejoins by Welcome under a discovery placeholder, which skips the post-Welcome
  history ask because a row exists; a record written before success would then leave the messages of
  the user's other devices never asked for ([principes](../../../principes.md), principle 2). A
  failed creation records nothing, and its group stays owed. A delegated creation runs these same
  functions on the leader. `groupCreation.sweepOverlap.test.ts` reads the record during `createGroup`
  (owed), after `ok` (recorded) and after a failure (owed).

### A creation that is refused now says which refusal it was (2026-09-24)

`createNewGroup` and `startNewConversation` answered `void`. Five distinct ways of declining ended
in a `log()` line and nothing else:

| Answer | What happened |
|---|---|
| `duplicate-group-name` | a group of that name is already open on this device |
| `blocked` | a block stands between the two accounts, in one direction or the other |
| `block-check-unavailable` | core-service could not be asked, so nothing is concluded |
| `peer-has-no-device` | the peer has never signed in and has published no KeyPackage |
| `creation-failed` | anything the creation threw; the log carries the detail |

**The modal closed on every one of them.** It called, ignored the answer there was none of, and shut
- so the member saw a sidebar that had not changed, over a conversation that did not exist, with
nothing anywhere saying why. The server-side orphan was cleaned up correctly the whole time; the
repair was never the missing half.

**The fix is a discriminator, not a message.** `ConversationOutcome` is
`{ ok: true; key } | { ok: false; reason }`, and the reason is a union of the five above. Prose in a
log line can only be read by parsing it, which is the one thing
[durable-rules](../../durable-rules.md) forbids - a distinction carried in a sentence is a
distinction exactly one call site will ever make.

**One exhaustive mapping turns a reason into a sentence**, in `conversationRefusalMessage.ts`. It is
a `Record<ConversationRefusal, () => string>` rather than a `switch`: adding a member to the union
fails to compile until a message exists for it, where a `default` branch would have let a new
refusal ship as whatever the fallback said - which is the shape of the defect being fixed. The
values are thunks because Paraglide reads the active locale when the message is CALLED.

**`Sidebar` decides, and the modal renders.** The panel stays open on a refusal, keeps the text that
was typed (a member told "this contact has never signed in" is looking at the id they entered), and
closes only on success - where the new row in the sidebar is the signal and no toast is added.
A `busy` flag locks the submit for the seconds a creation takes: device fetch, bulk commit and
Welcomes are not instant, and a panel that looked inert is how a member creates the same group
twice.

`key: null` is a SUCCESS, not a refusal: it means there was nothing to do - an empty name, or the
caller's own id. Both are already unreachable from the modal.

Background key distribution (`useChannelWorkspaces`) types the same call as `Promise<unknown>` on
purpose: it has no screen to say a refusal on, and already treats a failure as "the member misses
one key, their next request fetches it".

Pinned by `groupCreation.refusal.test.ts` (the discriminators) and
`Sidebar.creationRefusal.svelte.test.ts` (the panel stays open, keeps its text, closes on success,
and runs one creation per submit).

### A `welcome_request` has a third outcome, and only one of its two entrances knew it (R-D9, 2026-09-13)

A device that has lost its MLS state asks the group's members to re-add it. The member that answers
must already hold a READY conversation for that group - it cannot invite anyone into a group it is
still joining itself - so `handleWelcomeRequest` has a third outcome beside served and refused:
**not yet**. It signals it through an `onNotReady` callback, and the only correct thing to do with it
is to remember the asker and serve them the moment the group becomes ready.

**That is a policy, and it was written at ONE of the two entrances.** The socket entrance passed an
`onNotReady` that pushed the asker onto `ctx.deferredWelcomeRequests`; `onGroupReady`'s drain of that
same queue passed none - and deleted the key before serving - so an asker who came back *not yet* on
the drain fell into a `?.()` on an absent callback and vanished, silently, with the queue already
emptied.

**The drain reaching a group that is still not ready is a state the code produces, not a
hypothetical.** "Ready" there is the MLS group becoming sendable, which is not the same event as this
device's conversation row reaching `active`: of `setupMessageHandler`'s two fire points, the
redelivered-Welcome path sets the row first *if a row exists*, and the ordinary join path does not.
Nothing re-derived a dropped asker; only their own 60-second retry brought them back, and the log
said nothing at all.

The two entrances differ in exactly one thing - WHERE the ask came from - and everything else they
had in common was written twice, as two hand-built nine-field parameter objects. Both now call
`serveWelcomeRequest` in `welcomeRequestQueue.ts`, which holds the deferral, the log and the failure
report; the drain is `drainDeferredWelcomeRequests`, which **re-defers by the same path it drains
through**, so a group that is still not ready keeps its askers.

Two things came with the collapse. A failure is now REPORTED at both entrances - the drain used to
`.catch(() => {})` it - because an asker on the other side is locked out of a group they belong to
for as long as it is wrong. And the queue **deduplicates on `(userId, deviceId)`**: a refused device
re-asks every 60 seconds, and each ask landing while the group is not ready used to add another copy
of the same waiter, so the drain served one device N times and the post-Welcome cooldown absorbed
them one by one. The queue records WHO is waiting, and a device waiting twice is one waiter.

A table drives both entrances over the same not-ready group and the same failure, and a source check
refuses a third entrance that builds its own parameters.

### The post-Welcome cooldown knows every Welcome this tab sent, not only its own (2026-10-04)

A `welcome_request` for a device whose leaf is already in the tree is answered by kick + re-add,
and two different events reach that branch: the Welcome was **lost**, and the request is the retry
that recovers it; or it was **still in flight**, and the push and the pull overlapped. The 30 s
cooldown is what tells them apart, and it used to remember only Welcomes the `welcome_request`
handler had sent itself. A group's creation fan-out, a pending invitation and a Graine admission
send them too, so a device asking seconds after a creation fan-out (GRP-8, 2026-08-24) had its
fresh leaf kicked, and the kick line said *no Welcome sent from here*.

The record now lives in `welcomeSent.ts` and is written by `BaseMlsService.sendWelcome`, the one
call all four paths go through, once the delivery succeeded. So an ask inside the cooldown is
skipped whatever path welcomed the device - the overlap no longer exists - and a kick past it
says how long ago this tab's Welcome left. In memory on purpose, and reset at logout: a Welcome
sent before a reload is one the requester has had time to lose.

### One key per conversation - the "a DM has two keys" premise, audited and refuted (2026-10-04)

**THE MAP KEY IS THE ROW'S `id`, FOR EVERY ROW.** The section that stood here (2026-09-01) said a DM
learnt from a Welcome is keyed by the PEER'S USER ID, and wrote the rule *treat any `[key]` lookup
over this heterogeneously-keyed map as a defect on sight* - without enumerating the consumers. The
enumeration, done 2026-10-04 against `main`, refutes the premise instead: **no writer of
`conversations` keys a row by anything but its `id`** (the MLS group id, or `channel_<id>`), and none
did on 2026-09-01 either (`git grep` at `a939b6f97^`). The single-key store dates from `a6d5fb203`
(2026-04-07, *"only one id will be used now"*). What misled the reading is a name: the key parameter
is still spelled `contactName` / `selectedContact` in `useConversations` and `history.ts`, and
`deriveConversationIdentity` DOES return the peer as `contactName` - as a FIELD of the row, never as
its key.

The writers, which are the mechanism that holds the invariant:

| Writer | Key it writes |
| --- | --- |
| boot restore (`conversations.ts`) | `meta.id`; `saveConversation` persists `toConversationMeta(key, ...)` with `id = key`, so the loop is closed |
| `createNewGroup`, `startNewConversation`, the existing-server-DM path (`groupCreation.ts`) | the group id |
| the Welcome's early placeholder and `upsertConversation` (`setupMessageHandler.ts`) | `joinedGroupId`; a LIVE DM matched by PEER under another group is deleted and **re-keyed onto `joinedGroupId`** - the one writer whose key is computed; a RETIRED one (`removed`) is never matched, see [a deleted DM is not carried into the next](#a-deleted-dm-is-not-carried-into-the-next-one) - pinned by `setupMessageHandler.test.ts` (*"a Welcome into a DM keys the row by the joined group id"*) |
| `onWelcomeProcessed` (`sessionAuth.ts`), the FCM merge, channel builders, tab sync | the group / conversation id they were handed |
| every other `set` (retire, unread, watermarks, rename, avatar, messages) | read-modify-write of a key already in the map |

### Telling a peer's deletion from a false "deleted" (a 1.6.12 report, 2026-11-16)

A DM whose only content was a community-invitation notice showed "Cette conversation a ete supprimee"
above "Supprimer localement". The device's log began weeks after the row was retired, so it could
only say `[DISCOVERY] ... kept - already removed, awaiting a manual deletion` at every connection -
the tombstone rule above, not the moment of retirement. **The server answers the question the log
cannot**, read-only and in aggregates: the `dm_groups` row carried `deletedAt` (the same day it was
created, some eight hours later), no member, seat or interval remained, and `dm_user_dismissed_groups`
held exactly ONE row for it, written at the same instant as `deletedAt` - the shape of a manual
deletion (959 of the 1089 dismissals on production share it). That dismissal belonged to the OTHER
member: had it been the reporter's, discovery would have PURGED the row (`dismissed by user -
removing`, which runs before the tombstone branch) instead of keeping it with the banner. **A real
deletion by the peer, so the "deleted" state was the truth**; no 404/410, no sweep and no forgotten
group was involved. The defect in that report was the footer's missing bottom inset
([keyboard-and-send-motion](../keyboard-and-send-motion.md#7-a-banner-in-the-composers-place-stands-on-its-floor-2026-11-16)).

### A deleted DM is not carried into the next one

Decided by the owner on 2026-11-10. When a peer deletes a DM, this device keeps it as a RETIRED
conversation (`lifecycle: 'removed'`, with its "a supprime cette conversation" line). A later DM
with the same peer is a NEW group, and its Welcome used to ADOPT the retired row:
`findDirectConversationByPeer` did not skip tombstones, so `upsertConversation` moved the retired
conversation's stored rows onto the new group. Those rows carry author proofs naming the OLD group,
so every device that later received them in a history bundle marked them "non verifie"
([history-reconciliation](../../protocols/history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22)). The startup merge
(`mergeDirectConversationDuplicates`) and discovery already refused a tombstone - the paths disagreed.

**One predicate now answers "the conversation with that peer" everywhere: `canRepresentThePeer`,
applied inside `findDirectConversationByPeer`.** The callers, each decided:

| Caller | Skips a tombstone | Why |
| --- | --- | --- |
| `upsertConversation` (`setupMessageHandler.ts`, the Welcome) | yes, for ANOTHER group's row | the retired DM keeps its own entry and rows, the new group starts empty (`[WELCOME] ... starts empty` names the retired ids); the joined group's OWN DM row is still revived whatever its lifecycle - a re-Welcome into the same group is a re-add |
| the media send following a re-keyed DM (`useMessaging.svelte.ts`) | yes | it follows the row the Welcome moved, so it asks the same question; a file is never sent into a retired DM |
| discovery's local de-dup (`serverGroupConversation.ts`) | yes (already did, inline) | a record pending removal must not refuse its own replacement (user report, 2026-08-23) |
| `startNewConversation` (`groupCreation.ts`) | yes (inline before, same outcome) | a non-active row fell through to the server check anyway; a retired row listed before a live one no longer hides it |
| the community invitation DM (`useChannelWorkspaces.svelte.ts`) | yes | an invitation written into a deleted DM reaches nobody |
| `mergeDirectConversationDuplicates` (startup) | yes (already did) | a tombstone competing on `updatedAt` destroyed the fresh group for both parties |

Pinned by `setupMessageHandler.test.ts` (*"the stored rows of the previous DM with that peer"*) and
`conversations.directPeer.test.ts` (*"findDirectConversationByPeer"*).

The consumers that look a conversation up by a group id, and the verdict on each:

| Consumer | Lookup | Verdict |
| --- | --- | --- |
| `processPendingInvitations` (`actions.ts`) | `get(groupId)` / `has(groupId)` | correct - the key is the id |
| `handleWelcomeRequest`, *"No ready conversation - deferring"* (`actions.ts`) | `get(groupId)` | correct |
| `handleHistoryRequest`, the history-serving gate (`actions.ts`) | `get(groupId)` | correct |
| the promotion after a successful external join (`recovery.ts`) | `findByGroupId` (by `id`), saved by the found key | correct |
| `requestReAdd` idempotence, `stopRecovering`, `purgePhantomConversation` (`recovery.ts`) | `findByGroupId` | correct |
| the redelivered-Welcome branch (`setupMessageHandler.ts`) | `get(terminalId)` | correct |
| `upsertConversation`'s migrated-peer read (`setupMessageHandler.ts`) | `get(joinedGroupId)` | correct |
| SYNC_WATCHDOG candidates (`sessionWatchdogs.ts`) | `convo.id`, channels skipped on the key | correct |
| `onWelcomeProcessed` (`sessionAuth.ts`) | `has(groupId)` | correct |
| group avatar refresh (`actions.ts`), call notices (`callSystemMessages.ts`) | `get(groupId)` | correct |

**No defect, so nothing was re-routed.** `findByGroupId` stays private to `recovery.ts`: it reads by
`id` and is right whatever the key, and replacing the `get`s above with an O(n) scan would buy
nothing while the writers hold. The `recovery.test.ts` cases with a key different from the id stay as
a pin on that helper - they describe a state no writer produces. **The rule that survives is the
writer table**: a new writer that keys a row by anything but its `id` breaks every `get(groupId)`
above at once, so it goes in the table and in the `setupMessageHandler.test.ts` pin, rather than
teaching the readers to scan.

### An exit is owed to the SERVER, and the local purge is not what pays it (DEL-10)

Deleting a group is two halves - tell the server, then destroy the local MLS state - and
`exitGroupAndCleanup` wrapped the whole server half in ONE `try/catch` and then purged
unconditionally. So "the server said 404, the group is already gone" and "there was no server, the
radios are off" ended in exactly the same place: the MLS state destroyed, the group still live in
`dm_groups`, and nothing anywhere remembering that a DELETE was ever intended. The next
`discoverMissingGroups` then found a server group with no local row and did what it is for - handed
it back as a placeholder. The user deleted a conversation offline and watched it return.

The purge staying unconditional is deliberate: a user who deleted a conversation must not see it, and
the MLS state of a group they have left is not something to keep on the chance the network returns.
What was missing is the other record - that the SERVER has not been told yet. That is now a durable
row, one per `groupId`, in the `pendingGroupExits` store (IndexedDB v8, SQLite schema 10), written
BEFORE the call and cleared only by an ANSWER.

Three properties, and none of them is a timer:

- **Idempotence from the row**, not from a guard. The primary key is the `groupId`, so deciding twice
  cannot queue two calls, and the newer decision (a `leave` after a `delete`) is the one that
  survives.
- **Termination from a PROOF.** The row is cleared when the server answers - a success, or the
  delivery service's 403 saying it is already done - and never on an attempt count or an elapsed time. A server that is
  reachable and REFUSES (a 500) keeps the row and logs at a level that accuses, because that is a
  server bug and dropping the row would hide it.
- **The trigger is an EVENT**: `connectivity.onReconnect`, plus exactly one pass at startup, for an
  app killed while offline that will never see an `online` edge. Registered at login beside
  `registerOutbox` and `registerOfflinePromotion`, unregistered in `logoutImpl` - no flag deciding
  whether a listener exists.

**One classifier, or the defect comes back with its halves swapped.** The drain and
`exitGroupAndCleanup` both have to read a failure, and if they disagreed about a 403 the composable
would keep a row the drain would clear, or worse. `classifyExitFailure` in
`utils/chat/pendingGroupExits.ts` is the only reading of it: `'already-gone'` for the delivery
service's own 403 (Nest's envelope or a contract refusal code, never an edge's page, never a 404 - neither route sends one, see
[the 2xx a portal answered](#a-2xx-a-captive-portal-answered-is-no-answer-2026-10-25)), `'refused'`
for any other status, `'unreachable'` only when `isTransportFailure` - the same predicate
`apiFetch` uses to decide the server is unreachable - says so. Note what that means for a
PROGRAMMING error thrown inside the call: it classifies as `refused`, not `unreachable`. That is the
choice we want, because a bug must not be able to keep a row for ever while blaming the link.

And discovery now consults what is owed: a server group whose exit this device still owes is NOT
re-created, and the skip is logged. Without that the row alone would not be enough - the drain would
eventually delete the group, but the placeholder would have already appeared.

**AND THE MECHANISM ABOVE MEASURED NOTHING FOR THREE DAYS, BECAUSE THE SWALLOW IT REPLACED WAS ONE
LAYER FURTHER IN.** `exitGroupAndCleanup` does not call the server itself - it hands a
`serverAction` to `deleteGroupAndBroadcast` / `leaveGroupAndBroadcast` - and step 2 of each of those
had its OWN `try/catch` around the exit call. The delete's logged and moved on; the leave's was a
bare `catch { /* non-blocking */ }`. So `serverAction` never threw, the classifier in the enclosing
`catch` never ran, and the happy path's `clearPendingGroupExit` deleted the row that had been written
three lines earlier. Every property listed above held, over a store that was empty by the time
anything read it.

The signature is exact, and DEL-10 recorded it on `4a79a6c6`: one DELETE left the device, zero were
answered, `reconnectAnnounced: true` with `drainStarted: false` and `exitLines: []` on BOTH
reconnects, and `dm_groups` still holding the group as live. The `console.error` the delete path did
emit was invisible for a second reason - it carries `Failed to fetch`, which the harness forgives as
the noise of the cut the check performs on purpose.

Both helpers now HOLD the failure, finish every local step, and rethrow it last. That ordering is the
contract: the purge must not depend on the network, and the classification must not be taken by a
function that cannot see the durable row. **A classifier is only installed where the error is still
travelling** - enumerate the frames between the throw and the reader, because one `catch` anywhere
between them makes the reader unreachable while every test of the reader still passes.

### An exit takes the group's queue with it, before its server step (GRP-6, 2026-10-22)

GRP-6 recorded `[OUTBOX] … REFUSED with 403 … parked, no retry until the next sign-in` on the
leaver: an entry written at +0 ms, the local state dropped at +26 ms, the refusal at +54 ms. **It was
not the `memberLeft` notice.** The notice is a direct `mlsService.sendMessage`, which resolves on the
`POST /api/mls/send` answer (`BaseMlsService.emitFrame` awaits `postApplicationMessage`), so the
server exit already waited for its DELIVERY. The refused entry was another frame of the same group in
the durable outbox: dropping the selection ends the open conversation's read debounce, whose cleanup
hands the owed read watermark to the outbox, and that flush lost the race to the membership's end.

So `exitGroupAndCleanup`, for a leave and a delete alike:

- revokes the group's owed read mark (`forgetDmReadMark`) synchronously, before any await, so the
  debounce cleanup no longer names the group and no sign-in re-queues it;
- after recording the owed exit and BEFORE the server step, SETTLES the group's outbox
  (`drainOutboxForExit` -> `OutboxController.drainForExit`). A lane already running for the group is
  AWAITED, so a send in flight settles before the membership ends rather than racing it. The exit
  then claims the lane and drains it in queue order, each entry skipping its backoff once: the
  membership and the MLS state still exist, so a text written just before leaving is SENT. What
  cannot go (offline, held, an upload still running) is withdrawn under the same claim - so nothing
  withdrawn can be on the wire - and logged by kind as lost
  (`[OUTBOX] leave of <id>…: N of M queued entries sent before the server step, K lost (1 text)`);
- every enqueue reads the DURABLE owed exit (`pendingGroupExits`) and refuses a group whose exit is
  owed, before its write and again after it - whichever of the exit and the write comes second sees
  the other, so no clock is involved. A refused read mark then leaves the owed-mark ledger too; a
  refused text or file is said at `warn`, since only an exit refused for ever can reach that;
- every ordinary flush reads the same owed exit, once per lane pass, and WITHDRAWS the group's rows
  instead of sending them (`[OUTBOX] lane <id>…: this device owes the leave of the group ... N queued
  entries withdrawn, never sent into the refusal`, at `warn`). Only the exit's own drain (`exiting`)
  may still send. This covers a KILL between `recordPendingGroupExit` and that drain: on relaunch the
  replay of the owed exit may end the membership before or after the first flush, and either way no
  row of the group is posted into the 403 (review of #2259). The replay itself is unchanged and needs
  no live outbox controller, so its order against the outbox at start-up does not matter;
- a withdrawn entry whose send fails is dropped, and the line says what that means for who withdrew
  it: an author's delete, a newer read mark superseding it, the exit, or another tab.

**A notice that fails is LOST, not sent later, and the exit goes on.** It cannot be queued - a frame
needs the MLS state and the membership the exit removes - and holding the exit for it would keep a
user in a group they asked to leave for as long as the link is down. The failure is logged
(`[GROUP] memberLeft notice … NOT delivered`, `[DELETE] groupDeleted notice … NOT delivered`), where
it used to be a bare `catch`. What the others lose is the visible line only: the roster changes with
the server half (replayed by the owed exit when it failed too), and `removeStrayLeaves` collects the
leaver's leaf. An eviction is NOT this seam: the evicted device did not ask to be out, a re-add can
reverse it, and its queued entries stay for that case.

## The render window is a pointer into an array the component does not own (WP-EMPTYVIEW-1)

`ChatArea` never renders a whole conversation. It renders a WINDOW - `messageGroups.slice(start,
end)` - because a thousand bubbles in one synchronous pass delays layout and the entry scroll then
overshoots. `windowStart` is component STATE: it moves when the reader paginates upwards, and it is
recomputed from the list length in exactly one place, the effect that fires when the conversation
KEY changes (`ChatArea.svelte`, `hasConversationChanged`).

The list it points into belongs to somebody else, and that somebody REPLACES it rather than
appending to it. `loadHistoryForConversation` ends by setting `conversation.messages` to
`getMessagesPage(id, key, INITIAL_MESSAGES_PAGE)` - 60 messages - on both its fast path (the
`limit=1` cursor probe finding nothing new) and its full path. It runs on every conversation click
and from `ChatBackgroundService` on reconnect and on history events.

So the two combine into a conversation that renders NOTHING:

| step | in-memory messages | groups | `windowStart` | rendered |
| --- | --- | --- | --- | --- |
| a bulk ingest / history bundle has grown the open list | 598 | ~300 | - | - |
| the conversation is clicked: the key changes | 598 | ~300 | `300 - 60 = 240` | 60 groups |
| `loadHistoryForConversation` replaces the list with one page | 60 | ~65 | still 240 | `slice(240, 65)` = **none** |

`slice` with a start past its end returns `[]` without complaining. There is no error, no log, and no
skeleton - `showSkeleton` requires `isLoadingHistory`, which is false by then - and no empty state,
because `ChatMessageGroups` renders an empty list as nothing. The user sees the header, the avatar,
the composer, and a void. Observed on production 2026-08-11 with 598 messages in the local store and
zero on screen, surviving a full reload.

Two facts make the diagnosis a proof rather than a story, and both are cheap to re-check:

- the SIDEBAR renders `convo.messages[convo.messages.length - 1].content` as its preview, so a tile
  showing a preview proves the map entry the pane reads is NOT empty;
- `groupMessages` only ever pushes - a non-empty list cannot produce empty groups - and
  `hideDuringEntry` is `opacity-0`, which `innerText` still reports. So a pane whose `innerText` is
  the header and the composer alone had no message nodes in the DOM at all, which leaves the slice
  as the only reduction that could have removed them.

The fix does not make `windowStart` correct; it makes the READ side stop trusting it.
`utils/chat/renderWindow.ts` clamps the stored index against the CURRENT group count on every
render, and every consumer - the slice, the hidden-above count, `loadOlderGroups`,
`fillViewportThenPin`, `navigateToMessage` - reads the clamped value while pagination keeps writing
the raw state. The invariant it guarantees is the one worth remembering: **a non-empty list always
yields a non-empty window.** `renderWindow.test.ts` pins it across every combination of stored index
and list length, which is the assertion that fails against the old arithmetic.

**The entry window is 20 groups, then 60 (2026-10-14).** Mounting a page of rows is one task that
scales with the rows (339-635 ms for 56-200 rows on a Mi 9T) and nothing paints until it ends. So an
ENTRY mounts the last `ENTRY_FIRST_FRAME_GROUPS` (20) groups, `fillViewportThenPin` widens straight to
`INITIAL_RENDER_GROUPS` (60) only if that does not fill the pane (never a 140 page, which mounted 160
one-line rows), and `widenEntryWindow` completes the 60 after the first frame, compensating `scrollTop`
by the height added above. The 20-group floor of `resolveRenderWindow` applies only while `entering`;
otherwise a replaced, shorter list settles on the full 60 floor. A re-pin of the entry only ever LOWERS
the start. Known duplication: that scroll compensation repeats what `observeThreadGrowth` does for
growth above the viewport; folding the two is a note, not done. The salon skeleton raised by a history
request issued at the tap is keyed by its salon (`skeletonSalon`). `ChatArea.entryWindow.svelte.test.ts`
pins the row counts under a modelled geometry.

**The render BEFORE the entry is the entry frame too (2026-10-22).** The entry effect sets
`windowStart`, but an effect runs AFTER the render it follows. So the first render of a mount used
the initial `windowStart` of 0 and mounted EVERY group of the thread. A switch used the window the
previous conversation had left. The entry frame then cut it to 20 in the same flush, so the DOM
looked right while the work was thrown away. That cost grew with the whole thread, not the window:
2.0 s at 300 rows against 0.5 s at 70 under happy-dom, and the 20/60 split above existed to bound
it. `awaitingEntry` (the conversation's entry key differs from `lastConversationKey`) now makes the
window the entry frame until the effect has run. The test counts every row that EXISTED during the
mount, from the observer's removals as well as its additions, because the DOM after the flush shows
20 either way.

The replacement itself - the reason the window and the list could disagree at all - is gone as of
2026-08-12, see below.

### The mirror case: `windowStart` too SMALL after the list grows (mobile notification-tap)

`clampWindowStart` only ever pulls a stored index DOWN to fit a list that shrank; nothing pushes it
UP to follow a list that grew. That asymmetry was invisible until a report from a real phone:
tapping a notification opened the conversation, but it showed the wrong (older) messages and did
not land at the bottom.

The entry effect (`ChatArea.svelte`) recomputes `windowStart` to the tail in exactly one place -
`hasConversationChanged`, when the conversation KEY changes - and treats every later change to the
message count as an ordinary live message, which only conditionally calls `scrollToBottom` and
never touches `windowStart` at all. That distinction assumes the conversation's message array is
already settled by the time the key changes. On a warm, already-open app it usually is. On a
cold-started app landed on by a notification tap, `ChatBackgroundService` has to wait for
`conversationsRestored` before it can even open the target - and the conversation object it opens
into can still be near-empty at that instant, so `hasConversationChanged` fires against a tiny list
and pins `windowStart` near 0. Moments later `loadHistoryForConversation`'s async merge (see below)
grows the SAME conversation's message array by dozens of entries. The key has not changed, so this
lands in the "ordinary new message" branch, which does not move `windowStart` - it stays pointing at
the small slice from before the real page arrived, and "scroll to bottom" scrolls to the bottom of
that stale, rendered slice rather than the true tail.

The fix does not touch `clampWindowStart` - its safety invariant (a non-empty list always yields a
non-empty window) is correct as stated and unrelated to this direction of the mismatch. Instead the
entry effect now treats message-count growth THE SAME as a conversation change - re-running the
same tail-pin - whenever it happens while `entering` or `catchupActive` is still true, i.e. while
the initial page for THIS conversation could still be arriving late. A live message from a peer
while the reader is already settled in still only conditionally scrolls, unchanged.

### The sibling report from the same phone: "no history at all" was a silently swallowed rejection

The same notification-tap report also described conversations opening with NO messages at all, not
just the wrong ones. `loadHistoryForConversation`'s full replay path (`useConversations.svelte.ts`)
had no `catch` anywhere in it - only a `finally` resetting `isLoadingHistory`. Every caller fires it
with `void nav.loadHistoryForConversation(...)`, never awaited and never `.catch()`-ed, so a throw
from `replayConversationHistory` (a network hiccup, a decrypt error, IndexedDB contention - all
realistic among the many concurrent steps a cold start runs at once: WS connect, bulk-ingest
observers, IndexedDB restore) became an unhandled rejection. `conversation.messages` never grew,
and NOTHING was logged anywhere - no `ctx.log`, no console trace with any app-level context. The
skeleton still disappeared on schedule (`isLoadingHistory` cleared via `finally` regardless), which
is exactly what made a silently-failed load indistinguishable from a conversation that genuinely had
no history to show.

The fix wraps the replay-and-reload block in its own `try/catch`, logging
`[HISTORY] Échec chargement historique (<id>…): <message>` on failure - mirroring the sibling
`loadChannelHistory`'s existing `[CHANNEL]`-tagged catch a few hundred lines up, which already had
one. Whether this exact failure mode was THE cause of the phone report, or only a plausible one
among several, could not be settled from the code alone; the earlier silence was the actual bug
regardless - a swallowed branch that logs nothing is unfalsifiable, and now it is not.

Was this ever a missing "return to the list" mechanism? No - `ensureMobileConvoHistory` /
`goBackToMenu` (both in this same file) already push a `historyOverlayStack` entry the moment a
conversation is selected, through the SAME `selectConversation` call the notification-tap path uses
(`openConversationFromId.ts`), and pop it back to the list on a hardware/gesture Back press exactly
like any other overlay. An initial read of this report suspected that mechanism was entirely absent;
it is not - re-verify before adding a second, parallel one.

### And the re-verification it asked for says the mechanism is there and the LANDING destroys it (2026-09-21)

The paragraph above is right that nothing is missing, and it is the reason nothing was added. What it
could not say is that the landing takes the entry away again.

**Measured on an Android handset, app in the FOREGROUND on `/posts`.** The notification tap was
reproduced exactly - same component, action, data and flags as the `PendingIntent` built in
`CanariFirebaseMessagingService.kt` - and compared against the same conversation reached by hand:

| journey | BACK 1 | BACK 2 | BACK 3 |
| --- | --- | --- | --- |
| by hand: posts -> chat tab -> row | list | posts | app exits |
| notification tap | **app exits** | - | - |

The route push was never the missing part: `[notifNav] routing to /chat` is in the log of the failing
run.

**THAT TABLE HAS TWO CAUSES IN IT AND CANNOT SEPARATE THEM**, which is worth knowing before it is
quoted. The second is native and is not this page's: nothing in the app handled the Back press at
all, so an intact history stack could still be walked out of the app. It is
[on the mobile page](../mobile.md#the-hardware-back-press-had-no-owner-and-chromium-decided-it-2026-09-21),
and the web fix below is necessary on its own - the overlay entry it saves is the one BACK 1 spends.

**THE OVERLAP IS THE LANDING'S OWN.** Selecting pushes the overlay entry; `beforeNavigate` in
`routes/+layout.svelte` DRAINS the overlay stack. The landing effect did both in one pass, so the
navigation it had just started drained the entry it had just pushed - the JS stack lost it, the
`pushState` survived as a ghost, and `onPopState`'s ghost-skip chain walked Back out of the app.

So the overlap is deleted rather than reconciled. `landingStep`
(`utils/chat/notificationRouting.ts`) makes the three states explicit - `route`, `await-arrival`,
`select` - and **nothing is selected until the router says this page IS the target's page**. The
effect reads `$page.url.pathname`, which is reactive, where it read `window.location.pathname`, which
is not: that is what makes it re-run on arrival rather than waiting for the conversations map to
mutate again.

**And the second writer is gone.** `hooks.client.ts` routed as well, so one tap drove TWO navigations
to the same route - one extra Back press for the reader - and its `catch` assigned
`window.location.href`, a full document load that discards the back stack outright, on the one path
whose purpose is to leave one behind. It now publishes the target and nothing else.

## A page read is merged into the list, never assigned over it

`loadHistoryForConversation` used to END by assigning `getMessagesPage(id, key,
INITIAL_MESSAGES_PAGE)` over `conversation.messages`, and three other loads did the same: the
`limit=1` fast path, the startup restore in `utils/chat/conversations.ts`, and `loadChannelHistory`.
The read is issued at the END of a load that takes seconds, so it answers a question that was asked
before it began, and the assignment threw away everything that had arrived in between.

**Measured on the live DM, 2026-08-12** (`trace-arrival.mjs` in the harness, which samples the
receiver every 250 ms instead of twice): the message rendered at **+0.5 s** and disappeared at
**+3.4 s**, exactly as the pane grew from 2 808 to 15 756 characters - the page landing. Scrolling to
the bottom did not bring it back; a reload did. So the store had it and the rendered list did not.
The same run also exposed why two readings can never settle this: a count of 0 with the composer
gone is a missing PANE and says nothing about the message, while a count of 0 with a present composer
and 15 000 characters of pane is a missing MESSAGE. The probe carries both, plus which conversation
is open, because "not in the pane" also has a harness reading - the sidebar preview of a row nobody
opened.

`mergeMessagePage` (`utils/chat/messageMerge.ts`) is the single replacement for all four sites. Its
rule needs no timer and does not care how large the conversation is:

- the page is authoritative INSIDE the window it covers, so a message it omits from between its
  oldest and newest row is genuinely gone and is dropped - deletions and tombstones still land;
- memory is authoritative OUTSIDE it, which keeps both newer arrivals the read could not have seen
  and the older pages the reader had scrolled back to (the cost this section used to record as
  "deliberately not changed");
- an UNSENT message is kept wherever it sits, because no page can ever carry it;
- an empty page asserts nothing and therefore removes nothing.

**Authoritative means a STALE page is destructive, so a salon's loads are ordered (2026-10-13).** A
load that started earlier and finishes later used to merge last: load A reads the page before seed S
is held and leaves row R out, S lands and starts load B, B decodes R, then A merges and R - inside
A's window - is removed. The redundant refetch that every held seed triggered hid it until #1761
removed it. `loadChannelHistory` now takes a generation per salon (`utils/chat/loadGenerations.ts`):
only the latest load STARTED merges, an older one logs `superseded` and merges nothing - its poll
tallies included, since `setPollMeta` overwrites and the older load read them earlier. The loading
skeleton is lowered by the load that last RAISED it, not by the latest one: a newer load started while
the salon is off screen (a repair after the reader left) raises nothing, and the superseded load would
otherwise leave it up for good. If the newer load FAILS, the older page is still not merged: the salon
keeps what it held, is not marked loaded, and the next open asks again. Pinned by
`useConversations.staleLoad.svelte.test.ts`. The refetch is not to come back: it was a heal, not a fix.

Two corrections ride on the same seam, because they are the same stale read wearing different
clothes. `readBy` is unioned rather than taken from the page: reading is applied optimistically in
memory before the network ACK, so taking the page's array un-reads what the user just read and the
badge comes back. And the page may never DOWNGRADE an on-screen envelope back to an FCM preview,
which taking it verbatim would do whenever the stored row is still the notification one. The unread
COUNT in the startup restore is now computed over the merged list too - counting the page alone lost
the same message twice, once from the display and once from the badge.

### A salon copy is stale when the live stream had a gap, never when a clock says so (2026-10-01)

A salon's in-memory copy is the REST page plus every live socket event since. Live events are never persisted one by one; since F4 the device keeps only a copy of the last page a load drew, replaced at every load and drawn before the next one answers ([community-open-budget F4](../community-open-budget.md#f4-built-2026-10-15)).
It used to be trusted for five minutes after its load (`CHANNEL_HISTORY_CACHE_TTL_MS`), which proves
nothing. **Measured on a Mi 9T, 2026-10-01:** A1 on `#general`, HOME, a peer posts, the push decrypts
and notifies (`seed source=mirror`), the tap resumes the app - the socket reconnects and NO
`GET /api/channels/:id/messages` goes out, so the message stayed invisible in the open salon until
the five minutes ran out. A salon push writes no row anywhere (only a DM push feeds
`fcm_message_cache.ndjson`), and re-tapping the open salon selects nothing new. A rotated-seed
message did appear, but only because the Graine repair listener invalidates the salon it repairs.

So the copy is now current until an EVENT makes it stale, and the event a missed message produces is
the gap in the stream: `useConversations.noteLiveStreamTransition`, driven by `isWsConnected`
changing in `ChatBackgroundService`, clears every salon copy on BOTH transitions (a page loaded while
the socket was down misses what was posted before the reconnect) and, on the reconnect, reloads the
salon on screen. Every other salon reloads on its next selection. Deletion, kick and repair keep
their own invalidations. Pinned by `useConversations.channelCache.svelte.test.ts`.

## Conversations are ordered by the server's clock (decided by the owner 2026-10-31)

**A DM or a group is ordered by the time the SERVER accepted each message, as a salon always was**
([offline-and-weak-network 6.4](../offline-and-weak-network.md#64-salon-graine-v2-replay-rules)).
The author's `sentAt` decided the order until then, and a message delivered late - an outbox that held
it for minutes on a stalled link, a sender whose clock runs slow - slotted in ABOVE what everyone had
already read: silently, and already "read", because the read marks compared against the same
`sentAt`. Measured on a peer's iPhone log the same day: one message queued at 18:16:31 and sent at
18:20:36 by the SAME device clock - four minutes of real delay, not skew.

**One key per row** (`messageTime`, [messageOrder.ts](../../../../frontend/src/lib/utils/chat/messageOrder.ts)):
`serverTimestamp ?? timestamp`. The server time is `queued_message.createdAt` on a recipient's copy and
the `receivedAt` the send answered on the author's (one `Date` per send, so the same value on every
device); a row without it - a copy older than the field, a bundle from a source that lacked it - keeps
its `sentAt`. Everything that says "when" reads this one function: the sort, the bubble's time (no
"written at" hint, owner's decision), the day and gap separators (`groupMessages`), the arrival
animation, the conversation's recency, the shared-content panel, and the read marks.

**The order is total and transitive**: `compareMessageOrder` is lexicographic on (tier, key, id). Tier 1
is the author's own copy the server has not dated YET (`awaitsServerTime`: a salon echo, or an own row
`pending`/`sending`/`error`/`unconfirmed` with no `serverTimestamp`); it sorts after every dated row,
by `sentAt` among its kind, and takes its place when the send answers (`patchServerTimestamp`, which
moves the row with `replaceMessageOrdered`; a follower tab gets the same `receivedAt` in
`outbox_entry_sent`). An own row with no status and no server time is a copy older than the field and
keeps its `sentAt` - otherwise every message sent before this change would sink to the bottom for ever.
`serverTimestamp` and `ingestSequence` are no longer tie-breaks; that mix was the recorded intransitive
cycle (see the next section).

**The read marks move to the same key in the same change, as a second map** (`readState.ts`). A
watermark is a number with no unit, and every mark written before 2026-10-31 is on the `sentAt` clock:
switching the one map's clock would have turned the last-read message of every conversation unread on
upgrade (its server time is later than its `sentAt` by the delivery latency). So:
`serverReadWatermarks` is compared against `messageTime` and is what this build writes for a DM or a
group; `readWatermarks` (stamped) keeps every older mark, an older client's frame and the native
shade's, and is compared against the row's `timestamp`. **A row is read when either map covers it.**
Salons keep their marks in the stamped map, where a salon row's stamp IS its server time. The frame
says `{ at, serverAt }` (the same value); a frame with no `serverAt` lands in the stamped map
([legacy-compatibility](../../legacy-compatibility.md)). Bundles carry both maps; SQLite schema v16
adds `server_read_watermarks`. `seenByAnchors` places every reader with two binary searches over
SUFFIX MINIMA of the two keys plus a last-row-written lookup, built in one pass - neither key is
monotone in display order (an unsent own row sits below every dated one on its `sentAt`, and stamps
skew), and the last index whose suffix minimum is under a mark is exactly the last row under it.

**Which server times may become a key or a mark** (review of #2824, P1-1 and P2-6). A row's server time
is trusted from the server only: the delivery's `createdAt`, the send's `receivedAt`, a salon row's
`createdAt`. A HISTORY BUNDLE is written by a peer, so a server time it relays is kept only inside
`[sentAt - 24 h, the bundle frame's own server time]` (`vettedBundleServerTime`, `messageTime.ts`) and
dropped otherwise (logged `[HISTORY_BUNDLE]`) - and checked a second time once the row's signature is
verified, against the SIGNED `sentAt` (`boundedByVerifiedSentAt`), since the first check could only
read the relayer's own unsigned `timestamp`; the bundle's server read marks and a received
`read_watermark`'s `serverAt` are refused above their frame's own server time
(`boundedServerMarks`, `receivedReadWatermarkMark`). And the target of this device's own server mark is
clamped to the newest server time HELD in the conversation, and below the newest one the server
stated to this account on this device (`serverMarkCeiling`, `serverClock.ts`): a live frame's
`createdAt`, a send's `receivedAt`, a background send's line, a push cached by the native side, a
frame the leader tab relays, and the `timestamp` the server stamped on each row of a history-log
replay (`newestServerRowTime`, `history.ts` - third review of #2824: a device that joined every group
by external commit and restored everything from the replay received no live frame, so its mark could
not move and a conversation read in that window showed its badge again after a restart; only the
rows' own server stamps are read there, never what a frame's plaintext claims). That value is durable (`ACCOUNT_KEY.serverClock`), shared by the tabs of
one origin, and while it is 0 - nothing stated yet, an offline first boot - the server mark does not
move at all. No row, however it arrived, can lift the mark past what the server has said. DM marks owed in `localStorage` are kept per clock - the key
written before the upgrade (`canari.dmReadMarks.*`) is now the STAMPED ledger and goes out as `{ at }`
alone; the server ledger is `canari.dmServerReadMarks.*` (`salonReadMarkQueue.ts`).

**A live frame had no `createdAt` until 2026-11-03, and every live DM read mark was refused for it.**
chat-delivery publishes `createdAt` on `chat:messages`, but the gateway rebuilt the WebSocket frame
from a field list that left it out (`live_mls_frame`, `apps/chat-gateway/src/subscribers.rs`), so only
a PULLED frame carried a server time. From `v1.6.0` (#2824, marks on the server's clock) every
`read_watermark` received LIVE logged `[READ] REFUSED ... the frame carries no server time to bound
it`: a DM read while both devices were online never showed on the sender (one check for good), nor on
the reader's own other devices. Measured on dev with `1.6.3-alpha.7/8`: iPhone 12 -> Mi 9T and web ->
Mi 9T, and the reader's own iPhone mark refused on its web device ([device-verification](../../device-verification.md)).
The gateway now forwards it when the payload has one, and never invents one; its test is in the same file.

**What a late message does now**: it sorts where it arrived, counts as unread and notifies - unless a
STAMPED mark newer than its `sentAt` covers it, which only an older client, the iOS shade's "mark as
read" (still `sentAt`-keyed, see below) or a mark from before the change can produce.

**Edge cases, checked**:

- **Edits, reactions, deletions and pins never move a row**: none of them writes `serverTimestamp`
  (an outbox `control` entry's id names the message it mutates, and `patchServerTimestamp` is skipped
  for it).
- **The newcomer cut and the exclusion windows** (#2800, `historyEntitlement.ts`) were already placed
  on the server's clock (`messageServerTime`), with a widened margin for undated copies - unchanged.
- **The re-admission replay** (#2804) re-delivers queued rows with their stored `createdAt`, so a
  replayed message keeps its first server time.
- **The history manifest is keyed by message ID, not by time** (`historyRangeOf`, see "The unit is a
  slice of the ID SPACE" below) - no clock enters it, so it needs nothing.
- **Local pages are cut on the same key** (owner's decision, same day: it must work for conversations
  of every size). Each stored row carries its order key in the clear beside the ciphertext -
  `order_at` in SQLite (schema v16, index `idx_messages_conv_order` on `(conversation_id, order_at,
  id)`, which replaces `idx_messages_conv_time`), `orderAt` in IndexedDB (v12, index
  `byConversationOrder` on `[conversationId, orderAt, id]`) - written by every save as `storedOrderAt`
  (= `messageTime`, one function in `messageTime.ts`). A page is cut on the PAIR `(orderAt, id)`, so rows
  tied with the boundary are neither lost nor read twice, and every row a page returns carries its
  `pageKey`.
- **A row the migration cannot key is keyed PROVISIONALLY, and nothing waits for it** (review of
  #2824, P1-2). The server time is INSIDE the ciphertext, so the v16 step (one `UPDATE`) and the v12
  upgrade (one cursor, after the v11 repair) key every stored row on its `timestamp` and flag it
  (`order_pending` / `orderPending`, each with its own index that holds the flagged rows only); a
  backup import (`importEncryptedRow`) does the same. A page read walks the index as it stands -
  keyed and provisional rows together, so the first page costs a page whatever the conversation
  holds - and starts the derivation behind it (`$lib/db/orderKeyDerivation`): 500 rows per chunk, in
  id order, each chunk WRITTEN before the next is read, one run per conversation; the flag is the
  durable progress, so a kill loses one chunk and the next run reads only what is still flagged. ONE
  lane for every conversation: a run starts when the previous one settled, so a first boot does not
  decrypt in parallel with its own writes - and a run a READER waits for (a load-older below a
  provisional boundary) starts before every background run still queued, a queued background run of
  the same conversation being promoted rather than duplicated (third review of #2824); a run in
  progress is never preempted. A row this key can never read (`PayloadUnreadableError`,
  thrown by `decryptData` for WebCrypto's `OperationError` and a non-JSON plaintext only) is keyed on
  its `timestamp` for good; any other failure leaves it flagged - a run that deferred a row ends the
  waiting, and its conversation's pages read as keyed until a FACT says the failure passed: a backup
  import (`rearm`), or a page read that decrypted a row still flagged (`readableAgain`), which re-arms
  the conversation, starts a run behind itself and hands its page back provisional. A row the run can
  never key does not decrypt in a page read either, so it cannot re-arm the conversation in a loop;
  the next session's run retries it. Only the store's
  BOUNDARY was provisional - the screen sorts on the decrypted `messageTime` - so a page's `pageKey`
  says `provisional`, and a load-older below such a boundary waits for the derivation and re-reads
  what lies above it too: a row whose real key rose past the boundary is in neither page otherwise.
- **The scrollback pages below where the STORE's pages stop**: the lowest `pageKey` held
  (`oldestPageKey`, `loadOlderMessages`), never the oldest row in memory - a row that arrived another
  way (live, from a bundle, an own send the outbox put back) may sit far below the last stored page,
  and a cursor taken from it skipped every stored row in between (P2-4). A message delivered many pages
  late is on the first page after a reload (`messagesPage.test.ts`, "a late message more than a page
  deep"; `useConversations.loadOlder.svelte.test.ts`). An own row still awaiting its server time is
  stored under its `sentAt` until the answer re-saves it, and one older than the page held is put back
  on screen from the store by the outbox (`applyPendingStatuses`, P2-3).
- **A background send** (a drain while the app was shut) writes `id<TAB>receivedAt` to
  `outbox_sent.ndjson` on both platforms; `reconcileOutboxSent` dates the stored and the in-memory row.
  The quick reply's own cache row carries the `receivedAt` its POST answered on both platforms
  (`writeSentMessageToCache` / `CanariWriteSentMessageToCache`, which `CanariDrainOutboxBackground`
  hands the receive times it collected; `serverTimestamp` in `fcm_message_cache.ndjson`), and so does
  an inbound push's (the push's `createdAt`). A reply another drain delivered has none and keeps its
  `sentAt` until the app dates it, said in the native log.

**Logs**: `[ADD_MSG] ✓ Message added` carries `sentAt=… serverAt=… gap=…ms`, and a batch line the
largest gap of the batch (`clockGapNote`). A gap of minutes on a positive sign is delay; a negative
gap, or one constant per sender, is a clock.

**The Android shade states the server clock too**: the push's `createdAt` (and, on the WebSocket
trigger, the frame's server time, `notify_native_message`'s `server_at`) rides the notification as
`EXTRA_SERVER_AT` beside `EXTRA_SENT_AT`. The banner a shade read already covers is compared on that
clock when both the message and the mark carry it (`coveredByShadeMark`), on the stamps otherwise. "Mark as read" and the quick reply's mark then send
`{ at, serverAt }` (`build_read_watermark_app_message(at, server_at)`, the shape the app sends) and
write `serverAt` into `read_watermarks.ndjson`, which `applyNativeReadWatermarks` merges into the
server map. A notification without it (an older build's, a push with no readable `createdAt`) sends
the stamped `{ at }` and says so in logcat.

**Not done, owed**: the iOS shade's "mark as read" and quick reply still announce the banner's
`sentAt` (`canari_native_build_read_watermark_proto` passes no server time, `CanariAppendReadWatermark`
writes `at` alone): the push's `createdAt` would have to reach `userInfo` in the Notification Service
Extension first. Tests: `messageOrder.test.ts`, `readState.test.ts`, `outbox.test.ts` ("takes its
place by the receivedAt"), `outboxMirror.serverTime.test.ts`, `systemMessageHandler.readState.test.ts`,
`historySystemEvents.test.ts`, `messagesPage.test.ts`, `readWatermarkCache.test.ts`,
`proto_fields.rs` (`build_read_watermark_app_message_*`).

### A joined conversation is ordered by its admission (2026-11-16)

**Seen on the iPhone 12 (`1.7.0-alpha.5`, dev), twice of twice:** a group the phone joined with the
chat list in front (`[WELCOME] Group ... ready` within a second) was not drawn for minutes, through a
tab change and a pull-down; after a resume it was on the first screen with the right age.

**The cause.** The row a Welcome writes (`upsertConversation`, the placeholder before it, and the
held-group row of `writeRowForHeldGroup`) carried no ordering seed, and it holds notices at most -
"X a ajoute Y", a nickname - which are not activity. So `conversationRecency` fell through
`lastMessageAt` and `startedAt` to **0: the last row of the list**, below the screen on a phone with a
long list, where the rig's visible-tree reader (`tools/ios-device`, `isVisible`) never reaches. The
resume "fixed" it because a new connection runs the group sweep, whose `recordGroupStart`
(`serverGroupConversation.ts`) writes `startedAt` (the group's server creation, minutes before the
join) onto a row that lacks one - so the row rose to the top only once the socket reconnected. The
creator never had the defect: its row is seeded with its creation moment (`groupCreation.ts`).

**The fix.** The Welcome's own server time (`deliveryMeta.queuedCreatedAt`, the moment this account
was admitted, the same on each of its devices to within milliseconds, each holding its own queue row, and ties break by id) is the joined row's `lastMessageAt` seed
(`admissionSeed`, `setupMessageHandler.ts`), on every path that creates the row: the fresh install,
a DM's new row, and the "already held" Welcome of a group joined in the background. A row that
already has a seed keeps it - a re-Welcome (a re-add, a repair) does not move a conversation. A
Welcome with no server time is ACCUSED at warn and invents nothing. Tests:
`setupMessageHandler.test.ts` ("a Welcome orders the joined conversation by the server time of its
admission"). Read on the Mi 9T on `1.7.0-alpha.7` (2026-11-17, [readings](../../device-verification.md#the-mi-9t-readings-of-2026-11-17-170-alpha7-the-envoyer-a-retakes-on-section-22s-screens)): the row was on the first screen within seconds; the entry is deleted.

## A catch-up batch is merged with ONE sort (2026-10-12)

`mergeMessagesInInputOrder` (`utils/chat/messageOrder.ts`) merges a batch of received messages into a
conversation's held list - the bulk ingest of `useMessaging` and the background service's batches.
It used to insert one message at a time, each a copy and a full sort of the conversation: O(K x N)
for K messages into N held, 18-25 ms for 200 into 5000 on a desktop (vitest, warm), per batch, per
conversation. It is now one stable sort of `existing ++ incoming`: 0.1 ms on the same input. A stable
sort of `sort(A) ++ [x]` orders equal elements exactly as a stable sort of `A ++ [x]`, so the two
give the same array whenever `compareMessageOrder` is a consistent order - pinned against the old
loop on deterministic random input full of ties ([test](../../../../frontend/src/lib/utils/chat/messageOrder.test.ts)).
**The edge that had no defined answer is gone (2026-10-31)**: messages with the SAME millisecond and
MIXED presence of `serverTimestamp` / `ingestSequence` made the old comparator intransitive - held
messages carry a `serverTimestamp` and no `ingestSequence`, a catch-up batch the reverse, so three of
them could form a cycle. The comparator now reads one key per row and the id, which is a total order
(see the section above; the cycle's former shape is pinned as ordered in the test).

## The workspace list prunes only what existed when it asked

The same seam as the section above, one level up, and it destroyed whole communities rather than
single messages. `executeWorkspaceLoadAttempt` fetches `listUserWorkspaces()`, then - per community -
joins the Graine distribution group and lists the salons, awaiting both. Only after all of that does
it end with two deletions: every conversation the listing did not mention, and

```ts
channelWorkspaces = channelWorkspaces.filter((ws) => validWorkspaceSlugs.has(ws.id));
```

The gap between the question and the deletion is SECONDS on a real account, and anything created in
it is absent from an answer that was already on its way.

**Measured on production, 2026-08-20**, three runs out of three, with the community-phase harness:
create a community, and the header names it for between 500 ms and 4 s; then `rail=false` - it is
gone from the sidebar entirely - and the app falls back to the first community in the list, salon
deselected. The salon created inside it went the same way, which is how COMM-12 came to log
`Channel created: #c12-joined-...` for a salon that was not there a second later. It came back on a
reload, which is what kept it invisible for two days while the check failed in a different place
every run. The request ordering is the proof and needs no inference: the console shows
`GET /api/channels/workspaces/user/me` issued at line 196, `POST /api/channels/workspaces` (the
creation) at 398, and `[WORKSPACE-LOAD] communities/channels loaded` at 497.

The repair is a **tick**, not a timestamp. It is read BEFORE the listing request goes out, and both
prunes spare anything dated later than the request. The question is not "how old is this" but "did
this exist when I asked", and a monotonic counter answers that exactly - there is no clock to be
wrong about and nothing to tune. A community that really was deleted elsewhere is still removed.

### A live fact heard during a listing is newer than its answer (2026-10-26)

The 2026-08-20 repair dated only what this device CREATED. **Measured on dev by the cross-client rig
(Mi 9T)**: a community joined in-session logged `[WORKSPACE-LOAD] community joined in-session -
loading its salons` at T, its listing went out at T+0.2 s, the server created a salon at T+2.6 s and
the phone logged `Joined channel <id>` (`onChannelMemberJoined`), the listing answered at T+6.4 s - and
its prune deleted the salon's conversation and row, without a line. The member did not see the salon
until a later listing. Same code on the web: only the width of the in-flight window differs.

The mirror image was open too: a salon or community DELETED, LEFT or taken from this member during a
listing was still in its answer, and the listing drew it back.

**One record, `listingLedger.ts`**, holds the LAST thing learned live about each id - `present`
(created here, or heard of on the socket) or `gone` (deleted, left, removed) - with the tick it was
learned at. Salons are keyed by conversation id, communities by `community:<slug>`. Every live
write goes through one of four places, and the listing's own writes go through none of them:

| Live fact | Where it is dated |
| --- | --- |
| salon created here, heard of (`channel.member.joined`), or drawn by a community creation | `addChannelToWorkspace` (the listing draws through `upsertChannelRow`) |
| community heard of on an event, or created here | `ensureWorkspaceForChannelEvent`, `ensureWorkspaceByName` |
| salon deleted, left, kicked from (`channel.deleted`, `channel.member.kicked`/`removed`) | `removeChannelFromWorkspaces` (the prune removes through `dropChannelRow`) |
| community deleted, left, removed from | `purgeWorkspaceLocally`, before its first await, for the community and every salon on its rail |

`leaveCurrentChannel` and `deleteCurrentChannel` record the removal as soon as the server answers,
before they await the store delete: a listing answered during that await used to set the
conversation back. `ChatBackgroundService.svelte`'s handlers are held to these entrances by a source
guard in the same test file.

**Fields, since 2026-11-25.** The same ledger is keyed per (row, field): `fieldHeard` /
`fieldHeardSince`. A rename, a write verdict or policy (`channel.updated`, a role change, a refused
post), a role change (`workspace.role.changed`) and a cover or history change (`workspace.updated`)
record the field at the tick they were heard, and `upsertChannelRow` / `upsertWorkspaceFromDto`,
called by the listing with the tick it asked at, leave that field alone - the older answer cannot give
a demoted administrator their controls back. The history rule of a `workspace.updated` frame is
forwarded from `channelEventHandler.ts` through `deps.ts`, so the admin card keeps what was saved
instead of resetting to the old rule.

A listing then:

1. **Does not draw back** a community or salon learned `gone` after its request
   (`[WORKSPACE-LOAD] <kind> <id> not restored: ...`). This is asked again at each point
   `loadCommunitySalons` would write next, because the purge can land while that community's salons
   or key group are still on their way. A community removed in that window gets no conversation, no
   channel map, no key-group join and no entry.
2. **Gathers every store that holds a salon the answer does not name** - its conversation, its row
   (in the communities the answer covers) and its stored page (F4) - and **decides once per salon**,
   reading the ledger first:
   - learned `present`: kept (`kept salon <id> (<stores>): ...`);
   - learned `gone`, with the purge still running: finished quietly
     (`salon <id> (<stores>) removed on this device after the listing was asked - its removal is
     finished here`), never blamed as unheard;
   - nothing learned: pruned, with **one `warn` per salon** -
     `pruned salon <id> (conversation, row, stored page): not listed by the server, and neither
     created nor heard of on this device after the listing was asked (tick N)`. This is the visible
     end of a removal this device did not hear live, usually one made while the app was shut: one
     line, not one per store.

   Communities get the same three outcomes.

The keep, decline and finish lines go to the session log (`ctx.log`), so they reach a phone's
in-app log: `appLog.ts` does not keep `debug`. Each attempt of a retried listing reads the tick
again, so a salon heard during the back-off is judged by the retry's answer.

A community first drawn from an event under a slug the server does not use (`workspace-<id>` when
the event named none) is folded into the listed entry by id, under the server's slug. It used to
appear twice.

The ledger keeps only the last fact, so a salon removed and then heard of again in the same window
is drawn. All of this is pinned by an explicit order in `useChannelWorkspaces.svelte.test.ts` ("a
live fact heard while a listing is in flight"), and the not-heard control is still pruned.

**What the ledger does NOT cover** (the same race, on fields rather than existence): a rename or a
`viewerCanWrite` change heard during a listing (`onChannelUpdated`) is overwritten by the listing's
older row, and a role change (`workspace.role.changed`) or a cover/history change
(`workspace.updated`) by `upsertWorkspaceFromDto`'s older DTO, until the next listing.

### The communities are loaded side by side, not one after another (2026-10-12)

The per-community half (key-group join with its roster audit, salon listing, private salon groups)
ran one community at a time. On a production web console (`v1.2.5`, 7 communities) that was 21+
requests in a row - `distribution-group`, `members`, `user/me` for each, 50-650 ms apiece - and
`communities/channels loaded`, which the unread counts wait for, arrived 2.87 s after the first one
left. Nothing one community does reads another's: the join is coalesced per scope
(`ensureDistributionGroupFor`) and each community appends only to its own sidebar entry. So
`executeWorkspaceLoadAttempt` now upserts every community row synchronously, in the server's order,
then runs `loadCommunitySalons` for all of them with `Promise.allSettled`; the load costs the longest
chain instead of the sum. **Settled, never raced**: a failed community fails the attempt only once
its siblings have finished, so the retry never starts beside a chain of the attempt it replaces -
the overlap `isLoadingWorkspaces` forbids. The prune above (`pruneAfterLoad`) still runs after every
community has answered. Pinned by counts, not clocks: three listings in flight before any answers,
sidebar order kept when they answer in reverse, and no retry while a sibling is still loading
(`useChannelWorkspaces.svelte.test.ts`).

## UI features

- **Focus writing mode**: header hides when composer is focused on mobile.
- **Sticky date**: current date label stays visible during scroll - see
  [The day label and its floating pill](#the-day-label-and-its-floating-pill-2026-10-01).
- **Search**: in-chat search with prev/next navigation and highlight.
- **Lightbox**: full-screen image/video with pinch-zoom and download, and previous/next over the
  conversation's media - see
  [The media viewer of a conversation walks its images and videos](#the-media-viewer-of-a-conversation-walks-its-images-and-videos-2026-11-13).
- **Radial menu** (mobile): long-press message -> circular action menu
  (`MessageMobileActions.svelte`). The actions are ICONS ONLY on ONE row (owner, 2026-11-08), built
  from one `actions` list (name = aria-label + title): 7 at most (own text message), each `flex-1`
  and 44px tall, 48px wide from 360px and 42px at 320px - never wrapped, never scrolled. The text
  nodes inside a bubble are `select-text` for a mouse but `pointer-coarse:select-none` (a child's
  `select-text` beats the bubble's `select-none`, which let iOS select a word under the sheet);
  "Copier" is the touch way to copy. **The quick-reaction strip above the row is a `role="group"` named "React"** (`data-quick-reactions`), each emoji a 44 px button named "React with X" with `aria-pressed`, the glyph `aria-hidden` (S17, 2026-11-20: the iOS accessibility tree did not list the emojis; read again on the phone).
- **Read receipts**: three states — sent / delivered / read — with distinct icons. In a DM the
  reader's "Lu" marker sits under the NEWEST message of the conversation the peer has read, which must
  be the viewer's own (`dmReadAnchorId`, owner, 2026-11-13, the Messenger placement - it reuses
  `seenByAnchors`, so a DM and a group agree on "the last thing they saw"): everything read puts it
  under the conversation's last message, a peer behind by N keeps it N rows up, a system line at the
  bottom never carries it, and a peer's reply below the last read own message removes it (the reply
  is the proof; the old rule left "Lu" on that older message). Computed over every row in
  `ChatArea`, passed down as `dmReadAnchor`. **In a group or a
  salon, each member's head sits under the LAST message THEY read, whoever wrote it** (user,
  2026-10-02, the Messenger placement): `seenByAnchors` in `utils/chat/readState.ts` places them over
  the WHOLE sorted conversation (a render window ending above a reader's anchor would pin the head
  to its last row), never draws the viewer, counts an author's own message as read by them, and
  draws no head on its owner's message. Who can appear is what `readWatermarks` holds - for a salon
  the server's `read-marks`, restricted to who may read it now
  ([social-service](../../services/social-service.md#read-receipts-in-a-salon)). One drawing,
  `SeenByHeads.svelte`, serves both: three heads, then `+N`. Each head's tooltip is its owner's
  name (`Avatar`); the `+N` counter's tooltip names the readers it folds, and the screen-reader
  text names every reader (`msg_statut_lu_par_noms`), resolved live by `userDisplayNames`. There is
  no per-member "hide my read state" setting: what `readWatermarks` holds IS the predicate, so the
  placement never filters a second time. A reader whose watermark is older than the loaded page
  gets no head (every loaded row is one they have not read); one past the newest row sits on it.
  The placement compares a mark with each row's `timestamp`, so both must be on one clock: a salon
  row is dated by its server `createdAt` on every path, or the heads under the last message flicker
  with each history load (2026-10-12,
  [social-service](../../services/social-service.md#read-receipts-in-a-salon)).
  **How a DM or group receipt is computed, end to end.** The reader's receipt effect
  (`MainChatPage`) takes `readMarkTarget`: the newest `messageTime` among the FOREIGN rows held,
  bounded by `serverMarkCeiling` (the newest `serverTimestamp` held, and what the server said to this
  account, `serverClock.ts`); it leaves as `read_watermark {serverAt}`; the author's device merges it
  into `serverReadWatermarks` and draws the head on its last own row with `serverTimestamp <= mark`
  (`readersOf`). So the reader's rows and the author's rows must carry the SAME key, the server's
  acceptance: `queuedCreatedAt` on a received row, the `receivedAt` the send answered on the author's.
  **The receipt one or two messages late (owner, 2026-11-05, 1.6.5).** `batchAddMessages` - the drain
  every live arrival goes through - gave the server time to the STORED row only and built the SHOWN
  row without it, so until a reload every received row was keyed by its author's `sentAt`. Measured on
  dev with a logpoint on `readMarkTarget` in two bench browsers: the reader's rows held
  `serverTimestamp: undefined`, its mark was the author's `sentAt` of the last message (author clock,
  ~0.7 s behind the server, plus the network), and the author compared it with the later server time
  of its own rows - the head stayed on the message before a quick pair, both of the pair single-checked.
  The ceiling, with no dated foreign row, held the mark at the reader's own last send, which is why it
  moved only when the reader acted. A reaction played no part (the same run without one gives the same
  head); nor did #2937 or #2939: the row never carried the field, and #2824 (`1.6.0`, marks on the server
  clock) made it load-bearing. Fixed at the row: the shown row carries `serverTimestamp`.
  `readReceipt.oneLate.svelte.test.ts` (the owner's sequence, reactions both ways, arrivals while open,
  a second device on each side; all four fail without the fix).
- **GIFs**: an in-app picker (KLIPY) sends a GIF by URL; on Android the soft keyboard's own
  GIF/sticker button also works via `commitContent` (see below). GIFs skip canvas compression in
  `useMessaging.handleFilesSelected` so their animation is preserved.
- **Group photo**: `ChatGroupPanel` opens the picked image in `AssociationLogoCropper` (drag/zoom/
  resize square crop, exported at 512x512) before uploading it as the group avatar, the same
  component associations and card icons already use - see
  [design-reference](../design-reference.md) for the crop mechanism itself.

### The swipe gesture was switched off by a variable nothing writes (2026-09-20)

*"la reponse en swipant un message n'a pas l'air de marcher, est-elle implementee ? Testee sur
mobile ?"* (user). It was implemented, in `messageSwipeReply.ts`, with its own unit tests - and it
had never run once, on any device, since 2026-03-26.

`MessageBubble` gated the gesture on `let supportsHover = $state(true)`. **Nothing in the repository
ever assigned to it** - two occurrences in the whole tree, the declaration and the read - so
`canSwipeReply` returned `false` unconditionally. The reaction swipe shares the same handler and was
dead with it.

**WHY NO GATE SAW IT, AND THIS IS THE part WORTH KEEPING.** `messageSwipeReply.test.ts` was green
throughout: it tests the gesture MATHS - the lock between horizontal and vertical, the clamped drag
offset, the trigger threshold - and every one of those functions was correct. The predicate deciding
whether any of it would be CALLED lived in the component, privately, where no test could reach it.
*A green gate is not a working system*, in its sharpest form: the tested part worked and the
untested part was one wrong default.

The fix moves the predicate into the tested module as `canStartReplySwipe`, and the capability it
asks about is `isCoarsePointerDevice()` - which this repo already owned, for exactly this question.
A mouse reader has the hover toolbar and does not need a gesture; a laptop with a touchscreen
reports `pointer: fine` and keeps the toolbar. The bubble re-reads it on mount (a server render
cannot ask `matchMedia`, and the helper answers `false` there) and subscribes to changes, so a
tablet gaining a mouse or a browser toggling device emulation moves the answer.

**THE WIRING IS NOW TESTED, NOT JUST THE MATHS.**
`MessageBubble.swipeReply.svelte.test.ts` mounts the real bubble and dispatches real `pointerdown` /
`pointermove` / `pointerup` at the real `[data-swipe-reply]` element, plus one pass over the
`touchstart` / `touchmove` / `touchend` path that a finger actually takes, and asserts that `onReply`
fires. It runs with `matchMedia('(pointer: coarse)')` stubbed to match, because that single fact is
what the old gate got wrong. Five of its twelve cases go red if `canStartReplySwipe` is made to
return `false` - measured by mutating it - so the suite fails the way the original defect did. The
refusals are pinned too: a mouse `pointerType`, a fine-pointer device, a tombstone, a system pill, a
drag too short, and a vertical drag (scrolling a thread must never answer a message).

**THE FINGER IS PAID, 2026-09-21.** A debug APK was built from `33c064687` with a clean tree - the
build asserts both halves, that the seven `VITE_*` origins reached the packaged chunks and that the
commit describes the artefact exactly (`tools/cross-client-harness/a1apk.mjs`) - installed on the
Mi 9T, and driven with `adb shell input swipe`, which enters Chromium through the real touch stack
rather than through a dispatched event.

**Two gestures, because one of them proves nothing on its own.** A 320 px leftward drag on an own
bubble (~122 CSS px, above the 56 px trigger) filled the reply composer with that message's author
and text. A 70 px drag on the same bubble (~27 CSS px, below it) did nothing at all. Without the
second reading the first would only say that the element takes touches; together they say the
THRESHOLD is live on hardware, which is the part a simulated DOM cannot claim.

**What this does NOT cover, stated so nobody reads it as more than it is.** The bubble was an OWN
message, so only the `isOwn` direction was exercised on glass - a peer's bubble swipes the other
way and is covered by tests alone. Nothing here was measured on iOS, where the engine is WebKit and
the pointer-event path is its own question.

### The reaction swipe is gone, and the reply hint moved to the outer edge (2026-09-22)

Two days after the gesture was switched back on, the user met it and cut half of it. *"swiper pour
reagir n'est pas quelque chose de bien, c'est meme assez bizarre. Tu peux retirer ceci."* And on the
half that stayed: *"swiper vers l'interieur fait apparaitre une bulle avec le logo repondre, mais a
l'interieur et qui ne bouge pas, donc c'est un peu bizarre (le message passe dessous, pas
intuitif)"*.

**BOTH WERE SETTLED BY MEASUREMENT RATHER THAN BY TASTE, ON MESSENGER 579.0.0.61.91, ON THE SAME
HANDSET.** The rig drives it with `adb shell input swipe` over a long duration and screenshots
MID-GESTURE, which is the only way to see an affordance that exists solely while a finger is down.

| Gesture | Messenger | Canari before | Canari now |
| --- | --- | --- | --- |
| Drag toward the thread centre | reply | reply | reply |
| Drag away from the centre | **no displacement at all** | reaction tray | **nothing** |
| Long press | reaction bar on the bubble + action bar docked at the screen bottom | one mobile sheet | one mobile sheet (kept, user) |
| Double tap | nothing observed | heart | heart (kept, user) |
| Thread-list row swipe | **none**; every action is the long press | none | none |

**THE HINT IS REVEALED, NOT DRIVEN OVER, AND THAT IS THE WHOLE DEFECT.** The hint is absolutely
positioned on the wrapper and does not move; the bubble does. It was anchored on the side the bubble
travels TOWARD (`left-full` on a received bubble), so the message slid straight under an icon sitting
at `z-20` - announcing an action while being covered by the thing that would perform it. Messenger
translates the whole row, avatar included, and reveals the reply icon in the space the row VACATES,
on the outer edge. The fix is that placement: `right-full` for a received bubble, `left-full` for an
own one, the arrow mirrored to point the way the bubble travels.

**The side is pinned by a test, and the test is proven by reversal**: restoring the old placement
fails `anchors past the LEFT edge of a received bubble` and its own-message twin. Three more tests
assert the outward drag now moves nothing and calls neither handler, because a deleted gesture is
the kind of thing a later refactor restores in good faith.

**`showQuickReactions` went with it.** The tray it guarded was reachable only from the reaction
swipe, so removing that gesture left a `$state` nothing ever set to `true` and a block that could
never render - dead the moment the gesture was.

### A double tap likes and does NOTHING else: the single tap waits out the window (2026-10-12)

*"double tap pour liker ne doit pas aussi faire l'action du simple tap"* (user). On a phone the
bubble's tap toggles `MessageInfoTooltip` (time, readers) and its double tap sends a heart. Both
lived in one `onclick`: the first tap opened the panel AT ONCE and stamped `lastTapTime`, the second
saw the 300 ms window, liked and closed the panel. So every heart flashed the readers' panel, and a
like was always also a single tap.

**THE STANDARD DISAMBIGUATION, AND ONE IMPLEMENTATION OF IT.** `utils/tapDisambiguator.ts` arms ONE
timer of `GESTURE.DOUBLE_TAP_MS` on the first tap; a second tap inside it, within
`DOUBLE_TAP_SLOP_PX`, cancels it and runs the double action alone. `MediaLightbox` had the same
pattern written inline and now uses the same helper, behaviourally unchanged, so the bubble's private
`300` literal is gone and the two surfaces cannot drift apart. **The window is 250 ms, decided (user,
2026-10-12)**: the like's tolerance went from 300 to 250 ms, and the single tap answers 50 ms sooner.
The wait is paid ONLY where a second tap would change the answer (`heartOnDoubleTap`: a phone, a live
message, `onReact` wired); a desktop bubble or a tombstone opens its panel immediately, as before.

**THE EDGES OF A SEQUENCE, EACH DECIDED.**

- **A second tap too FAR away replaces the pending one**: the single action runs once, for the newer
  tap. That is what the viewer always did, and it is right for the bubble too: settling the first as
  single and then the second would toggle the panel open and shut within a quarter second - the very
  flash this fix removes.
- **A completed like consumes its window** (`quietAfterDouble`, the bubble only): a third quick tap
  is IGNORED - no second like, and no pending single that would open the panel behind the heart. Past
  the window, a tap is a new sequence. The viewer keeps its old behaviour (a third tap starts afresh).
- **A long press, or the `contextmenu` a phone browser fires for one, cancels a pending tap**: the
  action sheet supersedes it. An unmounted bubble cancels its own.

**AN INNER CONTROL OWNS ITS TAP.** Links, mentions and media buttons already stopped propagation;
a poll option did not, so two quick votes were also a heart. `tapBelongsToInnerControl` now drops,
at the bubble, any click whose target sits in a nested `a[href]`, `button`, form control or
`role="button"`: it acted, and it neither opens the panel nor counts towards a heart.

Pinned with counts on fake timers by `MessageBubble.doubleTap.svelte.test.ts` (single -> 1 open,
0 likes; double -> 1 like, 0 opens; three quick taps -> 1 like, 0 opens; contextmenu -> 0 opens;
link and poll option -> 0 likes, 0 opens), by `MediaLightbox.videoTap.svelte.test.ts` (a far second
tap -> exactly 1 toggle of the bars) and by `tapDisambiguator.test.ts`. The triple-tap, far-tap and
contextmenu tests were each proven by reverting the behaviour they pin.

### The edge-swipe-back gesture had no target guard, and the back button sits inside its own edge zone (2026-09-22)

*"you can only swipe page on no elements (if I swipe on a button, it doesn't click it, but doesn't
swipe either)"* (user). The back button (`ChatHeader.svelte`, and the null-conversation safety net
in `ChatArea.svelte`) is the LEFTMOST element in the header - well inside `swipeBack.ts`'s default
28px edge zone - and `onTouchStart` armed the gesture on `clientX` alone, with no check of what the
touch actually started on.

**Neither outcome fired, and that is the point worth keeping rather than "the swipe was wrong."**
`swipeBack.ts` never calls `preventDefault()`/`stopPropagation()` anywhere - the browser's OWN
tap-vs-drag disambiguation cancels the native synthesized `click` once a touch moves roughly 10px
from its start, independently of any JS here. The gesture's own commit threshold is 90px. A touch
that starts on the button and drifts even a little - 10 to 90px - therefore lands in a dead zone
neither side claims: too far for the browser's native click, short of this gesture's own commit.

The fix checks `e.target.closest('button, a[href], [role="button"]')` once at `touchstart`, so
`tracking` never arms and every later handler's existing `if (!tracking) return` does the rest.
`swipeBack.test.ts` (new - the action had no test file at all before this) dispatches the same
minimal touch-event shape `pullToRefresh.test.ts` uses and pins both outcomes: a touch starting on
a button never sets a transform or calls `onBack`, and a touch starting on plain space inside the
edge zone still commits.

**THIS IS A LOCAL PREDICATE, NOT `swipeNavigation.ts`'s `shouldIgnoreSwipeTarget`, and the first
version of this fix reused that one - for a few hours, same day.** The two gestures need OPPOSITE
answers to "does a button/link arm me": the tab-swipe gesture covers the whole screen, where almost
everything a reader's thumb lands on IS a card `<a>`, so the user's very next report
("swipe should occur when starting something else than empty space, not the header though")
relaxed `shouldIgnoreSwipeTarget` to stop excluding plain buttons/links there. Had `swipeBack.ts`
kept importing it, that same relaxation would have silently un-fixed the back button. Two questions
that happen to sound alike get two functions.

### The tab is an unread signal, and it needs no permission (2026-08-31)

**The web had exactly ONE out-of-page unread signal before this, and it is conditional.**
`useMessaging` posts a browser `Notification` when the tab is hidden or unfocused;
`sendSystemNotification` returns early unless `Notification.permission === 'granted'`, so the FIRST
message that arrives while the tab is away is spent on the permission prompt rather than delivered.
A user who declines once is then permanently without any signal: the in-app badge has to be looked
at to be read, which for a backgrounded tab is not a signal at all.

The title and the favicon ask nobody. `stores/tabIndicator.ts` renders `(3) <page title>` and swaps
a red-dotted copy of the app icon in, unconditionally, from the same unread total the sidebar and
the bottom bar show - `utils/unreadTotal.ts`, which is where that reduce lives now instead of in
each of them.

**IT IS THE ONE WRITER OF `document.title`, AND THAT IS THE POINT.** There were two candidates and
they could not both be right: `SeoHead` renders the route's `<title>` reactively, and
`useNotifications` blinked an incoming call's bell by SAVING the current title, overwriting it and
restoring the saved copy. Any prefix present when a call arrived was captured into that save and
reinstated after it; any applied during the call was erased by the restore. So the blink was moved
behind `setTabRinging` and the title became a pure render of `(base, unread, bell)` - `formatTabTitle`
in `utils/tabTitle.ts`, which returns a WHOLE title from an undecorated base and therefore cannot
accumulate `(3) (3)` however often a reactive effect calls it.

**The route's own title is OBSERVED, never passed in.** A `MutationObserver` on the `<title>`
element adopts any change this module did not make as the new base, so a navigation, a locale
switch, or a future title source is picked up without knowing the indicator exists. Writes made
here are recognised by comparing with the last one written, which is only sound because the render
is derived rather than edited.

The favicon badge is a DOT, not a number: the count is already in the title where it is legible, and
a sixteen-pixel glyph redrawn on every arriving message is a race between asynchronous draws for
nothing. One draw, cached for the page's life, verified against the real asset in Chrome - the
canvas is same-origin so `toDataURL` does not throw, and the badge centre reads exactly
`rgb(239, 68, 68)`, the `bg-red-500` the in-app nav dot already uses.

### Android keyboard media (`commitContent`)

The Android soft keyboard commits rich content (GIF/sticker/image) through the focused editor's
`InputConnection.commitContent`. The native `KeyboardMediaBridge` (Kotlin) wraps the WebView input
connection to advertise image MIME types and, on commit, reads the content URI and dispatches a
`canari-keyboard-media` DOM event (`{ mime, name, data }`, base64). `MainChatPage` listens for it,
rebuilds a `File`, and routes it through the normal media pipeline (`handleFilesSelected`), so a
keyboard GIF is encrypted and sent like any picked file, in DMs, groups, and channels.

**The one hook, `RustWebView.onCreateInputConnection`, lives in the vendored wry TEMPLATE**
(`frontend/src-tauri/patches/wry/src/android/kotlin/RustWebView.kt`, a `CANARI PATCH`), never in
`gen/android/.../generated/RustWebView.kt`: wry's `build.rs` rewrites every file of `generated/`
from its templates on each Android build, so the tracked copy is an OUTPUT, refreshed by a build and
committed with it. All logic stays in the non-generated `KeyboardMediaBridge`, in the same package,
which is why the template can name it unqualified.

**The hook was lost for four months (2026-07-25 to 2026-11-22).** It was first written into the
generated copy (`ebdc943366`, 2026-07-02, with a comment asking to *"re-apply after `tauri android`
regeneration"*), and the next regeneration, committed as `3614a79518` ("fix"), erased it. The bridge
kept compiling with no caller, the WebView advertised no image MIME type, and Gboard answered
*"GIF non disponibles ici avec cette appli"* on every Android build since. A comment
asking a human to re-apply a hunk after a tool rewrites the file is not a mechanism: the hook moved
to the template, which no build rewrites, and
`.github/scripts/tests/android-keyboard-media-hook.test.mjs` (in `make test-ci-scripts`) fails if
the template or the tracked generated copy loses the override, if the override stops returning the
bridge's wrapper of `super`'s connection, or if the bridge stops offering `image/gif`; it proves each
check against the upstream class and against an override that drops the wrapper. The bridge logs
`KeyboardMedia: input connection wrapped` once per process - the line that says on a device that the
hook is live.

**One dispatcher routes it (2026-11-22), and nothing is dropped silently.** With the hook live,
Android advertises image types on EVERY editor of the WebView, so Gboard offers its GIF tab in any
field. Each composer used to listen for `canari-keyboard-media` on its own, which would have left
every unwired field taking the GIF and losing it. `utils/keyboardMedia.ts` is now the one owner: the
root layout installs one window listener, and a composer registers with the `keyboardMediaTarget`
action. The event goes to the innermost registered element containing the focused element:

| Surface | Registered on | What a keyboard GIF does |
| --- | --- | --- |
| `chat` | `ChatComposer`'s footer | attached through `onFilesSelected`, the picked-file path (DM, group, channel) |
| `chat-edit` | the same footer, while a message is edited | refused: toast `keyboard_media_refused` |
| `comment` | `CommentComposer`'s field | staged through `stageMediaFile` |
| `post` | `CreatePostForm`'s root | added through `addFiles`, the picked-file path |
| any other focused field (a channel poll, a reel caption, a profile field) | nothing | refused: toast `keyboard_media_refused`, and one `KeyboardMedia` line naming the surface (`data-media-surface` if an ancestor declares one, else the tag) |
| no focused field | - | nothing attached, one line, **no toast**: no keyboard commits without an editor, so this is iOS seeing the app's own pasteboard write (an image copied in the app), and "GIFs cannot be added here" would be false |

An unreadable payload toasts `keyboard_media_unreadable`, and so does a native ERROR event: both bridges, instead of only logging, send `{ error: 'too-large' | 'unreadable' }` with no data when they received an image they could not hand over (empty, over 12 MiB, a read that threw). The focus rule comes first for errors too, so a too-large image copied on iOS outside any composer shows nothing. Before this, the chat page sent ANY
dispatched image into the open conversation whatever had focus - an image copied on iOS included.
Tested in `utils/keyboardMedia.test.ts`. Reliable IME `commitContent` needs a recent Android
WebView; on devices where it is unavailable the in-app GIF picker still works.

### The thread sticks to its own bottom, and ONE boolean says whether it should (2026-09-22)

The user described the whole of it in one sentence: *"c'est une histoire de 'coller' le bas de la
discussion lorsqu'on n'est pas en train de remonter (j'imagine qu'un True/False pourrait etre
coherent ?) a ce qu'il y a en dessous, et suivre les mouvements de maniere fluide plutot que de
cacher involontairement des morceaux de l'interface"*.

**The boolean exists and is `isNearBottom` in `ChatArea.svelte`.** `handleScroll` is its only
writer, because a scroll is the only thing that can express an intent to leave the live end of a
conversation. Its predicate is `isPinnedToBottom` in `src/lib/utils/chat/threadAnchor.ts`, with the
slack it reads named there as `THREAD_BOTTOM_SLACK_PX` - it was an unexplained `120` inline in the
scroll handler, which nothing could test and nothing could explain.

**Three things can grow the pane under the reader, and before this only one of them was watched.**

| What grows | What sees it | Why it is the same quantity |
|---|---|---|
| The content - a row added, a reaction chip, an image settling | `MutationObserver` on the scroller | - |
| The pane's own box - soft keyboard, window resize, a side panel opening | `ResizeObserver` on the scroller | - |
| The composer band - a message wrapping onto a third line | `ResizeObserver` on the band | its measured height IS the scroller's `padding-bottom` (`--chat-composer-height`), and `scrollHeight` INCLUDES `padding-bottom` |

That last row is the one that makes a single mechanism correct rather than convenient: **composer
growth and content growth are literally the same number**, so all three observers call one `follow()`
closure, which asks one predicate about one number (`threadGrowthResponse` and the reach since
2026-10-30, below). Three copies of this
judgement could disagree about where the bottom is; one cannot.

Every trigger is the change itself. There is no timer, nothing to tune, and nothing that fires when
nothing happened.

**Scrolled up, nothing moves.** A message arriving while `isNearBottom` is false raises the unread
pill on `.chat-scroll-bottom-button` (`unreadBelowCount`) and leaves the pane exactly where it is -
the behaviour the user chose over auto-scrolling, and it predates this work.

### A box shrinking is growth too: the keyboard and the pinned thread (2026-10-09)

Reported on production 1.1.2 (Android): at the bottom of a conversation, the keyboard opened over the
last messages and the scroll-to-bottom arrow appeared. `follow()` asked `shouldFollowThreadBottom`
about `scrollHeight`, and the keyboard changes the scroller's BOX (`flex-1` loses ~330 px) while
`scrollHeight` stays the same, so nothing "grew". The judgement now reads the **reach**,
`scrollHeight - clientHeight` (`threadReach` in `threadAnchor.ts`), the one number a row, a
reaction, a typing bubble, the composer's padding AND the box all move. No timer, no new observer:
the `ResizeObserver` on the scroller already fired, it was asked the wrong question.

Measured in headless Chrome (390x844, real `observeThreadGrowth` and the real scroller CSS shape,
box 844 -> 514 px as the keyboard): pinned, distance from the bottom 330 px before, 0 after, last row
7 px clear of the composer instead of 323 px under it; scrolled up 700 px nothing moves (the reader's
row stays at -56 px), which is deliberate - a reader up in history keeps their row. A reaction row
growing above, and the typing bubble sliding in, were already followed (0 px) and are unchanged.
**iOS WebKit was not run.** The viewport numbers feeding the box (visual vs layout viewport, the iOS
safe-area) are `keyboardViewport.svelte.ts`'s, corrected in PR #1667; this change reads only the
resulting box, so the two combine without overlap.

### A field that stays focused with the keyboard down: the rise that covered the thread, and the "+" that raised the keyboard (2026-10-29)

Reported by the owner on 1.5.0 (Android, Gboard): the keyboard covered the conversation instead of
lifting it, and once the keyboard had been opened, "+" opened the keyboard again instead of its menu.
**One fact causes both: an Android WebView keeps the text field FOCUSED when the keyboard is put
away** (Back, Gboard's down arrow). Read on the Mi 9T (`1.5.1-alpha.7`, LatinIME, over CDP):
`document.activeElement` is still the composer's editor after Back, with `innerHeight` back at 945.

- **The rise.** Focusing the composer goes to the end of the thread, from any distance (`ChatArea`'s
  `_composerFocused` effect). A tap on a field that is ALREADY focused raises the keyboard with no
  focus event, and the keyboard effect followed only a reader within the 120 px slack
  (`isPinnedToBottom`). A reader 138 px up kept their `scrollTop` (2772 before and after) and the
  distance to the bottom went from 138 to 483 px: the last messages stood behind the keyboard and the
  scroll-down arrow appeared. `keyboardChangeResponse` (`threadAnchor.ts`) now answers a keyboard
  rising for the focused composer like the focus itself, wherever the reader was; a keyboard FALLING
  still moves only a reader at the bottom.
- **The "+".** `keepsFocus` (#1345, first stable `1.0.1`) cancels the press's `mousedown` so the
  keyboard stays up under the menu. With the keyboard already DOWN it left the field focused, and
  Chromium raises the keyboard on any tap while an editable element holds focus; the rising keyboard
  then closed the menu (`keyboardOpened`). Measured: no menu and the keyboard up; with the field
  blurred first (`activeElement.blur()` over CDP, the control), the five entries and no keyboard. The
  composer now asks for `keepsFocus` only while the keyboard is up (`menuPressKeepsFocus`,
  `composerSurface.ts`): with it down the press takes focus, the field blurs, and the menu opens.

**What was not a regression.** Nothing in this area changed between `1.5.0` and `1.5.1`; the "+" half
dates from #1345 (2026-10-02) and the rise half from the keyboard effect of 2026-05 combined with the
120 px slack of 2026-09-22. The native IME padding (`MainActivity.applyKeyboardInsets`) worked on the
Mi 9T (Android 16, edge-to-edge enforced): `IME inset: 885 -> content padding`, `innerHeight`
945 -> 588. Both fixes were read on the Mi 9T by reproducing the change over CDP on the installed
build (a capture-phase `mousedown` that skips the hold while the keyboard is down: the menu, no
keyboard; the hold kept with the keyboard up: the menu over the keyboard, focus kept); the built
change itself is owed one reading ([check W](../../device-verification.md#w-the-composer-stands-still-while-the-keyboard-rises---owed-on-both-phones)).

### A reader at the bottom is anchored to the bottom, in both directions (2026-10-30)

Reported on production 1.5.1 by the owner (Pixel 6a) and a friend: in a DM whose tail holds a photo,
opening the keyboard showed OLDER messages, the photo cut by the composer and the scroll-down arrow
up; a text-only DM rose correctly. The friend read it as "it anchors on the end as it was when the
app opened". **That reading, and the hypothesis of a stale `isNearBottom` snapshot, were refuted on
the Mi 9T** (`1.5.1`, CDP, the real observer): late growth and new messages were followed every time
and the flag was right.

**The mover was the row anchor.** On Android the WebView itself resizes for the keyboard
(`MainActivity.applyKeyboardInsets`), so every `svh` length shrinks with it, and a chat photo sits
under `--media-max-height: 60svh`. Measured, a 567 px block (60svh) above the last rows, keyboard
357 px: frame 1, the box shrinks, the reach grows, `follow()` pins (distance 0); frame 2, the WebView
resize shrinks the block by 214 px (0.6 x 357), the reach SHRINKS, and `shouldFollowThreadBottom`
followed growth only - so `anchorShift` kept the row at the top of the viewport in place by moving
`scrollTop` 3527 -> 3313: distance 214, arrow up. The 214 px is the photo's loss, not the keyboard's.

`threadGrowthResponse` (`threadAnchor.ts`) replaces the predicate with three answers: a reader at the
bottom FOLLOWS any change of reach, growth or shrink (`follow-bottom`), holds when nothing moved
(`hold-bottom`), and is never anchor-compensated; the row anchor (`keep-row`) is for a reader in
history and while older messages are prepended. **Entering is no longer one of them** (2026-11-09,
[below](#rows-received-as-notifications-appeared-only-at-the-second-open-2026-11-09)): an entry
follows the bottom.
`threadGrowthObserver.test.ts` drives the observer through late growth, the keyboard box and the
`svh` shrink: the old rule leaves the pinned reader exactly 214 px up, the new one at 0, and a reader
in history keeps their row. **Owed: one reading of the built change on an Android phone, a DM with a
portrait photo near its end.**

### The flag is only ever the reader's (2026-11-21)

The photo DM of the Pixel 6a (`1.6.12`, 2026-11-14): a DM whose last rows hold a photo, a video and a
screenshot landed on OLDER messages ~50 ms after the keyboard settled, the scroll-down arrow up. The
2026-10-30 fix and the held media ceiling did not stop it. **Not reproduced on a phone**; the
mechanism was reproduced in Chrome (a pane, three photos under a `calc(var(--kv) * 0.6)` ceiling, the
real `observeThreadGrowth` and the real `stickToBottomAfterScroll`) and is a property of the flag, not of
the media.

**Why the anchor was lost.** `measureScroll` runs in an animation callback, before the frame's
`ResizeObserver` entries, and decided "the reader went up" from `scrollTop` lower than the LAST
MEASUREMENT while more than the slack from the bottom. Frame A: the thread shrinks (the photos'
ceiling drops, the box loses the keyboard), the browser clamps `scrollTop` and the observer pins it
lower - the pane is at the bottom, at a smaller `scrollTop`. Frame B: the thread grows back (the
ceiling restored) BEFORE the measurement of A's scroll runs. It reads a `scrollTop` lower than its
last reading and a distance of 643 px from the bottom: the flag falls, every later change answers
`keep-row`, and the reader stays 429-643 px above the newest rows, with nothing that will ever follow
them. Measured: flag `true -> false`, distance 429 px after the settle (Chrome, three 567 px photos).
It needs no media load and no timer: any shrink then growth of the thread in consecutive frames does
it; the photo DM is the one place a phone showed it.

**The fix: a reader leaves the bottom by moving up from where the PANE was last put, by anyone.**
`observeThreadGrowth` takes an `onPlaced(scrollTop)` callback, called after every write it makes (a pin,
which is also where a clamp ends); `ChatArea` writes it into `lastMeasuredScrollTop`, as
`scrollToBottom` does for its own write. The next measurement then compares with the pane's own
placement, finds `scrollTop` unchanged, and keeps the flag; the observer pins the regrowth. Same
replay, fixed: flag `true`, distance 0. No clock, no ceiling, no per-media rule - it holds for a
thread of any length and any content.

`threadGrowthObserver.test.ts` ("a thread that shrinks then grows back") replays it: the pin of
frame A, the growth of frame B, the measurement between them. With the placement as baseline the reader
ends at the bottom with the flag up; with the last measurement as baseline (the old rule) the flag
falls and the reader is left above - the control, which fails on the old code.

**Owed:** one reading on the owner's Pixel 6a (a reading-owed entry in the plan). Not refuted: other
writers of `scrollTop` (`widenEntryWindow`, `loadOlderGroups`) were excluded by reading, not measured.

**The iPhone does not pass (`1.7.3-alpha.4`, 2026-11-22, 3 of 3 identical):** the last portrait photo
ends 71 pt under the composer - the thread rose 176 pt, the composer 278. Android passes. Two
candidates, and the source cannot choose: the pane left above its end (on iOS an overflow scroller is
scrolled by WebKit's own UI-process scrolling, so a programmatic write may land elsewhere and come back
as a `scroll` event this measurement would read as the reader going up), or a scroll range that ends
short of the thread's padding. So the build REPORTS instead of guessing: the native settled-keyboard
line carries `threadTop`, `threadMax`, `threadPad` and `lastRowBottom`, and `measureScroll` logs every
fall of the flag with NO finger on the pane (`left the bottom with no finger on the pane: ...`; a reader
scrolling up is not logged). Such a fall during a rise is the flag read off a move that was not the
reader's; the fix then is to let only a reader's input lower it - which `1.8.0-alpha.1` showed, below.

### The engine's keyboard move is put back, and only it (2026-11-23)

**What the iPhone said** (`1.8.0-alpha.1`, iPhone 12, iOS 27, 3 of 3): one line per opening,
`left the bottom with no finger on the pane: scrollTop 5813 (last placed 6188), 375 px from the end`
(an earlier run: 102 px). The pane went 375 px UP while its reach (`scrollHeight - clientHeight`) was
the reach of the last placement, with no finger on it, and no writer of this page made the move: every
one of them reports its placement (`onPlaced`, `scrollToBottom`). It is the engine's: WKWebView scrolls
an overflow scroller to reveal the focused field. **It happens with the keyboard UP**, after the
WebView was resized and the observer pinned the pane: the thread ended 96 pt short once the keyboard
fell, which is 375 minus the 279 pt keyboard - a move before the resize would have left it 375 short.
Read as the reader leaving, the move dropped the flag, every later change answered `keep-row`, and the
last photo stayed under the composer. The Mi 9T (Chromium) makes no such move and passed.

**The rule: a move is put back only when it is POSITIVELY the engine's keyboard move**, named by three
facts carried from where each is already known, never by a clock (`scrollMeasurementResponse`,
`threadAnchor.ts`):

1. **No reader input since the last placement** - `trackReaderInput` (`readerInput.ts`): a `touchstart`,
   `pointerdown`, `wheel` or `keydown` on the pane, a scrolling key pressed with the focus on the page
   itself (the pane has no tabindex, so PageUp lands on `body`), or a jump the reader asked for. Lowered
   when the page places the pane with no finger down, so a fling stays the reader's through its momentum.
2. **A keyboard transition still moving, and unspent** - `keyboardTransition.ts`. A transition starts
   once per keyboard open or close, and in the iOS shell once per height change while open (a change
   arriving while one moves belongs to it: one count, one log line). It comes to REST by a fact: in the
   iOS shell, `window.canariKeyboardAtRest` (`canari_ios.mm`, `CanariTellPageKeyboardAtRest`);
   everywhere else, in the same update that started it (the Android shell announces the final inset, a
   browser's viewport resize is the keyboard where it stands, and neither engine makes the move).
   Unspent: started after the reader's last input and after the last put-back.
3. **The reach unchanged** since the last placement or measurement.

**Why the rest comes after the reveal - the ordering, in the iOS shell.** The rest must reach the
page after the page measured the scroll WebKit's reveal caused, or the flag falls and the defect is
back. Three facts order it, none of them a delay:

1. **It rests on the facts WebKit acts on.** WebKit reveals the focused field from its own
   `_keyboardDidShow:`. So a show rests on `UIKeyboardDidShow` and a hide on `UIKeyboardDidHide`.
   `UIKeyboardDidChangeFrame` is posted BEFORE did-show, in the same run-loop turn, so it rests only
   a height change while the keyboard is open: `CanariApplyKeyboardLayout` sets
   `g_keyboardShowHidePending` for a rise or a fall, and did-show / did-hide clear it.
2. **WebKit's observer runs first.** `CanariObserveKeyboardRest` registers the three observers once,
   synchronously (`queue:nil`), from the first keyboard change - after the WKWebView exists, so after
   WebKit registered its own. The notification center delivers a post to its observers in
   registration order, so WebKit's `_keyboardDidShow:` has run, and started its reveal, when ours runs.
   That delivery order is what the build relies on and what the reading checks: a rest heard before
   the reveal shows as `the flag falls (keyboard transition #T at rest)` in the in-app log.
3. **The proof orders the page after both.** Ours asks for a screen-update proof (a snapshot
   `afterScreenUpdates`), which the web process answers only with a rendering update made after the
   reveal's scroll reached it. That update runs the scroll event and, in the same update, the
   animation frame that measures it. The page is told only once the proof returns, and only if no
   newer keyboard change superseded it. A superseded rest is silent, because that change rests on its
   own.

**Mobile Safari on the web is out of scope.** It runs the same WebKit, but nothing there says the
keyboard is at rest. A transition rests at once, in the viewport update that started it, so no move is
ever put back. Safari does not resize the layout viewport for the keyboard either, so the reveal there
scrolls the document, not the thread pane. The defect was read in the app, the fix lives in the shell,
and a browser keeps today's rule.

**Any other move up out of the slack lowers the flag, as it always did.** A VoiceOver or TalkBack
scroll, a swipe to the previous message, find-in-page, a reader's key: once the keyboard is at rest -
open or closed - no transition is moving, so an assistive or unexplained move is the reader's. Such a
fall logs at INFO since 2026-11-23 ([below](#the-keyboard-comes-back-with-the-app-2026-11-23)): it was
DEBUG as the expected path of every assistive scroll, and the exported log, which records no DEBUG,
was then silent on the one defect it would have named.

**Not done, and why:** spending the transition when a placement or measurement after it finds the
pane at its end. The observer's own pin after the resize is such a placement, and it comes BEFORE
WebKit's reveal (the 96 pt above): it would spend the transition the reveal needs.

**Termination by construction:** a put-back SPENDS its transition, so there is at most one per keyboard
transition; an engine that repeated its move would get one put-back and then lower the flag. The
`left the bottom with no finger on the pane` line stays, one per such move and never per frame, both at
INFO: ending `the engine's keyboard move, put back at the end (put-back N of this pane, keyboard
transition #T)`, or `not a keyboard move of the engine, the flag falls (keyboard transition #T moving
|at rest)`.

Tests: `threadGrowthObserver.test.ts` ("the engine keyboard move") replays the opening with the photos
growing before and after the resize; the control on the old rule ends 375 px short; a move with no
transition, or after one at rest, lowers the flag; a reader's touch still leaves; ten repeated engine
moves give one put-back; a change during a moving transition counts once.
`ChatArea.scrollAnchor.svelte.test.ts` drives the put-back through the mounted pane (the INFO line, the
scroll to the end, the arrow absent) and the assistive case with no transition and after one at rest
(the DEBUG line, the arrow shown). `iosKeyboardRiseHandoff.test.ts` holds the native relay: the did-show / did-hide
observers registered once the WebView exists, did-change-frame only with no show or hide pending, then
the screen-update proof, the silent superseded check and the page hook. Read on both phones on 1.8.0-alpha.2
([device-verification](../../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone)).

### The keyboard comes back with the app (2026-11-23)

**What the iPhone said** (`1.8.0-alpha.4`, iPhone 12, the DM of the sitting, keyboard up at its end,
Home, back 3 to 10 s later): 4 returns of 10 left the thread 65 to 87 pt above its end with the
"Scroll to bottom" arrow up. The web view was 390 x 543 pt (the keyboard-up size) in passing and
failing returns alike, and the exported log had no `left the bottom with no finger on the pane` line
and no `[CHAT_VIEW]` line at any return.

**Why, by reading.** iOS re-presents the keyboard when the app comes back, and WebKit reveals the
focused field from that presentation's `_keyboardDidShow:` exactly as it does for a rise: it scrolls the
thread pane. But the WebView comes back at the size it left with, so `keyboardViewport` reads no change
of the keyboard and **no keyboard transition starts**. `scrollMeasurementResponse` then finds a move up
with no reader input, the reach unchanged, and no transition moving - the assistive case - and the flag
falls: every later change answers `keep-row`, and nothing takes the thread back. That fall logged at
DEBUG, which the exported log does not record, hence the silence. The reveal moves the pane only when
the field is not already in view after the return's relayout, which is why it is 4 in 10 and not 10.
The shell's did-show at the return still reaches the page (`canariKeyboardAtRest`), but it finds
nothing moving to bring to rest.

**The fix: the keyboard's return is a transition, started and ended by the shell's facts.** The iOS
shell tells the page `window.canariKeyboardShows()` on `UIKeyboardWillShow` (`CanariTellPageKeyboardShows`,
registered with the rest observers once the WebView exists, sent at once with no proof so it reaches the
page before the did-show reveal's scroll), and the page starts a keyboard transition - or joins the one a
resize already started, as on every ordinary rise. UIKit pairs every will-show with a did-show or, when
the show is cancelled, a did-hide, and both already rest the transition (`canariKeyboardAtRest`): so the
transition starts on a fact and ends on one, and none is left moving. **A rest belongs to the transition it was
asked in**: a rest still waiting for its screen-update proof when a will-show arrives (with no frame
change, so `g_keyboardChangeSeq` does not move) is dropped, because the will-show bumps its own counter
(`g_keyboardShowSeq`) and the rest compares it after the proof - otherwise the older rest would end
the new transition before its reveal (review of #4023). The rise counter is left alone: a rise's own
proof reads it, and a will-show must not cancel that. The put-back rule is unchanged:
one put-back per transition, spent; a reader's touch before the reveal takes the move as theirs; no
clock anywhere.

**Refused in review (2026-11-23): starting it when the page is hidden with the keyboard open.** That
transition would end only on a did-show or did-hide the shell might never send for this return (the
field's first responder lost while away, a native modal, a did-hide delivered before the re-show), and a
transition left moving puts back a later VoiceOver or find-in-page move and swallows the next real
keyboard change, whose own move (#3984) would then not be put back. The will-show is the fact that the
did-show it pairs with will follow.

**Not done, and why: "only a user gesture lowers the flag".** It would put back every move with no
finger on the pane, and a VoiceOver three-finger scroll or a find-in-page jump has no finger either -
the reader could never leave the end with assistive technology. The flag stays durable intent that a
move lowers only when nothing explains it, and the return is now explained.

**The geometry at every edge** (`paneGeometryLine`, `[CHAT_VIEW]`, INFO, one line per edge, never per
frame): the page hidden or visible (read at once: a hidden page runs no frame), a keyboard transition
starting and coming to rest (each read in the frame after the edge, outside the keyboard's own update,
in the order the edges came, with the transition's state as it stood at its edge). Each carries `scrollTop`,
`scrollHeight`, `clientHeight`, `fromEnd`, `pinned` (measured), `isNearBottom` (the flag), the
keyboard and the transition number with `moving|at rest`. A failing return now names its cause: the
flag down is a move read as the reader's (with its `left the bottom` line at INFO); the flag up with
`pinned=false` is a pane the page did not put back; a reach that changed between two lines is the
thread's measure, not its place.

Tests: `keyboardViewport.appReturn.test.ts` (a will-show at the same size starts a transition the did-show
rests; a cancelled show rests on its did-hide; a rise is one transition; a will-show during a moving
transition joins it), `iosKeyboardRiseHandoff.test.ts` (the will-show observer, no proof before it),
`keyboardTransition.test.ts` (one edge per start and per rest, a throwing listener isolated),
`ChatArea.scrollAnchor.svelte.test.ts` (the reveal put back, the geometry lines read in their frame and
in order, the assistive fall at INFO), `threadAnchor.test.ts` (the line).

**Read and closed (`1.8.1-alpha.1`, iPhone 12, 2026-11-25): 10 of 10.** The same gesture - keyboard up
at the end of the DM, Home, 3 to 10 s away, relaunch - left the thread at its end every time, the arrow
never up; every transition logged `at rest` with `fromEnd 0 pinned=true`, and no return logged `left the
bottom` or `not a keyboard move of the engine, the flag falls`. In the syslog, `WebKit's own keyboard inset
detached ... (scroll view inset bottom 0.0)` once per launch and no `detached too late`; the owed-rest path
(`keyboard at rest before rise #N set its frame`) was exercised 13 times and the page's `at rest` followed
it. **The lesson the entry leaves:** a keyboard the system re-presents at a return is a transition like any
rise, and a transition is only ever ended by facts - the paired did-show or did-hide, and the frame landed
([the next section](#a-rest-is-two-facts-the-keyboard-at-rest-and-its-frame-landed-2026-11-24)).

**Read and closed again, with the two-fact rest (`1.8.1-alpha.2`, iPhone 12, 2026-11-25): 11 of 11.** The
`1.8.0-alpha.6` gesture that had passed 6 of 11 (keyboard up at the end of the DM, Home, 3 to 10 s
away, relaunch): the thread at its end every time and the arrow never up; every return's transition
`at rest` with `fromEnd 0 pinned=true`; no `not a keyboard move of the engine, the flag falls`, no `left
the bottom` (with WebKit's reveal detached the pane no longer moves at a return), no `a rest heard before
the keyboard's frame landed` WARN; the owed-rest path ran (`keyboard at rest before rise #N set its
frame`) and the page's rest followed the frame; every `keyboard settled` line read native offset and
inset bottom `0.0`, and the detach line `scroll view inset bottom 0.0` came once. **The lesson:** a rest
told from a notification is a guess about the screen when that notification can arrive before the frame
it describes - an un-animated keyboard's did-show precedes the WebView's resize - so a rest is the
CONJUNCTION of the keyboard at rest and its frame landed, each carried from the side that knows it, and
the second inset the engine would add on its own is removed rather than compensated.

### A rest is two facts: the keyboard at rest AND its frame landed (2026-11-24)

**What the iPhone said** (`1.8.0-alpha.6`, iPhone 12, the same gesture): #4023 passed 6 returns of 11.
Every failing return logged `not a keyboard move of the engine, the flag falls (keyboard transition #N at
rest)`, the transition at rest 36 to 45 ms before the move
([the sitting](../../device-verification.md#the-readings-of-2026-11-24-180-alpha6-iphone-12-the-dm-thread-again-the-composer-the-ios-27-sdk-build-the-broadcasters-column-the-voice-note-the-sign-out-row)).

**Why, from the syslog.** A keyboard that comes back with the app shows with no animation: UIKit's
did-show follows its will-show at once, while the shell's rise is still waiting for the page's layout
and its screen-update proof - before the WebView's frame is set. The rest went out from that did-show,
the frame landed after it, and the move came with or after the frame (return #26: rest .750, the rise's
proof .768, the move .795). On an ordinary rise the keyboard animates for ~400 ms and the frame lands
long before the did-show, which is why only returns failed, and only some.

**The fix: the iOS rest needs both facts, at both ends of the bridge.** The shell holds a rest heard
while a rise has not set its frame and tells it from the settle of that frame, after its proof
(`CanariTellPageKeyboardAtRest`, `CanariKeyboardLayoutSettled`; a newer will-show supersedes it). The
page rests a transition only once the shell has said so AND the hand-off target has been spent by the
resize (`noteKeyboardFrameAwaited` when `canariImeTarget` announces a height, `noteKeyboardFrameLanded`
when `measureViewport` spends or withdraws it): whichever comes first waits for the other, and a rest
the page has to hold is a WARN, since the shell now owes it after the frame. And WebKit's own keyboard
inset, which scrolled the document 301 pt on the failing return #31 before any frame was set, is
detached from the WebView, and WebKit's reveal with it, so the move the put-back exists for may simply
never come any more; the two-fact rest keeps whatever still moves the pane classified ([the doubled inset](../keyboard-and-send-motion.md#the-shell-is-the-one-authority-over-the-keyboards-room-2026-11-24)).
No clock: the rest is the conjunction of two facts, each carried from where it is known.

Tests: `keyboardTransition.test.ts` (a rest before the frame is held, a frame first leaves the rest to
the shell, a landing with nothing held rests nothing), `keyboardViewport.appReturn.test.ts` (the hand-off
through `canariImeTarget` and the resize, in both orders), `ChatArea.scrollAnchor.svelte.test.ts` (a move
after an early rest, frame still awaited, is put back), `iosKeyboardRiseHandoff.test.ts` (the owed rest
and its settle), `keyboardTransition.test.ts` again (a newer change drops a held rest). **Read and closed
on `1.8.1-alpha.2` (iPhone 12, 2026-11-25): 11 of 11** ([above](#the-keyboard-comes-back-with-the-app-2026-11-23)).

### A short thread sits at the bottom, and asks for its past at entry (2026-11-14)

The owner's Pixel 6a (`1.6.12`, 2026-11-14, the keyboard readings of that day, items 2 and 4): a
six-row DM drew its rows at the TOP of the pane, and closing the keyboard showed the older-history
spinner and jumped the thread twice. **Both came from the same fact: a pane its thread does not fill
cannot be scrolled.**

- **Where it sits.** The owner decided the Messenger/Messages layout: the rows sit against the
  composer. `app.css` gives the scroller's first child `margin-top: auto`, which takes the free space
  above a short thread and is zero once the thread overflows. `justify-content: flex-end` was refused:
  it overflows UPWARD, past `scrollTop` 0, so the top of a long thread could not be reached.
- **When it loads its past.** The older-history load is triggered by `measureScroll` near the top
  (`OLDER_TRIGGER_PX`). A pane that cannot scroll reached it only on the first stray scroll event,
  and the keyboard closing was one. That is the spinner, and the prepend under the motion is the jump.
  Once the entry has widened (both entry paths), the fill is armed. **It is driven by state, not by
  one pass** (review of #3545). An effect asks `loadOlderGroups` for one more page whenever something
  it reads moves, while the pane is still short and a source can still bring something. The things
  it reads:
  - a load ending, whether the reader's or its own;
  - a store page read (`storePagesRead`);
  - the pane gaining a height (its own `ResizeObserver`, `paneHeight`);
  - the window stepping;
  - the peer's answer returning `scrollbackState` to `idle`.

  **It ends because nothing moves any more, never on a count or a clock.** A pane with no height
  (display:none, a collapsed panel) is never paged, because everything measures "short" there.
  Two facts stop it for the rest of the entry, because no later change of state would undo them:
  - the store throws (logged at WARN with the error's class);
  - the store answers "more" without moving its cursor. Every stored row is shown, so a page that
    moved the cursor moved the rows.

  Without that stop, either one re-asked at once, forever. A peer's answer that lands after a
  conversation switch is dropped rather than written into the next conversation.
- **The entry fill is SILENT** (lead decision, review of #3545). Two things show only for a load the
  READER asked for by scrolling (`olderAskedBy`), never for one the fill asked:
  - the older-history spinner;
  - the scrollback banners ("loading", "no device can supply older messages").

  A reader who later reaches the top takes over whatever load is running, and its state shows from
  then on. A scroll event on a pane that cannot scroll is a box changing under the keyboard, so it no
  longer counts as the reader reaching the top.
- `ChatArea.entryWindow.svelte.test.ts` ("short thread fill") pins it:
  - an exhausted store is asked once with no scroll;
  - a growing store is asked until the pane overflows;
  - a store answering "more" without moving its cursor, or throwing, is asked once;
  - a pane that gains its height later is filled then;
  - a peer's answer after a switch is not written into the next conversation;
  - a pane with no height is never paged;
  - the fill's peer ask shows no banner;
  - an overflowing pane is never asked.

  Each fails on the code before it.
- **A reader at the bottom follows the keyboard during a store read.** While older messages are
  being prepended, the observer keeps the row at the top of the viewport (`keep-row`). The exception
  is a change of the pane's BOX height under a reader at the bottom: it moved the bottom, so that
  reader follows it (`threadGrowthResponse`, `boxChanged`). That holds even when the prepend lands
  in the same change, since a prepend above a reader at the bottom leaves them at the bottom.
- **The store's page keeps the reader's place by the row anchor alone.** `loadOlderGroups` used to
  capture `scrollTop` and `scrollHeight`, await the store, then write `prevTop + delta`. A keyboard
  rising during that await, with the thread taken to its end for it, was undone by the write: the
  reader landed a keyboard height up, on older messages - one candidate cause of the photo DM that
  "lands on older messages when the keyboard opens" (Pixel 6a, 2026-11-14), and a load this fill now
  starts at entry would have made it likelier. The growth observer's row anchor already kept the
  reader's place for the window step, which never had a restore; the store's page is left to it too
  (`threadGrowthObserver.test.ts`, "an older page prepended"; `ChatArea.entryWindow.svelte.test.ts`,
  "leaves scrollTop as the pane holds it", which fails on the old restore).
- **Owed: one reading on the Mi 9T, a short DM and the photo DM, keyboard open and closed.**

### A picture keeps its height when the keyboard opens (2026-11-13)

Reported by the owner on Android `1.6.11` (a DM ending on a tall screenshot): with the keyboard up
the picture showed LESS of itself, cut top and bottom, and the end of the thread looked out of reach.
**Not a scroll defect: the frame itself shrank.** A chat photo is a `MediaFrame` `fill` box,
`max-height: var(--media-max-height)`, its `<img>` `object-cover object-center`, and the ceiling was
`60svh` - chosen as "the stable unit" (`app.css`). It is stable in a phone browser, where the
keyboard shrinks only the visual viewport. **In the app it was not: Android padded the WebView by the
IME inset (`MainActivity.applyKeyboardInsets`, until #3556) and iOS shrinks its frame
(`CanariApplyKeyboardLayout`), so the LAYOUT viewport shrank and every viewport unit with it - `svh`,
`lvh`, `dvh` and `vh` alike.** `lvh` is therefore no answer. Since #3556 the Android app's keyboard
covers the WebView without resizing it, so `svh` holds there and `--keyboard-free-viewport-height` is
written for iOS only ([keyboard-and-send-motion](../keyboard-and-send-motion.md#6-android-since-2026-11-14---the-keyboard-covers-the-webview-and-the-page-rides-it)).

Measured on the Mi 9T (`1.6.11-alpha.5` release build on dev, over the WebView's DevTools socket,
a probe element sized in each unit):

| keyboard | `innerHeight` | `60svh` = `60lvh` = `60dvh` = `60vh` | a 1080x2340 screenshot in a 290 px frame |
| --- | --- | --- | --- |
| closed | 945 | 567.3 px | 567 px tall, 90% of the picture shown |
| LatinIME (357 px) | 588 | 352.7 px | 353 px tall, 56% shown, cropped top and bottom |
| ADB keyboard (90 px) | 855 | 513.5 px | - |

The 214 px is the same number the [2026-10-30 anchor fix](#a-reader-at-the-bottom-is-anchored-to-the-bottom-in-both-directions-2026-10-30)
measured as the photo's loss - that fix kept the reader at the bottom, but the picture still shrank.

**The fix:** no CSS unit names "the screen without the keyboard", and `keyboardViewport.svelte.ts` is
the one place that knows it (`baselineHeight`). `keyboardFreeViewportHeight` returns the baseline
while a keyboard is open AND the layout viewport gave it room, null otherwise; the store writes it as
`--keyboard-free-viewport-height` and removes it when null, and `app.css` reads
`--media-max-height: calc(var(--keyboard-free-viewport-height, 100svh) * 0.6)`. Absent, it is exactly
the old `60svh`, so a phone browser, a desktop resize and a rotation are unchanged. The resize event
that writes it runs in the same rendering step as the layout it corrects, so no frame draws the short
ceiling. Every `fill` medium reads that ceiling - a chat photo or video, a reel tile, a feed or comment
attachment (`mediaAspectStyle`); the event modal and `LetterboxedImage`'s documented ceiling now
read it too instead of a second `60svh`. A GIF (`--media-inline-max-height: 16rem`) never depended on
the viewport.

Proved on the phone by applying the new rule over CDP with the keyboard up: the screenshot frame
353 px without the held height, 567 px with it, 567 px both ways once closed. The unit test
(`keyboardViewport.test.ts`) replays the bench's LatinIME rise (945/945, 945/588, the 588/230.3 double
report, 588/587.9, back to 945) and holds the ceiling at 567 on every frame. **Limit:** below the
keyboard-open threshold (160 px on Android) no keyboard is "open", so a 90 px keyboard still takes
54 px off the ceiling.
**Read on the Mi 9T 2026-11-14 (`1.6.12`, dev, LatinIME):** `--keyboard-free-viewport-height` is set to 945 px with the keyboard up and unset when it is down, and a picture (256 CSS px high, not the tall screenshot) keeps its height both ways over two cycles with the end of the thread right above the composer. **A tall screenshot fixture (the 567 px case) was not sent, so the clamp itself is still owed.**

**The 90 px keyboard, per frame (Mi 9T, a one-row keyboard that takes 90 CSS px, 150 frames of a rise, 2026-11-14):** `innerHeight` goes 945 -> 855 in one frame, `visualViewport.height` reads 766 for that single frame (9 ms, the known double report) then 855.8, and the composer's ancestor padding goes 24 -> 12 px in the SAME frame as the resize, so no frame shows the composer 12 px low: the 24 ms of the old report was not reproduced and nothing was changed.

### The typing indicator is a row of the thread, not a band over it (2026-09-22)

It used to be a strip inside `ChatComposer`, above the input. It appeared and disappeared UNDER the
conversation, so the last message slid out of view and back every time somebody touched their
keyboard - the *"cacher involontairement des morceaux de l'interface"* above, in its purest form.
No padding could reach it, because the strip was inside the band whose height the padding reserves,
and the reservation was published only after the fact.

`ChatTypingBubble.svelte` renders it as an incoming row instead: the same 2rem avatar column, the
same `--bubble-in` fill and `--radius-bubble` corner as a received message, three bouncing dots.
Inside the scroller it grows the pane like any other row, so the follow observers raise the thread
for it and lower it again when it goes - no special case anywhere.

**ONE BUBBLE, HOWEVER MANY PEOPLE** (the user's question, *"A voir comment tu gères plusieurs
personnes ;)"*). A bubble per typer turns a lively group into a wall of dots. Who is typing is
carried by up to three stacked avatars, each ringed in `--chat-thread-ground` so they read as a
stack; past three the rest become a `+N` chip, because a fourth avatar is wider than the bubble.

**Two things outside this app depend on the class name `.chat-typing-indicator`**, which is why the
wrapper moved intact rather than being rebuilt: the cross-client rig's `state.mjs` tests it for
EXISTENCE, so it stays permanent with the `{#if}` inside it, and `archive/type.mjs` reads its
`innerText`, so the localized prose is still RENDERED - `sr-only` clips it, it does not remove it.
The permanent wrapper is also what makes the `role="status"` announce reliably: assistive technology
has to be observing a live region BEFORE the mutation that fills it.

**THE THREAD'S TRAILING SPACE IS ON THIS WRAPPER, because it is always the last row** (user,
2026-10-12: the bubble cut at the bottom, its avatar on the "+", with the keyboard closed). The
space above the composer used to be `ChatMessageGroups`' own `pb-4` - ABOVE the indicator - so the
last message stood 24 px clear of the composer and the bubble, once it showed, 0 px: its bottom edge
on the composer's top, which in the phone apps is transparent glass with the "+" 8 px below. The
`pb-4` is now on `.chat-typing-indicator`. Measured on the real `ChatArea`, 390x844, glass chrome
and the website's layout: last message 24 px clear while nobody types (unchanged), bubble 16 px clear (was 0),
scroller at its bottom (0 px) in both. On the Mi 9T (read-only, CDP) the same geometry held before
the fix: composer 76 px, scroller `padding-bottom` 76 px, the empty indicator 1 px under the
composer's top - the padding was never wrong, the space was on the wrong row.

**What was NOT reproduced:** a FOLLOW failure. Six sequences on the real component (typing alone, a
message then typing at +50 ms, typing then a message at +80 ms, message + stop + typing, typing
during a conversation's entry, a switch with typing in flight) all ended at the bottom, as did a
smooth scroll interrupted by the bubble. If a phone still shows the bubble UNDER the composer
rather than flush on it, it is a different defect, owed a reading with the keyboard closed.

**IT WAS A DIFFERENT DEFECT: THE RESERVATION MISSED THE FOOTER'S PADDING** (user, 2026-10-13, phone
app: the dots half under the composer, keyboard closed). `--chat-composer-height` is the footer's
`offsetHeight`, padding included, and the footer pads `max(0.75rem, var(--safe-area-inset-bottom))`.
Its `ResizeObserver` watched the default CONTENT box, which a padding change does not touch - so when
the bottom inset changed after the composer mounted (Android's navigation-bar inset reaching the
WebView, the keyboard's open/close), the footer grew and nothing republished. Measured on the real
`ChatArea` at 390x844, glass chrome: a 24 px inset arriving late left the footer at 76 px against a
published 64 (bubble 4.5 px clear), a 48 px inset (three-button navigation) at 100 against 64 - the
bubble 19.5 px UNDER the composer. `publishComposerHeight` (`utils/chat/composerHeight.ts`) observes
`border-box`, the box it publishes: 16.5 px clear at 0, 24 and 48 px, long and short thread, keyboard
simulated open (390x500) and closed. #1780's measurement held because its inset never changed under
it. **Not run:** a real Android inset change and iOS WebKit (the home indicator's inset is pinned to 0
while the keyboard is open, `keyboardViewport.svelte.ts`, which this now follows too). **And the
publish waits for the next frame:** written inside the `ResizeObserver` callback, the value resized
the SHALLOWER scroller, which the engine cannot notify in the same pass, so every composer growth (a
wrapped line as well, since long before this change) raised "ResizeObserver loop completed with
undelivered notifications" and delivered the scroller's notification a frame later anyway. The
callback now only schedules one `requestAnimationFrame`, cancelled at teardown; the scroller resizes
in an ordinary layout and is notified in its own frame - the same frame the follow already landed in.

### The day label and its floating pill (2026-10-01)

Reported by the user: scrolling a conversation, the floating "Mercredi 23 septembre" was not
centred. Three defects behind one report, each fixed at its one place.

**The label is the shortest honest name of the day** - `formatDayLabel` in `utils/dates.ts`, the
only implementation, called by `groupMessages` (`utils/messageGrouping.ts`) for every
`date_separator`. "Aujourd'hui" / "Hier" (`m.chat_day_today` / `m.chat_day_yesterday`), then the
weekday alone up to six calendar days back ("Mercredi"), then day and month ("23 septembre"), and the
year only when it is not the current one. `Intl` in the Paraglide locale, so English reads "Monday",
"September 23", "May 5, 2025". A day in the future (a skewed clock) never gets a bare weekday. The
floating pill reads its text off the separator's `data-chat-date-separator`, so the two cannot
disagree. Days are counted by `calendarDay`, shared with the media viewer's title. `groupMessages`
names the days of a pass through ONE `dayLabeler` (one clock, one `Intl.DateTimeFormat` per label
shape), and `calendarDay` answers the browser's own zone from the `Date` getters: the regrouping
runs over the whole conversation on every change of it, and three `Intl` builds per day separator
were most of its cost ([community-open-budget](../community-open-budget.md#per-bubble-and-per-day-work-cut-2026-11-08)).

**The pill is the last row of `.chat-thread-banners`, not a box positioned over the panel.** It was
`absolute; left: 50%; translateX(-50%)`: shrink-to-fit could only use the half of the panel right of
centre, so a long day (or a 200 % system font) wrapped onto two LEFT-aligned lines - the off-centre
pill. And at its own `top` it slid under the catch-up banner (z-40 over its 35). In the column it is
centred by `align-self`, capped at the thread width minus a gutter, stacks under any banner, and starts
under the header in both the floating (phone) and the in-flow (website) chrome because the column
already does. `--z-page-sticky` had no other user and is gone.

**It is shown only when the separator it names is out of sight** (`floatingDateIndex`,
`utils/chat/stickyDate.ts`). Measured from the scroller's box, the pill named the previous day over a
separator that had just come into view under the floating header, and drew the same day twice, one
pill over the other. It now measures from the top of the VISIBLE thread (the banner column's top),
treats a separator behind the catch-up banner as hidden, and stays hidden while the one it would
name is still on screen. Where it does float over a bubble or a sender name it is GLASS (`.glass-chrome`'s blur and
tokens, 2026-10-09): the first answer, an opaque chip with a page-colour halo, was read on the iPhone
as a sender name cut to "Canari Test De" and then the chip. The pill floats over moving content by
design, so layout cannot avoid the overlap - the surface blurs what passes under it instead. The
gate (`stickyDatePillGlass.test.ts`) reads the rule, since no rendering test sees a backdrop. **The
after-state is owed one look on the iPhone**; the pill is visible only while scrolling and 1.4 s after.

Audited at 390 and 1280 (a preview of the thread's real structure, headless Chrome): nothing else
draws text over text while scrolling - the scroll-to-bottom button and the send-error alert sit at
`bottom: 10rem`, the composer reserves its own height, reactions are in flow under their bubble, and
there is no unread divider in the list to collide with.

### A jump to a message scrolls the LIST, never the page (2026-10-05)

Reported by the user (web desktop): opening the pinned-messages banner and clicking the pinned
message made the salon header disappear. `navigateToMessage` called `scrollIntoView`, which scrolls
EVERY scrollable ancestor, so the page wrapper moved too and the chat column slid up. All jumps -
pinned banner, poll banner, reply quote, search result, notification deep link - end in that one
function, which now calls `scrollMessageIntoList` (`utils/chat/scrollToMessage.ts`): the offset is
computed against the list container and applied with `container.scrollTo`, so nothing else can move.
Not driven in a browser by the agent that wrote it; owed a look at 390 and 1280 px.

### The jump is instant, because a smooth one was cancelled by the tap that asked for it (2026-10-12)

Reported by the user (phone app, salon): tapping the poll in the "1 sondage actif" shortcut did not
scroll to it. The shortcut already called `navigateToMessageEnsureLoaded`, like the pinned banner -
and **the pinned banner failed the same way** in the phone apps; only the website worked. Measured in
a scratch preview at 390 px with the glass chrome on, by trapping every `scrollTop` write: the jump's
`scrollTo({ behavior: 'smooth' })` started, then seven writes from `threadGrowthObserver`'s
`ResizeObserver` followed within 120 ms, each `scrollTop += shift`, and the pane ended at its bottom.

The chain: closing the dropdown (`showPolls = false`, `showPinned = false`) shrinks the chrome over its
150 ms `slide`; in the phone apps the chrome FLOATS and its height is the list's `padding-top`
(`--chat-header-height`), so every row's `offsetTop` moves; the observer reads that as a change above
its anchor row and compensates with a plain `scrollTop` write - and **any plain write aborts a smooth
scroll in flight**. The anchor was still the row from before the jump, so the compensation was
computed from the bottom of the thread and put the reader back there. On the website the chrome is
in the flow, the list's BOX shrinks instead of its padding, no row moves, nothing is written, and the
smooth jump survived - which is why only the phone saw it.

**The fix is in `scrollMessageIntoList`: the jump is `behavior: 'auto'`.** An instant jump has
nothing in flight to abort, and the compensations that follow then do exactly their job (the padding
moved every row by the same amount, so they keep the target where it landed). Measured after: the
target lands at the same place with and without the glass chrome, poll and pinned alike, and carries
`chat-message-jump-highlight`. Delaying the jump until the chrome settles was refused: it waits on an
animation, and any other growth during a smooth scroll (a medium settling, the typing bubble) would
abort it the same way. `scrollToMessage.test.ts` pins the default.

**One thing seen and not changed:** the observer's anchor is captured only when it fires, never on
a user scroll, so after a long scroll it is a row far from the viewport. A size change BETWEEN that
row and the reader would move the reader. Recapturing on `scroll` would race the observer's own
`ResizeObserver` delivery (a scroll event can land after a mutation and before the callback, erasing
the shift), so it wants a bench of its own, not a line in this fix.

## Routes

| Route | Description |
|---|---|
| `/chat` | Main chat page (conversation list + active chat) |
| `/communities` | Same page in community mode (channels) |
| `/c/join/[token]` | Accept a community invite link, then land in the joined channel |

There is **no per-conversation URL**. `/chat/[groupId]`, `/c/[groupId]` and `/g/[groupId]` were
documented for a while and never existed as routes; opening one renders an empty shell. A
conversation is opened by publishing its id to `notifNav` (see the deep-link section above), which
is why a notification tap works from any route while a hand-written URL does not.

### The unread count follows my own read point (2026-10-05)

**Reported with a screenshot:** the tab read `(2) Discussions - Canari` and the red dot stayed with
nothing left to read. The title, the favicon dot and the nav badges all sum `unreadCount` over
`globalConvs` (`utils/unreadTotal.ts`), and `unreadCount` is a counter kept BESIDE the read
watermark, not derived from it. Single-tab DMs were fine (`selectConversation` zeroes it); the
count stuck wherever the watermark moved without a caller remembering the counter:

- **a salon read on another device** - `channel.read` carrying MY mark merged the watermark and
  stopped, so tile, dot and title kept the count until the salon was opened here too (the DM twin
  `read_watermark` did zero it, unconditionally);
- **a conversation open in a FOLLOWER tab** - the follower took the leader's `unreadCount`
  verbatim from `message_added`, and its own read (the debounced watermark effect in
  `MainChatPage`) set the watermark only, never the count, and told no other tab (`conversation_read`
  was published on selection alone). Leader and follower both kept `(N)` for good.

**The fix is one function, `withOwnReadAdvanced` (`readState.ts`)**: the watermark rises and the
count becomes `min(count, still-unread-at-the-new-watermark among held messages)`. It replaces the
unconditional zero in the DM self-read (a message NEWER than the read stays counted), runs for the
salon self-mark (`ChannelEventContext` now carries `userId`), runs in the optimistic mark of the
open conversation, which now also publishes `conversation_read` to the other tabs, and a follower
reading a leader's arrival for the conversation it has open counts it 0, the live path's
`isConversationOpen` rule. Tests: `readState.test.ts`, `channelEventHandler.read.test.ts`,
`systemMessageHandler.readState.test.ts` (two fail on the old code).

**Not changed, owed a reading:** OS notification banners on the other devices are cleared by the
push-side receipt (`markChannelRead` for salons, the native `read_watermark` for DMs); nothing here
touches them. The stuck count was reproduced as failing tests, not on two live devices.

### Read state between devices - the census (2026-11-02)

**Reported by the owner:** a conversation read on one device still showed as unread on another,
possibly until that page reloaded, and receipts did not always seem to reach the other devices.
Every path "read" travels by was mapped and each was given a test in
`utils/chat/readSync.devices.test.ts`: three conversation stores driven through the REAL handlers
(`handleSystemEvent`, `handleChannelEvent`, the tab channel), `A` and `B` two devices of one
account, `P` the other party, `B2` a second tab of `B`'s browser. No clock is read; the server's
time of a frame is the `queuedCreatedAt` the test hands in. Vitest, not the rig: the local estate
was not up, and every one of these paths is decided in the client.

| Path | Platform | Before | Why |
| --- | --- | --- | --- |
| DM/group read on A -> B, live (`read_watermark`, `withOwnReadAdvanced`) | all | works | the frame reaches every leaf, own devices included; the count follows the mark |
| same, B offline then catching up (pending pull, frames in order) | all | works | a message newer than the read stays counted |
| A's read -> P's "Vu" (`withReadMark`, `readersOf`) | all | works | |
| salon read on A -> B, live (`channel.read`, audience includes the reader) | all | works | count falls whether or not B holds the rows |
| salon, B reconnects (`unread-counts`) | all | works, **except the salon B has selected** | see below |
| shade "Marquer comme lu" -> the phone's own badge (`read_watermarks.ndjson`) | Android | works | merged at login AND at resume |
| **Android resumed on an open conversation** | Android | **FAILED** | the receipt effect read `isAppInForeground()`, a plain global; it returned while the app was in the background and nothing ran it again on the way back. What landed in the background stayed unread on the phone, and the mark never left, so on every other device too, until something else changed the conversation (a send, a new message, a reload) |
| iOS resumed on an open conversation | iOS | works | WKWebView fires `visibilitychange`, which the effect follows |
| **a frame arriving in the seconds before iOS suspends the app** | iOS | **FAILED** | `isAppInForeground()` was always `true` on iOS, so the arrival counted as read - fixed by the iOS follow-up ([below](#read-state-between-devices---the-census-2026-11-02)) |
| **a read made inside the 2 s window before leaving the app** | iOS | **FAILED** (late, never lost) | the delivery was handed to the outbox and nothing held the process; it left at the next open - fixed by the iOS follow-up |
| **resumed from a notification for Y with X left open** | Android (and iOS) | **FAILED** | the foreground edge re-ran the receipt effect on X before the tap's link selected Y, so X was marked read - a conversation nobody looked at. Owner, 2026-11-02: X must not be marked, the same on both platforms (below) |
| web tab hidden, then shown / window refocused | web | works | `isTabVisible` / `isWindowFocused` are state |
| **any read (own other device, or the peer's receipt) -> a FOLLOWER tab** | web, desktop | **FAILED** | a follower opens no socket; the leader relayed messages and counts but no read state, so the follower kept its badge and drew no "Vu" until reloaded |
| **salon counts re-read by the leader (reconnect, a community cleared elsewhere) -> a follower tab** | web, desktop | **FAILED** | same: only the leader asks, and it relayed nothing |
| **a read in one tab -> the other tab's thread** (`conversation_read`) | web, desktop | **FAILED (half)** | the badge fell, the watermark did not, so the list said read and the open thread's divider and scroll button still said unread |
| **salon left selected but not read (another page, hidden tab, app in background), read on another device while this one was offline** | all | **FAILED** | `reconcileSalonUnread` skips the selected salon because the receipt effect owns its count - but it owns it only while the salon is READ. "Selected is not a screen" ([below](#a-selection-is-not-a-screen-2026-10-10)): the server's 0 was thrown away and the badge stayed until the reader came back to the salon |

**The list badge and the open thread** read two things: `unreadCount` (list, nav dot, title,
favicon) and the reader's own watermark (the thread's divider and scroll-button count). Every path
above moves both together through `withOwnReadAdvanced`; the half-failure
was the one that moved only the first.

**What changed.** Each missing event, named and added - no polling, no reload on focus:

- `appForegroundState.svelte.ts`: the Android foreground as STATE, following the
  `canari:foreground` event the activity already dispatches; the receipt effect reads it, so the
  transition itself re-runs the effect. Same guard, same door: nothing is marked that is not on
  screen ([read-receipt-privacy](../../read-receipt-privacy.md), door 1, unchanged).
- `read_state` on the tab channel (leader-gated): the leader publishes ONE moved mark
  `{userId, at, clock}` whenever a RECEIVED event moved it (`read_watermark`, `channel.read`, each
  entry a bundle restated); a follower merges it by `max`, and recounts its badge only when the mark
  is its own (`withOwnReadAdvanced`) - a peer's moves the receipt and nothing else.
- `unread_counts` on the tab channel (leader-gated): the salon counts a server answer moved, each
  with the leader's OWN mark of that salon when it applied it. A follower skips the salon it is
  reading and any whose own mark is newer than the leader's - it read that salon after the answer
  was counted. Values that are not counts are refused and said.
- `conversation_read` carries the reading tab's `mark`; the receiver advances its own watermark with
  it. A selection still carries none and only zeroes the badge, as before. **For a salon it also
  stamps the receiver's counts** (`noteSalonOpened`, `noteSalonMarkFromAnotherTab`): a counts request
  the receiver had on the wire was counted before that read, so its answer neither applies to that
  salon nor is joined by a later caller - otherwise a leader re-raised a salon a follower had just
  read and relayed the stale count back (review of #2937; the re-raise is older than the relay).
- Every conversation event of the tab channel is STAMPED with the publishing tab's account and the
  receiver drops a mismatch first (`tabEventIsAddressedHere`): the channel and the leader lock are
  per browser, and a `conversation_read` from a tab of another account would otherwise advance this
  account's watermark. The lock stays global: an origin holds ONE refresh credential, so two accounts
  never hold live sessions side by side ([sessions](../../sessions.md#a-token-that-names-another-account-than-the-local-identity-is-refused-2026-10-10)),
  and the stamp covers the moments between a second sign-in and the first tab learning of it. An
  UNSTAMPED event (`account` absent: a tab still on the bundle from before the stamp) is ACCEPTED -
  dropping it cut a mixed-version browser's tabs off from each other; the window it leaves (an old tab
  of another account) closes with that tab's next load. An empty stamp (a signed-out tab) is dropped.
- `conversationBeingRead` (`arrivalRuntime.ts`): both callers of the server count hand it the salon
  being READ, never the bare selection.
- **A resume that opens something does not read what was left open** (`resumeOpening.svelte.ts`,
  owner 2026-11-02). The shell knows, when it announces the foreground, that the resume is a
  notification tap, so it sends the link WITH the edge (`canari:foreground`, `detail.opening`):
  Android takes it in `onNewIntent`, which always precedes `onResume`. The page records, in that same
  dispatch and before any effect re-runs, that the conversation on screen (X) is held. ONE wiring,
  `createResumeReadGate`, is what `MainChatPage`'s receipt effect asks and what the tests drive;
  `isReadingConversationNow` asks the same hold. A tap for X itself holds nothing; a plain resume
  still marks X. The hold ends on an event, never a clock:
  - the selection moves (the landing selected Y, or the reader chose - a `pre` effect, so the receipt
    effect runs once);
  - Y's landing ENDS, read from `notifNav`: released, or abandoned (`clear()`), whether it was
    published before the edge or after - the baseline is the landing count at the LEAVE when it was
    published before (review of #2937, F1: taken at the edge, an abandon left the count equal and X
    held for good). A landing for ANOTHER conversation replacing Y's keeps X held - a `chat` hold
    uses the `landing` hold's rule, held while a landing not for X is pending;
  - a page link navigated (`noteOpenNavigated`, from `afterNavigate`);
  - the open was routed NOWHERE (`noteOpenRoutedNowhere`): the router's every non-routing branch
    (`mobile/appLinkRouter.ts`: an unclaimed `open?url=`, a link not ours, a callback with no code,
    a checkout return to no known page, and every failure that leaves nothing shown - a chat
    landing that could not be published, a `goto` that failed with no document-load fallback, a
    claimed link whose in-app navigation failed, reported by `openClaimedAppLink`; the `catch`es that
    fall back to a document load navigate, so they report nothing), a native tap record that is not
    a link, a page notification's tap with no identity or not posted by this session;
  - the app left again, or a resume carried no link.

  On iOS a page-notification resume waits for its landing ONLY while this page's tap listener is
  REGISTERED (`notePageTapsRoutable`, set by `armPageTapListener` when the plugin's `onAction`
  registration RESOLVED - a positive signal). No `onAction`, a throw, a rejection, or simply no
  notification posted since the page loaded (a WebView reload, then a tap on a notification posted
  before it) leave it unset: that resume holds nothing and warns `page notification tap lost`.

  **The router's outcomes, before or after the edge.** The link reaches the router (and its landing,
  navigation or "nowhere") through its own channel, before OR after the edge, so each of those
  outcomes is a SEQUENCE, snapshotted when the app LEAVES the screen (a module-level listener,
  whatever page is mounted): at the edge an outcome counted since the leave is this open's, one
  counted after ends the hold. A `false` while already away is not a leave (review F4): a repeated
  signal would re-snapshot past an outcome the coming resume must count. The selection moving and
  the app leaving are not router outcomes: they end the hold only after the edge.
  **Keys, not ids:** a link and `notifNav.pending` carry a GROUP id, the selection a MAP key, and the
  two differ for every DM and group; every comparison resolves through `resolveConversationKey`, as
  the landing does (review of #2937 - compared raw, a tap on a DM's own notification held it for
  good). **A reload drops the hold, and nothing it covered survives:** the selection lives in memory
  only, and the one selection carried across a load (`canari_pending_contact`) is written only by an
  explicit "open this conversation", never by a resume.

  **A tap on a notification the PAGE raised** follows the same rule: on Android the page's message
  notifications are built natively (`notifyMessageFromWebSocket`) and tap as an ordinary chat link,
  so `onNewIntent` carries them; on iOS they are the notification plugin's, which carry no link, so
  the shell sends the marker `PAGE_NOTIFICATION_OPENING` and the hold waits for the landing the page's
  tap handler (`routePageNotificationTap`) publishes, or for it to say the tap routes nowhere. A cold
  start needs nothing: no conversation is open, so nothing is held, and only Y is read. The chat link
  is parsed in ONE place (`mobile/chatLinkTarget.ts`), which the deep-link router uses too. Tests:
  `resumeOpening.svelte.test.ts` - keys that are not group ids, each router outcome (landing
  published, landing abandoned, navigated, nowhere) before and after the edge, a repeated leave
  signal, Y already selected before the edge, a DM's own notification, a non-navigating link driven
  through the REAL `processAppLinks` and `listenForNativeNotificationTaps`, the page notification's
  tap, a cold start, the arrival rule, another conversation's landing replacing Y's, a claimed link
  whose navigation fails, a checkout return to no known page;
  `resumeOpening.pageTapListener.svelte.test.ts` - every registration outcome of
  `armPageTapListener`, each test on fresh modules (a page load), so each passes alone.

**The cost.** One tab event per mark that MOVED (never per message, never the whole map), one per
server answer that moved a count (one entry per moved salon). Neither grows with a conversation's
length or the list's; a group of N members costs one event per member who reads.

The router is ONE function (`routeTabReadEvent`, `tabReadRelay.ts`) that `ChatBackgroundService`
calls once, after the account gate: a leader applies `conversation_read` and ignores the two events
only a leader sends. Tests: `readSync.devices.test.ts` (both review cases mutation-checked),
`arrivalRuntime.beingRead.test.ts` (both halves, in a document), `tabReadRelay.wiring.test.ts`.

**iOS, fixed in the follow-up PR (which depends on #2937).** Two iOS paths were left after the census, and the rule is fix, never defer:

- **The foreground is published, not assumed.** `canari_ios.mm` used to observe only the ACTIVE pair
  (`didBecomeActive` / `willResignActive`) for its own `g_isInForeground` and published nothing to
  the page. That meant `isAppInForeground()` was always `true` on iOS, so `arrivalContextNow` counted a frame
  the JS processed in the seconds before suspension as read on arrival. The shell now writes
  `window.__canariForeground` and dispatches `canari:foreground` on the **background/foreground
  pair** and after every page load (`CanariPublishForeground`): leaving at `didEnterBackground`;
  coming back when the resume COMPLETES - the resume begins at `willEnterForeground`
  (`g_resumePending`) and is published one notification-center round trip AFTER the `didBecomeActive`
  that ends it (`getNotificationSettingsWithCompletionHandler`, answered on the main queue). A
  tapped notification is noted (`CanariNoteResumeOpening`, called before the tap is queued for the
  page) whenever it runs while that resume is pending, so the edge carries the link it opens
  (`detail.opening`), as Android's does - and the shared hold of
  [the resume that opens something](#read-state-between-devices---the-census-2026-11-02) applies
  unchanged. **Either order:** UIKit does not promise whether the delegate runs before or after
  `didBecomeActive` (review of #2939); a response that caused the activation comes either with the
  activation itself or on the notification center's own connection, and that the connection hands
  the response to the main queue before the round trip's answer is LIKELY BUT UNPROVEN - Apple
  documents no such ordering (re-review F3). It is an ordering argument, never a delay, and it is
  read on hardware by check LA steps 5 and 8: the shell logs `didBecomeActive: awaiting the
  notification-center round trip` and `round trip answered: publishing the foreground edge`, and the
  ONE rule read there is that the tap's line comes BEFORE `round trip answered` (whatever its `state`
  or `resumePending`, and before or after `awaiting`); a failure blocks the stable. A `didBecomeActive` with no resume pending (Control Centre, a Face ID sheet) publishes
  nothing and drops a link a cold launch left; a tap on an app active with no resume pending (a
  banner over the open app) is not a resume (step 10). This is the same contract as Android's `MainActivity.pushForeground`, asserted for
  both shells by `utils/appForeground.contract.test.ts`. The ACTIVE pair was deliberately not chosen: Control
  Centre, a Face ID sheet and the notification shade resign ACTIVE without leaving the screen, and
  a read on screen must not stop counting because a system sheet passed over it. The page now hears
  two signals for one transition (`visibilitychange` and `canari:foreground`), so `onAppScreenChange`
  reports one edge per transition (it remembers the last state it reported). The listeners were
  checked for idempotence anyway, in case one is ever wired to the raw events: the read-mark flush
  (`take()` empties), connectivity (`probeOwedOnScreen`), the playback arbiter, and the call service
  (`cameraHeadedOn()`, `videoPausedByBackground`).
- **A read made in the 2 s window before leaving reaches the other devices now, not at the next
  open.** The off-screen handler of `MainChatPage` runs its delivery (the debounced mark, the owed
  salon and DM marks, the outbox flush) under `holdWhileLeaving` (`utils/backgroundFlush.ts`), which
  asks the shell for a `canari-leave-flush` background task BEFORE the work
  (`begin_background_flush`) and ends it when the work SETTLES, whichever way it ends
  (`end_background_flush`, `commands/background_flush.rs`, `canari_push.mm`). There is no timer: the only other
  end is iOS's own expiration, and the shell logs that as an ERROR. The mark is then still owed
  (durable) and leaves with the next one. Off iOS the work runs as it did.
- **The next step, gated on a reading.** The hold keeps the PROCESS alive, but whether iOS keeps
  WKWebView's WebContent process running under it has not been read on hardware. If the iPhone
  reading (check LF in [device-verification](../../device-verification.md#lf-a-read-reaches-the-other-devices-when-the-iphone-leaves-the-app---owed-on-the-iphone-12))
  shows the hold beginning and expiring with no settle, the delivery moves native: the
  shell drains the durable owed marks itself, under the same task, the way the quick reply sends
  without the page. That variant is designed and not built, because only that reading tells us whether it is needed.

### A DM's unread count is derived from its read point at every load (2026-11-11)

**Reported by the owner (Android `1.6.9`):** a DM whose last message was never opened showed no
badge in the list, and the peer still saw "Envoyé" - no read mark had left.

**Cause.** `unreadCount` is not persisted (`ConversationMeta` carries the read marks, not the
count), so every row starts at 0 at a cold start. The load (`loadExistingConversations`) then set the
count to the unread messages its archive replay ADDED - `!preReplayMsgIds.has(m.id)`, a proxy from
May 2026 that predates the watermark (2026-08-12), when "arrived now" was the only signal there was.
A message was therefore counted only in the session that STORED it: on Android a resume stored the
push cache (`consumeFcmCache`) and counted it (+1 in `fcmMemoryMerge.ts`), the process died, and the
next cold start found the message already held and counted 0. A load with no link was worse: it
`continue`d before the recount and left every badge at 0. Salons had the same gap and were fixed by
the server's count ([above](#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08));
DMs and groups (the same loop - only salons skip it) never were.

**The rule: the count is derived from durable state, never from what arrived this session.** A load
assigns each row `derivedUnreadCount` (`readState.ts`): the held messages `isUnreadForUser` calls
unread at the `countingReadPoint`. It is PUBLISHED AS SOON AS THE STORED PAGE IS READ
(`publishBootCount`), online or not, BEFORE the replay - on a slow link the replay takes seconds and
the badge of what the device holds must not wait for it (weak-network chantier) - then again after the
replay, and after a failed one, from what is held. Rows are only ever added, so after the first
publish the count rises for what the replay brought and **only a mark lowers it** (tested: a mark the
replay brings takes 1 to 0). A row that left the map before its count is said at debug. **A row that
is not `active` derives 0**: a removed or pending conversation takes no read
mark (the receipt effect refuses it, and a selection zeroes the count in memory only), so nothing
could ever clear a badge given to it.

The live writers ask the same point, so the `+1` they add is what the next load re-derives:
`mergeFcmMessagesIntoConversations` (which used to add 1 for any foreign row, even one the shade had
already marked read), both add paths of `useMessaging`, the `history_bundle` recount, and
`withOwnReadAdvanced`, and so do the readers: the shade's hand-off (`applyNativeReadWatermarks`,
`readWatermarkCache.ts`), the "already read here" question before a banner, and the scroll-down
pill. **Salons included**: the live add path and the salon self-mark ask
`countingReadPoint` too, so a salon with no mark of this reader's does not count, on this device, a
row older than the reader's own newest post; the server's count (`unread-counts`, merged at a
reconnect) still does. Pinned by `readState.test.ts`, "PINS THE SALON BEHAVIOUR".

**The read point - ONE clock, the server's, for all it adds to the saved marks.**

| What applies | Server point | Why |
| --- | --- | --- |
| a saved mark (either map) | the saved marks, max the seed | the marks are what says "read"; the seed keeps covering what the row held at the upgrade, so a mark BELOW it (another device's, an old "Marquer comme lu" from the shade) never un-hides it - `applyNativeReadWatermarks` ASSIGNS the count, and a lower point there RAISED a badge on a read (tested) |
| the upgrade's local seed (`localReadSeed`) | the seed | see below |
| no saved mark, an own message the server dated | its SERVER time, max the seed | a reply is written with the thread open, so what the server holds before it was on screen. The server's clock, never the author's: a phone an hour fast hid the peer's later answer, one an hour slow counted an earlier message (both cases tested). An own row not yet dated (queued) implies nothing |
| none of them | 0 - every foreign message counts | a conversation new on this install, never opened, never answered: a first contact, which IS unread |

**The upgrade's local seed - no flood on upgrade (owner), written INSIDE the store migration.**
Older builds counted only what a session received, so a group read but never marked, a first contact
ignored, anything last read before the marks existed (2026-08-12) has no read point, and deriving its
count would light up to a page of "unread" on every such row the day this build lands. So each
conversation gets a LOCAL point: **the newest server time among ITS OWN stored messages, written by
the store migration that adds the field** - SQLite v20 (`CONVERSATION_LOCAL_READ_SEED_FILL`, one
`UPDATE` before the version is stamped), IndexedDB 14 (`seedLocalReadPointsInUpgrade`, in the
`versionchange` transaction). The restore only READS it.

- **Why in the migration, and not in the app (two versions of this fix were refuted on that).** The
  first seeded in the restore's second phase, after the boot pull had stored what arrived while the
  app was killed, and swallowed it; the second moved the seeding before the pull, which is an
  app-level order, and every other writer (the push cache at a resume, a login) is one more order to
  prove. A migration needs no proof: SQLite's `init` resolves only after it, and nothing writes
  through a store whose `init` has not resolved; an IndexedDB `versionchange` transaction is
  exclusive - an older tab gets `versionchange` and closes (`onVersionChange`), an open blocked by
  one is rejected and logged, and any other connection's write waits for the upgrade to commit
  (`localReadSeedStore.test.ts` queues one during the upgrade). **What is held at the migration is
  "before the upgrade" by construction; everything stored after counts.**
- **Per row, never a global boundary**: one row's newest time cannot cover another row's older
  message (tested on both backends).
- **The server time, read in the clear.** `serverTimestamp` is inside the encrypted payload; the
  migration cannot decrypt (it has no device key). It reads the ORDER KEY instead, which is plain:
  `order_at` / `orderAt` is `messageTime`, the server's time when the row knows it, the author's
  `sentAt` otherwise. A row whose order key equals its `timestamp` is undated (or still provisional,
  `order_pending` / `orderPending`) and is skipped - one phone running fast would otherwise push the
  seed past messages not received yet. A row with nothing dated (or nothing at all) is seeded **0**:
  it covers nothing, and what is replayed into it afterwards counts.
- **Idempotent**: the SQLite fill writes only rows still NULL, the IndexedDB walk only rows holding no
  number, so a migration run twice (a crash before the version stamp) changes nothing it wrote
  (tested on both).
- **Limits, accepted.** A message the server held before the upgrade, older than the newest one this
  device held in the same conversation, but not yet delivered to it, is covered - the device's queue
  delivers in the server's order, so this needs an out-of-order delivery. An IndexedDB store below
  version 12 holds only provisional keys and is seeded 0 everywhere (nothing dated to read). A
  message stored before the upgrade, past a row's saved mark but before its seed, is covered: the
  seed applies with a mark too (above), and the upgrade does not flood marked rows either.
- **A backup exported before the column** restores rows with no seed (NULL covers nothing), so a row
  with no saved mark lights up to one page (60) of what it holds.
- **A downgrade, then a re-upgrade**, is the same case: an older build's `INSERT OR REPLACE` writes
  the row without the column, which NULLs it, and the fill never runs again once `user_version` is
  20.
- **A web rollback after this ships** fails `indexedDB.open(name, 13)` with a `VersionError`, said as
  `StorageOpenError`. No data is lost; this is true of every IndexedDB version bump.
- **Stale marks now count** (accepted): a conversation whose saved mark is old, with messages past it
  that an older build never counted after a restart, shows them as unread at the next load - above
  its seed only. That is what its marks say.

It is a column of its own (`conversations.local_read_seed`; the same field in IndexedDB). A row this
build INSERTS is born `0`; a save that does not state the field keeps the row's
(`CONVERSATION_LOCAL_READ_SEED_VALUE`, `localReadSeedStore.test.ts` on both backends). **It is
local**: neither mark map moves, no frame or receipt is sent, no bundle carries it, and a backup
import keeps the state it was exported with. **Accepted consequence:** a first contact never opened
and held before the upgrade shows 0, as it did before.

**History bundles** count only past the read point: the bundle carries the read marks (step 0 of
`history_bundle`, persisted before the messages), so what was read on another device is covered. A
bundle answering an ask (`addOnly`) carries no marks; its rows count past the point above.
**Own messages and system notices** never count (`isUnreadForUser`).

**One page, a lower bound - chosen, not a store count.** The count is taken over the rows HELD: the
stored page (`INITIAL_MESSAGES_PAGE`, 60) merged with what arrived live. A conversation with more
than a page unread shows a page's worth until it is opened. A store count would need a query in both
backends over encrypted rows for a badge that reads "many" either way.

**Logs:** ONE census line per load, `[RESTORE] unread census: N conversation(s) counted from the
upgrade's local read seed, N with a badge, N unread in all, N removed or pending (they take no mark)`; per row, at debug only, the count and
the point that decided it (`saved`, `seed`, `own`, `none`). The migrations say once how many rows they
seeded (`[SQLITE] Migration v19->v20: ...`, `[IDB] Migration v13->v14: ...`). `[FCM_CACHE] message
<id> is already covered by the read point - no badge` when a push row is not counted. Tests:
`restoreUnreadCount.test.ts` (cold starts against one store: the reported defect, offline, skew both
ways, non-active rows, no rise-then-fall; the seed only read, a push-cache row stored before, at the
pull, during the replay or after the load counted), `localReadSeedStore.test.ts` (both migrations:
per row, undated and provisional skipped, empty 0, run twice a no-op, a write queued during the
IndexedDB upgrade), `readState.test.ts`, `fcmMemoryMerge.test.ts`,
`useMessaging.unreadReadPoint.svelte.test.ts` (both add paths), `systemMessageHandler.readState.test.ts`
(the bundle recount); each fails on the code it replaced. **Owed:** the owner's reading on the
Android phone.


## A community's salons have an order everyone shares, and a name that is only a name (2026-10-05)

**Order.** `channels."sortOrder"` (migration 076; the backfill numbers each never-arranged community
by creation date, so nothing visibly moves) is written by `PATCH /channels/workspaces/:id/channels/reorder`
(`ChannelService.reorderChannels`). Both listings sort through `sortChannels` (position, age, id - a
total order). **Permission: `memberCanManageChannels`**, the grant that already gates creating, renaming
and deleting a salon - arranging the list is governance of the same object, so weaker would let any
member rearrange everyone's sidebar and `workspace.manage` alone would lock out a role that may
already delete the salons. This is NOT the community rail's order, which is personal
(`reorderWorkspacesForUser`).

- `orderedIds` is the actor's VISIBLE list. A private salon they cannot see is not in it and keeps
  its slot (the visible ids are written back into the slots the visible salons occupied); any id that
  is not a visible salon of the community refuses the whole request.
- **Live update:** `workspace.updated { channelsReordered: true }` to the community with NO ids (a
  private salon's existence must not leak to members who cannot see it); each device re-reads its own
  `listChannels` and only reorders what it holds (`refreshChannelOrder`, `orderByIds`).
- **Client:** `Sidebar.svelte` puts `svelte-dnd-action` on the salon list (one type per community,
  mouse drag; touch needs a 350 ms long press so a swipe still scrolls; no second tab stop on the
  wrapper). Keyboard: Alt + ArrowUp/ArrowDown on a focused row (`moveById`), announced in a live
  region. Only when `viewerCanManageChannels`. Optimistic, rolled back and logged on refusal
  (`useChannelWorkspaces.reorderChannels`).
- **A press held past the 350 ms is still a tap (2026-10-12).** Once the hold elapses the library
  starts a drag with NO movement: it lifts the row from under the finger and drops it back on
  release, so the browser's `click` never reaches the row. Measured on the iPhone 12 bench as a
  community manager: holds of 60, 150 and 300 ms opened the salon, 400, 600 and 900 ms opened
  nothing, every time - the *"je clique sur le salon mais rien ne se passe"* report. The verdict is
  read from where the library's placeholder went, never from a clock
  (`utils/chat/channelPressGesture.ts`): a drag whose shadow never left its starting index was a
  press, and `handleChannelDndFinalize` delivers it as the row's own tap (`activateChannelRow`) and
  persists no order; a drag that moved, even back home, or left the list, stays a reorder. A
  member who cannot reorder never had a drag zone, so never had the defect.
- **Enter and Space on a focused row open it (2026-10-13).** The library also claims both keys on its
  draggables as "start a keyboard drag" (`preventDefault` + `stopPropagation`), and here the
  draggable IS the row's button, so Enter opened nothing for whoever may reorder. The zone carries
  `keepRowActivationKeys` (`utils/dndActivationKeys.ts`): a capture listener stops an Enter or Space
  aimed at a row - WITH OR WITHOUT a modifier, since the library reads `e.key` alone and a let-through
  Shift + Enter started its silent keyboard drag - before the library sees it, and leaves its default
  alone, so the button activates. The library's keyboard drag is therefore unreachable here, deliberately: the keyboard
  reorder is Alt + arrows. `setKeyboardDragTrigger` cannot do this - it is global and keeps one key.

**Name.** A salon name is a DISPLAY string, stored as typed (case, accents, emoji, spaces). Server
`validateChannelName` refuses only: empty after trim, over 80 characters (code points), a control
character (`\p{Cc}`). Nothing lowercases it any more - not the server (create, rename), not
`createNewChannel`/`renameCurrentChannel`, not the settings panel. Identity was already the
channel id everywhere (routes, `channel_<id>` conversations); the one place that used the NAME as
an identity, the invitation's target salon in `Sidebar.svelte`, now picks the first public salon
the viewer may open. The unique index `(workspaceId, name)` stays and is case-sensitive.

**Default salon:** `DEFAULT_CHANNEL_NAME` is the accented 'general' (e-acute twice). NEW
communities only: existing default salons keep the name `general` (user decision, 2026-10-05 - no
rename migration; a member with the right may rename one by hand).

## A repeat tap on the same conversation is a new landing (2026-10-06)

Found on the iPhone bench (phone campaign 2026-10-05, [cross-client-ios](../../cross-client-ios.md) H4), the same code runs on Android. `ChatBackgroundService` kept `lastNavigatedNotifTarget`, the conversation ID it had routed for, and never cleared it. The pending target also stays set while the user walks away from `/chat`, so a second tap on the same conversation published the same ID: `notifNav.pending` did not change, and the effect that did re-run on the route change answered `landingStep` -> `await-arrival` for ever. The log showed `[notifNav] deep link received` and no `routing to /chat`. A different ID routed at once.

**The guard is an identity, not an ID.** `notifNav.navigate` bumps a counter (`notifNav.landing`, never reset); the effect reads it and the route-once guard is `lastRoutedLanding === notifNav.landing`. Every tap is a new landing and routes once; the same landing re-running because the user left the page still answers `await-arrival`, so nothing pulls them back. Clearing on "landed" or "left the route" was rejected: `pending` has to outlive the landing for the selection watchdog, so a second clearing rule would be a second owner of the same state. No timer is involved. Test: `notificationRouting.test.ts`, "a repeat tap on the same conversation is a new landing" (fails when the bump is removed).

### A failed reaction said "cela n'a pas abouti" and named nothing, and its toast covered the bubble (2026-10-06)

A Mi 9T screenshot of the salon `general` showed `Reaction au message : cela n'a pas abouti`. That sentence is
the NAMELESS arm of `toUiActionError` (`useChannelWorkspaces`): it is reached only by an error that is not a
`ChannelApiError` (those carry a status and an envelope) and is not a transport failure. A reaction is a sealed
message, so the candidates are the seal's own refusals - `GraineNotReadyError`, `GraineUnknownChannelError`,
`GraineDistributionUnavailableError` - all of which mean "nothing was sent, this device holds no key for the
scope yet". **The exact cause on that phone is NOT established**: the failure was swallowed with no log, which
is the defect. Now:

- the three share one base, `GraineSealUnavailableError` (`utils/graine/sealUnavailable.ts`, import-free to avoid
  a cycle), and `toUiActionError` answers it by TYPE with `channel_action_error_not_ready`;
- the nameless arm logs the error object (`console.error`) so the next occurrence has a cause to read.

The toast container sat at `bottom: 5rem`, sized for the bottom nav. Inside a conversation the nav is hidden and
that offset lands on the last bubbles and the composer, so on a phone toasts now sit at the TOP (below the safe
area); desktop keeps its bottom-right corner (`ToastContainer.svelte`).

**Follow-up, same day (build `5b56dcb74` on the Mi 9T): the top toast overlapped the header, and the cause was a
transport failure.** Three fixes:

- the toast's top is `--chat-chrome-bottom`, the viewport Y where the conversation chrome ends, published on the
  ROOT by `ChatArea` (the toast layer is a sibling of the app and cannot inherit the panel's
  `--chat-header-height`); with no conversation open it falls back to the safe area;
- `MlsDeliveryApi.postApplicationMessage` classifies a `fetch` rejection at the throw as
  `DeliveryUnreachableError` (Tauri's `plugin-http` rejects with the bare reqwest string `error sending request
  for url .../api/mls/send`, which was "unclassified"); `isRetryableLoadError` reads it, so the toast is the
  existing network sentence. A cancelled request (`AbortError`) is not it;
- **the optimistic reaction is rolled back, but ONLY when nothing was sent** (`DeliveryUnreachableError` or
  `GraineSealUnavailableError`): the inverse frame at a later `at`, applied locally, never sent. A 5xx may have
  reached peers, so there the pill stays - the earlier "no rollback is possible" reasoning still holds for that
  case. Other sends (`/api/mls/send` callers beyond reactions) now also see the typed error; the outbox treats any
  throw as a failure, as before. Owed ONE on-device re-read: airplane mode, react, toast below the header, pill gone.

## The conversation list has one ordering key (2026-10-06)

The sidebar sorts in a `$derived` (`Sidebar.svelte`, `filteredConversationEntries`), so it re-sorts on every `conversations.set`. What was wrong was the KEY. It was `Conversation.lastMessageAt`, a stored seed advanced by `addMessageToChat`, `batchAddMessages` and the FCM merge only - history replay, channel history, `renderStoredPage` and older pages replaced `messages` and left it behind - and written from `Date.now()` by `toConversationMeta` (empty conversation) and the DM name repair, which `Math.max` then made permanent. Two devices with the same messages ordered differently.

Now `conversationRecency(convo)` (`utils/chat/conversations.ts`) is the time (`messageTime`: the server's acceptance, else `sentAt`) of the newest message in `messages` (sorted by `compareMessageOrder`), falling back to the persisted seed only while nothing is loaded, else 0; `compareConversationRecency` breaks ties by id. A message applied by ANY path - live, pending drain, history seed - moves the row, because the key is read from the list rather than remembered. Reactions, edits and read receipts do not touch `messages` order, so they do not move it. Known residue: the local-only "member joined" notice in `ChatBackgroundService` is stamped with the local clock and does count. Test: `conversations.recency.test.ts`.

**The server's newest visible frame is a floor under the key (2026-11-24).** Owner report on a new web device (prod `1.7.3`): _"mes discussions ne sont pas dans l'ordre"_. A new device learns its 153 conversations from `GET /mls/users/:id/groups` at once, and their history over the next two minutes, oldest page first (`history_bundle` chunks of 200), from the members' devices that happen to be online; some never arrive (a group nobody online can answer for). So the list was ordered by group creation (`startedAt`) and then by whatever page had landed - and stayed wrong for every conversation whose history never came. The server already holds the fact every device of every member would agree on: the receive time of the newest frame it accepted into the group. `dm_group_last_message` (migration 057, one row per group) records it for every VISIBLE frame - `silent` false, durable, not addressed, never a Welcome or a Commit - upserted with GREATEST, so it only moves forward. **A table of its own, never a column of `dm_groups`:** an UPDATE of the group row takes FOR NO KEY UPDATE, which conflicts with the FOR SHARE every send into the group takes on that row (`enqueueForLiveGroup`), so the sends of one group would have queued behind each other's note (the first build did exactly that, and its comment claimed the opposite - review of #4064); the insert reads the group row FOR SHARE and only while it is live (`deletedAt IS NULL`), which conflicts with no send and, after a deletion that held the row, inserts nothing - so the post-commit note can never leave a row on a tombstone (`057_dm_group_last_message.integration.spec.ts` holds a FOR SHARE and writes under a 1 s lock timeout, with an UPDATE of the group row as the contrast that does time out). The row goes with its conversation (ON DELETE CASCADE, and `GROUP_OWNED_TABLES` for the soft delete that keeps the tombstone), and the hourly retention sweep deletes it once older than the queued copies it stands for (`MESSAGE_RETENTION_MS`, 90 days). A repeat that finishes an interrupted first send notes it at the first copy's instant (`finishFirstCopy`). The members' list returns it and is ordered by it - **except to a seat still awaiting admission** (someone who followed an invitation link and was never let in), which gets `null` and is sorted by the row's last update; the single-group read (`GET /mls/groups/:groupId`) never carries it. The client reads it on every connection's discovery sweep (`recordGroupStart`, forward only) into `Conversation.serverLastMessageAt`, PERSISTED on its own (`ConversationMeta.serverLastMessageAt`, SQLite column `server_last_message_at` added on every open), and `conversationRecency` is `max(local key, serverLastMessageAt)` - the local history takes over once it reaches the fact, and a reload keeps the floor whatever page is loaded (`updatedAt` alone was read back only while no message was). **Which notices move it:** every group event the members see travels as a visible frame, so the server cannot tell it from a message - a rename, `memberAdded`, `memberRemoved`, `memberLeft`, the photo change and `groupDeleted` all raise the row, where the local key, which skips notices, would not; the same on every device. The row's preview stays the newest LOADED message until the history arrives. **No backfill, and none is possible:** the history stream does not record which frames were silent, so a conversation already quiet when this shipped has no row and keeps the old order (its last update) until its next visible frame. The measurement that says when that residue is gone: `SELECT (l."groupId" IS NULL) AS unknown, count(*) FROM dm_groups g LEFT JOIN dm_group_last_message l ON l."groupId" = g.id WHERE g."deletedAt" IS NULL GROUP BY 1`, run N days after the deploy - the `unknown` share should fall to the conversations silent for N days. No content and no author: it is one more time per conversation of the kind every queued copy already carries, kept no longer than they are (register C3, and the privacy policy). Tests: `conversations.recency.test.ts`, `serverGroupConversation.groupStart.test.ts`, `sqliteConversationColumns.test.ts`, `members.controller.user-groups.spec.ts`, `messaging.durability.spec.ts`, `messaging.send-race.spec.ts`, `group-purge.spec.ts`, `queued-payload.integration.spec.ts`, `057_dm_group_last_message.integration.spec.ts`.

### A reply belongs to ONE conversation (2026-10-06)

`useMessaging` held a single `replyingTo`, so a reply armed in a DM stayed above the composer of the
conversation opened next (measured on the Mi 9T, alpha.4). It is now a `SvelteMap` keyed by conversation
id: `handleReply(conversationKey, message)`, `replyFor(conversationKey)` and `cancelReply(conversationKey)`
take the key from the caller (`MainChatPage` passes `convs.selectedContact`), and a send consumes only the
entry of `ctx.selectedContact`. No clear-on-change effect is needed - nothing is shared, so nothing leaks.
Returning to the DM shows its reply again, like a draft. Each decision logs `[REPLY]`.
Test: `useMessaging.replyScope.svelte.test.ts`.

### A reply survives attaching a file (2026-11-10)

Owner report (1.6.9): reply to a message, attach a photo, and the photo went out as a plain message. Attaching never touched the armed reply; the loss was at the SEND. `handleSendChat` takes the reply out of `replyByConversation` at the tap, but only the text path (`sendChatMessage`) used it - the media path never read it - and the wire could not carry it anyway: `MediaMsg` had no reference, unlike `ReplyMsg`.

Now the reply rides the FIRST file, like the caption (several files: the others are plain attachments). `quoteReference` (`utils/chat/messaging.ts`) builds the quote once for the text and the media send. The reference is written to the outbox entry's `replyTo` (the entry stays `kind: 'media'`; the encrypted payload already stored `replyTo` for any kind), to the placeholder envelope and row, and, once the upload names the blob, to `MediaMsg.reply_to` (proto field 17, a `ReplyRef`) and the stored media envelope (`buildMediaMessage(..., replyTo)`). A salon attachment takes the same path through `startSalonAttachment({ replyTo })`. The receiver rebuilds the envelope's `replyTo` in `appMsgToEnvelope`; `MessageBubble` already drew a media envelope's quote. The exclusion-window rule is the text reply's: `decideQuote` also covers a `media` entry carrying a quote (its preview is blanked for a reader outside the window), taken BEFORE the seal barrier so nothing is awaited between the gates and the send (the promise of review #2874 L1 stays true). **How a quoted file is held:** `dependsOnAny` cannot see it - the queue read leaves a media row's encrypted payload undecoded, so `replyTo` is unknown there. `flushOne` takes the lane's `heldBack` set and, once the full row is loaded, answers `uploading` (held, not failed) for a file whose quoted message is still unsent in that pass; the lane re-evaluates it on its next pass. A voice note armed with a reply carries it the same way (it goes through the same send path as the first file). If the first file is refused and re-staged, the reply is re-armed with it (`[REPLY] re-armed`). Older clients ignore the new field and show the file without the quote. The native notification scanner (`proto_fields.rs`) does not read it: a notification of such a photo names the photo, not the reply. Tests: `useMessaging.replyWithAttachment.svelte.test.ts`, and `utils/chat/outbox.replyingFile.test.ts` (real IndexedDB queue read: the hold, and the order quote decided -> barrier -> gates -> send).

### A refused salon send gives the draft back (WP-OFF-1, 2026-10-09)

A salon text has no bubble and no queue entry (OFF-2 and OFF-3 are not built), and the composer is emptied synchronously on click, so a refused send (offline, 5xx) used to destroy the text. `handleSendChat` now answers `false` on a refusal (`true` once the server took it) and puts the reply target back in `replyByConversation`; `MainChatPage.handleSendChat` then restores the text with `restoreFailedDraft` (`utils/chat/draftRestore.ts`: an empty composer gets it back, a composer the member typed in meanwhile gets it in front, never overwritten) - into the draft of the conversation the text was written in, whichever one is open by then (each conversation keeps its own draft since 2026-10-27, [below](#each-conversation-keeps-its-own-draft-2026-10-27)), and it logs. The error banner stays. Tests: `draftRestore.test.ts`, `useMessaging.salonRefusal.svelte.test.ts`. Status of the rest: [offline-and-weak-network](../offline-and-weak-network.md).

### A salon message is shown at once and settled by the server (WP-OFF-2, 2026-10-09)

`sendChatMessage` (channel branch) draws a local ECHO row before the POST - `status: 'pending'`, then `'sending'` while in flight - using the same `ChatMessage.status` union and `MessageMetadata` labels as DMs and groups; no second model. The row is memory only (`skipDbSave`) and flagged `awaitingServerId`, because a salon message has TWO ids: the client UUID it is drawn under, and the one the server mints for its row (R4 in [offline-and-weak-network](../offline-and-weak-network.md)), which react/edit/delete/pin address. `utils/chat/salonEcho.ts` re-keys the echo to the server id IN PLACE - the row keeps `renderKey` (its client id), which `ChatMessageGroups` keys by, so it is updated, not remounted, and its entrance does not replay at delivery (2026-11-13, [keyboard-and-send-motion](../keyboard-and-send-motion.md); before that the `{#each}` key was `id` and the row WAS remounted) - on whichever answer comes first: the POST reply (`sendEncryptedChannelMessage` now resolves with the row id) or the `channel.message.created` frame, matched on the client UUID sealed inside the ciphertext (`channelEventHandler.ts`). A second answer is a no-op; if the server row is already in the list the echo is dropped, never drawn twice. A refusal sets `error` and the text STAYS in the row, with "Reessayer" (same payload, same client id) and "Supprimer" in the status line, which now shows an `error` on any own message, not only the last. Until re-keyed the row offers no reply/forward/react/edit/delete/pin, and it is not announced to the sibling tabs (`salonEcho` option of `addMessageToChat`); the re-key announces it. The composer keeps nothing once a row exists (`result.echoed`); WP-OFF-1's draft restore now covers only the case where no row could be drawn.

**What settles it, and who may.** The frame re-keys an echo ONLY when its sender is this user (the client UUID inside the ciphertext is author-chosen, so another member could otherwise swap any awaiting row). The outcome of the POST is classified at the throw: a 4xx (`ApiRefusalError`) or an unsendable seal (`GraineSealUnavailableError`, nothing left the device) is an ANSWER and marks the row `error` (Retry/Delete); a throw with NO status, OR A 5xx, is an UNKNOWN outcome - a 502/504 may come from a gateway AFTER the social service stored the row - and the row becomes `unconfirmed` (2026-10-12, review of #1649): its own amber label ("Non confirme"), distinguishable from a failure, offering Delete, "Remettre dans le champ" (`takeBackSalonSend`: the row and its ledger entry go, the text returns to the composer through WP-OFF-1's `restoreFailedDraft`), and - since WP-OFF-3 - Retry. No clock, no heal: the frame or the next history load still settles it if the server did take it (`loadChannelHistory` re-keys any own echo whose client UUID, `DecodedChannelMessage.clientMessageId`, appears in the page, whatever its state; this also covers a reply that carried no id, typed `null` from `sendEncryptedChannelMessage` and logged as an error). **The server dedupes on the client id since WP-OFF-3 (migration 088)**: a repeat of the same `messageId` by the same author in the same salon is answered with the stored row, which is what makes Retry safe on an unknown outcome ([offline-and-weak-network](../offline-and-weak-network.md#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17)). A transport failure that leaves the device OFFLINE is `pending` and sent again on the reconnect (the server answers a repeat with its row; the proof once awaited first was retired on 2026-11-22, [one lane per salon](#a-salon-is-received-in-the-order-it-was-written-one-lane-per-salon-2026-11-22)). A Retry already in flight refuses a second click (`retrying` in `utils/chat/messaging.ts`; test "a double-click on Retry sends once").

**Tabs.** Only the leader receives the frame, so a FOLLOWER that composed the message learns the server row from the leader's `message_added`, which now carries the client UUID (`clientMessageId`, set by `channelEventHandler` for an own frame and by `applySalonEchoChange` on a re-key). The follower settles its echo under that id (`mergeAnnouncedMessage`) and forgets the send (`forgetDeliveredSalonSend`) instead of drawing the server row beside it; test: `salonEcho.test.ts` "shows ONE row, in both orders". **The unsent ledger is shared by every tab**, so each entry names the PAGE LIFE that wrote it, and that page life holds the Web Lock `canari.salon-unsent.owner.<id>` until its document goes away. A leftover is taken only when it is this page life's and no live send owns it, or its owner's lock is no longer held - the browser's release IS the proof of death, no heartbeat. The ledger is read BEFORE the locks are queried and only that read's entries can be taken (an entry is written after its owner's lock is requested, so a living writer is always in the snapshot that follows); read after, an entry a sibling or this life's own send wrote during the query was taken from a living writer. Without Web Locks a foreign entry is never taken, and that is logged; an entry written before owners existed is taken. Test: `salonUnsent.test.ts`.

**The text survives a kill.** The echo is memory only, so the text is also written to the unsent ledger (`utils/chat/salonUnsent.ts`, localStorage per user) before the POST and removed on the server's answer, a discard, or any PROOF the server holds it - the author's frame or a history page carrying that client UUID (`clearUnsentSalonTexts`); without the last two, a send whose reply was lost and that the frame settled handed its delivered text back to the composer at the next start. At the next start, opening that salon hands any leftover back to the composer (`MainChatPage`), never re-sending it. Residual: the reply target is not kept.

**It settles on the server's clock (2026-10-12).** The echo is drawn at the author's `sentAt`, but every salon row is dated by the server's `createdAt` on the live and the history path, and read marks compare against that column. So the settling answer carries it - the POST reply (`ChannelRowAck.serverMs`, read from the row the server returns) or the frame's `createdAt` - and the re-keyed row takes it as `timestamp`/`serverTimestamp` and moves only as far as that time requires (`placeAt`): a message somebody else's device got stamped before ours, already drawn below the echo, ends above it, as on every other device. Test: `salonEcho.test.ts` ("takes the server clock"). **Until then the echo moves no read mark** (`watermarkAfterReading` skips `awaitingServerId`): taken at the author's clock, it put the reader's own mark past every server row whenever the device ran fast, so a message stamped inside that lead read as read. Test: `readState.test.ts`.

**Why it matters, measured (production web console, `v1.2.5`, 2026-10-12).** One salon send: click 17:12:08.052, bubble 17:12:14.191 - **6.1 s with nothing on screen**, because the bubble was the server's broadcast. The time was two round trips in series on a slow link (`[CONNECTIVITY] slow link (latency floor 1123 ms)`): the community's key group had taken a commit 10 s earlier, so the send minted a new Graine session and distributed its seed (`POST /api/mls/send`, 4055 ms) before posting the message (`POST /channels/<id>/messages`, 2049 ms). With the echo the row is on screen at the click and only its status waits for those two. DMs and groups were already drawn at the click (`[ADD_MSG]` at +3 ms, bubble ~+120 ms on the Mi 9T), so both now share one status model.

**What it is not:** durable as a row. A reload loses the echo; since WP-OFF-3 the ledger is the queue's durable half, and the next session-up SENDS AGAIN what a dead page life left there (same id, `sentAt` and quote). An entry written before WP-OFF-3 has no `sentAt` and still comes back to the composer. Tests: `salonUnsent.test.ts`, `salonEcho.test.ts`, `useMessaging.salonRefusal.svelte.test.ts`, `channelEventHandler.salonEcho.test.ts`, `messagingChannelRefusal.test.ts`, `MessageMetadata.retry.svelte.test.ts`.

### A salon not yet loaded holds the send, it does not refuse it (2026-10-13)

**Reported on both phones (prod `1.2.6`):** a message sent right after opening the app showed `Rien n'a été envoyé : ce salon n'est pas encore chargé sur cet appareil` and the member restarted the app. **Cause:** a salon is drawn from the local store (cold start, resume, notification landing F1) long before `loadChannelWorkspacesFromBackend` has called `registerChannelWorkspace` for it, and `sealChannelMessage` throws `GraineUnknownChannelError` (`unknown-channel`) when `scopeForChannel` is empty. The listing walks every community in parallel, but each one awaits `ensureMls`, the key-group join and `listChannels` before registering its salons, which takes seconds on a slow link. Nothing was wrong except the order. This is read from the code, not from a device log: it is the only throw that carries `unknown-channel`. The row did stay as `error` with Retry (WP-OFF-2), but a Retry while the listing was still running was refused the same way, and one after a listing that GAVE UP (offline start) was refused for good.

**Now the send waits for the salon** (`utils/graine/salonSendGate.ts`). `deliverSalonSend` asks the gate BEFORE sealing, so the fact is read where it is known and not learnt from the seal's refusal:

- `ready`: the salon was ENTERED this session. `openSalonSendGate` is called where an entry ends, after the private salon's own group is joined, not at the scope registration (a private salon registered but not yet entered would refuse its seal `key-group-not-held`). There are four call sites: the listing walk, `registerJoinedChannel`, community creation and salon creation.
- `wait`: a listing is in flight, or none has settled since the session began. The row stays `pending` ("En attente"), nothing is sealed, the text is in the unsent ledger, and there is no banner.
- refused: a listing settled without entering it (`not-listed` if it answered, `listing-failed` if the SERVER failed it - a 4xx, or 5xx after the retries), its community was purged (`forgetWorkspaceGraineState` -> `left`), or the session ended (`setGraineRuntime(null)` -> `session-ended`). The row turns `error` with its Retry, and the banner names the cause (`salonGateRefusalMessage`, four Paraglide sentences).

**A listing that reached NOBODY refuses nothing (2026-10-14).** Offline, the listing gives up `unreachable` (`isTransportFailure` on its last error): no server decided anything, so held sends keep waiting, as the offline banner says, and `retryFailedListing` - called on `connectivity.onReconnect` and on the foreground - lists again and settles them. A reconnect that lands while a listing is still running is OWED to it and taken up only if that listing gives up. Bounded: one reconnect retry per give-up, none after a reconnect's own listing gives up, none owed while the listing's own request is on the wire; the foreground always lists again ([offline-and-weak-network](../offline-and-weak-network.md#14-a-transport-failure-is-one-type-on-every-platform-2026-10-14)). Measured on the Mi 9T (`v1.2.7-alpha.1`): before this, an offline start refused every salon send `listing-failed` for 2.5 min after the network came back ([offline-and-weak-network](../offline-and-weak-network.md#14-a-transport-failure-is-one-type-on-every-platform-2026-10-14)).

**The wait has no timer.** Each way out is an event (entered, listing settled, purge, sign-out), and a listing always settles because it has a bounded retry ladder. `settleSalonListing` refuses waiters only when NO listing is left in flight, and it runs after the reload owed to a join has begun, so a held send waits for that reload too. A listing that began before a sign-out carries the previous session's token, and its settle is ignored.

**The signature rule is unchanged.** The held message is cleartext in memory, never a queued unsealed row. It is sealed and signed when released, through the ordinary `sealChannelMessage`. The seal keeps its own `unknown-channel` refusal for any path that reaches it without the gate.

**No duplicate on reload.** A held send has sent nothing. A reload loses the row (memory only, as before) and the ledger hands the text back to the composer. Held sends to the same salon are released in arrival order, and each one exactly once (the resolvers are removed before they run). A Retry on a refused row asks the gate again, so it waits if a listing is in flight. The banner of an answer that arrives after the member moved to another conversation is not shown there: the row keeps the state, and the log says so.

**A salon upload waits too**, BEFORE the upload so a salon that never loads leaves no orphan blob - but since 2026-11-02 it waits ON ITS ROW, after the send has returned ([a salon attachment is drawn at the tap](#a-salon-attachment-is-drawn-at-the-tap-and-its-row-carries-its-upload-2026-11-02)). The row says `queued` meanwhile; a refusal parks it in `error` with its Retry and the banner names the cause, only if the same conversation is still on screen. Nothing is re-staged (the row holds the file) and the caption is never sent alone (it is in the file's own message). **`session-ended`** withdraws the row and uploads nothing: `globalMessaging` outlives a sign-out, and nothing of the leaving account may go out under the next.

**A salon entered in-session holds too.** `registerJoinedChannel` brackets its joins with `beginSalonEntry` / `settleSalonEntry`: the event draws the salon before the joins end, and a send typed then would otherwise be refused by a listing that settled before the salon existed. An entry ends without changing the last listing's outcome.

**The banner is no longer drawn over the thread.** `.chat-floating-alert` sat at `bottom: 10rem` on a 95 %-opaque pink in raw hex, and the messages under it showed through and collided with its text (user's screenshot). It is now `.chat-send-notice`, rendered by `ChatComposer`'s `notice` snippet at the top of the footer, so `--chat-composer-height` counts it and the thread makes room. It uses opaque tokens (`--banner-danger-bg`, `--red-err`, `--radius-lg`) and the type scale (`--text-xs`, and `--text-sm` from 768 px).

Not covered: reactions, edits and polls (`toUiActionError`) still refuse on `unknown-channel`, because they are a toggle and not a message. A context where the runtime is installed but no listing ever begins would wait until sign-out; the post-login effect in `ChatBackgroundService` begins one. **A listing belongs to its session** (its gate token is the session, `isCurrentSalonSession`): one still running at sign-out stops at its next write (`assertListingSession` after every await of the walk, so nothing of the leaving account reaches the sidebar, the runtime map or the gate), records no `workspacesLoadError`, drops the reload a join owed it, and does not hold `isLoadingWorkspaces` against the next account - the next session's call supersedes it. Tests: `useChannelWorkspaces.svelte.test.ts` ("a listing that outlives its session").

## The restore keeps the salon rows the community load wrote (2026-10-12)

Reported from an iPhone: after a notification tap into a salon, tapping the other salons lit the
row and opened nothing, until a restart. **What the code proves** (`restoreKeepsSalonRows.test.ts`,
two cases red on main): a salon's conversation row is written by `loadChannelWorkspacesFromBackend`,
which never persists it, and `loadExistingConversations` used to `clear()` the whole map and
rebuild it from storage. Any restore that ran AFTER the community load - the login path sets
`isLoggedIn` (which starts the community load) and only restores after the socket opens, and
`onWelcomeProcessed` restores mid-session - erased every salon storage did not hold, and emptied
the messages of the ones it did. The sidebar reads `channelWorkspaces`, so the row stayed listed;
a tap set `selectedChannelConversationId` (the highlight) and `selectedContact`, and the selection
watchdog in `useConversations` dropped the key it could not find in the same frame. A restart ran
the two loads in the other order, which is why it "healed".

- **The fix:** the restore deletes only the rows it owns (every non-salon key) and does not rebuild a
  stored salon already in memory - it only reads back the persisted state the live row lacks (read
  watermarks, history floor, `startedAt`, the sort key), the live row winning; a stale salon is pruned by the community load, never by the restore.
  It logs `[RESTORE] kept N salon row(s)`.
- **The diagnostic:** the watchdog now says `[SELECT] <key> is not in the conversation map -
  selection dropped` at `warn`, so the next inert tap names itself instead of looking like a tap
  that never arrived.
- **Not measured on the device:** the order of the two loads on the reporter's cold start was not
  observed (no inspectable build on the bench at the time). The press held past the reorder hold
  ([above](#a-communitys-salons-have-an-order-everyone-shares-and-a-name-that-is-only-a-name-2026-10-05))
  is the other inert-tap cause, measured on the iPhone.
- **Reproduced on a desktop the same day, then refuted on main.** The owner hit it on Firefox
  (`v1.2.5`, which carries neither fix): three salon clicks, each followed by `GET .../members` and
  `GET .../pins` (the two `MainChatPage` effects keyed on `selectedContact`) and by NO `/messages`
  (`loadChannelHistory` returns on a missing row, silently), and from the second click on a
  `CanariBrand: name does not fit in 0px` - the hidden phone header re-mounting because the selection
  had gone back to `null`. On the local estate with W1, a salon created through the API (so this
  device never saved it) and the gateway socket held back 8 s on reload: the community load landed at
  `+0.7 s`, the restore at `+8 s`, and the click gave exactly that signature with the row
  `aria-current` and no composer. Same steps on a build of main (`bb95de309`):
  `[RESTORE] kept 57 salon row(s)`, the salon opened and its `/messages` was fetched. **What to read
  in the next export:** `[SELECT] ... selection dropped, nothing opens` means a row is missing from
  the map again, and the `[WORKSPACE-LOAD] communities/channels loaded` / `[RESTORE]` /
  `[SYNC] Welcome processed` lines before it date the two loads.

## Profile fetches that failed on a device, and the denominator that is owed (2026-08-16)

The symptom was seen twice on 2026-08-16, on both platforms: nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. The log line that makes it countable did not exist then; since 2026-08-19 every warn in `displayName.ts` ends `(failed/attempted lookups failed this session, X%)`, counting only lookups that reached the network. Do not assume it is the same fault as the avatar endpoint, and do not assume it is not. The number is read from a device or browser console during a campaign run: there is no client telemetry, and server-side is not an option (`GET /api/users/:id` is not request-logged, and a client that never reached the network would not appear anyway). **Then decide about `FAILURE_BACKOFF_MS`**: a high rate says the two-minute suppression does real work against a refusing server; a rate near zero says it is a clock hiding a name for two minutes over a blip the reconnection listener already handles.

### A muted salon and a membership notice raise no badge (2026-10-18)

WP-SALON-UNREAD, decided by the user 2026-10-18. Two rows the badge counted that its owner never
wanted to read:

- **The "X joined" notice.** It is an encrypted row, so the server could not tell it from a message
  and counted it until the salon was opened (the 2026-10-11 fix only made it coverable). The one
  writer (`inviteMemberToChannel`) now sends it `silent`, the flag the server already skips in
  `listUnreadCounts`; as a side effect it no longer rings phones either. `listMessages` returns the
  silent rows of a salon with NO body at all, so a salon holding only notices still shows them, and
  on a SHORT page (fewer bodies than asked - the end of the history) it drops the lower bound on the
  silent rows and keeps only the cursor: the join notice written before a salon's first body is in
  no later page, since none is ever asked for below a short one.
  **Notices written before this stay counted until the salon is opened**, which the read mark now
  reaches - no data repair. **An inviter on an older client keeps sending ordinary (non-silent)
  notices**, which stay counted the same way until `minClientVersion` reaches this build.
- **A muted salon.** `notifLevels[channel] = 'none'` is left out of the SQL, and the answer gains
  `muted: string[]` (raw channel ids) so the client's LIVE tally stays quiet for them too
  (`isSalonMuted`, read by both arrival paths in `useMessaging`; `reconcileSalonUnread` sets a muted
  salon to 0). The settings panel updates the set at once (`noteSalonNotificationLevel`); a badge
  already on screen when the member mutes falls at the next count. That local choice is stamped on
  the same tick counter as `openedAtTick`, so an answer asked BEFORE it and landing after cannot
  undo it. **Unmuting brings back what arrived while muted**: the server counts against the read
  mark, which muting never moved, so those messages re-enter the badge at the next count - a mute
  silences, it does not read. **`mentions` still counts**: the
  row is encrypted, the server cannot tell which rows mention the member. An older server sends no
  `muted`, and nothing is muted then.

Tests: `channel-unread-counts.spec.ts`, `channel.service.spec.ts`, `salonUnread.test.ts`,
`useChannelWorkspaces.svelte.test.ts`. **Owed on a device:** mute a salon, post into it from another
account, read the community rail dot and the tab title; add a member and read the other member's badge.

### A salon read mark reaches its membership notices (2026-10-11)

**Reported:** community Pist'On Fire, salon `infos` showed a badge of 3 and the community a red dot;
opening cleared it, a refresh (and the phone) brought it back. **Cause:** the server's
`listUnreadCounts` counts every non-silent row not authored by the caller after the caller's mark,
and a membership notice is such a row (authored by the adder, encrypted, `isSystem` only once the
client decodes it). The client read point (`watermarkAfterReading`) and the `serverAt` it sends both
SKIPPED system rows, so when the newest rows of a salon were notices there was no `target > held`
and no mark was ever sent: nothing could cover them. **Evidence (prod, read-only):** `infos` newest
two rows (2026-10-09 09:09:16 and :31, by the adder, right after two memberships) sit after every
member's mark (09:03:13); the two other salons end on real messages, which carry the mark past any
notice before them - hence only this salon. Recomputing the server query gave 3 for the members whose
mark was 09:03:13.234 (one real message plus the two notices). Not a stuck row: the data is
correct, the notices simply were never coverable. **Fix:** `watermarkAfterReading(..., includeSystem)`
is true for a salon (its notice is dated by the server's `createdAt`, unlike a DM's, which is stamped by
the device clock and still skipped) and the salon `serverAt` includes system rows. Self-heals: the
next open of the salon sends the mark. No data repair needed.

## Reading the ADD_MSG selected flag against CHAT_VIEW

Added 2026-10-14 for a web report (Firefox, window visible but unfocused) where a message reached the
list preview and badge but not the open pane until a refresh; not reproduced in Chrome. Two lines
bracket the unknown stretch between the conversation map and the pane DOM:

- `[ADD_MSG] Batch into "<id>": N added, M upgraded, selected=<bool>` - `selected` is
  `ctx.selectedContact === <conversation id>` at flush time.
- `[CHAT_VIEW] <id8> messages N (hasNewMessage=<bool>, response=<respondToNewMessage>)` - logged by
  `ChatArea`'s `conversation` effect once per change of the DISPLAYED count (not per run, not on a
  switch); `response` is `n/a` for a shrink.

**Reading.** `selected=true` with no following `[CHAT_VIEW]` of N+1: the map-to-prop chain is broken
(the pane never received the grown conversation). `[CHAT_VIEW]` N+1 with the row still missing:
rendering or scroll (`windowStart`, the pin), not data flow. `selected=false` while the pane is open
means `selectedContact` and the pane disagree.

**The count line is `Log.d`, so it is NOT in the exported log** (`appLog.ts` records no debug) - it is
for a console attached to the device. What the exported log carries (2026-11-09):

- `[ADD_MSG] ✓ Message upgraded: id=<id> selected=<bool>` - a shown row (a push preview) upgraded in
  place by the live path: the count does not move, so no count line follows it.
- `[CHAT_VIEW] <id8> entry settled: pinned=<bool> isNearBottom=<bool> newestVisible=<bool> rows=N
  fromBottom=<px>` - INFO, ONE per conversation entry (`chatViewEntryLine`), written on the frame
  after the entry is revealed AND its catch-up (`isLoadingHistory` / `isCatchingUpMessages`) has
  ended, so the history replay's upgrades and withdrawal have landed. `pinned` is measured
  (`isPinnedToBottom`), `isNearBottom` is the flag the observers read, `newestVisible` says whether
  the conversation's newest row is the last row in view. `newestVisible=false` with `pinned=true` is
  a render-window defect (the row is not mounted); `pinned=false` with `isNearBottom=true` is a
  change the follow did not answer.

  **A boxless row used to make it lie (2026-11-25).** The Mi 9T opened a DM ending in a voice note
  and two 738 px images, visibly at its end, and read `newestVisible=false` three times in three.
  `measureLastVisibleAnchor` binary-searches the rows' tops and read a drawn row with no element
  (`document.getElementById('msg-<id>')` null) as `Infinity`, "below": a system line (call, device
  notice) had no `msg-` id, and the probe landing on it sent the search left, so the rows after it
  were never examined (confirmed on the Mi 9T DOM: at n=10 the first probe is row 4, the boxless
  "added a device" line, then 1, 2, 3, ending on row 3). The mapping of drawn groups onto `messageRows` was 1:1 and was not the
  defect. Two sources fixed: `MessageBubble`'s two system roots carry `msg-<id>` like the bubble, decided by its own
  `effectiveSystem` (`isSystem` OR a system envelope), so every row has exactly one box, and `lastRowAbove` takes `null` for "no box", probes the next row that has one
  and names the boxless row (`Log.w 'last-visible measure: ... has no msg- element'`). Consumers of
  the measure: the entry line (it lied), the unread pill's anchor (`lastVisibleAnchor` feeding
  `countUnreadBelow`: the badge counted from an earlier row, over-counting rows the reader had
  seen), and `remeasureAnchor`'s missing-anchor warning (could accuse a healthy thread). The
  `msg-` selector of the fill measure and the growth observer now counts system rows too.

### Rows received as notifications appeared only at the second open (2026-11-09)

Reported by the owner (Android 1.6.8): messages received as push notifications showed in the DM only
when it was opened a SECOND time. The log proved the data path: at the notification-tap open the
three previews were in the map (`FCM_CACHE Injection done 3/3`), then within 1.4 s the stored page
was drawn before the probe, the three previews were upgraded in place (`Preview upgrade ... taking
the live path`, two into taller reply bubbles, count unchanged), and `[HISTORY] 3 early-drawn row(s)
below the fresh page withdrawn` took the oldest rows off the top. The second open changed no data.
The pane's own evidence was debug-only, so the mechanism is inferred, and three holes were closed:

1. **An entry dropped every change of the thread's extent.** `threadGrowthResponse` answered
   `keep-row` while `entering`, and `anchorShift` compensates nothing while entering - so an upgrade
   growing a row, or a withdrawal, during the entry was not followed at all. An entry is at the
   bottom by definition (`fillViewportThenPin`), so it now follows (`follow-bottom`) whatever
   `wasNearBottom` says - a scroll measured while the list is hidden is not the reader's. Only a
   prepend (`isLoadingOlder`) keeps the row. Reproduced first in `threadGrowthObserver.test.ts`
   ("a conversation being entered": 180 px from the bottom after two 90 px upgrades), then fixed.
2. **The follow of a new message was a SMOOTH scroll.** Every `scroll` event of the glide is
   measured, so the stick-to-bottom flag read `false` mid-way, and growth then was answered as growth
   under a reader in history: the glide ended at the OLD bottom. `scrollToBottom` is instant
   everywhere, like the jump to a message ([above](#the-jump-is-instant-because-a-smooth-one-was-cancelled-by-the-tap-that-asked-for-it-2026-10-12)).
3. **The entry's re-pins on a clock are gone.** `scrollToBottomSettled` re-pinned for four frames
   and at 250 and 600 ms - a guess at when late content lands, blind to what lands after it and
   pulling a reader who scrolled up inside it back down. The observer now covers the entry, so the
   pin is the synchronous one plus the reveal frame.

**Ruled out: the entrance animation.** `animate-rise-in` fills nothing and ends at `opacity: 1`, so
a row whose animation stops is its own style (`riseInEntrance.test.ts` reads the rule). **And a
stale write fixed on the way:** the live upgrade wrote `{...convo, messages}` from the snapshot read
BEFORE `settleWithPending`'s store read, and a notification-tap open draws the stored page in that
gap - the write put the thread back to the previews alone. It re-reads the conversation after the
await (`useMessaging.upgradeSnapshot.svelte.test.ts`). **Owed: one notification-tap open on the
Mi 9T with three pushed replies, and the `entry settled` line read from the exported log.**

**What the timed re-pins were still covering, found in review (2026-11-09).** Three cases, each now
closed at its cause rather than by a clock:

- **A growth seen by the scroll measurement before the observer could follow it.** `measureScroll`
  runs in an animation frame, and a frame runs those BEFORE it delivers `ResizeObserver` entries: a
  medium decoding to its size (no DOM mutation) in the frame of a pending measurement - the reveal's
  scroll, every widen step's - read "not at the bottom", dropped the flag, and the observer then
  answered `keep-row`. `stickToBottomAfterScroll` (`threadAnchor.ts`): a reader leaves the bottom
  only by moving UP out of the slack; a pane that did not move up keeps the flag, and the observer
  follows. This also makes the smooth glide of fix 2 harmless in principle.
- **An older-history load in flight across a switch.** `loadOlderGroups`' restore was computed from
  the PREVIOUS conversation's offsets and landed on the new one, and its `isLoadingOlder` held the
  new entry's growth to `keep-row`. A switch now retires it (`olderLoadToken`): no restore, and the
  flag is the new entry's.
- **The stored copy of the preview.** Re-reading the conversation after the await still wrote the
  upgrade built from the SHOWN preview over whatever row the stored page had put there - a tombstone
  came back as the body, a reaction the copy carried was dropped. The body now lands onto the
  current row (`mergeMessageUpgrade`, the same pending mutations re-folded), and a row that is no
  longer a preview is left as it is, like the store's compare-and-set does.

## Each conversation keeps its own draft (2026-10-27)

The composer's text was ONE field of `MainChatPage` (`messageText`), cleared only when the route
switched between `/chat` and `/communities`. A draft left in one conversation - or a share staged
there - sat in the next conversation's composer, and that conversation's Send posted it there: read
on the Mi 9T, where two shared links followed the reader into two other conversations. The text now
follows the rule the staged files and the armed reply already followed:
`useMessaging.draftByConversation`, keyed by conversation id, read through `draftFor` and written
through `setDraft`; the page's `messageText` is a `$derived` of the open conversation's entry.
`forgetAccount` clears it with the other two at sign-out, since the next account may open the same
DM or salon. A refused send (`restoreFailedDraft`), a taken-back send and a share all write into
the draft of THEIR conversation. Test: `useMessaging.draft.svelte.test.ts`.

Two consequences of the drafts outliving the page (review of #2614, 2026-10-27):

- **Text that comes back LATER is written through `lateDraftWriter`**, which captures
  `signOutGeneration()` when it is made and drops the text (logged, without the content) once a
  sign-out has begun: an edit's saved draft, a refused send and a resumed salon text. A sign-out
  clears the drafts (`forgetAccount`) while the composer is still mounted, and the edit's reset or
  the refused send's answer came after the clear - the next account to open the same DM or salon
  saw, and could send, the leaving account's text. Test: `useMessaging.draft.svelte.test.ts`.
- **The composer resets an open edit when it UNMOUNTS** (`ChatArea`'s `onDestroy`), not only when
  the conversation id changes: the page remounts on any route change, so an edit left open there
  left the edited message's text as the draft, with no banner, for Send to post twice. Test:
  `ChatArea.editUnmount.svelte.test.ts`; `MainChatPage.draft.test.ts` pins that the page's text is
  derived and its late writers gated - and created BEFORE the await or callback they outlive.
- **Loose ends closed 2026-11-25.** (a) A text restored while an edit is open (`holdRestoredText`,
  `editSession.svelte.ts`) joins the edit's SAVED draft, found by the conversation's draft key
  (`ChatArea`'s `draftKey`), instead of the composer that holds the edited message: `cancel`,
  `confirm` and `reset` give it back, and `confirm` never saves it into the edited message.
  `MainChatPage.restoreText` is the one entrance for the four restores. (b) **The salon ledger detour
  stays on purpose**: a salon text resumed after the member left goes back to the ledger
  (`recordUnsentSalonText`), which is persisted, while drafts are memory only; revisit only when
  drafts outlive the page. (c) The @mention picker closes when the composer's conversation changes
  (`MentionComposerInput`'s `mentionScope` -> `dismiss()`, whose generation bump drops a late search
  answer). (d) A conversation that leaves the list (left, deleted, removed) drops its draft
  (`forgetDraftsOfLeft`, driven by an effect on the list's keys in `ChatBackgroundService`, which
  outlives the chat page). Tests: `editSession.svelte.test.ts`, `useMessaging.draft.svelte.test.ts`,
  `useMentionAutocomplete.svelte.test.ts`.
- **Two keys, one risk.** Drafts are keyed by `convs.selectedContact`, which for a DM is the map key
  (its display name), while the edit's reset follows `conversation.id`. A DM whose map key changes
  under an open conversation (a name resolved late, a rename) strands the draft under the old key:
  invisible, and forgotten only at sign-out. Not seen; it is the first thing to check if a draft
  "vanishes" from a DM.

### The scroll-to-bottom badge counts only what lies below the viewport (2026-11-01)

The owner saw a yellow "1" on the floating arrow while scrolled up in a conversation with nothing new. The badge was `countUnreadForUser` over the WHOLE thread: any foreign row not covered by the read mark - above the viewport, in view, or held back by `serverMarkCeiling` or an unfocused window - raised it. Reactions, edits and pins are not rows and never counted. It is now `countUnreadBelow` (`readState.ts`): the unread rows after `lastVisibleMessageId`, measured by `ChatArea.measureScroll` next to `isNearBottom`; an unmeasured position counts nothing. `readState.test.ts`.

**The count is taken against the marks held when the reader LEFT THE LIVE END (2026-11-25).** The open window marks every arrival read (the read-mark effect has no scroll position), so against the live marks a catch-up into a scrolled-up thread counted 0 and the arrow carried no number (Mi 9T, `1.8.1-alpha.2`). `ChatArea` freezes the reader's counting marks (`pillBaseline`) on the first run away from the end and drops them on the way back or on another conversation; `pillCountingPoint` (`readState.ts`) takes the lower of baseline and live. Reading owed: [backlog](../../backlog.d/reading-owed-the-scroll-to-bottom-arrow-counts-a-catch-up.md).

The position (`utils/chat/visibleRow.ts`) is the last row above the scroller's bottom MINUS its padding (the floating composer's height), found by binary search over the display-ordered `messageRows`; it is re-measured when the thread or conversation changes, not only on scroll, a vanished anchor resolves to the nearest surviving row (logged once), and nothing is counted while pinned to the live end.

### A group conversation and a community are two entry points with two names (owner, 2026-11-04)

A user in the English app wanted a GROUP and created a COMMUNITY: the community dialog was titled by its name field ("Club or group name" / "Nom de l'association ou du groupe"), and English called a community a "club" in the community screens. Decided: the words never overlap.

| Entry point | What it creates | fr / en |
|---|---|---|
| "Nouvelle discussion" with two or more people chosen, then the name step (`SidebarNewChatModal`, `onCreateGroup`; [one panel](#one-new-discussion-panel)) | an MLS group conversation | button "Créer un groupe avec N personnes" / "Create a group with N people", then "Créer la discussion de groupe" / "Create group conversation" |
| The rail's dashed "+" (`SidebarNewCommunityModal`, `onCreateWorkspace`) | a community (workspace with channels) | title "Nouvelle communauté" / "New community", field "Nom de la communauté" / "Community name", button "Créer la communauté" / "Create community" |

**English never says "club" for a community** (the `chat_*` strings about a community's settings, invitation and deletion now say "community"). "Club" stays where it names an ASSOCIATION (the `asso_*`, `admin_*`, `posts_*`, `payout_*` and `dependency_*` families): there it is the English word for the French "association", a different object from a community.

### One new discussion panel

The owner, 2026-11-17: creating a group took "Nouvelle discussion", then the "Groupe" tab, then a name, then an
EMPTY group whose members were added afterwards from its own panel. Now there is one panel
(`SidebarNewChatModal`) and people are chosen FIRST; the number chosen decides
([principe 7](../../../principes.md), simple).

| Chosen | The footer button | What it does |
| --- | --- | --- |
| nobody | "Démarrer la discussion", disabled | - |
| one person | "Démarrer la discussion" | opens the 1:1 with them, or creates it (`startNewConversation`, unchanged) |
| two or more | "Créer un groupe avec N personnes" | opens the NAME STEP, a second panel over the first |

**The chips row has one height from the opening** (2026-11-18): a hint before any pick, a single line scrolling
sideways after - the first chip used to push the recent list under the finger about to tap the second person
(`new-chat-chips-slot`).

**The name step.** The field is EMPTY, and its placeholder - greyed - is the label the group will
carry if it stays empty: the chosen people's first names, composed by the same function every
device uses afterwards (`composeUnnamedGroupLabel`), so the suggestion is exactly what will show.
Keeping it creates an **UNNAMED group**; typing creates a named one, with the duplicate-name refusal
as before. Either way `createGroupWithMembers` (`useConversations`) creates the group, which adds this
account's own devices, then invites the people chosen into it, addressed by the key the creation
answered - two commits, the order every creation already took. An invitation that reaches only some
of them is told by `reportBulkAdditionOutcome` like any other; the group exists and is completed
from its panel. An invitation that added NOBODY names everyone it invited, and one that met another
device's add lock is owed rather than refused ([below](#nothing-takes-the-add-lock-it-does-not-commit-under-2026-11-17)).

**Decisions taken here (reversible):**
- **Layout**: the chosen people are removable chips ABOVE the search, the Messenger pattern; the
  recent 1:1 peers are listed below as toggles (a check in a circle), so a group of familiar people
  costs a tap each. Tapping a recent peer no longer opens their 1:1 at once - it chooses them, and the
  footer acts: one gesture model for one person and for ten.
- **Communities stay a separate entry** (the rail's dashed "+"): a community is a different object
  with a different name (the 2026-11-04 decision just above), and offering it here would put it back
  in the panel the owner asked to simplify.
- **The button** with several chosen says what it does and how many: "Créer un groupe avec N
  personnes" / "Create a group with N people". N counts the people chosen, not the creator.

#### Nothing takes the add lock it does not commit under (2026-11-17)

Read on `1.7.0-alpha.10`: a group created on the iPhone held its creator alone. The creation's own
commit admitted the creator's other devices; the web seat processed its Welcome, and the
group-ready sweep (`announceGroupReady` -> `processDeviceInvitationsLocally` ->
`processPendingInvitations`) found the group's `pending` rows - the creator's devices not yet
`active`, all already leaves of that very commit - and **took the group's add lock before reading
a single row**, only to vouch for them. In that second the iPhone's invitation asked for the lock,
was refused (`add-lock-busy`), and nobody was added.

Every taker of the add lock, and when it takes it:

| Caller | Takes the lock | What it commits under it |
| --- | --- | --- |
| `processPendingInvitations` (`actions.ts`), the sweep | **at the first row that needs an Add** (`takeLockForAnAdd`), after its leaf check and BEFORE its package is claimed; vouching, an ask raised for a member and a cleanup take none | the Add of a pending device NOT in the tree |
| `handleWelcomeRequest` (`actions.ts`) | **once the Add is decided**: after the cooldown, the refused-device check and the anti-livelock limit (a refused lock is not counted as an attempt), before the package is claimed | the Add or replace answering a `welcome_request`; a package missing or refused by the vetting is still learned under it |
| `processWelcomeRequestBackground` (Android FCM service) | on entry, after its "already refused from these bytes" check, before the package is claimed | the background answer; its native stage may still decline (`already-member`, `stale-epoch-known`, `foreground-active`), which only the stage - built from the claimed package - can tell. Left as it is: changing it means a native build, for a path that answers a request with an Add as its purpose; its `Thread.sleep` retry of the lock is a [backlog entry](../../backlog.d/p2-the-android-background-welcome-answer-retries-the-add-lock-on-a-clock.md) |
| `createGroup` (`groupCreation.ts`) | before the creation's Add of the creator's other devices | that Add |
| `processBulkAddition` (`groupCreation.ts`) | before the invitation's Add | the invitation |
| `performDirectAdd` (`groupCreation.ts`) | before the 1:1's Add | the peer's and own devices |
| `admitNewcomer` (`graine/admitNewcomer.ts`) | before the Add | a newcomer into a key-distribution group |

A lazily taken lock decides nothing the eager one did: it never made the local tree current (a
holder's commit may still be queued here when it releases) - the server's epoch gate does, and the
Add staged on a moved tree is refused and rebuilt. A refused lock ends the sweep's pass for that
group; its rows stay `pending` for the next sweep (`onGroupNotSwept`).

**A REAL Add in that second is still possible** - a sibling answering a `welcome_request`, or
adding a device it was owed - so **a member's FIRST invitation that meets another device's lock is
OWED, never refused** (`add-lock-owed`). `processBulkAddition` hands `acquireAddLockAnswer` an
`oweIfHeld` that states the invitation with its roster baseline (`owedInvitationOf`); on `held` the
service records it (`oweInvitationOnHeldLock`, at the group's current epoch) BEFORE the refusal
arms its wake. **The record merges, and a conclusion settles only what it covered**
(`owedInvitations.ts`): two gestures owed at one epoch - this one and a kept commit lost at the same
base, or a second invitation refused by the lock a drain holds - are one entry holding both people,
and a re-plan that concludes removes the people IT re-planned, never the entry. It then takes the path a lost invitation
waiting on `add-lock` takes ([mls-protocol](../../protocols/mls-protocol.md)): re-planned at the
server-stated end of the lock (`wakeAtAddLockExpiry`), a commit applied in the group, the release of
this device's own lock, or the next connection - events, never a retry on a clock - and every ending
that does not complete is told by `reportLostInvitation`. Not for a re-plan (it already is the owed
entry) nor for a join ask's answer (the member tapped it, and is told it is busy). A roster that
cannot be read records nothing: an entry without a baseline could never be re-planned, so that
refusal stays the member's to retry.

**What the member is told.** An invitation that added nobody names everyone it invited, from the
local name cache (they were just chosen in a panel that drew them): "Ajout non effectué pour
{names}. {reason}" / "Not added: {names}. {reason}" (`chat_invite_not_added`, owner 2026-11-17); an
owed one says when it will finish (`chat_invite_owed_add_lock_named`, a warning); the kept Add that
finishes by itself (`outcome-unknown`) names nobody.

Tests: `actions.pendingInvitations.test.ts` ("the add lock is taken only for an Add"),
`actions.welcomeRequest.test.ts` (the lock and the claim), `lostInvitation.test.ts` ("another device
holds the add lock"), `BaseMlsService.unresolvedCommit.test.ts` (the record and its wake),
`conversationRefusalMessage.test.ts`.

#### An unnamed group: no name stored, the members' first names drawn

The owner's decision: a group whose creator kept the suggestion stores NO name - the client sends
`createRemoteGroup(null)` (no `name` key; the `dm_groups.name` column stays NULL), the row stores
`''`, and no MLS statement names it - and EVERY device draws it by its current members' first names,
updated as people join or leave (Messenger and WhatsApp do the same). It fits
[sealed names](../../backlog.d/p1-encrypt-the-names-of-groups-communities-and-salons.md): the server never learns a name the members did not
choose, and the label is composed from what each device already holds.

- **Who**: the user ids of the group's RATCHET TREE (`getGroupMemberIdentities`, local), not the
  server's roster. Every member's device holds the same tree at the same epoch, so they name the same
  people; the roster is a routing table read at an instant. `groupTreeMembers.ts` keeps them,
  reactive, re-read after every inbound commit and every Welcome (`setupMessageHandler`) and after
  every commit of this device's own (`BaseMlsService.mergeAccepted`) - only for a group a label was
  ever drawn for, so a named group or a key group costs no read. A group is read on first sight. The
  newest read wins: a read that straddles a commit and answers last is dropped. A group this device
  does not hold (a newcomer before its Welcome, a follower tab) keeps the generic word.
- **What they are called**: the local display-name cache, by FIRST name (`getUserFirstNameSync`;
  a nickname set in the group replaces it, as everywhere in the group). Each member's profile is
  asked once when the tree is read, and the label fills in as profiles land.
- **The order** is the names' under ONE fixed collation, written out rather than left to an engine's
  ICU table (2026-11-27, so a WebView and the native push agree): Unicode NFD with every combining
  mark removed, lower-cased (`labelCollationKey`), compared code point by code point; then the names
  themselves; then the ids - never the tree's leaf order, so every device spells the same label.
  A name is TRIMMED OF A LISTED SET (`trimLabelName` / `is_label_space`), never a language's own
  `trim`, which disagree (JavaScript keeps U+0085 and strips the BOM, Rust the reverse): ASCII tab
  to carriage return, space, U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F,
  U+205F, U+3000, U+FEFF; a name of nothing else is the id.
  Up to three names are spelt out; past
  three, two are named and the rest counted ("Alice, Bob et 3 autres"), so the count is never one.
  The viewer is never named; alone in it, the group reads
  "Groupe".
- **Everywhere a name shows** reads `resolveConversationListPresentation`, whose last resort is now
  the members' label before "Groupe": the list and its search, the thread header, the conversation
  panel, the share sheet, a call's peers - and an in-app or Android-builder notification
  (`notificationGroupName` takes the resolved title for a group, `useMessaging`).
- **A push raised while the app is DEAD** (2026-11-27, the owner's entry of 2026-11-17) is titled
  the same way, composed ON THE PHONE by the one native copy of the rule,
  `src-tauri/src/mobile/unnamed_group_label.rs`, which every native push composer calls when the
  push declares a group (`isGroup`) and names none: the Android FCM service
  (`nativeUnnamedGroupTitle`), and on iOS both the extension (`unnamedGroupTitle`) and the app
  process (`CanariUnnamedGroupTitle`, `canari_push.mm`, reading the copies in the app's data
  directory) through `canari_native_unnamed_group_title`; `messageNotificationShape.test.ts` pins the
  two iOS call sites and both headers:
  - **who** is the group's current tree after the push catch-up: the push decrypt answers
    `treeMembers` (canonical user ids, sorted) from the state it just decrypted with, after its
    in-memory commit catch-up (`with_tree_members`, `background.rs`) - every commit it applied,
    including one made after the message's own epoch, so the title names who is in the group now,
    as the app's list does, and a member added or removed while the app was dead is already counted;
  - **what they are called** comes from the phone's own copies the WebView writes: the nickname in
    THIS group (`conversation_nicknames.json`), else the profile's first name, else its name
    (`display_names.json`, whose `firstNames` map the name mirror fills since this change,
    `nameMirror.ts` -> `store_display_names`; a first name never outlives its name: a note or a
    write that CHANGES the name without carrying a first name drops the old one, and one that
    re-sends the same name without it keeps it);
  - **ONE RULE, TWO IMPLEMENTATIONS, ONE CONTRACT**: the web cannot run the Rust and a dead app cannot
    run the WebView, so `libs/contracts/unnamed-group-label.cases.json` holds the rule and the
    words of both languages, read by `unnamedGroupLabel.contract.test.ts` and by Rust's
    `the_rule_answers_the_shared_contract`; Rust's words are also held to `messages/{fr,en}.json`
    (`push_text.rs`);
  - **no label** - a member the phone has never named (added while the app was away), no name file,
    another account's file, nobody else in the group, an unreadable message - keeps "Conversation de
    groupe" / "Group conversation", never an id or "someone" printed as a name; the native caller
    says which (`[GROUP_LABEL]`, info for an ordinary state, error for a fault).
  Principle 1 holds: the server sends only `isGroup` and no name, and the label is composed from ids
  the device already holds and names it already resolved. A build older than this one shows
  "Conversation de groupe" on a dead-app push, and one older than 1.7.0 reads the server's NULL name
  and shows "Groupe". A row that only knows its id (a newcomer's placeholder of a NAMED group, before
  the name arrives) shows the members' names for that moment instead of "Groupe".
- **Naming it later** is the ordinary rename (`groupRenamed`, dated by step 1 of the sealed-names work,
  PR #3785). Taking a name back off - "remove the name" - does not exist; a frame carrying an empty
  name is refused (`empty-name`).

Tests: `unnamedGroupLabel.test.ts`, `unnamedGroupLabel.contract.test.ts`, `groupTreeMembers.test.ts`,
`conversations.unnamedGroup.test.ts`, `groupCreation.unnamed.test.ts`, `nativeNotification.test.ts`,
`Sidebar.creationRefusal.svelte.test.ts`, `nameMirror.test.ts` (the first names), and in Rust
`mobile::unnamed_group_label` (the contract, the copies, the reasons),
`a_message_answer_names_the_current_tree_after_the_catch_up`,
`a_commit_past_the_message_s_epoch_is_in_the_tree_it_answers`,
`a_member_removed_while_the_app_was_dead_leaves_the_tree_the_push_answers` and
`an_unreadable_tree_answers_tree_members_error` (`background.rs`), and
`first_names_ride_beside_their_names_and_the_book_reads_them` and
`a_changed_name_without_a_first_name_drops_the_stale_one` (`display_names.rs`). Nothing here runs
Kotlin or Swift: the native callers are plumbing around the one Rust call. **Owed on hardware**:
[the reading](../../backlog.d/an-unnamed-group-s-push-names-its-members-by-first-name.md).

## Per-conversation nicknames ("Modifier les pseudos", 2026-11-08)

The user's Messenger screen (asked 2026-10-14, rules 2026-10-14 and 2026-10-18): every member listed,
the name the conversation shows for them, a pencil, "Définir un pseudo". `NicknamesPanel.svelte`,
opened from the conversation panel (`ChatGroupPanel`, a DM included: both people) and from a salon's
member list (`ChannelMembersList`, the COMMUNITY's members). What the screen offers is
`nicknamePermission.ts` (`mayNameMember`, modelled on `pinPermission.ts`); where a change goes and
what it comes to is `nicknameActions.ts` (`saveNickname`, one typed outcome per sentence).

**Two mechanisms, one register shape** (`conversationNicknames.svelte.ts`): per scope, per member,
`{ nickname | null, setBy, at, verified }` merged by date - the later wins; on a tie a reset wins, then
the larger `setBy + nickname`, so every device settles the same pair the same way. **An authenticated
entry (`verified`: an MLS frame, the viewer's own change, the server's answer) always beats an
unverified one, whatever the dates.** The register has a HARD cap of 500 entries
(`MAX_NICKNAME_ENTRIES`), verified ones included, evicting a member no longer in the conversation
first, then an unverified entry, then the oldest. A reset is DATED like a set, so
a late statement cannot resurrect a cleared name. Nothing is keyed by the setter: a nickname stays when
its setter leaves.

| | DM / group (MLS room) | Community |
|---|---|---|
| Who may set | any member, any member (no ranks) | a moderator (`viewerCanModerate`); the target may only CLEAR their own |
| Carried by | a silent `nickname` system frame, `{ userId, nickname, at }`, `DELIVERY.mutation` (`setConversationNickname`) | `channel_members.nickname`, `nicknameSetBy`, `nicknameSetAt` (migration 149), written by `PUT /api/channels/workspaces/:id/nicknames/:userId` |
| Checked by | every reader: the setter is the MLS-authenticated sender, never a payload field; the value is held to the contract; the TARGET must be in the tree (`getGroupMemberIdentities`, `nicknameMembersOf`), with an unreadable tree refusing the frame (`applyNicknameFrame`). The setter is not checked against the current tree: decryption already proved they were in it at the frame's epoch, and a check against today's tree would make a device that reads the frame after a commit removing the setter disagree with one that read it before. Live and replay apply one rule | the server, on every write (`CommunityNicknamesService.set`, `memberCanModerate` read from the role rows) |
| Reaches others | the group's shared log (live and replay) | `workspace.updated { workspaceId, nickname }` to every member, plus `GET .../nicknames` read once per session at the first salon opened and at each opening of the screen |
| Kept | per device AND per account, `localStorage` `canari_nicknames:v1:<account>:<groupId>` (`ACCOUNT_KEY`; the 500-entry hard cap above), wiped at sign-out (`clearUserLocally`) and by the account deletion's sweep (`eraseAccountRecordsLocally`) | in memory; the server holds it |

**The late joiner.** A member added after a `nickname` frame went out never receives it. The
inviter's JOIN PUSH to the new device restates the register (`nicknames`, beside `pins`), even when
every message is withheld, so a new member gets the names in the first bundle; since 2026-11-17 the
push carries the state and NO message (the messages come by the newcomer's own sealed reconciliation,
[history-answer-addressing](../../protocols/history-answer-addressing.md#what-is-not-sealed-the-inviters-join-push---so-it-carries-no-message-2026-11-17)).
That join push and the answer to the newcomer's own register ask (below) are the ONLY bundles a
register is taken from (review of #3177). **It hangs on the delivery of a Welcome, not
on a caller** (#3185). `BaseMlsService.sendWelcomeConsuming` is the one place a Welcome is known
stored by the server, whoever sent it - the member's "Ajouter" (`inviteMembersToGroup`, which a
join-request approval also is), a pending invitation, a welcome_request answer, a group's creation, or
the owed-Welcome drain (`deliverOwedWelcomes`) that delivers a Welcome whose first send failed or whose
Add's commit was only settled later. It announces each delivery once (`onWelcomeDelivered`; a
concurrent send of the same bytes awaits the first), and `joinPush.ts`, installed with the service in
`useChatSession`, answers it:

- **once per Welcome, from durable state**: a per-account ledger (`mls_join_pushes_sent:v1:<account>`,
  a 512-entry FIFO) names each pushed Welcome by group, device and a fingerprint of its bytes, written
  before the push starts. The drain consumes what it delivers, so a re-run sends nothing; a reload that
  lost the clear re-sends the same bytes, and the ledger stops the second push (the joiner, already
  holding the group, would refuse it as answering no ask). A re-add is a new Welcome and is pushed for;
- **off the gesture**: queued synchronously at the delivery and run one at a time, never awaited by the
  Add, so "added" shows at once; each push caught and logged on its own (`[JOIN_PUSH]`);
- **never into a key group** (`isDistributionGroup`);
- **for the session that delivered it**: the account, the store and the device key are read when the
  delivery is announced, and a job whose client the session holder let go of (a sign-out, an account
  switch) is dropped at its turn (`isCurrent`, `MlsHolder.current`), so a queued push never runs with
  the next account's data through the previous account's MLS client.

**The limit it keeps: online only.** The push is an ADDRESSED frame, and an addressed frame is
transport-only - the server publishes it to a device all of whose live sessions declared the capability
and refuses it otherwise (`addressed_unsupported`); it is never queued. A newcomer whose device is not
connected when its Welcome is delivered gets no push, and nothing retries it. **The push is not sent to
find that out**: the Welcome's answer says whether the server can address the device
(`DeliveredWelcome.addressability`, [history-answer-addressing rule 3](../../protocols/history-answer-addressing.md#the-rules-as-built)),
and a device answered `offline` or `undeclared` is sent nothing. That outcome - or, for a device that
left between the Welcome and the push, the send's own refusal (`sendFullHistoryBundle` ->
`unaddressable`) - is said at debug (`[JOIN_PUSH] ... no push to <device>`), naming the follow-up:
since #3777 the newcomer asks for its register at its next connection, so an offline newcomer is the
ordinary case and no longer a warning (it was until 2026-11-17, and named a step that had shipped). **The fix is the newcomer asking, not the inviter retrying**, and the reasoning is the
choice: an inviter retry "when the device becomes present" rests on two things nobody holds durably -
the newcomer's `join` ask lives in memory (`noteJoinSolicited`), so a reload between the Welcome and the
retried push refuses it, and the inviter's own device has to come back while the newcomer is online.
The newcomer, by contrast, is online by construction when it asks, already runs a reconciliation on
every connection whose deferral waits for a member to return, and can keep a durable "register owed"
marker until an answer clears it. So the register rides the existing digest ask (`register: true`)
and its elected answer, sealed to the ask, under the same four limits below
(`registerOwed.ts`, built 2026-11-17 in a draft pull request:
[the mechanism](../../protocols/history-answer-addressing.md#the-newcomer-asks-for-its-register-2026-11-17),
its entry (entry deleted 2026-11-18, every half read)).

Before #3185 only the pending invitation and the welcome_request answer pushed, each by an explicit
call: a newcomer added by "Ajouter", or whose Welcome came from the drain, saw no nickname at all
(reading 2 of `1.6.9-alpha.1`, fixed by #3185; re-read on the phones and the web seats, and every
item of the reading closed on 2026-11-18, [S6](../../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).

**What a push costs.** `sendFullHistoryBundle` decrypts the inviter's whole store for the group and,
in `sendBundleChunks`, re-reads the reader's windows for EVERY 200-message chunk - deliberately: a
chunk is filtered on the windows in force when it leaves, so a member removed or re-added meanwhile
is held to the current answer. For a newcomer every chunk is withheld, so a store of N messages costs
one full decrypt and N/200 window reads to send a state-only frame. It is not reduced here (the
per-chunk read is the correctness property); it no longer delays the member's gesture.

**Why it does not breach step A** ([the decision](../../protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)).
Step A forbids a newcomer the MESSAGES sent before their arrival; the push is addressed to the new
device and filtered on its owner's server windows, so for a newcomer it carries no message from
before - a state-only frame, or only what was sent since the Add. A nickname is not a past message:
it is the name the conversation shows TODAY for a current member, which the newcomer reads on every
later frame anyway, and which the screen marks "Défini avant votre arrivée" rather than attributing.
Its only trace of the past is the entry's date and the setter the relayer states, and the screen
names neither as a fact: the entry is unverified, the relayer's word. A broadcast or replayed bundle carries none,
and an answer to a later ask carries none either. A bundle's entries are the relayer's word about what
others did, so a relayer could forge a setter and pass the target's block check. So
`mergeBundleNicknames` applies four limits:

- it takes every entry UNVERIFIED;
- it requires the TARGET to be a current member of the MLS tree (`getGroupMemberIdentities`). The
  setter may have left since: a nickname stays when its setter leaves (owner, 2026-10-18);
- it takes at most as many entries as the group has members;
- it bounds each entry's date by the bundle's server time.

An unverified entry naming the viewer never takes the "I set it myself" shortcut, and any frame
supersedes it. The screen does not name its setter as a fact: it reads "Défini avant votre arrivée"
(`chat_nicknames_set_before_you`) where an authenticated entry reads "Défini par X".

**The sender's clock is bounded by the server's.** A frame's `at` is the sender's claim. Left
unbounded, a date far in the future would freeze a nickname against every later change. Every path
clamps it to the server time it already has plus 5 minutes (`boundedNicknameAt`,
`NICKNAME_CLOCK_SKEW_MS`):

- the live frame uses `deliveryMeta.queuedCreatedAt`;
- the replay uses its log entry's timestamp;
- a bundle uses its own `queuedCreatedAt`.

The receiver's clock never stands in for the server's. Every copy carries a server time: a pulled copy
has its queue row's `createdAt`, and a live copy has the same `createdAt`, which chat-delivery
publishes and the gateway forwards (`live_mls_frame`). A frame without one is a defect upstream, and
it is refused at error level.

**A correction is dated to win.** `saveNickname` dates a group change
`max(now, held.at + 1)`, where `held` is the entry being replaced, and bounds the local apply as a peer
does. A peer uses its server time; this device uses its own clock at the send. The outcome then
depends on what the device already holds:

- If a held statement still outranks the change, nothing is sent, and the outcome is `superseded`
  (`chat_nicknames_error_superseded`).
- If a newer statement lands while the frame is being queued, the outcome is also `superseded`.

In neither case does the screen say "saved".

**Old clients.** An unknown system event is ACKed silently, so an older build ignores the frame. The
community change rides `workspace.updated`, whose absent fields every build reads as "unchanged"; a new
event type would have been logged as an error by every older one. Read on the Mi 9T on 2026-11-18 with `v1.6.7-alpha.1`: a group and a community nickname set
by a web seat gave only `[MLS] System event 'nickname' ...`, no warning or error, and the community member under
its profile name ([S6](../../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).

**The name is resolved in ONE place.** `getUserDisplayNameSync` / `getUserFirstNameSync`
(`displayName.ts`) and `userDisplayName` / `userDisplayNames` (`displayNames.svelte.ts`) take an
optional `scope`; with it, `visibleNickname` overrides the profile name, without it nothing does. Every name drawn INSIDE a conversation passes the open conversation's scope (`MainChatPage`'s
`nicknameScope`; a salon reads its COMMUNITY's register, `community:<id>`):

- the thread: sender labels, the typing line, the reply caption and quote (`MessageBubble`), the reel
  viewer's author (`MessageMediaRenderer`) and the "seen by" list (`MessageInfoTooltip`);
- the composer's reply bar;
- the DM header and the DM's sidebar tile (`ConversationTile`, scoped by its own id);
- the member lists (`ChatGroupPanel`, `ChannelMembersList`);
- the shared-media panel;
- the call overlay's title (the call's group).

Nothing else passes it, except a NOTIFICATION about that conversation (below). An admin access list
and the OS's media session stay unscoped. The register's reactivity is ONE module-level revision every reader reads and every
write bumps: a register first created inside a `$derived` would be a source of that derived, which
Svelte does not track, and the screen kept the old name until that was found.

**A notification names a member by their nickname in that conversation, composed by the device**
(owner, 2026-11-14, reversing the 2026-11-08 rule that kept nicknames out of every notification):
*"comme sur Messenger, tous les pseudos"* - the nickname set in THAT conversation, whoever set it,
lock screen included; and *"Tout pourrait etre donne par l'appareil et rien par le serveur, ce serait
plus homogene"* - no server puts a nickname in a push, for any kind (DM, group, community). The
owner's reasoning: the server will soon know nothing (content-free push), and the device composes
the notification and holds the nicknames. Blocks apply exactly as on the screen: a nickname of the
viewer set by somebody in a block with them is not shown, and while that block status is unknown the
profile name is.

One rule, `libs/contracts/notification-nickname.cases.json`, asserted by every reader:

| Path | Where | What names the member |
| --- | --- | --- |
| The WebView's own notifications (web, desktop, the iOS app alive, and Android's socket trigger) | `notifyInbound` -> `resolveNotificationSenderName(senderId, conversationKey, convo)` / `notificationSenderName` (`displayName.ts`) | the one resolver with the scope of `notificationNicknameScope` (the group itself, or a salon's `community:<id>`, from the salon placements `noteSalonCommunities` keeps) |
| The native copy | `nicknameMirror.ts` -> Rust `store_conversation_nicknames` -> `conversation_nicknames.json` (data directory, and the iOS App Group) | `{userId, scopes: {scope: {member: nickname}}, channels: {salon: scope}}`, only nicknames the account may SEE (`mirroredNickname`: the block rule is applied before the write, and a block answer re-mirrors) |
| Android FCM (killed app) | `CanariFirebaseMessagingService.nicknameLookup` -> pure `push/ConversationNicknames.kt` | an MLS frame's banner (`shownName`), a salon's speaker (`ChannelBannerAuthor.of(nickname = ...)`, a PROVEN author only), the socket trigger's salon speaker, a chat reaction's actor, the call ring's caller (`knownCallerName`) |
| iOS extension | `NotificationService.conversationNicknameLookup` / `conversationNickname` | the MLS banner (`shownName`), the salon speaker (`channelBannerAuthor(nickname:)`) and its "X vous a mentionne" line, a chat reaction's actor |
| iOS app alive | `canari_push.mm` `CanariConversationNicknameLookup` / `CanariConversationNickname` | the MLS banner, the salon speaker (`CanariSalonSpeaker`) and its mention line, a chat reaction's actor, the CallKit caller (`CanariCallerDisplayName(callerId, groupId)`) |

What stays the profile name, and why:

- **The mention tokens in a body** (`@[<id>]`): the thread's own chips (`MessageMentionChip`) name the
  profile, and a notification says what the screen says.
- **The Rust push scanner** (`proto_fields.rs`, `push_text.rs`) composes sentences whose subject is the
  banner's sender line, and names nobody itself.
- **The server's display-name copies** (`senderName`, a reaction's `title`, `actorName`) stay the
  profile and are only a fallback the device overrides; they go with content-free push. A server never
  reads a nickname column for a push (owner, 2026-11-14).
- **A salon whose community this device has not placed** (the sidebar has not listed it yet) or whose
  nickname list it has never read: a community's register is the server's and lives in memory, so it
  reaches the copy only once read (`loadCommunityNicknames`, the first salon of it opened in a session,
  or a live `workspace.updated`). Once mirrored it stays in the copy across launches, until the
  sign-out.

**The copy follows the account.** It names its owner: every reader uses it only when the owner is the
account of `push_context.json`, a write for another account REPLACES it, every session writes it once
even with nothing to say (so it names the signed-in account from then on, and an absent file is a
fault, not a state), every register stored for the signed-in account is restated WHOLE once per
session (`mirrorStoredNicknames`, `ChatBackgroundService`; `restatedScopes` empties each scope before
its entries apply), a community's list read from the server restates that community whole
(`restateMirroredScope`: after a relaunch the register starts empty, so a member the list stopped
naming would otherwise keep the old nickname in the copy), the salon placements are one account's
(an account switch places every salon again), the sign-out waits for a write in flight before it
removes the copy,
the sign-out removes it (`forgetConversationNicknames` -> `forget_conversation_nicknames`, the owner
checked), the account deletion removes it with the other push files
(`remove_account_push_and_name_files`), and the factory wipe removes the App Group copy
(`wipe_group_names`). Capped at 5000 nicknames and 2000 salons.

**A block.** A blocked person cannot rename the blocker. In a community the server refuses
(`403 USER_BLOCKED`, `isBlockedBetween`, either direction). In a group no server reads the frame and
a block is private, so no third member can know of one: the SETTER's screen asks `block-status` before
sending (and sends nothing when it cannot ask), and the TARGET's own devices show a nickname of
themselves set by someone else only once `block-status` for that setter answered "clear". The answer
is keyed by viewer and setter, and asked once. A failed ask is a state, `unknown`, which the read
depends on. `connectivity.onReconnect` clears it, and the next read asks again: no timer, and no
dependence on an unrelated re-render. **The remedy survives the hiding.** The screen reads the RAW
entry, so a target who cannot see a nickname of themselves still sees "a nickname you cannot see is
set" (`chat_nicknames_hidden_for_you`), with its reset. That notice appears only once the block is
KNOWN (`nicknameHiddenByBlock`). While the question is pending or unanswerable, the row shows the
plain name and nothing else, so no text appears that the answer could prove wrong.

**Limits** are the profile's, in `libs/contracts/conversation-nickname.json`, walked by both
`nicknameRules.contract.test.ts` and social-service's `community-nicknames.spec.ts`:

- NFKC normalization;
- control, format and line/paragraph separator characters dropped (`stripInvisible`), with two
  exceptions that are writing, not hiding:
  - judged per grapheme, as #3175's role labels are: U+200D inside a grapheme holding a pictographic,
    never as its last code point (families, professions, the rainbow flag);
  - the tag characters only in a tag flag: a grapheme starting with U+1F3F4 and ending with U+E007F
    (the England flag);
  - U+200C/U+200D between two letters or marks of a script that spells with them: Arabic (Persian),
    Syriac and the Indic scripts. Never between Latin, Greek or Cyrillic letters, where a joiner only
    splits a name that looks whole;
- trimmed; empty means reset;
- at most 100 code points (`nickname_too_long`).

**The community list is a snapshot, and is read again.** `loadCommunityNicknames` runs once per
connection: the read is cleared when the socket drops and re-runs on the reconnect. It drops any held
entry the list no longer names (a member who left, a membership made afresh, whose `nicknameSetAt` is
NULL), except an entry a live event changed while the list was in flight. Each read carries a
sequence number per community, and an answer whose read is no longer the latest is dropped, so an
older answer never overwrites a newer one.

**Reports and reversal.** A community nickname is reportable (`contentType: 'nickname'`) by a member
of that community; the subject is one VERSION, `<member row id>@<set-at ms>`, so a nickname changed
since is no longer reportable and the next one is a new subject. The setter is read from the row. The
admin queue shows its text while that version is shown, none once it changed
([moderation-and-blocking](../../moderation-and-blocking.md)). A moderator reverses one by clearing it
on the screen. An MLS group's nicknames reach no server, so they have no report: the target resets
theirs, or blocks.

### Channel access is a choice, not a switch (2026-11-10)

Channel settings > Accès draws visibility as a two-option `SegmentedControl` - **Public** (every community member) and **Restreint** (only the allowed members) - with both one-line explanations listed under it and the current one emphasised. It replaces a `role=switch` that was ON for *private*: a public channel therefore showed "Canal public" beside a grey, OFF track, which read as "public is disabled" (owner report, a dark pattern). The binding was NOT wrong (`accessIsPrivate` is the server's `isPrivate`, the card only renders after the load); the control's polarity was. Decision by the lead, reversible. A member without `channel.manage` sees the explanations only. Picking the current option writes nothing; picking the other one asks the same confirmation as before.

## The media viewer of a conversation walks its images and videos (2026-11-13)

Opening an image or a video from a bubble no longer ends at that item (owner, 2026-11-13): the same
viewer moves to the previous or next image or video of THAT conversation, like a gallery.

- **One viewer, two doors.** [`ConversationMediaViewer`](../../../../frontend/src/lib/components/chat/ConversationMediaViewer.svelte)
  takes a list and the key of the item to open on; the "Medias" panel and `MessageMediaRenderer`
  both use it, so they cannot drift. The arrows (pointer devices), the horizontal swipe (touch) and
  Left/Right are `MediaLightbox`'s own, shared with posts (`showPrev`/`showNext`), as are the
  rotation and fullscreen of a video ([screen-orientation](../screen-orientation.md)).
- **The sequence is what the client already holds.** `MainChatPage` provides one loader
  (`provideChatMediaSequence`, a context, so no prop crosses five components) over the same local
  read as the panel (`loadSharedContent`: storage for DMs and groups, the in-memory messages of a
  channel). No history fetch is ever triggered to extend it. `buildViewerSequence` orders it OLDEST
  FIRST (left = older), and drops a CanaReel sent in the chat (a tile with its own viewer), a media
  whose expiry hint has passed, one this device met a `410` for (`mediaPurgedAt`) and a deleted
  message (the aggregate already skips it). One message carries one media; the key is
  `messageId:mediaId` so a second attachment would be its own item.
- **It opens at once, then gains neighbours.** The bubble's decrypted URL is passed as `known`
  (never released by the viewer, it is the bubble's); the list arrives a moment later and the viewer
  stays on the same item BY KEY - no remount, no second history entry. A neighbour is decrypted when
  reached, through `MediaService.downloadAndDecrypt` like the panel's.
- **No wrap-around** (`viewerBounds`): the newest wrapping to the oldest would jump across the whole
  conversation on one stray swipe, and an end that stops tells the reader there is nothing further.
- **A video stops when you move**: the next item replaces the player (`{#key}`), which unmounts it.
- The panel's list stays newest first (its grid order), so there its "previous" is the newer one.

Tests: `viewerSequence.test.ts` (order, skips, bounds), `ConversationMediaViewer.svelte.test.ts`
(keyboard, ends, video stop, known URL). **Owed: a reading on a phone** - swipe between a photo and
a video in a conversation with both, rotate a video, then move on.

## Mes notes - the conversation with oneself (2026-11-22)

**What the owner decided** ([decisions](../../decisions/owner-decisions-of-2026-11-22.md), charter
principles 1 then 2): the personal notepad moves into `/chat` as a conversation whose only members
are the account's own devices, end-to-end like any other. The server side is
[chat-delivery](../../services/chat-delivery.md#mes-notes---the-self-conversation).

**The row.** `conversationType: 'self'`, built by `selfConversationIdentity()` and never with a
`directPeerId`. Its name and roster cannot say what it is (a legacy malformed `u::u` 1:1 looks the
same), so the server's `kind` is carried to every place a row is born - `ensureConversationForServerGroup`
(listing and recovery) and `upsertConversation` (a Welcome) - and stored: `ConversationMeta.kind =
'self'`, a `kind` column in SQLite (added on every open) and the same field in IndexedDB.
`restoredConversationRow` reads it back before any name parsing.

**The name (owner, 2026-11-25, `1.8.1`).** The row no longer says "Mes notes" with a Bookmark: it is
the account's OWN avatar and "Prenom NOM (Notes)" (`selfConversationTitle`, the name from the one
resolver, the suffix `conversation_self_named` in fr/en), in the row, the header, the share pickers
and the notification (`notificationGroupName`, `selfUserId`). The search matches the own name like a
person's AND the aliases `conversation_self_search_aliases` ("notes", "mes notes", "my notes";
`matchesSelfConversationAlias`, `selfConversationMatchesQuery`, and the picker filter). No avatar
means the usual initials. The own name is read REACTIVELY like a DM peer's (`userDisplayName` in the row and the header; the pickers ask for it through `missingPeerNameIds` and `peerNames`), so a late or renamed profile repaints them without a reload. Tests: `selfConversationName.test.ts`.

**The list (owner, 2026-11-25).** The row (own avatar and name, see above, and the subtitle "Visible
uniquement sur vos appareils") is NOT pinned: it sits in the one recency-sorted list
(`compareConversationRecency`, the same search filter) like every other conversation, so a newer DM
is above it and an older one below. **A device that holds no Notes conversation yet** draws one
placeholder entry AFTER the list (it has no recency; the first tap creates it, `openSelfConversation`),
so it stays discoverable without jumping above real activity; it is searchable by the same aliases.
A tap on a held row opens it. The earlier pin at the top was wrongly attributed to the owner (see
[the decision](../../decisions/owner-decisions-of-2026-11-25.md)). Covered by
`Sidebar.selfRow.svelte.test.ts`. The share-destination pickers (`shareDestinations.ts`) never
pinned it: they rank by their own recency, unchanged. Only ONE self row is drawn (the first held,
non-removed one), and the "no discussion found" message is not shown beside the placeholder of a
search. A row of a self group built while its kind
could not be read (a Welcome whose group read failed makes a `group` row) is re-typed by the next
listing (`retaggedAsSelf` in the `known` branch of `ensureConversationForServerGroup`). The share
pickers draw it the same way (`ConversationPickList`).

**Creation.** `createSelfConversation` (in `groupCreation.ts`, sharing `createOwnedGroup` with
`createNewGroup`) creates the group with `kind: 'self'`, adding only the account's other devices whose
build stated the capability (`devicesKnowingSelf`, `SELF_CONVERSATION_VERSION`, sent on every
registration). A follower tab delegates it to the leader (`create-self` in `tabCommitDelegation`).
When the server already holds one it answers `SELF_CONVERSATION_EXISTS` (`SelfConversationExistsError`,
typed at the throw, never logged as a failure) with the live `groupId` and `otherHolders`, and the
client decides on those facts: a group this device holds is opened and its row re-typed; another
holder means `self-conversation-arriving`; no holder means one more request with `replaceUnheld`,
which has the server end the unreadable group and write a new one
([server](../../services/chat-delivery.md#mes-notes---the-self-conversation)). The notes are believed
only from the answer's own `kind: 'self'`: a server older than 056 writes an ordinary group, which
is deleted as such and the creation refused (`SelfConversationUnsupportedError`,
`self-conversation-unsupported`, [legacy-compatibility](../../legacy-compatibility.md)). The row is
offered only to a signed-in session: the logged-out preview gets no `onOpenSelfConversation`, so it
draws no row (`Sidebar.selfRow.svelte.test.ts`).

**The header.** `ChatHeader` with `isSelfConversation`: no calls, no settings, the own avatar
and the lock subtitle. Every `directPeerId` path (peer resolution, DM repair, blocking, nicknames,
calls) skips a self row because it has no peer; notifications name it with the reader's own label.

**The loss notice** (charter principle 2): while a single device HOLDS the notes, the top of the
conversation says that losing it loses the notes and links the `.canari` backup
(`SelfConversationLossNotice.svelte`, read once per opening). A holder is an active device of a build
that knows "Mes notes" (`selfConversationVersion >= SELF_CONVERSATION_VERSION`, from `listUserDevices`,
a peek that claims nothing) AND seated in the group (`getGroupMembers`): a second device that merely
exists is no copy. Either read failing says nothing - `readSelfConversationDeviceCover`.

**The notepad moves in (owner, 2026-11-22 items 12-14, moved to `1.8.2` on 2026-11-25).** The
personal notepad sat in `users.notesCiphertext` under a key core-service held (`users.notesKey`),
which charter principle 1 refuses; principle 2 says nothing may be lost on the way
([principes](../../../principes.md)). `notepadMigration.ts`, run by `ChatBackgroundService` once per
signed-in account whose conversations are all drawn (leader tab only, again when "Mes notes" appears):
reads the notepad (`GET /users/me/notes`, decrypted under `GET /users/me/notes-key`, or the legacy
plaintext), creates or finds "Mes notes" WITHOUT selecting it (`openSelfConversation(ctx, { silent })`),
posts the notepad as a message under a heading (`notepad_moved_heading`), and only once the outbox says
the message is SENT asks `POST /users/me/notes/moved { digest }`, which deletes the notepad, its
plaintext and its key in one conditional statement (`apps/core-service/src/users/notepad.ts`).

*Why it can neither post twice nor lose anything* - idempotence from durable state, termination from
the server's answer, no clock anywhere:

- **The message id is derived, not minted** (`notepadMessageId`: SHA-256 of the account and the
  notepad's digest, shaped as a v8 UUID). A kill after the post replays under the SAME id: the device
  asks its own store first (`heldAs`) and queues nothing new. Two devices of the account moving the
  same notepad post the same id; each receiver keeps one row ("all already held").
- **The server's notepad is the "still owed" bit.** It is deleted only after the post is sent, and
  only if the digest named is the notepad held NOW: a save an older build made between the read and
  the delete changes it, the conditional `UPDATE` matches nothing, the answer is `409
  NOTEPAD_CHANGED`, and the next run moves the newer notepad as a second message (another digest,
  another id). A kill between the send and the delete leaves the notepad owed and the message held:
  the replay finds both and only deletes.
- **No notepad is ever created again**, so "none held" is final: every old route answers `410
  NOTEPAD_MOVED` to an account holding none - the read, the key (never minted) and the save, which
  writes only over a notepad still held, in the same statement as its condition. That finality is
  what lets the device keep a local mark (`notepadDoneMark`) once the server has said it, and ask
  nothing in later sessions.
- **What waits:** a message only queued, or parked failed for the member's Retry, keeps the notepad
  on the server; "Mes notes" arriving from another device (`self-conversation-arriving`) posts nothing
  until its Welcome lands; a read with no answer changes nothing. Every branch logs `[NOTEPAD]`.

*The entry point is removed in the same build* (the entry's ordering rule: never before the
migration ships). The profile's notepad section is gone (`profileSections.ts`; an old
`/profile/me/notepad` link lands on the hub through `+page.ts`'s unknown-segment redirect), and the
build that removes it is the build that moves the notepad, at the first signed-in session; until that
session the notepad stays on the server, unread but whole. An older build keeps its page and may edit a
notepad not moved yet; once moved, its read answers `410` (its load error is shown) and nothing it
saves is accepted - the notes are in "Mes notes" on the moving device. Recorded in
[legacy-compatibility](../../legacy-compatibility.md). The three emptied columns are dropped by a later
held migration ([the entry](../../backlog.d/p3-drop-the-notepad-columns-once-every-notepad-moved.md)).

**The retention line** (item 13). Below the loss notice, always: the photos, files and voice notes of
"Mes notes" follow the ordinary conversation retention - the server deletes them after 90 days
unopened, by default (`conversation_self_retention`, `SelfConversationLossNotice.svelte`).

**The delete.** A self row has no settings, so the header offers "Supprimer mes notes" in their place
(the desktop icon, the phone menu entry; `onDeleteSelfConversation`). It asks first, `danger` (nothing
can bring the notes back), then runs the ordinary exit (`exitGroupAndCleanup`: retired first, owed
durably, answer classified) with the kind stated: `deleteGroupAndBroadcast({ kind: 'self' })` sends
`?kind=self`, and the owed row is the verb `delete-self`, which the replay
(`drainPendingGroupExits`) sends the same way - the row that knew the kind is gone by then. Both stores
narrow the verb through `isPendingGroupExitKind`, so a build that does not know `delete-self` keeps the
row unrun. Tests: `useConversations.exitGroup.svelte.test.ts`, `pendingGroupExits.test.ts`,
`pendingGroupExitsStore.test.ts`, `groupActions.exitPropagation.test.ts`,
`ChatHeader.selfConversation.svelte.test.ts`, `notepadMigration.test.ts`, and core-service's
`users.service.spec.ts` and `user-write-gone.integration.spec.ts` (the conditional statements against
PostgreSQL).

Tests: `selfConversation.test.ts`, `mlsDeliveryApi.selfKind.test.ts`, `sqliteConversationColumns.test.ts`, `sqliteMigrations.test.ts`,
`tabCommitDelegation.test.ts`. **Owed: a reading on both phones** - open "Mes notes" on one device,
write, add a photo and a voice note, then read them on the account's second device; and an account
holding a profile notepad sees it arrive in "Mes notes" once
([the reading](../../backlog.d/reading-owed-mes-notes-on-both-phones-and-the-notepad-move.md)).

### The jump outline follows the bubble (2026-11-26)

Owner, web desktop: a replied-to message reached by a jump was boxed in a pale accent RECTANGLE
covering the "vous a repondu" header, the quoted chip and the bubble - *"le vrai contour, pas un
rectangle moche"*. The cause: `navigateToMessage` put `chat-message-jump-highlight` (a `box-shadow`
pulse, `app.css`) on the `msg-<id>` row, which wraps all of them. It is now put on the element marked
`data-message-bubble` inside the row, so the shadow follows that element's own radius, the grouped
corner variants of `getBubbleShapeClass` included. This is the ONE mechanism: jump to a reply, the
pinned banner, the poll shortcut and a search hit all go through `navigateToMessage`. Decisions:
the quoted chip is a second, separate bubble (`MessageReplyQuote`) and is not outlined; a bubble with no
fill of its own (media alone, link card, poll, emoji) carries `rounded-bubble` so the shadow still has
a corner; a row with no bubble (system notice, channel invite card) is its own shape and carries the
class itself. The old `isHighlighted` ring prop of `MessageBubble` has no caller and was left alone.

## A quoted photo is drawn, not named (2026-11-27)

Owner's two minifixes. **No frame:** a message that answers another keeps the render it would have without the reply
(`MessageBubble`; superseded the same day by the owner's general rule, *"c'est pas parce que c'est une
reponse qu'il faut mettre un contour"*): a captionless attachment of ANY kind, a link, a GIF, a lone
emoji (jumbomoji) and a poll stay naked, and a photo with a caption keeps its bleeding layout (the
bubble's corner facing the quote is flattened by `stackedQuotePosition`). The quote is a separate
block stacked above; only a plain text reply keeps its bubble.

**Thumbnail in the quote:** a stored quote carries only a text preview, so `ChatMessageGroups` looks
the original up in an id map of the messages it already renders (`quotedVisualMedia`, never a fetch; the same original answers with the same object) and hands
its ref to `MessageReplyQuote`, which draws `ReplyMediaThumb` (60% opacity, `aria-label` = the kind
label) from, in order: the decrypted blob already in memory (`retainWarmDecryptedMediaBlobUrl`,
released on teardown; an `$effect` keyed on the ref; a VIDEO takes no hold - pinning its blob for a quote would keep it alive - and uses its ThumbHash), else the ThumbHash the sender embedded, else
today's text label. The last two states are legitimate (original not loaded, expired, never opened)
and log at debug only. A quote mounted before its original finished downloading takes the blob the moment it lands
(`onDecryptedMediaHeld`, a one-shot arrival listener on `BlobUrlPool`; no polling, no remount).

## A reply keeps its quote after a restart (2026-11-27)

Read on the iPhone 12 (`1.8.3-alpha.1`): a photo sent as a reply showed its quote header and thumbnail
until the app was killed, then drew as a plain photo. A stored row has NO `replyTo` field - the quote
lives in the envelope of `content` - so a restart shows exactly what the envelope was written with, and
the envelope was written without it. **Cause:** a file sent as a reply is queued with its quote in the
encrypted payload, which the lane's queue read leaves undecoded for a media row. When the upload ended in
this page life the lane rebuilt the entry as `{ ...slimRow, media: settled.media }`, so `buildMediaMessage`
built the proto, the in-memory row and the stored row with no `replyTo`: the screen kept drawing the
quote from the echo's in-memory `replyTo`, and **the peer never received it either**. The upload task now
keeps the quote read from the full row (`UploadTask.replyTo`) and gives it back with the settled payload
(`outbox.replyingFile.test.ts`: the frame carries `media.replyTo`). A second, separate cause of the
same sight: `ChatMessageGroups` looked the quoted photo up by `msg.replyTo` only, so a row read back from
the store lost its thumbnail even when its envelope kept the quote; `quotedIdOf` reads the envelope too.
A reply sent from a build before this fix stays a plain photo on both sides: the quote was never written.
