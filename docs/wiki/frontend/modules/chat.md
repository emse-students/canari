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
  conversation in a CENTRE PILL (avatar, name - tap opens its settings), and `GlassMenuButton`
  ("Plus d'actions") growing into the SAME actions as the classic row, under the same conditions -
  calls when their handlers are given, a channel's members first, media, search, settings.
  `ChatHeader.phoneMenu.svelte.test.ts` holds that parity, and that the website draws none of it.
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
  `bindFixedPopover`'s new `stayAnchored`, since a panel that grows OUT OF its button must not be
  centred however wide it is. Its `plain` variant is the same menu without glass: the website's phone
  paperclip. An entry with an on/off state (search, members) is a `menuitemcheckbox`.

**On iOS the four pieces are real Liquid Glass** (WP-G2): each is doubled by a native glass button
drawn at its rect, the web piece kept as its invisible geometry, and the menus are native
([mobile](../mobile.md#the-conversations-native-glass-chrome)).

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
| `ChatComposer.svelte` | Message input, media picker, reply preview. **The drop badge ends at the WINDOW, not the panel** (2026-09-25): a drop on the editor stops propagating (the file is attached once), and a cancelled drag's closing `dragleave` fires wherever the pointer was - so `drop` (capture), `dragleave` with no `relatedTarget` and `dragend` are read on `window`; `ChatComposer.dragBadge.svelte.test.ts`. **A drop carrying only a local file's ADDRESS is refused, not inserted** (2026-09-25): Firefox given a file by Nemo receives its `file:///` URI and path but no `File`, and the editor pasted the name. `localFileAddressesFromTransfer` (`composerTransfer.ts`) recognises it; the editor and the panel insert nothing and toast `composer_drop_file_unreadable` - a page cannot read a local file from its address, so the attachment button is the way. **On a phone the paperclip opens a menu** (2026-09-28, user: *"comme sur messenger"*) - since 2026-10-02 THE one menu, each entry going straight to its picker, and none on an iOS browser where WebKit's sheet is the menu ([below](#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)). A picker is chosen by what the input ACCEPTS - one input taking images, videos, audio, PDFs and archives is a document request, which Android answers with the file browser - so the photos entry is a second input accepting `image/*,video/*` only: the system photo picker where the phone has one, the photo library on iOS, and no gallery permission (Google Play grants that only to apps built around photos, so an in-app Messenger-style grid was declined). A desktop keeps its single dialog. `ChatComposer.attachMenu.svelte.test.ts`; **which Android versions show the photo grid through the WebView's chooser is NOT measured - owed on a phone.** |
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
listening** - salon messages are never stored here and the count was never persisted - so a reload, a
cold start, a phone asleep or a socket that was down left every badge at zero while the server's mark
said the salon was unread. The user reads that as "marked read".

**What changed.** `GET /api/channels/unread-counts` counts per salon the messages that are not silent,
not the caller's own and newer than the caller's mark (no mark: newer than the membership and than
`UNREAD_TRACKED_SINCE_MS`, so history from before marks existed is not called unread). The client asks
after every community load and every return of the socket, and `reconcileSalonUnread` sets each salon's
count to the server's count PLUS the messages that landed live after the server counted
(`ChatMessage.serverTimestamp > asOf`: both sides the row's `createdAt`, no device clock). A salon
opened while the answer was in flight is skipped (a counter, not a timer). The receipt now names the
row's own `createdAt` (`serverAt`): the author's `sentAt` is always earlier, so the newest message stayed
"newer than the mark" for ever - measured, 49 ms on one machine - and would have been counted unread
right after it was read.

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
  group roster is `dm_device_group_memberships` (active devices), refetched when the invite ends;
  the newcomer's profile lookup is still in flight, so the roster HOLDS the id while the ordered
  list does not LIST it. `ChatGroupPanel` hid its "Inviting..." row on roster membership: appeared
  (pending), vanished (roster, not listed), reappeared (listed). `joiningRows` now decides by what
  the list renders: a row stays until the member row replaces it, one hand-over, no timer. NOT an
  MLS ordering problem - commit, welcome and roster were already in order. Pinned by
  `memberOrder.svelte.test.ts` ("a member added while the panel is open").

Association rosters (`EditMembersTab`, `AssociationDetailView`) are NOT sorted: their order is the
one the bureau arranges by drag (`sortOrder`), and the president is its first row.

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
| iOS app | **native** `PHPickerViewController` (`tauri-plugin-dialog`, `pickerMode: 'media'`) | input with `capture` - WebKit opens the camera directly, photo or video | **native** document picker |
| Android app, Android browser | input `image/*,video/*` | TWO entries, inputs with `capture`: `image/*` (photo), `video/*` (video) | input, every type |
| iOS browser | **no Canari menu**: the paperclip is a `<label>` around one input, and WebKit's sheet is the only menu | - | - |
| desktop | no menu: the paperclip opens the file dialog | - | - |

- **Android has two camera entries** because its capture intents are photo OR video: with both types
  accepted, wry's `RustWebChromeClient.onShowFileChooser` launches the video recorder only.
- **The iOS app's native picks come back through `take_picked_file`** (`commands/picked_files.rs`): the
  dialog plugin COPIES each pick (PHPicker into `Library/Caches`, the document picker into `tmp/`) and
  returns where; the command reads the copy, deletes it and returns the bytes. It reads and deletes a
  path the page names, so it takes an ALLOWLIST - the canonical caches and temporary directories -
  and compares the CANONICAL path, so neither `..` nor a symlink reaches outside. `nativeAttachPicker.ts`
  names the `File` as the picker did and types it from its extension (the picker gives no MIME type);
  a photo arrives as the library holds it, usually HEIC, which `compressImage` decodes on WebKit.

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
`mapKlipyItems` keeps them and LEAVES OUT, counting at warn level, a result that declares none - it
could not be laid out without a shift. `gifMasonry.ts` places every tile (shortest column first) from
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
  **Not done: an image or video quote still reads `[Media]`** - drawing it needs a thumbnail the
  quote does not carry.

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

- **`MessageBubble` takes `onBeginEdit(messageId, text)`**, not `onEdit`. The toolbar's and the mobile
  sheet's "edit" call it for the author's own text message (`canEdit`: not deleted, own, no media, a
  parent able to take it). It is threaded `ChatArea` -> `ChatMessageGroups` -> `MessageBubble`.
- **`createEditSession` (`utils/chat/editSession.svelte.ts`) holds the state.** `begin` loads the
  message into the composer's text and keeps the DRAFT it replaced; `cancel` and `confirm` give the
  draft back, so fixing a typo never eats the sentence the member was in the middle of. Switching
  from one edit to another keeps the FIRST draft. `confirm` saves only a text that is non-empty and
  changed (`onEdit`, the unchanged `handleEditMessage` path and its ordering rules below). `reset`
  runs when the conversation changes: the text went with it, the draft belonged to the one left.
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

### Editing your own message in a salon (2026-10-05)

**An edit is a SILENT ENCRYPTED CHANNEL ROW, exactly like a reaction** ([channel-encryption 4.7](../../protocols/channel-encryption.md)): a new `EditMsg` (`AppMessage.edit`, field 13: the target's SERVER row id, the replacement TEXT, `edited_at`), sealed under the author's Graine session by `sendChannelEdit` (`channelCrypto.ts`). The server stores an opaque row flagged `silent`, so **there is no new push and no server change, no endpoint, no migration** - and none COULD validate it: it cannot tell the row is an edit or whose message it names.

- **Authorship is checked by every reader**, in ONE function, `applyChannelEdit` (`utils/chat/channelEdit.ts`), used by the live handler (`channelEventHandler`), a history page and the search sweep (`useConversations`) and the sender's own write (`editChannelMessage`). The edit's sender is the ROW's - what Graine v2 proves, unforgeable by the server and by other members - and it must equal the target's author. **A moderator may remove someone's message (`channel.moderate`), never rewrite it.** A refusal is logged (`REFUSED`), silent to the user.
- **"Proven" holds for v2 sessions only.** A row opened under a v1 session has a server-supplied, unsigned `senderId`, so a malicious server or a pre-G2-5 v1 row could forge an edit from the author - the same trust level as DELETE today, not a regression, and deliberately not restricted. It ends with the v1 reader ([channel-encryption 21.5b](../../protocols/channel-encryption.md#215b-what-a-salon-edit-trusts-2026-10-05), [backlog](../../backlog.md)).
- **Paging limit, stated exactly.** `listMessages` returns silent rows only inside `[oldest body of the page, before)`, and the server cannot know which silent row targets which message (opaque), so no clean server-side fix exists. With a `before` cursor an edit made AFTER the cursor is not in that page. Nothing affected today: the history load takes the newest page (no cursor), channels have no older-page load (`loadOlderMessages` returns false), and the search sweep applies edits over ALL pages it collected. Reactions share the limit. Backlog item below.
- It edits a plain TEXT message only: not a poll, a notice, a media message or a tombstone (a delete is final). Empty text is refused. Order is `editSupersedes` (later `editedAt` wins, tie on the text), so two devices converge in any arrival order; the author's own echo is a quiet no-op.
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
default.

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

### Every keyboard rise moves the composer for a moment, on both phones (measured 2026-10-02, OPEN)

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

Not fixed. The Android one wants the WebView's double report recognised for what it is (a viewport
that shrank inside a layout viewport that already shrank). The iOS one wants the footer not to pad a
safe area the keyboard already covers - which runs against the comment on that rule ("the reserved
space must not visibly shrink just because the keyboard opened"), to be read before changing it.
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
`bulkIngestPhases` is a stack, so a second drain starting during a live `endBulkIngest` would call
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
`Flush skipped - follower tab` and the leader's `Flush requested by a follower tab` carrying the
**same entry id**, which is also what proves the shared IndexedDB queue is the transfer.
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

### Eight sites raise a flush, and there is ONE flusher (R-D8, refuted 2026-09-13)

The MLS audit counted the call sites and read them as a duplicate path. They are not one, and the
count is accurate - which is why the refutation is written down rather than deleted with the row.
Whoever counts them next should find this before they find eight things to fuse.

Every trigger reaches `runFlush`, and every gate lives there and nowhere else: the tab election, the
leader gate, `connectivity.isOffline`, `canFlush`, and the per-conversation lane claim (below). There is no
second flusher. **FIVE sites are internal wake-ups**, each bound to the one condition it is the seam
for - `connectivity.onReconnect`, `visibilitychange`, a follower tab's `outbox_flush_request`, the
backoff timer, and `enqueue`. **THREE are external moments nothing inside the module can observe:**

| Site | The moment, and why the outbox cannot see it |
|---|---|
| `promoteOfflineSession` step 4 | a session unlocked offline now has a token AND a socket |
| `sessionAuth`'s `onGroupReady` | one GROUP became sendable; the network never changed |
| `sessionAuth` after `initializeConnection` | login finished, which is not a reconnection |

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

`outbox.test.ts` drives the five internal triggers plus the external door over ONE table, asserting
for each that the same gate refuses it shut and drains it open, and a source check pins the three
external sites so a fourth has to be argued for rather than added.

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
- The send POST is under a `write` deadline ([offline-and-weak-network](offline-and-weak-network.md#9-wp-off-5-shipped-a-deadline-a-slow-state-and-lanes)),
  so a stalled lane ends as `DeliveryUnreachableError` and takes the ordinary backoff.

### A resume is prompt, bounded and idempotent (WP-OFF-6, 2026-10-09)

`connectivity.onReconnect` arms every entry whose last failure was a missing ANSWER to skip its
backoff once, and the store probes `/api/version` on `online` instead of waiting for an unrelated
request to prove the server reachable: 2.4-2.9 s down to 5-13 ms on a good link, one probe round trip
on a weak one. Refusals keep their clock. The reasoning, the bounds and the numbers are in
[offline-and-weak-network](offline-and-weak-network.md#12-wp-off-6-shipped-a-prompt-bounded-resume-exactly-once-in-effect).

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

**A push does not read the field.** A voice note on a locked phone is still announced as an audio
file: the sentence is chosen in the Rust push scanner (`mobile/proto_fields.rs`,
`extract_full_message_info`, from the `MediaKind` varint), not in Kotlin, and field 11 sits unread
beside it. The same file writes SIXTEEN user-visible sentences as French literals, whatever the
app's language:

| builder | sentences |
| --- | ---: |
| `format_system_event_text` - renamed (2 forms), image changed, member added (2 forms), removed, left, deleted, invitation | **9** |
| the reaction arm - `a réagi {emoji}` | **1** |
| the media arm - `Photo`, `Vidéo`, `Audio`, `Pièce jointe` | **4** |
| the call arm - `Appel vidéo entrant`, `Appel entrant` | **2** |

Its fallback arm prints `événement de groupe ({event})`, a raw protocol name; the silence list beside
it is what keeps that a trap rather than live noise. The text is what the FCM cache persists as a
message body, so emitting a KIND for the native side to word (which `appLocaleContext` already
localises on Android) changes what that cache stores - which is why it is a design, not a
translation chore.

### A system event is executed, never displayed

**`appMsgToEnvelope` returns `null` for a `system` AppMessage, and that null is load-bearing.** Every
call site that can receive a control event is written as `if (envelope) { display } else if
(msg.system) { handle }` - `handleKnownGroup` and the Welcome buffer in `setupMessageHandler`, the
replay in `history.ts`. Make it return an envelope and those handler branches become dead code: the
event is never applied and its JSON payload is rendered as an ordinary message attributed to the
sender. That is exactly what a `msg.system` branch added to it in `7e9d66e8` did until 2026-08-03.

A **channel** notice is the one system message that IS pre-rendered text: `inviteMemberToChannel`
sends `mkSystem('memberAdded', <already-localized sentence>)` into the channel, because a channel
has no per-event handler. The two channel decode sites - `channelEventHandler`
(`channel.message.created`) and `decodeChannelMessageRow` (history + search) - ask for it
explicitly through **`appMsgToChannelSystemEnvelope`** and attribute it to `'system'` with
`isSystem: true`, so it renders centred and neutral rather than as a message from whoever triggered
it. `ChatMessageGroups` centres on the ROW flag; the `system` envelope kind only gives the pill.

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

### A visible system notice needs an identity the SENDER minted

A notice the members are meant to SEE - a member added or removed, a rename, a new photo, a deleted
group - is written by **two paths that never meet**, and copied between devices by a third:

| path | where |
| --- | --- |
| live delivery | `systemMessageHandler.ts`, the `memberAdded` / `memberRemoved` / `memberLeft` / `groupRenamed` / `groupImageChanged` / `groupDeleted` branches |
| archive replay | `historySystemEvents.ts`, the same events re-read from `history:{groupId}` |
| a peer's `history_bundle` | `serializeForBundle` copies the row, **with the id that peer stored** |

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
every reader.

Pinned by `systemMessageHandler.noticeIdentity.test.ts`, which asserts the convergence property
directly: one frame handed to both paths produces one id. Old frames carry none and stay
duplicate-prone - [legacy-compatibility](../../legacy-compatibility.md).

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
envelope's caption, unreachable from this UI and better than throwing the attachment away), and
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
under a caption row naming who answered whom, measured off the reference in both themes:
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
| State | `useMessaging.messageReactions` | `stores/reactionStore.svelte.ts` |
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
- `beginBulkMessageIngest` and `resetMessageCatchupState` both `clear()` the buffer without
  flushing, so a second drain starting mid-window discards whatever the first was holding;
- the outbox cannot repair it, because `persistSent` resolves the message through `findMessage`,
  which only scans `conversations` - a buffered message was never there, so it returns silently.

Result: a message composed during any drain window was rendered by the peer and gone from the
sender at its next load, with nothing logged. It also explains why the offline path was always
correct - offline there is no inbound drain, so the echo took the live path (MSG-10).

Fixed 2026-08-07: `if (bulkIngestActive && !isOwnMessage(senderId, ctx.userId))`. An own message is
never deferred; one extra rendered item is not what the buffer exists to prevent. Both clear sites
now call `warnIfDiscardingBuffered`, because a dropped buffer and a message that never arrived are
otherwise the same observation. **The general rule: a UI buffer in front of a persistence call is a
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
| the Welcome's early placeholder and `upsertConversation` (`setupMessageHandler.ts`) | `joinedGroupId`; a DM matched by PEER under another group is deleted and **re-keyed onto `joinedGroupId`** - the one writer whose key is computed, pinned by `setupMessageHandler.test.ts` (*"a Welcome into a DM keys the row by the joined group id"*) |
| `onWelcomeProcessed` (`sessionAuth.ts`), the FCM merge, channel builders, tab sync | the group / conversation id they were handed |
| every other `set` (retire, unread, watermarks, rename, avatar, messages) | read-modify-write of a key already in the map |

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
- **Termination from a PROOF.** The row is cleared when the server answers - a success, or a 403/404
  saying it is already done - and never on an attempt count or an elapsed time. A server that is
  reachable and REFUSES (a 500) keeps the row and logs at a level that accuses, because that is a
  server bug and dropping the row would hide it.
- **The trigger is an EVENT**: `connectivity.onReconnect`, plus exactly one pass at startup, for an
  app killed while offline that will never see an `online` edge. Registered at login beside
  `registerOutbox` and `registerOfflinePromotion`, unregistered in `logoutImpl` - no flag deciding
  whether a listener exists.

**One classifier, or the defect comes back with its halves swapped.** The drain and
`exitGroupAndCleanup` both have to read a failure, and if they disagreed about a 403 the composable
would keep a row the drain would clear, or worse. `classifyExitFailure` in
`utils/chat/pendingGroupExits.ts` is the only reading of it: `'already-gone'` for 403/404,
`'refused'` for any other status, `'unreachable'` only when `isTransportFailure` - the same predicate
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

Two corrections ride on the same seam, because they are the same stale read wearing different
clothes. `readBy` is unioned rather than taken from the page: reading is applied optimistically in
memory before the network ACK, so taking the page's array un-reads what the user just read and the
badge comes back. And the page may never DOWNGRADE an on-screen envelope back to an FCM preview,
which taking it verbatim would do whenever the stored row is still the notification one. The unread
COUNT in the startup restore is now computed over the merged list too - counting the page alone lost
the same message twice, once from the display and once from the badge.

### A salon copy is stale when the live stream had a gap, never when a clock says so (2026-10-01)

A salon is never persisted: its in-memory copy is the REST page plus every live socket event since.
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

The repair is a **creation tick**, not a timestamp: `creationEpoch` counts what this device has
created, ever. It is read BEFORE the listing request goes out, stamped onto the sidebar entry the
moment a community exists locally (`createdEpoch`) and onto `locallyCreatedChannels` for a salon, and
both prunes spare anything stamped later than the request. The question is not "how old is this" but
"did this exist when I asked", and a monotonic counter answers that exactly - there is no clock to be
wrong about and nothing to tune. A community that really was deleted elsewhere is still removed, and
both prunes now LOG what they spared, because a reconciliation that silently deletes is one nobody
can attribute.

## UI features

- **Focus writing mode**: header hides when composer is focused on mobile.
- **Sticky date**: current date label stays visible during scroll - see
  [The day label and its floating pill](#the-day-label-and-its-floating-pill-2026-10-01).
- **Search**: in-chat search with prev/next navigation and highlight.
- **Lightbox**: full-screen image/video with pinch-zoom and download.
- **Radial menu** (mobile): long-press message -> circular action menu
  (`MessageMobileActions.svelte`). The button row has no width cap of its own and an own message
  shows one more button than a received one (Edit), which was enough to overflow a narrow phone
  screen on your own messages specifically - fixed with `max-w-[calc(100vw-2rem)] flex-wrap`
  instead of a fixed-width, single-line row.
- **Read receipts**: three states — sent / delivered / read — with distinct icons. In a DM the
  reader's head and a double check sit under the sender's own last read message. **In a group or a
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

The single hook lives in the auto-generated `RustWebView.onCreateInputConnection` (marked
`CANARI CUSTOM PATCH`); all logic is in the non-generated `KeyboardMediaBridge`, so re-applying the
patch after a `tauri android` regeneration is one line. Reliable IME `commitContent` needs a recent
Android WebView; on devices where it is unavailable the in-app GIF picker still works.

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
closure, which asks `shouldFollowThreadBottom` about one `scrollHeight`. Three copies of this
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
disagree. Days are counted by `calendarDay`, shared with the media viewer's title.

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
name is still on screen. Where it does float over a bubble, a halo in the page colour (`--cn-bg`)
fades the letters either side of it instead of leaving them cut hard against its edge.

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

Now `conversationRecency(convo)` (`utils/chat/conversations.ts`) is the sent time of the newest message in `messages` (sorted by `compareMessageOrder`), falling back to the persisted seed only while nothing is loaded, else 0; `compareConversationRecency` breaks ties by id. A message applied by ANY path - live, pending drain, history seed - moves the row, because the key is read from the list rather than remembered. Reactions, edits and read receipts do not touch `messages` order, so they do not move it. Known residue: the local-only "member joined" notice in `ChatBackgroundService` is stamped with the local clock and does count. Test: `conversations.recency.test.ts`.

### A reply belongs to ONE conversation (2026-10-06)

`useMessaging` held a single `replyingTo`, so a reply armed in a DM stayed above the composer of the
conversation opened next (measured on the Mi 9T, alpha.4). It is now a `SvelteMap` keyed by conversation
id: `handleReply(conversationKey, message)`, `replyFor(conversationKey)` and `cancelReply(conversationKey)`
take the key from the caller (`MainChatPage` passes `convs.selectedContact`), and a send consumes only the
entry of `ctx.selectedContact`. No clear-on-change effect is needed - nothing is shared, so nothing leaks.
Returning to the DM shows its reply again, like a draft. Each decision logs `[REPLY]`.
Test: `useMessaging.replyScope.svelte.test.ts`.

### A refused salon send gives the draft back (WP-OFF-1, 2026-10-09)

A salon text has no bubble and no queue entry (OFF-2 and OFF-3 are not built), and the composer is emptied synchronously on click, so a refused send (offline, 5xx) used to destroy the text. `handleSendChat` now answers `false` on a refusal (`true` once the server took it) and puts the reply target back in `replyByConversation`; `MainChatPage.handleSendChat` then restores the text with `restoreFailedDraft` (`utils/chat/draftRestore.ts`: an empty composer gets it back, a composer the member typed in meanwhile gets it in front, never overwritten) - only if the same conversation is still selected, and it logs either way. The error banner stays. Tests: `draftRestore.test.ts`, `useMessaging.salonRefusal.svelte.test.ts`. Status of the rest: [offline-and-weak-network](../offline-and-weak-network.md).

## Profile fetches that failed on a device, and the denominator that is owed (2026-08-16)

The symptom was seen twice on 2026-08-16, on both platforms: nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. The log line that makes it countable did not exist then; since 2026-08-19 every warn in `displayName.ts` ends `(failed/attempted lookups failed this session, X%)`, counting only lookups that reached the network. Do not assume it is the same fault as the avatar endpoint, and do not assume it is not. The number is read from a device or browser console during a campaign run: there is no client telemetry, and server-side is not an option (`GET /api/users/:id` is not request-logged, and a client that never reached the network would not appear anyway). **Then decide about `FAILURE_BACKOFF_MS`**: a high rate says the two-minute suppression does real work against a refusing server; a rate near zero says it is a clock hiding a name for two minutes over a blip the reconnection listener already handles.
