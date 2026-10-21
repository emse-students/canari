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
| S4 | Share IN on iOS: a Share Extension `CanariShare` in the App Group, a new signing profile (owed to the user) | not started |
| S5 | Conversation suggestions in the sheet (Android Direct Share, iOS `INSendMessageIntent`) | not started - a privacy decision comes with it |

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
   - an unreadable stream, more than 10 files, a file over 200 MB, or a share past 300 MB in all.
     The page reads each kept file whole when it stages it, so these bound what the WebView holds.
   Names are reduced to their last segment and a conservative character set
   (`share/SharedFileName.kt`). `onCreate` skips a relaunch (`savedInstanceState`,
   `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`) so a share is never offered twice.
3. **The handoff is a file, `pending_share.json`** in the Tauri data directory, because a cold start
   gets the intent before the page exists and a value pushed into a page that then navigates is
   lost. It is written to a `.tmp` and renamed into place, so a drain on a return to the foreground
   never reads half of it. `read_and_clear_pending_share` (`commands/handoff.rs`, the same helper as
   the CallKit answer's `pending_call_accept.json`) hands it over exactly once. **Each capture first
   empties the inbox**: a newer share replaces whatever came before (undrained, drained but never
   staged, or left behind by a corrupt manifest or a failed read), and nothing outside the inbox is
   ever deleted from there.
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
   files are read NOW (`readSharedFiles`), each through `take_picked_file`, which deletes the copy
   as it reads it. Its allowlist names the inbox itself and NOT the app cache around it, which also
   holds the WebView's files and the gallery's decrypted staging; on Android its other roots are the
   EXTERNAL cache and the process temp directory, so the two names are pinned equal by a test. The
   files then go through `handleFilesSelected` - the same size ceiling, compression and video
   re-encode as a picked file. **The member sends with Send. A share is never sent on its own.**

## Decisions

- **Destinations are conversations and salons, never a post** (user, 2026-10-11): a post's text is
  readable by the server, a message is end-to-end encrypted.
- **No server data is added.** The copies live in the app cache until the page reads them, and what
  is sent is an ordinary message.
- **A share belongs to the device holder, not to an account**: it is memory only on the page side,
  and a sign-out does not drop it (a session that expired at cold start would otherwise lose the
  share the member just made).

## Owed

- A reading on the Mi 9T: text from Chrome, one and several pictures from the gallery, a PDF from
  Files, a video; cold start, warm, and with the PIN gate up. `adb logcat -s IncomingShare` and the
  page's `[SHARE]` lines tell each step.
