# Sharing into and out of Canari

The OS share sheet, both ways, the way Messenger or Discord use it (user, 2026-10-11; made a
priority 2026-10-21). **In**: another app's "Partager" offers Canari, the member picks a conversation
or a salon, and the content waits in that conversation's composer. **Out**: "Partager..." on a
message, a picture or a post opens the system sheet.

## The lots and where each stands

| Lot | What | State |
| --- | --- | --- |
| S1+S2 | Share IN on Android: the intent filter, the native copy, the "Envoyer a..." picker, the composer staging | built (this page) |
| S3 | Share OUT (Android + iOS): `share_text` / `share_staged`, message and post menus | built - [share-out](share-out.md) |
| S4 | Share IN on iOS: a Share Extension `CanariShare` in the App Group, a third signing profile; **the iOS conversation suggestions (`INSendMessageIntent`) follow it**, since they need that extension | **built (2026-10-22), owed the iPhone readings** - [the iOS path](#share-in-ios---the-path) |
| S5 | Conversation suggestions in the Android sheet (Direct Share / sharing shortcuts) | built (Android), [below](#share-suggestions-android---lot-s5) |
| S6 | A post's or a reel's share sheet, Instagram's: send into a conversation, copy the link, the system sheet; a shared reel's card opens the viewer | built, design decided 2026-10-23 - [below](#a-post-or-a-reel-shared-from-its-sheet---lot-s6) |

## Share IN, Android - the path

1. **The manifest** offers `SEND` and `SEND_MULTIPLE` for `text/*`, `image/*`, `video/*`, `audio/*`
   and `application/*` on `MainActivity` (`singleTask`), hand-maintained OUTSIDE the deep-link
   plugin's generated block. Guard: `src/lib/mobile/androidShareManifest.test.ts`. The deep-link
   plugin only reads `VIEW` intents, so a share never reaches `onOpenUrl`.
2. **`IncomingShare.kt` copies at once, off the UI thread, one capture at a time.** A `content://`
   grant lasts only as long as the sender lets this activity hold it, and the page reads much later,
   after the PIN. Each stream is streamed (64 KiB buffer, never whole in memory) into
   `cache/shared_inbox/<share id>/`. Refused, and counted (`share/ShareRules.kt`, JVM-tested in
   `android-tests`):
   - a non-`content://` URI: a `file://` would let the sender name our own data;
   - one of THIS app's authorities (`fr.emse.canari.fileprovider` exposes parts of our cache): the
     sender would make us copy our own private file back to ourselves (a confused deputy);
   - a URI under a grant Canari HOLDS (`persistedUriPermissions`): a document the member gave to
     Canari, not to the sender;
   - an unreadable stream, more than 10 files, a file over 200 MB, or a share past 300 MB in all -
     bounds on DISK. The upload ceiling is the SERVER's number, which only the page can ask, so the
     page applies it (step 6).
   Names are reduced to their last segment and a conservative character set
   (`share/SharedFileName.kt`). `onCreate` skips a relaunch (`savedInstanceState`,
   `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`) so a share is never offered twice.
   **A share that kept no file keeps no folder**: a text share, or one whose every stream was
   refused, deletes its `shared_inbox/<id>/` before the manifest is written. No manifest entry names
   that folder, so nothing else would delete it while the process lives - text shares left one
   empty folder each until 2026-10-27 (Mi 9T); `sweepOrphansOnce` removes those at the next process
   start. Guard: `androidShareInbox.test.ts`.
   **At rest**: the manifest (files dir) and the copies (`cache/shared_inbox/`) live in the app's
   credential-encrypted storage - unreadable until the first unlock after boot, then readable by the
   app's uid alone - and neither is backed up (the cache never is; the data domain is excluded).
   Nothing is added on top: an app-held key protects nothing against an attacker who can already
   act as the app (the reasoning is under the iOS path, "At rest").
3. **The handoff is a file, `pending_share.json`** in the Tauri data directory, because a cold start
   gets the intent before the page exists and a value pushed into a page that then navigates is
   lost. It is written to a `.tmp` and renamed into place, so a drain on a return to the foreground
   never reads half of it. `read_and_clear_pending_share` (`commands/handoff.rs`, the same helper as
   the CallKit answer's `pending_call_accept.json`) hands it over exactly once: it **claims the file
   by renaming it before reading it**, so a newer manifest renamed into place meanwhile waits for
   the next drain instead of being deleted unread. It answers `{ manifest, epoch }`: the manifest
   carries the share epoch its capture started in, and an older one than the current is stale (see
   the sign-out decision below). A capture replacing an undrained share claims
   the older manifest the same way, so each manifest has exactly one taker.
   **Nothing older is deleted until a new share is handed over**: a capture that throws or keeps
   nothing leaves the share before it intact (refusals of an all-refused share are added to the
   waiting manifest, or handed over alone). Then each copy is deleted by whoever ends its share -
   the chat page reading it (`take_picked_file`), the page dropping it unread on cancel, on a
   replacement or over the ceiling (`discard_picked_file`, the same allowlist), or the capture that
   replaces an undrained share. What a dead page leaves is swept **once per process, at the first
   `onCreate`** - when no page exists to be staging anything - keeping only what the waiting
   manifest names (`IncomingShare.sweepOrphansOnce`). An activity re-created INSIDE a living process
   does not sweep: what its dead page held waits for the next process start.
   The claim is atomic because `rename(2)` resolves its path atomically (Android, iOS); a Rust test
   races two takers on it (`commands/handoff.rs`, POSIX only - Windows renames by handle).
   The Kotlin half (claim, replace, sweep) has no JVM test: it is Android-only, and is read on the
   Mi 9T (Owed).
4. **The page drains** (`IncomingShareHost.svelte`, mounted on every route by
   `ChatBackgroundService`) at mount, on `canari:incoming-share` (the native side announcing a share
   to a live page) and on `canari:foreground`. The listener is registered before the first drain,
   so no share falls between the two. **The drain takes the text and the file NAMES, no bytes**: it
   runs before the PIN, and reading a share there would hold it in the WebView for as long as the
   member takes to unlock and choose. What the native side refused is said in a toast
   (`share_items_lost`).
5. **"Envoyer a..."** is the forward picker (`ForwardMessageModal`, `variant="share"`): DMs, groups
   and salons. It opens only when the session is up, so the PIN always comes first, with no clock.
   The pick is published as a deep-link landing (`notifNav.navigate`, and NOTHING else), so the
   conversation opens exactly as a tapped notification would, salons under `/communities` included:
   the landing effect in `ChatBackgroundService` routes and selects. `landShareOn` used to `goto`
   the route as well, and on a phone already on `/chat` that navigation's `beforeNavigate` drained
   the overlay stack AFTER the effect had opened the conversation - the share was staged in a
   composer that closed at once (read on the Mi 9T, 2026-10-27, `1.5.0`).
   **A landing that ends without displaying its target** (abandoned, or the member went elsewhere)
   gives the share back to the picker (`incomingShare.releaseTarget`): the landing ending is the
   fact that says so.
6. **The chat page stages it** once that conversation is the one displayed
   (`incomingShare.takeFor`): the text joins the draft (in front of anything already typed), and the
   files are read NOW and **one at a time** (`stageSharedFiles`), behind the same session hold as a
   picked file (`whenSessionUp`), every one into the conversation the share was taken by - read ONCE,
   so a member opening another one during a video re-encode does not receive the rest - each through `take_picked_file`,
   which deletes the copy as it reads it, and staged before the next is read. **A non-video over
   the composer's ceiling is deleted unread**: the manifest carries each copy's size, and the share
   applies the composer's own predicate (`refusedBeforePreparation`, `media.ts`) against the
   server's `uploadLimits()`; a video goes to the encoder, which is its ceiling. Its allowlist names the inbox itself and NOT the app cache around it, which also
   holds the WebView's files and the gallery's decrypted staging; on Android its other roots are the
   EXTERNAL cache and the process temp directory, so the two names are pinned equal by a test. The
   files then go through `handleFilesSelected` - the same size ceiling, compression and video
   re-encode as a picked file. **The member sends with Send. A share is never sent on its own.**

## Share suggestions, Android - lot S5

Android's share sheet shows Canari's recent conversations as direct targets, like Messenger
(user, 2026-10-22). Picking one opens the same "Envoyer a..." picker with that conversation first
and highlighted; **the member still taps it, and still sends with Send** - a suggestion is a
preselection, never a destination by itself.

- **What is published** (`sharing/shareTargets.ts`): the picker's own destinations
  (`sharing/shareDestinations.ts`, the names the picker shows; a salon carries its community),
  restricted to conversations that can receive (`lifecycle === 'active'`) and whose name is known,
  ordered by the sidebar's one recency key (`compareConversationRecency`), the top
  `MAX_SHARE_TARGETS` (5). Each is a DYNAMIC shortcut `c:<conversation id>`, labelled with the
  name, in the share-target category of `res/xml/shortcuts.xml` (the `android.app.shortcuts`
  meta-data on MainActivity, hand-maintained; its types are the SEND filter's). A tap from the
  launcher's long-press menu, where dynamic shortcuts also appear, opens the conversation's
  `fr.emse.canari://chat/<id>` link like a notification. No icon: the avatar bitmap
  (`avatarBitmap.ts`) rasterises a node already on screen, and the initials disc lives in the app
  module the plugin cannot reach.
- **When**: `IncomingShareHost` calls `syncShareTargets` whenever the list, the setting or the session
  changes; the list is sent only when its ordered ids and names differ from what the native side
  was last told (`shareTargetsNative.ts`) - idempotence from that state, no debounce and no clock.
  A signed-out or still-loading session publishes nothing and erases nothing: the gate is
  `conversationSourcesSettled`, whose restore half (`conversationsRestored`) is reset at sign-out
  with the map (`invalidateRestores`), so the next account never publishes from a list still
  loading. The conversation map is read only when a publish is due, so a disabled or signed-out
  state does not re-run on every message.
- **Native** (`tauri-plugin-gallery`, `ShareTargets.kt`, beside S3's commands): `publish_share_targets`
  adds by its own ids and removes the ids it published before and no longer names;
  `clear_share_targets` removes every id it ever recorded. The ids are recorded in the plugin's
  preferences (`ShortcutRecord`) BEFORE the platform is touched, and a record that cannot be
  written aborts the call, so a later process removes exactly them - an allowlist, never a
  pattern. A publish answers what the platform LISTS afterwards (`present`, read back with
  `getDynamicShortcuts`, since the per-activity cap can evict a push at once) and the stale ids it
  could not remove (`leftover`); a leftover makes the page forget what it told the native side, so
  the next call is sent whatever it asks. It never calls `setDynamicShortcuts` or `removeAllDynamicShortcuts`:
  the long-lived `chat_<group>` shortcuts that make message notifications conversations
  (`CanariFirebaseMessagingService.publishConversationShortcut`) share the dynamic set. NOT
  long-lived: the sheet needs no cached copy, so removing the dynamic shortcut removes it
  everywhere. Capped at `getMaxShortcutCountPerActivity`.
- **A salon never publishes a conversation shortcut** (2026-11-01), though its notification takes
  the group shape since then: the cap above is shared, a busy salon posting one per message would
  evict the DMs' shortcuts and these suggestions, and the sheet offers conversations, not salons.
  `showMessageNotification` skips `publishConversationShortcut` for a `channel_` id and keeps the
  large icon (the speaker's face or initials). The `chat_channel_*` shortcuts the WebSocket trigger
  published before that are retired once per process start: `CanariApplication` calls
  `ConversationShortcuts.removeRecordedWithPrefix` (`removeLongLivedShortcuts`, the record rewritten,
  the count logged at INFO); with none left it removes nothing and logs nothing.
- **Erased at sign-out, with the notifications' conversation shortcuts** (an account switch
  included, the user's rule for the pending share too: nothing of an account stays for the next
  one). `clearAuthUnderway` calls `eraseAccountShortcuts` beside `discardSharedOut`, for
  `clearAuth` and `clearAuthLocally` alike. It ALWAYS asks the native side to clear the
  suggestions (only the native record knows for certain; the setting's own clear may skip when the
  page knows it published nothing), resets the "last told" state so the next account publishes its
  own, and calls `clear_conversation_shortcuts`. The calls are queued, so they land after any
  publish already in flight.
- **The conversation shortcuts** (`chat_<group>`, long-lived, a name and a Person each): the
  messaging service pushes them only through `ConversationShortcuts.push` (in the plugin, which the
  app module depends on), which records the id before pushing - an unrecorded push is refused - and
  keeps at most `ConversationShortcuts.CAP` (30): past it, the conversation whose notification is
  the oldest is removed. The sign-out clear removes every recorded id with
  `removeLongLivedShortcuts` (the dynamic shortcut and, on API 30+, the system's cached copy),
  disables the pinned ones, and empties the record only on success.
- **The hint is checked against the account**: `IncomingShare.kt` copies `EXTRA_SHORTCUT_ID` into
  `pending_share.json` as `target` only when it has the `c:` shape; the page parses it
  (`conversationIdFromShareTarget`) and preselects it only if the signed-in account's list holds
  that conversation (`suggestionIfHeld`) - a stale shortcut from another account targets nothing,
  and says so in the log.
- **The setting** "Suggestions dans le partage" (Settings > Preferences, Android app only, ON by
  default, per device): off clears at once. The names leave Canari for the system (launcher, share
  sheet), which the user accepted knowingly; the privacy policy (section 7) and the register (C22)
  say so.

**Known limits.** Android 9 (API 28, the app's minimum) does not list them: that needs
`androidx.sharetarget` and its chooser service, not shipped for one API level. A shortcut the
member PINNED from the launcher menu cannot be removed by any app: it is disabled at the next
publish or clear that drops it, and the launcher decides whether its label stays. iOS: none - the
suggestions need the Share Extension, so they are part of S4.

## A post or a reel, shared from its sheet - lot S6

**Asked by the user on 1.4.0 (2026-10-23):** *"Le partage d'un post/reel devrait permettre de
partager dans l'app, et avoir un 'copier le lien', comme sur instagram"* - and to look at the design
together. The design was proposed with six questions, and the user answered them the same day
(the decisions close the section).

**What existed before it.** A post's menu had "Partager" (the system sheet on the phone apps, a
copied link elsewhere) and, on the phone apps only, "Copier le lien"; the reel rail's send was the
same "Partager" ([share-out](share-out.md)). Nothing sent a post INTO a conversation. But the pieces
were all there: a link to `/posts/<id>` pasted in a conversation already draws an in-app card
(`LinkPreviewCard` -> `canariLinkPreview.ts`), and a share from another app already travels
picker -> landing -> composer (lots S1+S2, above).

**Instagram's sheet, read on the user's phone (2026-10-23).** A bottom sheet with a grabber; a
search field with an "add people" icon; a three-column grid of recent conversations and people
(round avatar, name under it, a green dot when active, stacked avatars for a group), scrolling; a
fixed bottom row of round labelled actions scrolling sideways - "Copier le lien" first, WhatsApp,
"Ajouter a la story", "Partager" (the system sheet), Snapchat... The post behind is dimmed. A tap
on a person SELECTS it (several can be), and a "write a message" field and a Send button appear.

**What is built (`PostShareSheet.svelte`).** "Partager" in a post's menu, the rail's send and the
post page's header all open it. Canari has no presence and no story, so neither is copied.
- A grabber, the search field (name or community), and the grid of the picker's own destinations
  (`shareCandidates`, the function `ForwardMessageModal` now reads too), **most recent first**
  (`compareConversationRecency`, the sidebar's key); a salon shows its community under its name.
- The bottom row: **"Copier le lien"** first, then **"Partager via..."** (the system sheet) where
  one exists (`canShareOut`, the phone apps). On the web "Partager" no longer means "copy": the
  sheet is the same everywhere, minus the system row.
- **A tap on a conversation sends the post's link INTO it the way a share from another app goes**
  (`sendPostLinkInApp`): `incomingShare.offerTo` offers the link with its destination already
  picked - so the S1 picker never opens for it - `landShareOn` opens that conversation as a tapped
  notification would, and the chat page puts the link in the composer (`takeFor`). **The member
  sends with Send; a word can be typed first**, which is Instagram's message field without a second
  one. The landing does not navigate when the conversation's section is already shown, so nothing
  drains the overlay stack then: the sheet closes itself, and **the reel viewer closes on the
  sheet's `onSentInApp`**, called only when the landing was published (`sendPostLinkInApp` returns
  true). Without it a reel sent from `/chat` or `/communities` left the viewer over the composer
  holding the link (review of #2609, 2026-10-27).
- The sheet is loaded on its first open (`import()`), never with a card: it reads the conversation
  list (`globalChatSingleton`), which a feed scrolled past must not pay for.
- `offerTo` stamps the share with the page's current FLOOR (the last sign-out it saw): it was made
  after it, so the fence cannot refuse it, and a sign-out still drops it like any held share
  (`eraseIncomingShare` -> `incomingShare.drop`).

**What the link reveals, and to whom.** The link is `https://canari.emse.fr/posts/<id>`
(`postShareUrl`), the same for every row: the id and nothing else.
- **In a conversation**, the card is fetched by EACH READER under their own session (`getPost`): a
  reader the post's spaces exclude, or who is signed out, gets the fallback card ("unavailable",
  the route's generic label) - not a word of the post. The message itself stays end-to-end
  encrypted; an in-app link never goes through the server's link-preview fetch (`isInAppHref`
  branch), so no server learns which post was sent where.
- **Opened**, the link is the app's (Universal / App Link, `/posts/*` is claimed) or the web page,
  both behind sign-in and the post's own audience - a reader who may not see it gets "not found".
- **Pasted outside Canari** (copy, system sheet), an unfurler reads the server-rendered card: an
  ASSOCIATION post's text and picture to anyone holding the link, whatever its spaces; a personal
  post gets the generic card. **Kept as it is, by the user's decision** (2026-10-23, below;
  [seo](seo.md#a-shared-post-and-the-ten-days-it-previewed-as-nothing)).
- No new data is collected: no share count, no log of who shared what to whom.

**Decided by the user (2026-10-23), on the six questions this section first asked.**
1. **A shared reel's card opens the reel in the reels viewer**, not its page - BUILT. The in-app
   preview carries the post whole when it is a reel (`reelPost`, `canariLinkPreview.ts`; it is the
   post the READER's session read), and a tap on the card mounts `ReelViewer` on it (loaded on the
   tap, like the card's `PostMedia`), continuing with the other reels. There was no deep-link entry
   into the viewer to reuse: it is opened by its owner, as `PostContent` and `ReelsEntryButton`
   do. A tap before the card has read its post still opens the page - the card does not know yet.
2. **The post page's header "Partager" opens the same sheet** - BUILT (`routes/posts/[postId]`);
   its in-place "Lien copie !" is gone, and its string with it.
3. **No sender warning** about recipients outside the post's spaces: it would be a new question
   asked of the server about other members. Not to be built.
4. **No dedicated MLS message type**: a shared post is its link and the in-app card. Not to be
   built.
5. **The external link preview stays as it is** ([seo](seo.md#a-shared-post-and-the-ten-days-it-previewed-as-nothing));
   the open question it was is closed.
6. **One destination per share stays**; sending to several at once from the sheet is LATER, not
   now. It would mean building the chat page's messaging context outside it.

**Owed**: on the Mi 9T and the iPhone - the sheet from a feed card, from a reel (it must sit above
the viewer) and from the post page; a tap lands in the conversation with the link in the composer,
Send draws the card; a tap on a reel's card opens the viewer; the recipient without the post's space
sees "unavailable"; "Copier le lien" and "Partager via..." from both. Tests:
`PostShareSheet.svelte.test.ts`, `sharePost.test.ts`, `shareDestinations.test.ts`,
`incomingShare.svelte.test.ts` (`offerTo`), `ReelViewer.rail` (the send opens the sheet, a sent reel closes the viewer),
`LinkPreviewCard.reel.svelte.test.ts` and `canariLinkPreview.test.ts` (a reel's card opens the
viewer, a post's its page).

## Share IN, iOS - the path

iOS has no intent: another app's sheet runs a SEPARATE process, the Share Extension, which cannot
reach the app's sandbox. So the extension writes into the App Group (`group.fr.emse.canari`, the
container the NSE already shares), and the app carries the share out of it into exactly the layout
Android leaves - from there, steps 3 to 6 above are the same code.

1. **The extension** (`gen/apple/canari_Share/`, target `CanariShare`, bundle
   `fr.emse.canari.share`, App Groups entitlement only, no keychain) is activated for text, one web
   URL, and up to 10 images, movies or files (`Info.plist`). `ShareCapture.swift` is
   `IncomingShare.kt`'s twin: it takes `<AppGroup>/shared_inbox.lock` (`flock`, exclusive) for the
   whole capture, reads `<AppGroup>/share_epoch` ONCE it holds it, streams each item
   (`loadFileRepresentation`, 64 KiB chunks, never whole in memory) into
   `<AppGroup>/shared_inbox/<uuid>/` under Android's caps and names (`ShareRules.swift` - 10 files,
   200 MB each, 300 MB in all; a `file://` URL as TEXT and a file inside the App Group are refused;
   and 1 MiB of TEXT for the whole share, `maxTextBytes` - the bound Android has unnamed, an intent
   extra past about 1 MB failing its binder transaction - a part that would pass it refused and
   counted like a file over its ceiling),
   then writes `<AppGroup>/pending_share.json` in Android's schema (tmp + rename), with Android's
   claim/replace/refusal-merge rules by epoch. Every branch logs (`os_log`, subsystem
   `fr.emse.canari`, category `share`). Drift against the Kotlin is a vitest:
   `src/lib/mobile/iosShareExtension.test.ts`. **The capture runs under
   `performExpiringActivity`**: when the system takes its time back mid-copy it is cancelled at the
   next chunk (the provider load under way is cancelled too), deletes its partial directory and
   releases the lock before the expiry handler returns - an extension suspended holding a lock on a
   shared-container file is killed (`0xdead10cc`). **The app is signalled only AFTER the lock is
   released**, or its try-lock import would answer Busy. The activation counts are PER KIND (10
   pictures, 10 videos, 10 files): a mixed share over 10 in all is offered, and the copy keeps the
   first 10 and counts the rest as refused.
2. **It does not open the app.** An extension has no public API to launch its host app, and the
   responder-chain `openURL:` trick is undocumented private behaviour App Review may refuse, so it posts a
   LOCAL notification, "Choisissez la conversation" (fr/en from its own `Localizable.strings`, in
   the SYSTEM language - the extension cannot read the app's chosen locale), and says on its card to
   open Canari when notifications are off. The banner carries `canariLocal: incoming_share` and no
   `deepLink`: `canari_push.mm` recognises it, shows nothing while the app is on screen, and its tap
   only opens the app - it never reaches the push routing (which would accuse a missing target).
   A running app also gets the Darwin notification `fr.emse.canari.share-ready`.
3. **The app imports** (`commands/app_group_share.rs`, Rust so it is tested here and so ONE
   implementation serves every caller): at bootstrap, on `didBecomeActive`, on the Darwin signal, at
   the unlock (item 5), and inside `read_and_clear_pending_share` itself before its claim. It TRIES the lock (never waits: a
   capture in progress is `Busy`, and the next activation imports), claims the group manifest by
   rename, MOVES `<AppGroup>/shared_inbox/<id>` to the app cache's `shared_inbox/<id>` (one volume,
   a rename - a failed move deletes the source and errors, there is no copy fallback), rewrites each
   path to the moved file of the same name, and hands over to the data directory's
   `pending_share.json` with Android's replace-by-epoch semantics. When it imported, `canari_ios.mm`
   removes the banner and dispatches `canari:incoming-share`. The once-per-process orphan sweep
   covers BOTH inboxes (the App Group one only when the lock is free), and settles the leftover claim
   and staging files of the app data directory and - with the lock held - of the App Group root (an
   allowlist: `pending_share.json.draining`, `.importing`, `.replacing`, `.tmp`, `share_epoch.tmp` -
   the NSE's files sit beside them; a claim is put back or deleted as lost, item 5). **The launch import
   and sweep run before the Rust logger exists**, so they answer CODES that `canari_ios.mm` NSLogs
   (`IMPORT_*`; the sweep's `CanariShareSweep` report with its `SWEEP_*` bits), pinned on both sides
   by the vitest. Deferring them until the logger exists was refused: Tauri creates the WebView
   BEFORE the setup hook, so a page could claim a manifest and be staging copies the sweep would
   then delete.
   Once the page has read or discarded a share's last copy, its emptied `shared_inbox/<id>/` is
   removed at once (`remove_dir`, which refuses a directory still holding a copy).
4. **Sign-out leaves nothing in the App Group** with the same two page commands as Android:
   `advance_share_epoch` also writes `<AppGroup>/share_epoch` and FAILS CLOSED when it cannot
   (a stale group epoch would let an old capture look current), and `read_and_clear_pending_share`
   imports before it claims, so the erase deletes the group's share too. `share_epoch` is now kept
   across the app-data wipe (`storage.rs`, `KEPT_AT_TOP_LEVEL`): a reset count would make an old
   share look current against the group's copy - and on Android against a capture in flight.
   **A failed App Group copy is repaired at its source**: the launch sweep finds the group's epoch
   behind the app's (or unreadable), rewrites it, and says so at ERROR level; it never lowers it.
   The factory wipe (`clear_app_data`) also removes the group's `pending_share.json` and
   `shared_inbox/`, under the lock - an allowlist of those two paths.
5. **At rest: out of backups, NOT sealed.** The App Group and the app data directory are backed up
   on iOS (the app cache is not), and a waiting share holds what the member shared - the manifest
   carries the shared TEXT in the clear. So each manifest is excluded from backups per file, after
   every write (a rename is a new inode, and the flag does not travel): the extension's
   `writePending` and the app's `write_pending` (`native_cache::exclude_from_backup`, the native
   caches' helper, [mobile](mobile.md#the-native-caches-are-sealed-at-rest-and-kept-out-of-backups-2026-10-22)).
   The extension also excludes the WHOLE `<AppGroup>/shared_inbox/` directory on every capture - it
   holds share copies and nothing else, unlike the App Group root.
   **At rest, a waiting share is LOCKED WITH THE DEVICE (2026-10-27).** The extension writes its
   folder, every copy and the manifest under Data Protection's `CompleteUnlessOpen` class
   (`ShareCapture.lockedAtRest`, `.completeFileProtectionUnlessOpen`): a CLOSED file cannot be opened
   while the phone is locked, as under `Complete`, but a capture the lock interrupts can finish - it
   runs under an expiring activity (a long iCloud video), and under `Complete` its open copies stop
   writing and no new file can be created once the phone locks, losing the share. The app's
   `write_pending` gives the app-side manifest `Complete` while it is still empty
   (`native_cache::protect_until_unlocked`, failing closed - a persistent refusal there loses the
   share, said at ERROR, never routed around). The App Group's default,
   `CompleteUntilFirstUserAuthentication`, left all of it readable on a locked phone once it had been
   unlocked since boot. The move into the app cache is a rename, and a class belongs to the file, not
   the path; the import READS it back on the first copy (`[SHARE] share <id>: moved copy protection =
   ...`) rather than assuming it.
   **A locked read deletes nothing.** Every claim goes through `handoff::claim_and_read` (the
   extension's `claimPending` is its Swift twin): a read refused with `EPERM` - the OS error CODE iOS
   answers for a protected file while locked, never a message; in Swift the POSIX error under
   Foundation's read error, by domain and code - moves the claim back and answers `Protected`. The
   move back is `renamex_np(RENAME_EXCL)`, so a manifest that landed meanwhile is never overwritten:
   the claim then stays under its claim name. Any other failure is a broken file and is still
   deleted, so "locked" is no hiding place for corruption. **The code cannot say why**: an `EPERM`
   from another cause is treated the same, and that file is kept - put back at every claim, its
   inbox never swept, said each time.
   **The app consumes nothing while its side is locked.** Before it claims the App Group manifest,
   the import reads (never claims) the app data's waiting manifest and probes a protected write
   there (`app_side_locked`, `probe_protected_write`); either refused by Data Protection answers
   `IMPORT_PROTECTED` with the share still whole in the App Group, and the unlock imports it with
   the ordinary newest-wins rule, both shares readable then. Only a lock in the instant between
   that check and the hand-over's claim still meets a locked waiting share: that answers its own
   code, `IMPORT_DROPPED_OVER_LOCKED`, NSLogged at ERROR (at launch the only logger), never the
   "imported once unlocked" of `IMPORT_PROTECTED`. The probe's refusal keeps its code at every
   step - the create, the protection (`native_cache::protect_until_unlocked` reads the `NSError`'s
   POSIX code, top level or under `NSUnderlyingErrorKey`) and the reopen - so a locked device is
   classified, never reported as a failed hand-over. A lock landing AFTER the hand-over has claimed
   the waiting share and before it writes the new manifest refuses both writes: both shares are
   lost, in a window of a few file calls, and one ERROR line names both.
   **A share arriving over a LOCKED waiting one is the one that goes - keep-old, against the usual
   newest-wins, deliberately.** It is reached in that instant on the app side, and in the extension
   when the phone locks during a capture (a long iCloud video) while an older share waits. Why: the
   waiting share cannot be read, so neither its session (epoch) nor its copies can be known - to
   replace it would delete a share the member was already told is ready ("Choisissez la
   conversation"), unseen; dropping the new one is said to the member who is sharing right now (the
   extension answers `.failed`, its card says the share could not be prepared), and at ERROR in both
   logs. The alternative (leave the old claim as `.replacing`, write the new manifest, and let the
   launch sweep delete the old as `SWEEP_CLAIM_LOST`) was rejected: once an import has carried the
   newer share out, no manifest waits beside that claim, so the sweep PUTS IT BACK and the next
   import replaces the newer share with the older one.
   **The sweep** leaves an inbox whose manifest is locked whole (`SWEEP_PROTECTED`): which copies it
   names cannot be read. A CLAIM a dead process left (`.draining`, `.importing`, `.replacing`, in the
   app data directory and the App Group) is a whole share nobody took: put back when no manifest
   waits (`SWEEP_CLAIM_RESTORED`) - a rename, which works while locked - and deleted as lost when one
   does (`SWEEP_CLAIM_LOST`, an ERROR line). A staging `.tmp` is deleted.
   **Who asks about the lock.** The launch sweep and import run from `canari_ios_bootstrap`, BEFORE
   `ffi::start_app()` creates the application object, so they put no question to UIKit (one put there
   answers NO on every launch) - a locked launch is Rust's to answer, safely. Where the application
   object exists (an activation, the extension's signal) the import is not tried while
   `isProtectedDataAvailable` is false, and says so only when a share waits. **The unlock is an
   event**: `UIApplicationProtectedDataDidBecomeAvailable` (also delivered to an app resumed after
   it) imports the App Group share and, when a manifest already waits in the app data directory - a
   drain that found it locked after a locked launch - sends the page `canari:incoming-share`, the
   page draining only at its mount and on that event. Nothing retries on a timer. Tests:
   `handoff.rs` (a locked read leaves the file, a file landing meanwhile is never overwritten, a
   broken one is deleted), `app_group_share.rs` (a locked manifest leaves both inboxes whole; a
   locked App Group share, a locked app data manifest and a refused protected write consume
   nothing; a share or refusals arriving over a locked one answer `DroppedOverLocked` and delete
   nothing waiting; a leftover claim is put back or deleted as lost), `iosShareExtension.test.ts`
   (the classes, the put-back, every import code said by its own case, no UIKit question at
   bootstrap, the unlock observer).
   **Why not an app-level seal.** The backlog's first shape sealed the text with the install's cache
   key (`CNSEAL1`). Rejected: it protected the text while the copies stayed plain, cost two crypto
   twins of the envelope (Kotlin, Swift) or the Rust library in a memory-capped extension, and an
   attacker who reads the app's files on an unlocked phone can use its Keystore or Keychain entry
   too. The platform's protection covers text and files alike.
   **No log line names a shared file**: a copy is `<index>_<sender's name>`, so `take_picked_file`
   and `discard_picked_file` say the share id and the byte count, never the path.

## Decisions

- **Destinations are conversations and salons, never a post** (user, 2026-10-11): a post's text is
  readable by the server, a message is end-to-end encrypted.
- **No server data is added.** The copies live in the app cache until the page reads them, and what
  is sent is an ordinary message.
- **A share is ERASED AT SIGN-OUT, an account switch included (user, 2026-10-22)** - it must never
  land in the account signed in next. This REVERSES the first decision ("a share belongs to the
  device holder", kept so a session expired at cold start would not lose it): the user chose the
  other risk. `clearAuthUnderway` calls `eraseIncomingShare` (`mobile/incomingShareSignOut.ts`):
  - the page's share is dropped and its copies deleted unread (`incomingShare.drop`);
  - a manifest not yet drained is CLAIMED through the drain's own command
    (`read_and_clear_pending_share`) and the copies it names are deleted unread;
  - what neither can see is closed by an ORDER, the share EPOCH (`share_epoch` in the app data
    directory, `commands/handoff.rs`). The erase ADVANCES it first. `IncomingShare.kt` reads it when
    a capture STARTS and stamps it on the manifest, and the drain returns the manifest with the
    current epoch: a capture still running natively at the sign-out lands STALE, and the next drain
    deletes it unread and offers nothing. The store is FENCED at the new epoch
    (`incomingShare.fence`), so a drain that claimed its manifest before the sign-out and offers it
    after is refused, its copies deleted. **The epoch fails CLOSED and never moves back**: an
    unreadable file is an error, not 0 - the drain then offers nothing, an advance refuses rather
    than restart the count, and a failed advance fences this process at `Infinity`. **It orders the
    native side too**: an older capture never replaces a newer session's waiting share (captures
    queue on one lock in no set order), a refusal count never crosses a sign-out, and the sweep at
    the first `onCreate` drops a waiting manifest from a signed-out session, so its copies do not
    wait on disk for the next account. A manifest the erase finds with the NEW epoch - a capture
    started in the instant after the advance - is the next session's, and is kept;
  - a staging in progress is checked against the sign-out generation read when the share was taken
    (`MainChatPage`): before each file (`stageSharedFiles`' `stillWanted`, the rest deleted unread),
    AFTER each file's preparation (`handleFilesSelected`'s, since a video re-encode takes seconds and
    `forgetAccount` has already emptied the queues), and a share held for the session
    (`whenSessionUp`) that is dropped or misdirected deletes its copies (`HeldSend.discard`). Nobody
    is told - nobody is signed in to be told.
  What is left: an unreadable claimed manifest keeps its copies until the next process start sweeps
  what no manifest names; and a persistently unreadable epoch file disables sharing INTO Canari (accused at
  every drain) until the app data is cleared - the price of never guessing which session a share is
  from. Tests: `incomingShareSignOut.test.ts` (nothing left in the
  page, on disk or as a copy; a running capture lands stale; a drain racing the sign-out cannot
  offer), `auth.shareErase.test.ts` (both sign-out exits reach it), `incomingShare.svelte.test.ts`
  (the fence), `useMessaging.mediaEnqueue.svelte.test.ts` (a sign-out mid-preparation stages
  nothing), `heldSends.test.ts`, and the `share_epoch` name pinned on both sides
  (`androidShareManifest.test.ts`).

- **The confused-deputy check is narrow, and that is accepted (Master review, 2026-10-21).** It
  refuses our own authorities and the grants Canari holds; a sender holding `READ_MEDIA_*` can
  still name a `content://media/...` URI the member never picked. The bytes only reach a composer
  the member sends by hand, in a conversation they chose, so the residual is low.

## Owed

- **S5 on the Mi 9T**: the suggestions appear in the sheet after a few conversations; picking one
  opens the picker with it preselected; the toggle off removes them; a sign-out removes them; a
  second account never sees the first's - nor its conversation shortcuts (a notification's
  conversation header, the launcher's long-press menu). `adb logcat -s ShareTargets GalleryPlugin IncomingShare`
  and the page's `[SHARE]` lines tell each step.

- A reading on the Mi 9T: text from Chrome, one and several pictures from the gallery, a PDF from
  Files, a video; cold start, warm, and with the PIN gate up. And the native half no JVM test reaches:
  a second share while the first waits (the first's copies go), a share whose every stream is
  refused while one waits (that one stays, the refusal is told), and a kill then relaunch (orphans
  swept, the waiting share kept). `adb logcat -s IncomingShare` and the
  page's `[SHARE]` lines tell each step.
- **S4, on the iPhone - nothing on Windows compiles Swift, Objective-C or the iOS `cfg` of the
  Rust**, so CI's archive is the first compile and these are the first proof: Canari in the share
  sheet of Photos (one screenshot, several pictures, a video), Safari (a URL), Notes (text) and Files
  (a PDF); the banner when notifications are allowed, the card's "open Canari" line when they are
  not; a tap on the banner opening the picker, cold and warm, with the PIN gate up; a share while the
  app is on screen (the Darwin signal, no banner); a second share while the first waits; a share
  then a sign-out (nothing offered to the next account, the App Group's `shared_inbox` empty); and
  the logs - Console filtered on subsystem `fr.emse.canari`, category `share`, plus the app's
  `[SHARE]` lines, and the `[CanariShare]` NSLog lines of the launch import and sweep. Unproven until
  then: the cross-container rename staying one volume, `flock` between the two processes,
  `loadFileRepresentation` on Photos assets, the activation rule, and the expiring activity's
  cancel path (a long video shared, then the sheet left at once). The project itself is linted by
  Xcode at the start of every `ios.yml` run (`plutil -lint`, `xcodebuild -list`) and parsed whole by
  the vitest, after a pbxproj with two unclosed objects passed every Windows check.
  Suggested next lot: iOS conversation suggestions (`INSendMessageIntent`, the S5 twin).

## One copy helper, one share-failure path (2026-10-30)

A tap on "Copier le lien" in the bookings space page, the message long-press sheet and the two invite panels gave NO confirmation (owner report, 2026-10-30): each call site wrote `navigator.clipboard.writeText` itself, and the ones that confirmed drew a private "Copie" state that stayed true when the write had been refused.

- **`utils/clipboard.ts` `copyText(text, { what })`** is the only clipboard write. `what` (`link | code | text | id`) picks the Paraglide confirmation toast; a refusal or a context without `navigator.clipboard` returns a typed `CopyResult` (`refused` / `unavailable`), is logged, and shows `clipboard_copy_failed`. `silent` skips only the success toast. One backend, no `execCommand` fallback: the web and the Tauri WebViews all expose `navigator.clipboard`, and no Tauri clipboard plugin is installed.
- `copyPublicShareLink(path)` (`utils/copyShareLink.ts`) is `copyText` over the public origin; `copyId` is `copyText` for an id.
- **`sharing/shareOut.ts` `runShareOut(what, open)`** runs any share-sheet call and owns the log and the `share_out_failed` toast (message bubble and post sheet shared two copies). It never falls back to a copy: the sheet's rows are only drawn where a sheet exists (`canShareOut`).
- The inline "Copie" states (forms list and page, calendar subscribe, backup code, group and community invite panels) were deleted: the toast is the single confirmation.
- The async invite panels copy after a network round trip, outside the tap's gesture: Safari may refuse, and the failure toast then points at the link field the panel keeps visible.
- **A text still being produced goes to `copyText` as a PROMISE, synchronously from the tap.** WebKit refuses a clipboard write after an awaited round trip, and both invite panels mint their link on the tap (a server call), so they cannot pre-hold it. A promise takes `navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })])`, which WebKit accepts inside the gesture while the promise resolves; a rejection of the promise is rethrown to the panel (its own error line), never reported as a copy failure. Superseded: the previous bullet's "Safari may refuse" caveat.
