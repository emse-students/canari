# Sharing into and out of Canari

The OS share sheet, both ways, the way Messenger or Discord use it (user, 2026-10-11; made a
priority 2026-10-21). **In**: another app's "Partager" offers Canari, the member picks a conversation
or a salon, and the content waits in that conversation's composer. **Out**: "Partager..." on a
message, a picture or a post opens the system sheet. CanaRun (activity cards from a GPX/FIT file)
builds on the IN half later and is not started.

## The lots and where each stands

| Lot | What | State |
| --- | --- | --- |
| S1+S2 | Share IN on Android: the intent filter, the native copy, the "Envoyer a..." picker, the composer staging | built (this page) |
| S3 | Share OUT (Android + iOS): `share_text` / `share_file`, message and post menus | not started |
| S4 | Share IN on iOS: a Share Extension `CanariShare` in the App Group, a new signing profile (owed to the user); **the iOS conversation suggestions (`INSendMessageIntent`) are folded in here**, since they need that extension | not started |
| S5 | Conversation suggestions in the Android sheet (Direct Share / sharing shortcuts) | built (Android), [below](#share-suggestions-android---lot-s5) |

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
3. **The handoff is a file, `pending_share.json`** in the Tauri data directory, because a cold start
   gets the intent before the page exists and a value pushed into a page that then navigates is
   lost. It is written to a `.tmp` and renamed into place, so a drain on a return to the foreground
   never reads half of it. `read_and_clear_pending_share` (`commands/handoff.rs`, the same helper as
   the CallKit answer's `pending_call_accept.json`) hands it over exactly once: it **claims the file
   by renaming it before reading it**, so a newer manifest renamed into place meanwhile waits for
   the next drain instead of being deleted unread. A capture replacing an undrained share claims
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
   The pick is published as a deep-link landing (`notifNav.navigate` + `chatDeepLinkRoute`), so the
   conversation opens exactly as a tapped notification would, salons under `/communities` included.
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

## Decisions

- **Destinations are conversations and salons, never a post** (user, 2026-10-11): a post's text is
  readable by the server, a message is end-to-end encrypted.
- **No server data is added.** The copies live in the app cache until the page reads them, and what
  is sent is an ordinary message.
- **A share belongs to the device holder, not to an account**: it is memory only on the page side,
  and a sign-out does not drop it (a session that expired at cold start would otherwise lose the
  share the member just made).

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
