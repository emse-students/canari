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
| S3 | Share OUT (Android + iOS): `share_text` / `share_staged`, message and post menus | built - [share-out](share-out.md) |
| S4 | Share IN on iOS: a Share Extension `CanariShare` in the App Group, a new signing profile | **set aside (user, 2026-10-22)** - blocked on an App ID and a provisioning profile only the user can make ([backlog](../backlog.md)) |
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
    (`read_and_clear_pending_share`, so a capture racing it is either claimed or lands after) and
    the copies it names are deleted unread;
  - a staging in progress stops at its next file (`stageSharedFiles`' `stillWanted`, the sign-out
    generation) and deletes the rest, telling nobody - nobody is signed in to be told.
  What is NOT covered: a share whose copy is still RUNNING natively when the sign-out lands writes
  its manifest afterwards, and the next account is offered it. It was made after the member tapped
  "sign out", by whoever holds the phone. An unreadable claimed manifest leaves its copies until the
  next process start sweeps what no manifest names. Tests: `incomingShareSignOut.test.ts` (a share
  pending, then a sign-out: nothing left in the page, on disk or as a copy).

- **The confused-deputy check is narrow, and that is accepted (Master review, 2026-10-21).** It
  refuses our own authorities and the grants Canari holds; a sender holding `READ_MEDIA_*` can
  still name a `content://media/...` URI the member never picked. The bytes only reach a composer
  the member sends by hand, in a conversation they chose, so the residual is low.

## Owed

- A reading on the Mi 9T: text from Chrome, one and several pictures from the gallery, a PDF from
  Files, a video; cold start, warm, and with the PIN gate up. And the native half no JVM test reaches:
  a second share while the first waits (the first's copies go), a share whose every stream is
  refused while one waits (that one stays, the refusal is told), and a kill then relaunch (orphans
  swept, the waiting share kept). `adb logcat -s IncomingShare` and the
  page's `[SHARE]` lines tell each step.
