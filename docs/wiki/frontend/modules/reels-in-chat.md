# CanaReels in a conversation - an ephemeral video message (DESIGN STUDY, decisions taken 2026-10-09 and 2026-10-30; RC-1 to RC-5 and RC-7 merged, the writer OFF; "Envoyer à..." to several targets designed in section 15, not built)

**Decided by the user, 2026-10-09** (French, relayed): generalise CanaReels *like Snapchat*, so a
member can SEND a reel in a group, a DM or a community salon. **The chosen form is an EPHEMERAL VIDEO
MESSAGE filmed in the chat - end-to-end encrypted like any message, expiring like a reel (30 days) -
and NOT a link to a published public reel.** This page is the study that precedes the build: it reads
the code and wiki as of `main` at `13d633aec` (2026-10-09), decides what can be decided, and names what
the user must rule on. **No product code was written by the study.** **The user's rulings of 2026-10-09 are recorded in
section 9, and where the text below still says otherwise (it was written before them) section 9
wins.** The published reel (feed, public, post row)
stays exactly as [reels](reels.md) and [reels (server)](../../services/reels.md) describe it.

**Not on `main` when this was written: `docs/wiki/frontend/offline-and-weak-network.md`** (searched on
`origin/main` after a fetch; no open pull request found by title). Section 5 therefore states what the
weak-network work must provide and WP-RC-5 is blocked on it; when that page lands, reconcile the two
before building (the upload path below is the one most likely to overlap).

## 0. What is reused, what is new - in one table

| Piece | State today | In a conversation |
| --- | --- | --- |
| Camera, one shutter (tap = photo, hold = video), 90 s ring, framed capture | `ReelCapture` / `CameraScreen` / `framedCapture.ts` ([reels](reels.md#the-capture-screen-c4)) | **reused as is** behind a `destination` prop |
| Review: full-bleed, looping, top mute, editor, sound removal | `ReelReview`, `ReelEditor` ([reel-editor](reel-editor.md)) | **reused as is**; its "Suivant" becomes "Envoyer" |
| Publish step (caption, identity picker) | `ReelPublishSheet`, `publishReel.ts` | **not used** (no identity, no feed); an optional caption reuses `MediaMsg.caption` |
| Preparation on the phone, one H.264/AAC MP4 | `prepareVideoForUpload` ([video-preparation](../video-preparation.md)) | reused with a **chat profile** (lower bitrate, section 4) |
| Segmented encryption, ranged reads, streamed play | `mediaSegmented.ts`, `PostMedia` ([media-service](../../services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01)) | reused for the full-screen viewer |
| The CEK inside the MLS / Graine body | `MediaMsg.key` ([channel-encryption](../../protocols/channel-encryption.md)) | reused: nothing about key custody changes |
| Retention class `reel` + social-service worker | posts only | **not reusable**: a conversation has no social-service row (new class, section 2) |
| A message type | `MediaMsg` (`MEDIA_KIND_VIDEO`, `voice_note` precedent) | **one declared intent field**, not a new top-level message |
| Tombstone when the blob is gone | `410` + `MediaPurgedError` on every media surface | reused, with a reel-shaped tile |
| Push for a message | decrypted on device (Android service, iOS NSE), `mediaKind` carried | **built (RC-7, section 12)**: `mediaKind` `reel` and one `PushText::Reel` sentence in the Rust scanner, fr + en |

## 1. Entering the camera from a conversation

**STATUS (2026-10-11, the D-camera package): the OVERLAY AND THE `destination` PROP ARE BUILT, the reel message is NOT.** `ReelCapture` takes `destination: 'feed' | 'post' | 'chat'` (a string form of the object sketched below; `reels/reelCapture.ts` `destinationRules` is the one table) and `CameraOverlay.svelte` mounts it as a full-screen layer over a composer, with its own history entry (Back closes the camera when idle; a take pushes its own above it). **Both entries leave the stack at once, whenever the overlay goes away with a take still held** (a take handed back, or the composer unmounted under a review), and their history entries stay as ghosts: the next overlay takes the one under the pointer over, and the next Back closes the overlay on screen (the conversation), never a dead entry - pinned by `CameraOverlay.svelte.test.ts`. In a CHAT it takes PHOTOS ONLY and a photo goes out as an ordinary image message (RC-3..RC-5 add the video, which is the reel message); in the new-post composer a photo produces a POST and a filmed video a CANAREEL since 2026-10-19 (user: one camera, one behaviour - [reels](reels.md#the-two-ways-into-the-camera-publish-the-same-thing-2026-10-19)); the post editor attaches both. The camera entry is the composer's "Ouvrir la camera"; no system camera is reachable from a COMPOSER or the CanaReels tab - in the iOS app the post composer's "Photo/video" and the tab's gallery open the native library (`pickNatively`), since WebKit answers an image/video input with a sheet that offers the system camera. **NOT covered, deliberately named (2026-10-15):** the single-image inputs outside the composers - an event cover (`EventFormModal`), a form cover (`FormBuilder`, `forms/[id]/edit`), a community icon (`SidebarCommunityAdminPanel`), an association picture (`SquareImageCropper`), a calendar export background and the carte admin background - still get WebKit's sheet, "Prendre une photo" included, in the iOS app. They are not capture surfaces of D-camera (a cover or an icon, not a message or a post) and the user's decision named the composers; routing them natively is a change of each picker's crop flow, not of this package. The overlay does NOT set `fullscreen-place-open`: that class re-lays the page out (shell and scroller padding, `overflow: hidden`), and under an opaque layer its only effect was to clamp a scroller sitting at its bottom, so the conversation came back shifted. **It IS a screen cover (`use:coversScreen`)**: on iOS the conversation's glass chrome (back, title pill, menu, the composer's "+") and the tab bar are NATIVE views above the WebView that no `z-index` reaches, and they painted over the viewfinder until the overlay registered (iPhone 12, `1.2.9-alpha.1`, 2026-10-15; the post composer's camera was clean only because its modal already covered) - pinned by `CameraOverlay.svelte.test.ts`. A lens the OS takes back (another app, a revoked permission) ENDS its track, and `CameraSession` turns that `ended` into `error`/`busy` instead of a frozen `live`. **Staged files are per conversation** (`useMessaging` `pendingMediaFilesFor`): a photo staged in A and not sent stays in A's composer, never in B's; a send removes only the files it took (one staged during its membership barrier stays for the next send); a sign-out forgets every staging and armed reply (`forgetAccount`, called by `handleSignedOut`), since the next account may open the same conversation ids. A lens that ends gives the fault `interrupted` ("La camera s'est arretee": another app or a withdrawn permission, the track does not say which), a microphone that ends mid-session turns the camera to photos only (`CameraSession.microphone`), and both listeners leave with the tracks. **The iOS native picker reads every pick WHOLE into memory before any check** (`pickNatively`: the dialog plugin hands back paths only, no size or duration), so the 90 s cap of the CanaReels gallery is applied after the read; the gallery opens a ONE-file picker (`single: true`) so nothing it would drop is read, and the bound on that one file is the device memory - measured on no phone yet.

### The Mi 9T reading of v1.2.9-alpha.1 - five findings fixed (2026-10-15)

The reading ([device-verification](../../device-verification.md), PR #1917) passed the camera and named five defects; the causes, each read from its console:

- **Back on a taken photo closed the camera first, then asked; "La garder" kept nothing** (P2, 2 of 2, `Back closed 2 overlay(s)`). Not the camera's code: the "+" menu's pick ABANDONS the menu's entry (`history.back()`, asynchronous) and the camera mounts in the same task and PUSHES its own (synchronous). The traversal then went back off the camera's entry, the take's push truncated it, and the next Back landed below both. `historyOverlayStack` now NEVER traverses to close: a UI close, an abandon and a release take the overlay off the stack at once and leave its entry as a ghost, and a push made while the pointer stands on a ghost TAKES that entry (`replaceState`, a hand-off at the same depth) instead of pushing. A member's Back closes every overlay above the entry it lands on, or the top one when none is above; a Back that leaves a ghost with nothing open walks on, as before. Two earlier designs held the push until the app's own traversal landed, and a model check over every sequence of push/close/abandon/Back/navigation (length 5, router and bfcache at 4) found holds that never ended - a back at the history's first entry fires no `popstate`, two backs predict the same landing, a shallow route or a bfcache restore loses the one in flight (reviews of #1925). The redesign has no state to get stuck: 111,110 and 30,940 sequences, no failure. One cost, accepted: a Back that closes the overlay whose own entry it landed on leaves the pointer on that ghost, so the press that then leaves the page crosses it. Pinned in `historyOverlayStack.test.ts` (a history fake whose pointer moves when the traversal RUNS) and `CameraOverlay.svelte.test.ts`.
- **A refused camera was asked twice** (P2). Android's permission dialog backgrounds the WebView, and `CameraScreen` stopped the session on `hidden`: the request the dialog was answering went stale, its refusal was dropped, and the return opened the camera again - a second dialog. `CameraSession.suspend()` now leaves an open in flight to land (released at once if granted while away), and `resume()` reopens only a session the background stopped: a refusal is shown once, as the refusal screen. Any OTHER failure while away (busy, unavailable: Android does not start a camera for a hidden app) is the background's, so the session is stopped and the return opens it again.
- **The refusal screen asked for the microphone in the chat** (P3). Only the reel tab asks it in the lens's own request; `CameraScreen` takes `microphoneAsked` (`destinationRules().microphone === 'with-lens'`) and otherwise says `reels_camera_denied_body_camera_only`.
- **The post take arrived as `canari-video-*.bin` with a grey tile** (P3). Asked for `video/webm;codecs=h264,opus`, the Android WebView reports `video/x-matroska;codecs=avc1,opus`; `captureFileFrom` names it from a table (`.mkv`) and accuses an unknown type. The same table missed the editor's flattened photo (`image/webp`, `reelEditor.ts`), named `.bin` on alpha.3; it now lists every type a canvas encode here returns (JPEG, WebP, and PNG where an engine cannot encode WebP), HEIC deliberately not. The tile was grey because a recorder's file has no seek index, so `PickedMediaPreview`'s `#t=0.1` decodes nothing: the camera takes a still of the preview (`ReelClip.poster`, `takeFramedThumbnail`: 360 px long edge, ~4 % of a full photo's pixels) BEFORE the drawing loop and the recorder start, so its synchronous encode costs the take no frame, and attaches it to the file (`reels/capturePoster.ts`), which the preview draws.
- **Back closed the new-post composer and dropped its video** (P3). The composer asks nothing about unsent TEXT, it keeps it as a draft; media now follow that rule, held in memory per account (`holdPostComposerMedia`, not `localStorage`: a reload still loses them; dropped at sign-out by `forgetPostComposerMedia`; each open makes and revokes its own preview URLs) and restored at the next open, with the banner saying "texte, options et médias".

**Owed on a device:** all five on the Mi 9T (Back + "La garder" on a chat photo and a post video, a refusal from a fresh permission, the post video's name and tile), and the iPhone 12 for the permission and Back paths, whose WebKit timing nothing here models.

### The iPhone 12 reading of v1.2.9-alpha.2 - the edge swipe is the iOS Back (2026-10-16)

The iOS app has NO system Back: Tauri's WKWebView does not enable the back-forward swipe, so no `popstate` ever comes from the left edge. Its only Back is the swipe the conversation draws itself (`swipeBack` on `ChatArea`), and that swipe called `onBack` (`goBackToMenu`) directly, outside the overlay stack. Two findings, 2 of 2 each, both of that one cause:

- **With the "+" menu open, ONE swipe closed the menu AND left the conversation.** The swipe closed the conversation; the menu went with the composer's teardown. It now asks the stack first (`backHistoryOverlayFromGesture`): the TOP overlay closes, told `'back'`, as Android's Back would; the conversation's own entry closes it when nothing is over it, and `onBack` is left for a layout where nothing holds an entry.
- **A swipe over the photo review did nothing.** `CameraOverlay` is portalled to `document.body`, out of `ChatArea`, so no touch over it reached the only swipe there was. The layer now carries the same `swipeBack`, closing the top overlay: the take (which asks), then the camera.

What the review of #1936 added:

- **No swipe arms inside `[data-swipe-back-off]`** - `ReelCapture`'s root carries it while the editor is open (a paint stroke or a sticker drag from the left edge dragged the whole layer, then asked to leave the editor mid-stroke) or a take is being FILMED (the swipe dropped the recording unasked; a recording ends by its own shutter, so the swipe is ignored there rather than asking).
- **One predicate for the swipe and the entries**: the stack is asked only in the overlay layout (`isOverlayLayout`, below `xl`), where the conversation holds an entry. On a touch screen of 1280 px and more (an iPad in landscape) the swipe is the conversation's `onBack` again; it had closed an unrelated top entry (a community admin panel) instead.
- **Leaving a thread ends the salon selection on every exit** (`onThreadLeft`, registered once in `globalChatSingleton`): the history close (Android's Back, the iOS swipe) left the salon row highlighted, since only the in-app back cleared it.
- **The iOS app writes NO history entry for an overlay** (`initHistoryOverlayStack({ systemBack: false })`): nothing there ever pops one, and closing N nested overlays by swipe left N ghosts of which only the one under the pointer is taken again - N-1 entries for good per cycle.

Pinned by `ChatArea.swipeBack.svelte.test.ts`, `CameraOverlay.svelte.test.ts`, `ReelCapture.svelte.test.ts`, `swipeBack.test.ts`, `useConversations.backOutOfLanding.svelte.test.ts` and `historyOverlayStack.test.ts`; the model check gained the gesture Back as an operation (177,155 sequences to length 5, 41,370 with router and bfcache to 4) and an iOS mode with no entries (579,194 sequences to length 5, router, shallow and bfcache included), no failure. **NOT covered, named:** a `Modal` or sheet portalled over a conversation still gets no swipe on iOS - the same mechanism, filed in [backlog](../../backlog.md#p3---ios-a-modal-or-sheet-over-a-conversation-has-no-edge-swipe-found-2026-10-16). **Owed on the iPhone 12:** the two sequences above, then a swipe on the review answered "La garder" (the review stays, a second swipe asks again).

### The iPhone 12 reading of v1.2.9-alpha.3 - one gesture, one close (2026-10-16)

**With the "+" menu open, ONE swipe still closed the menu AND left the conversation (3 of 3, DM and salon); a tap at the edge closed only the menu.** The commit closed the stack's top AT THE END of the stroke, and the logic is right on a model: mounting `ChatArea` with the real composer, opening "+" and swiping leaves the conversation open in happy-dom. So on the device the menu is already off the stack by the commit, and the conversation, now on top, is what the swipe closes. What takes the menu off mid-stroke is NOT read (the `[historyOverlay]` lines were debug, which the in-app log does not record), so the fix holds whatever it is:

- **A gesture closes at most the overlay that was on top when its finger came down.** `swipeBack` gained `onArm`, where `ChatArea` and `CameraOverlay` record `armHistoryOverlayGesture()`; `backHistoryOverlayFromGesture(arm)` closes nothing when that overlay is gone by the commit - the gesture was spent on it - and the owner does not act either.
- **The commit waits for the panel's OWN `transitionend`, or its `transitioncancel`.** The event bubbles, and the `{ once: true }` listener committed the Back on the first transition any descendant ended. A node hidden mid-slide fires only `transitioncancel`.
- **One stroke commits once.** At most one release handler waits, and a new gesture that arms drops it. The arm is handed over ONCE: a second commit gets `null`, which is spent too. Unarmed, it would close the next overlay down, which is exactly "the menu AND the conversation".
- **The one real candidate for the device cause, unproven:** a `keyboardOpened` flicker (`ChatComposer.svelte`'s keyboard effect, `composerSurface.ts`: `menu` + `keyboardOpened` -> `idle`). A `visualViewport` change during the stroke would close the menu mid-gesture. The info line tells it apart: `gesture Back spent` says something closed the menu before the commit.
- **The two decisions log at `info`** (`[historyOverlay] gesture Back closes overlay N` / `gesture Back spent: ...`), one line per committed swipe, so the next reading names which one ran.

Pinned by `ChatArea.swipeBack.svelte.test.ts` (a menu closed during the stroke; a descendant's transition). **Owed on the iPhone 12:** the "+" menu open, one swipe: only the menu closes, in a DM and in a salon; then the in-app log names `gesture Back closes overlay` or `gesture Back spent`. A `spent` line means something else closed the menu during the stroke, and that closer is the next thing to find.

**An OVERLAY over the conversation, never the `/camera` tab.** The tab is a swipe place left of the feed
(`CAMERA_PLACE`, [reels](reels.md#the-tab-c5)) and its origin logic (`cameraOriginFrom`) returns to a
PATH. A conversation is selected by state, not by a route a Back can restore (`notifNav`, the
`conversationId` in the layout), so leaving through the tab and coming back would drop the draft, the
scroll position and the selected conversation. So `ReelCapture` is mounted by the conversation itself
inside a full-screen layer carrying `fullscreen-place-open` on the document (today set from
`isFullScreenPlace`, a ROUTE predicate: the overlay needs the same class, set and removed by the layer),
and it takes the same history entries a take already takes (`pushHistoryOverlay`), so Android Back and
the iOS edge swipe end a recording, then discard a review, then close the camera - the contract of
the tab, unchanged.

**The prop.** `ReelCapture` gains `destination: { kind: 'feed' } | { kind: 'conversation', target }`
(`target` = the chat target the composer already holds: a DM or group conversation id, or a channel
id). `feed` is the current behaviour byte for byte. `conversation` changes exactly three things:

1. the review's primary action is "Envoyer" (it opens NO publish sheet - there is no identity to
   choose and nothing to caption mandatorily);
2. the 90 s ceiling comes from the same `GET /api/posts/reel-limits` call, so there is still ONE copy
   of the number (**decision: the chat shares C4's 90 s**, the user said "the 90 s limit"; a shorter
   chat cap is a one-line change in that route's answer, never a client constant);
3. the take is handed to the conversation's pipeline (section 2 and 5), **not** to `publishReel`, and the
   camera closes at once - the member returns to the conversation and watches the bubble work.

**The entry points (composer).**

| Where | Control | Notes |
| --- | --- | --- |
| Composer, EMPTY field | a camera button beside the microphone (Snapchat's place) | disappears when text is typed, as the mic does; the mic keeps its own hold gesture, the camera is a TAP target - two hold gestures side by side is how a slide turns into the wrong one |
| The composer's "+" menu ([chat](chat.md#one-attachment-menu-and-a-gif-panel-in-the-keyboards-place-2026-10-02)) | an entry "CanaReel" | the discoverable path and the desktop one; same handler |
| The same "+" menu (phone apps; `addMenuItems`, one list for the web glass menu and the iOS native one) | an entry "CanaReels" (WP-REELS-MENU, 2026-10-18) | NAVIGATES to the camera TAB (`CAMERA_PLACE`), it opens no overlay: the tab is otherwise reached only by a swipe nothing announces. Not in the Android browser's paperclip menu. Owed: count of members who ever opened the camera, afterwards |
| Camera inside the overlay | exactly the tab's controls | the camera opens on the FRONT lens (`CameraSession.facing` starts at `user`) |

**Tap vs hold inside the overlay.** The shutter is unchanged: a HOLD films a reel. A TAP takes a photo,
and **a photo from this camera goes out as an ORDINARY image message, not a reel** - the same rule the
feed applies (a photo is published as an ordinary post because "a reel is exactly one video",
[reels](reels.md#one-shutter-and-a-capture-that-is-the-preview-2026-10-05)). It is the one place a
member could expect ephemerality and not get it, so the review for a photo says "Photo" and not
"CanaReel" (decision D6, section 7: do the user want ephemeral photos as well - a different class and a
different bubble, a later package, not smuggled in here).

**Accessibility of the gesture.** The tab's shutter has been hold-only since 2026-10-05, and a hold
is not available to every hand. The conversation overlay adds an accessible alternative at once: the
shutter exposes `role="button"` with `aria-pressed` toggling record/stop through the keyboard
(Space/Enter) and a "tap to start, tap to stop" lock offered by a short sliding gesture, as Snapchat's
lock is. The same alternative should then be given back to the tab (a separate, small fix noted in
section 6; the study does not widen the scope).

## 2. The message model

### 2.1 One message type, two declared fields

**No new `AppMessage` kind.** A reel message is a `MediaMsg` with `kind = MEDIA_KIND_VIDEO`, the
declaration the sender alone can make, exactly as the voice note did: `voice_note = 11` was added
because "a voice note and an imported `.m4a` are the same bytes" and a file-name rule is "a distinction
carried in prose that the next file manager breaks" ([chat](chat.md)). A camera take and a picked clip
are the same bytes too. So `MediaMsg` gains (field numbers to be taken from the proto at build time):

```proto
// How this media was made and what it is for. DECLARED BY THE SENDER; 0 reads as an ordinary attachment.
enum MediaIntent { MEDIA_INTENT_NONE = 0; MEDIA_INTENT_REEL_MESSAGE = 1; /* 2 reserved: VIEW_ONCE (section 3.4) */ }
MediaIntent intent      = 14;
uint32      duration_ms = 15; // declared, drawn on the tile before a byte is fetched; never trusted for a limit
int64       expires_at_ms = 16; // display hint (section 2.4); the SERVER's clock is the authority
```

An enum, not a bool, because the decided later mode (view once) is a second value, and because an
unknown VALUE must be read as "ordinary video", never as an error.

**Compatibility is free in the direction that matters.** A client older than the build reads the
message as an ordinary video attachment (proto3 skips unknown fields; `MediaRef` decoders drop what
they do not know). It plays it like a chat video, from a bubble with a download - which is a
softer ephemerality (it can save it, see 3.3) but never a broken message, and the blob still goes at
30 days. **This is the one reason the intent must not be the file name or a mime parameter.** No
`minClientVersion` bump is needed for the plain reel message; **view once WOULD need one** (an old
reader would treat it as a durable video), see 3.4.

**The payload, field by field**, all inside the MLS application message (DM/group) or the Graine body
(salon) - so the server never sees any of it:

| Field | Source | Notes |
| --- | --- | --- |
| `media_id` | the upload's answer | opaque |
| `key` (CEK), `iv`, `encoding = SEGMENTED_V1` | `encryptAndUpload` | segmented, so the viewer streams |
| `mime_type` | the prepared file's `type`, codecs included | `chooseSegmentedPlayback` reads the codecs from it |
| `size` | plaintext bytes | |
| `width`, `height` | `PreparedVideo` | 720x1280-ish: reserves the 9:16 box before the first byte |
| `duration_ms` | `PreparedVideo.durationSeconds`, clamped to the cap as `declaredReelDurationMs` does | |
| `placeholder` | a ThumbHash of the FIRST frame | existing field 13, the box paint ([media-frame](../media-frame.md)) |
| `caption` | optional text typed in the review | existing |
| `intent`, `expires_at_ms` | new | |

**No separate poster blob.** The bubble paints the ThumbHash (25 bytes, blurred) and a play glyph; it
fetches nothing before a tap. A recognisable poster would be a second upload under the same class, an
extra leak in a notification preview or an OS-level thumbnail, and Snapchat itself shows an opaque tile
on purpose. Owed to the user as D5 only if they want a real preview frame (it would be a <= 24 KB JPEG
carried as `bytes poster`, encrypted with the rest, and nothing else changes).

### 2.2 The retention class: a NEW one, swept by AGE, by media-service alone

The published reel's `reel` class cannot be reused: its lifecycle belongs to social-service (the
claim after publication, the hourly `ReelRetentionScheduler` selecting due ROWS, then calling
`reel-purge` per owner - [reels (server)](../../services/reels.md#the-retention-class-reel-and-the-claim)).
A DM or a group message has no social-service row, and the message queue is chat-delivery's. Making a
conversation reel depend on a social-service row would invent a table to hold a clock.

So media-service gains a fifth class, **`chat-reel`**:

| | |
| --- | --- |
| Set by | the client at upload (`encryptAndUpload`'s REQUIRED class argument, so no call site can forget it). A client labelling something `chat-reel` gains only a SHORTER life (30 days from upload against 90 days idle) - nothing here can make a blob last longer, which is why the client may set it, unlike `association` |
| Swept | **by AGE from `createdAt`, not idleness** (`lastAccessAt` is refreshed on every download: an idle clock would let a reel watched every 29 days live for ever, the opposite of the decision). Window: `CHAT_REEL_RETENTION_DAYS = 30`, ONE constant in media-service, overridable by env on the bench so a verification can cross it |
| Mechanism | the existing sweep (boot, hourly, on `download()`), whose allowlist predicate `isSweepable` is the ONE copy (`getStorageStats` calls it too): it gains `chat-reel && createdAt + window < now`. **Still an allowlist** - nothing becomes sweepable by omission |
| Tombstone | the existing tombstone with `purgeReason = reel_expired` (the 90-day tombstone trim stays), so the client's `410` handling needs no new wire shape |
| Account deletion | takes it (`removeAllOwnedBy`), like `reel` |
| Stats | `chatReelCount` / `chatReelBytes` and an `overdue` figure on `/admin/storage` - an exempt or new class folded into a total is one whose growth nothing can see |
| Deleting a message for everyone | the sender's client calls a new owner-only `DELETE /api/media/:id` for a `chat-reel` blob. Allowed here and refused for ordinary media because **a reel message cannot be forwarded** (3.3): the "a blob can be cited from conversations the deleter cannot see" reason in [media-service](../../services/media-service.md#retention-a-90-day-idle-sweep-on-chat-media-and-nothing-else-deletes-them) does not apply. The owner check is the allowlist, as in `reel-purge` |

**Cost to decide, with a number.** A 90 s reel at the post profile is ~28-35 MB of ciphertext, kept 30
days; one blob serves a whole group (the CEK is shared, the ciphertext is stored ONCE). At the chat
profile (section 4) it is ~14-17 MB. The storage forecast ([storage-forecast](../../infrastructure/storage-forecast.md))
has to be re-read with the expected sends per active member per day before the build ships (WP-RC-0 owes
it: nothing here has been measured on production).

### 2.3 Salons

A community salon message is server-authoritative and carries its encrypted body in `channel_messages`
(Graine v2: the author is proven, the ciphertext is bound to its place,
[channel-encryption section 21](../../protocols/channel-encryption.md)). The `MediaMsg` rides in that
body like any attachment, so nothing in the cryptography changes. Two things are salon-specific:

- **The row outlives the blob.** `channel_messages` keeps messages for 365 days
  (`CHANNEL_MESSAGE_RETENTION_DAYS`); the reel's blob goes at 30. The bubble is therefore a tombstone
  for eleven months, which is the intended behaviour and the reason the tile must read well expired
  (2.4).
- **A moderator can delete the message, and the blob must go with it.** Social-service holds the
  author (`channel_messages` is the place the proven author lives), so it calls an internal
  `chat-reel-purge { mediaId, ownerId: <author> }` - the same ownership allowlist as `reel-purge`,
  never "class is chat-reel". A moderator is not the uploader, and the allowlist still holds because
  the OWNER named is the author the row proves.

**To verify before the build (WP-RC-0, not asserted here):** who may `GET /api/media/:id` for a blob a
salon message cites - the table says "owner or group member", and a salon has no MLS group in that
sense. If any JWT may fetch it (a member who left keeps the CEK only if they cached the message, but
the blob stays fetchable until it expires), say so in the page and accept it explicitly: it is
consistent with every other salon attachment today.

### 2.4 What the recipient sees after expiry

A **tombstone tile**, not a vanished message and not an error: the same 9:16 box, no ThumbHash (an
expired ephemeral should not keep a blurred ghost of itself), the label "CanaReel expire" and the age
of the message. Two facts make it, in this order:

1. the message's own `expires_at_ms` (a DISPLAY hint set by the sender from `sentAt + 30 days`): the
   tile draws expired without a request. This exists because *never learn by failing what a fact could
   have told you* - without it the first sight of an expired tile costs a `410` per bubble per
   scroll. It is never the authority: a tampering sender can only SHORTEN, since the server sweeps on
   its own clock.
2. the `410` (`MediaPurgedError`) - the truth, for every early loss (account deletion, a moderator,
   the sender's delete) and for a hint that disagrees. `404` keeps its own `media_error_not_found`.

The message row, its reactions and replies stay (a conversation's history is not edited by a blob's
life). The caption survives under the tombstone only if the member wrote one - their words, not the
video's. **No "deleted in N days" chip** (the user ruled it out for the feed on 2026-10-02: it is "pas
discret"); a reel message shows its AGE like a reel does.

## 3. The viewer

### 3.1 In the conversation: a tile, not a player

`MessageMediaRenderer` gets a branch for `intent === REEL_MESSAGE` BEFORE the generic video branch (and
**the study repeats the lesson of #1229: that file once lost every photo to the video branch and no test
had ever mounted it - this branch needs a mounting test on day one**). The tile is 9:16 at the media
width the chat already fixes (`w-68`, a fixed width, never a percentage), drawn from `width`/`height` so
the layout never shifts; ThumbHash fill, a play glyph, the duration (`0:42`), the caption in the bubble
as for any media.

- **No autoplay, no prefetch in the bubble.** The chat reads media WHOLE (bubbles do not stream) and a
  reel is 14-35 MB; auto-fetching it on arrival would spend a member's mobile data on a message they
  may never open and would defeat the whole weak-network posture (section 4). The tile fetches on
  TAP.
- States the tile draws, each a typed state, never a string compare: `idle`, `fetching` (a ring and the
  fraction), `failed-retryable` (a retry), `expired` (2.4), `sending` / `failed-send` for the sender
  (section 5).

### 3.2 Full screen: the existing viewer, single-slide plus the unseen ones

A tap opens `ReelViewer` in a **conversation mode**: the touched reel first, then the other reel
messages of THIS conversation in the order the member would watch them - Snapchat's chain. The
vertical swipe/next machinery, the preload of the next one, the single mounted player and the "ONE
sound answer" are `reelViewerNav.ts` / `reelPreload.ts` / `VideoPlayer` unchanged; only the source of
the list changes (the conversation's loaded messages instead of `GET /api/posts?kind=reel`). The
viewer plays through `PostMedia` in gallery mode, i.e. it STREAMS a segmented blob as it arrives.
Chrome in the viewer: close, the sender's name and age, the caption, **no** save, **no** share, **no**
forward (3.3), mute follows the app's one sound switch (muted until the member has turned sound on
anywhere, the rule `VideoPlayer` already enforces), loop on.

**Autoplay muted vs sound.** On open it plays (a tap is a user gesture, so the engine's autoplay policy
allows sound); sound follows the app-wide switch, exactly as a published reel does. No second setting.

### 3.3 Save, forward, screenshot - what is and is NOT preventable

| Action | Policy decided here | What is truly preventable |
| --- | --- | --- |
| The SENDER saves their own take | allowed, at the review ("Enregistrer", `ReelSaveButton` + the gallery plugin, C6) - the member's own footage, kept before it is gone | n/a |
| The RECIPIENT saves | **no button in v1** | a button is a courtesy, not a barrier (below) |
| Forward / copy | **not offered** for a reel message; the action sheet drops them | forwarding copies the `MediaRef` (so the CEK) - a modified client can always do it |
| Screenshot | not blocked, not announced | **Web/desktop: nothing.** **Android: `FLAG_SECURE` blocks screenshots and screen recording of the viewer** (also blanks the app-switcher thumbnail) but is native work on the window and still loses to a second phone. **iOS: no supported way to block a screenshot**; `UIScreen.isCaptured` and the screenshot notification can DETECT, and the secure-text-field trick can blank a recording, but it is undocumented and brittle |
| Screen recording | same | same, Android 14+ also offers a capture callback |
| A camera pointed at the screen | nothing | nothing, anywhere |
| A modified client or devtools | nothing | the recipient's client holds the CEK and fetches the ciphertext; whoever runs it can write the plaintext out. The 30-day deletion removes the SERVER's copy, not what a recipient kept |

**What the product may therefore claim, and what the UI must never say.** "Disappears after 30 days"
is true of the server's ciphertext. "Cannot be saved" is NEVER true and the copy must not suggest it
(no "protected" badge, no "screenshots are blocked"). The sentence for the sender, once, in the review:
"Ce CanaReel est supprime des serveurs apres 30 jours. Un destinataire peut toujours en garder une
copie." (D4: whether to add `FLAG_SECURE` on Android anyway, as a deterrent that costs a plugin
command and a per-viewer toggle - recommended **no** for v1, because a protection that works on one
platform of three is a promise with a hole in it.)

**A reel's local copy.** The ciphertext sits in the Cache API (`canari-media-ciphertext-v1`) and the
decrypted blob URL in the pool for 5 minutes. For a `chat-reel` message the cache entry is dropped at
the expiry (the hint, then the `410`) and the blob URL is revoked when the viewer closes; the Cache
API's persistence is otherwise a "kept after the server forgot it" copy that the tombstone would
contradict.

### 3.4 Read semantics, and "view once" as a later, partial mode

**Read.** Today a read receipt is a per-conversation WATERMARK (the last message a member read), drawn
as heads under that message and for a salon the server's `read-marks`
([chat](chat.md)). It says "reached the screen", not "watched". For a reel message that
is the wrong grain only if the product wants to say "OPENED". Recommendation for v1: **change nothing**
- the reel tile counts as read when it is on screen like any bubble, the heads say who has been past
it, and NO "opened" signal exists. A distinct "Ouvert" is a per-message, per-recipient fact that in a
group reveals WHO watched (a viewers list, Instagram's, which the feed does not have for reels
either) - a privacy decision, not an implementation detail (D3). If the user wants it, it is a silent
control event (`reel_opened { message_id }`, the same family as reaction/edit/read, "Every message
mutation travels as a control event", [chat](chat.md)), DMs first, and the sender's tile says
"Ouvert".

**View once (optional, LATER, and honest about what it is).** What it can guarantee in an E2E app is
narrow, and the study lists the holes so nobody sells it as stronger:

- *A DM (two people)*: the recipient's client, on the first full open, (1) tells the server to delete
  the blob (a new owner-or-recipient allowlisted route - the "owner" here is not the caller, so the
  allowlist needs a second rule: the named DM peer), (2) drops the Cache API entry and the URL, and (3)
  rewrites its own stored message row to the tombstone. **It guarantees the SERVER's copy is gone
  after the first view by an honest client.** It does NOT guarantee the recipient did not record it, and
  a recipient who fetches the ciphertext and never reports the open leaves the blob alive until the 30
  days - the delete is a client-asserted fact.
- *A group or a salon*: **not possible as stated.** One blob serves N recipients; deleting it on the
  first view denies it to the rest, and "deleted when all N have opened" needs per-recipient opened
  facts nobody can verify and a membership that changes. The only honest group form is per-recipient
  copies (N uploads of the same video under N CEKs) - a different cost model, not proposed.
- *Old clients*: an older reader would show a view-once as an ordinary video that outlives the
  promise. It therefore needs a `minClientVersion` at or above the reader that understands
  `VIEW_ONCE` - and is gated like the Graine writer was (reader release first).
- *Multi-device*: the same account's second device holds the same message; "once" would have to be once
  per ACCOUNT, i.e. another cross-device fact.

So: **view once is a DM-only, best-effort, honest-client feature, shipped after the plain reel message
has run for a while, and labelled as such.** It is not in WP-RC-1 to 8.

## 4. The weak network

**A reel is 14-35 MB, the one big thing a chat message has ever carried, so the weak-network posture
is the feature, not a polish.** What the code does TODAY, read from it:

- **Preparation is a foreground, in-WebView encode.** Measured 2026-10-01: a 20 s clip took 8-28 s on
  the two phones ([video-preparation](../video-preparation.md)); a 90 s take is **unmeasured** (WP-RC-0).
  It runs in the WebView, so a backgrounded app can pause it (iOS suspends) and a killed app loses it.
- **Upload is ONE POST up to 50 MB.** `media.ts` only chunks above `CHUNK_SIZE = 50 MB`, and a ciphertext
  cannot exceed the 50 MB ceiling - so **a reel is always a single request with no resume**: a cut at
  90 % restarts from byte 0. (The chunked routes exist - `upload/chunk/init`, `/:id`, `/complete` - but
  nothing reports how many bytes the server holds, and a chunk may be as big as 50 MB.)
- **The outbox persists a queued media file INSIDE the row** (`outboxCodec.ts`: `fileBytes` ->
  `fileBytesB64`), then, once uploaded, keeps only the `uploadedRef` (idempotent, a crash after the
  upload does not re-upload). A 28 MB prepared video is a ~37 MB base64 string in one row, in a
  database that mirrors to disk and, on the phones, to a native copy (`outbox_pending.ndjson`,
  [mobile](../mobile.md)). That is the wrong place for it.

**The design, in order of what it needs from whom:**

1. **A chat PROFILE for the preparation** (`prepareVideoForUpload` option, `videoEncodingPlan.ts` the
   only copy): short side 540 px, ~1.2 Mb/s, 30 fps, AAC 96 kb/s, bounded by `maxBytes`. At 90 s that
   is ~14 MB instead of ~28-35 MB, and the post profile stays 720p/2.5 Mb/s untouched. **The trade is
   real**: a chat reel is smaller and softer than a feed reel. D2 (the user decides the numbers); the
   code makes it a profile table, not a second pipeline, because C3's "one format" is about the CONTAINER
   and codecs, which do not change.
2. **A raw-take safe place before anything else.** The recorder's `Blob` is written to a file in the app's
   cache directory (OPFS or the native cache) the moment the take ends, so a kill during preparation
   loses nothing, and the camera can close.
3. **The prepared file is stored OUTSIDE the outbox row**, in a blob store keyed by the entry id; the row
   carries a reference and the size. The row stays kilobytes; the file is deleted when the entry is
   sent or dismissed. The send is queued like any media message - the existing outbox states and
   `uploadedRef` idempotence are reused, not rebuilt.
4. **A resumable upload with small parts, REQUIRED of the weak-network work and of media-service**:
   parts of 1 MiB aligned to the segment size (so a part is a whole sealed segment and the server needs
   no knowledge of the cipher), a `GET /api/media/upload/chunk/:id` answering the byte count the server
   holds, and the client resuming from it after any failure - **a fact the server reports, never a
   guess by the client**. Under 1 MiB per request, a Mi 9T on a flaky 3G does not lose 30 MB to one
   timeout. This is the dependency: if the weak-network page already decides a resumable upload for
   media in general, this design defers to it and WP-RC-5 shrinks to wiring.
5. **The sender sees the truth.** The bubble goes `preparing 43 %` -> `sending 12 %` -> `sent`, cancel
   at every stage, `failed` with a retry that resumes; the member may leave the conversation (the outbox
   owns it). Offline: queued exactly like a text; the prepared file waits locally; the flush uploads
   when `canFlush` opens (the outbox's gate, which "answers MAY I SEND", not "now").
6. **The recipient's data is protected by the tile**: nothing downloads before a tap (3.1); the
   viewer streams the first segment (R2) so playback starts without the whole file; the preload of the
   NEXT reel in the conversation is skipped on a metered or slow connection (the same signal the
   weak-network work defines).
7. **Caps, in the server's voice**: the 50 MB ciphertext ceiling still holds and `too-large` stays the
   typed refusal; the 90 s comes from `reel-limits`; a per-member daily byte cap for `chat-reel` is a
   decision (D7) so one account cannot fill the store - proposed 500 MB/day, enforced by media-service
   from `ownerId` (the only attribution it has), answered `429` as an ANSWER and never retried blindly.

**Prepare while the member reviews?** An optimisation, not a requirement: start preparing when the
review opens and throw the result away if the member edits (a stroke or removing the sound changes the
input). It hides ~10-30 s of encode behind the member's own look at the take. Left to a later package
(WP-RC-11) because it costs battery on takes that are discarded.

## 5. Platforms - and which parts need native work

| Part | Web | Desktop (Tauri) | Android | iOS |
| --- | --- | --- | --- | --- |
| Camera, review, editor | `getUserMedia` | the same | the app's WebView, the existing camera permission | the same; iOS asks mic then camera ([reels](reels.md#the-first-camera-open-read-on-both-phones-2026-10-01-before-anything-was-built-on-it)) |
| Preparation (WebCodecs + mediabunny) | works where WebCodecs does | **WebKitGTK on Linux: unmeasured** - WP-RC-0 reads it | measured 2026-10-01 | measured 2026-10-01 |
| Raw-take / prepared-file store | OPFS | OPFS or the cache dir | the cache dir via the existing plugin, or OPFS | same |
| Resumable upload, tile, viewer | web | web | web | web |
| **Push text and kind** | n/a (no push) | n/a | **the shared Rust scanner** (`proto_fields.rs`, `push_text.rs`) returns `mediaKind: "reel"` and the line; Kotlin passes both through (built, RC-7) | the same Rust, called by the NSE and `canari_push.mm`; no `Localizable.strings` entry (built, RC-7) |
| Deterrent against capture | none possible | none | `FLAG_SECURE` is native, optional (D4) | none supported |
| Save own take | download | download | gallery plugin (exists) | gallery plugin (exists) |

**So the build is almost entirely shared TypeScript.** Native work is limited to the push surfaces
(since WP-PUSH-I18N, one Rust branch and its tests: section 12) and an optional Android window
flag. The camera needs none - the point of building the capture screen in the WebView.

## 6. Push, moderation, accessibility, i18n

### Push text

Push for a DM, group or salon message is composed ON THE DEVICE from the decrypted message, in the
LANGUAGE THE MEMBER CHOSE inside Canari (mirrored into `push_context.json`,
[mobile](../mobile.md#the-language-a-notification-speaks)). The server writes no sentence for a chat
message and cannot: it holds ciphertext, so no `contentKey` is involved (those are social-service's,
for posts and events). **As built (RC-7, section 12), and as it changed from this study's first
draft:**

- The line is written by the **Rust push scanner**, not by three native tables: since WP-PUSH-I18N
  (#2037) every sentence the scanner composes - the voice note's included - lives once, in fr and en,
  in `mobile/push_text.rs`, and Android, the NSE and `canari_push.mm` post what Rust returns. A reel is
  `PushText::Reel`: `🎬 CanaReel`, and with a caption `🎬 CanaReel : <caption>` / `🎬 CanaReel: <caption>`
  (the caption FOLLOWS, where a photo's caption replaces "Photo": the banner must still say a reel is
  waiting). The sender's name is the title (DM) or the prefix in the group/salon line, exactly as for
  every message. The emoji follows the four media lines beside it (`📷 Photo`, `🎥 Vidéo`, `🎤 Message
  vocal`); the study's "no emoji" was written for native tables that no longer hold these lines.
- `mediaKind` is `"reel"`, derived from the DECLARED `intent` (field 14 = 1 on a video, the rule of
  `isReelMessage`), never from the mime type, so a picked clip stays `🎥 Vidéo`. An intent value the
  reader does not know (2, view-once) stays a video.
- **No thumbnail, ever, as a fact in Rust**: a reel never hands over its `mediaKey`/`mediaIv`, whatever
  its encoding, so no native caller has anything to fetch (the native `mediaKind == "image"` checks are
  a second, independent refusal). Decrypting a 9-35 MB blob inside a background service to draw a
  preview would be the wrong cost and an exposure the tile deliberately avoids.
- When the decrypt fails (a newer epoch in the NSE, [mobile](../mobile.md)) the generic line stays as
  it is for every message - no new fallback.
- Muting, "do not disturb" and per-conversation settings are the conversation's, unchanged.

### Moderation and the report path

**The honest limit first**: a DM or group message is ciphertext; the server has nothing to show a
moderator, and [moderation-and-blocking](../../moderation-and-blocking.md) removed `message` from
`content_reports` for exactly that reason ("reporting a message would mean the client attaching the
decrypted excerpt, which is a privacy decision about what a reporter discloses"). A reel is a harsher
case of the same: a video cannot be an excerpt. So:

| Surface | What exists / is proposed |
| --- | --- |
| DM, group | **Block** (a block is between two people, silent) and **report the USER** (`contentType: 'user'`, exists). No server-side removal of an E2E message. Optional later (D8): "report this message" where the reporter chooses to DISCLOSE the CEK and `mediaId` so a moderator can fetch and decrypt the video - an explicit act, in the report, never automatic |
| Salon | The community's existing moderator delete, which now also purges the blob through the allowlisted internal route (2.3); the salon's report path is whatever the salon has, plus the user report |
| A reel ABOUT to be sent | a mute check at send, as `publishReel` does ("the mute check"): a muted member cannot send a reel to a community they are muted in |

A hidden-by-moderation salon message must hide the tile too (the renderer reads the same row flags as
any message). **A reel message is not forwardable (3.3), which is also a moderation property**: it can
only be as widely seen as the audience it was sent to.

### Accessibility

- The tile is a real `button`, with an accessible name built from typed parts: "CanaReel de <name>,
  0:42, envoye il y a 3 h" (and "expire" for a tombstone), never from the caption alone.
- The viewer announces open/close, has a visible close, an Escape key and the arrow keys (the wide-screen
  step buttons exist), and respects `prefers-reduced-motion`: no swipe animation, **no autoplay-on-open
  motion** - the player starts paused with a visible play control (an OS-level reduced-motion member
  should not be handed a looping video).
- A reel has no captions (no speech-to-text exists here). The mitigation is the optional TEXT caption
  the sender types, read by the screen reader, and the sound-off default that makes the video usable
  without audio. Said plainly in the page so nobody claims otherwise.
- The hold-only shutter needs the toggle alternative (section 1).
- Focus returns to the tile that opened the viewer. Contrast: the tile's glyph and duration sit on a
  scrim token, never a raw colour (design-reference).

### i18n keys (Paraglide, French default, English second; none inline)

`reel_chat_camera_button` ("Camera"), `reel_chat_attach_entry` ("CanaReel"), `reel_chat_send`
("Envoyer"), `reel_chat_photo_note` ("Cette photo sera envoyee comme une image ordinaire"),
`reel_chat_sender_note` (the 30-day sentence of 3.3), `reel_chat_preparing`, `reel_chat_sending`,
`reel_chat_send_failed`, `reel_chat_send_retry`, `reel_chat_tile_label` (the accessible name, with
parameters), `reel_chat_expired`, `reel_chat_expired_label`, `reel_chat_open_error`,
`reel_chat_muted_in_community`, and the viewer's `reel_chat_viewer_*` set. The push line is NOT a
Paraglide key nor a native-table key: it is `PushText::Reel` in the Rust scanner (`mobile/push_text.rs`,
RC-7), where every push sentence the scanner composes lives since WP-PUSH-I18N.

## 7. The work packages, in order

Each is one pull request, small, with its test named, and none starts before the one it names. Efforts
are for one engineer including tests, in days.

| WP | What | Tests / verification | Effort | Needs |
| --- | --- | --- | --- | --- |
| **RC-0** | **Measure and audit, no code.** Prep time of a 90 s IN-APP take on both phones at the post profile and a chat profile (output size, thermal); WebCodecs on WebKitGTK; the salon media-download access rule (2.3); outbox row size with a real 14 MB and 28 MB payload; the storage forecast re-read with an expected volume; the weak-network page's decisions | numbers and a table added to this page; nothing merged but docs | 1.5 | the weak-network PR on `main` |
| **RC-1** | **The wire contract**: `MediaIntent`, `duration_ms`, `expires_at_ms` in `MediaMsg`; `MediaRef` / `MediaEnvelope` / `OutboxMediaPayload` carry them (written ONLY when set, as `voiceNote` is, so an old message reads unchanged); bindings regenerated | proto round trip both ways, the envelope decoders drop an absent intent, an unknown value reads as ordinary, an OLD reader fixture still plays | 1 | RC-0 |
| **RC-2** | **media-service `chat-reel`**: class, age sweep through `isSweepable`, `reel_expired` tombstone, stats and the `/admin/storage` line, owner `DELETE`, the env-overridable window; client `encryptAndUpload` accepts the class | unit: sweep by age not idleness, allowlist (an untouched `reel`/`archive`/`association`/none), tombstone reason, stats, owner-only delete; **real** media-service over HTTP on the bench with the window shortened | 2.5 | none (parallel to RC-1) |
| **RC-3** | **The chat profile** in `prepareVideoForUpload` / `videoEncodingPlan.ts` | plan unit tests (sizes at 20/60/90 s fit `maxBytes`), and the device table of RC-0 re-run for the shipped numbers | 1 | RC-0 |
| **RC-4** | **Capture destination**: `destination` prop, the overlay layer with its history entries and `fullscreen-place-open`, the composer camera button and "+" entry, "Envoyer", the photo-as-image branch, the accessible shutter toggle, the mute check; i18n | component tests (the overlay mounts, Back ends take then review then layer, the photo goes the image path, the feed destination is byte-identical), harness row on both phones | 3 | RC-1, RC-3 |
| **RC-5** | **Outbox**: the raw-take store, the prepared file OUTSIDE the row, states `preparing`/`sending`/`failed`, cancel, resume; the resumable chunk upload and its server offset route | outbox tests for each state and a crash at each stage (no double upload, no lost take); chunk-resume unit on media-service; a throttled-network run (`offline-and-weak-network` is the model) | 4-5 | RC-2, RC-4, the weak-network PR |
| **RC-6** | **The tile and the viewer**: `MessageMediaRenderer` reel branch, tombstone, conversation mode of `ReelViewer`, no save/forward, cache hygiene at expiry, accessibility. **Amended 2026-10-30 (15.4)**: a `410` met in the viewer is reported back to the tile and kept on the message's local row (`purged`), drawn "CanaReel supprimé" before the hint's expiry and "expiré" after - a shared blob can now vanish from a conversation nobody in it touched | **a mounting test of the branch** (lesson of #1229), every state, reduced motion, the action sheet drops forward/copy, `410` and the hint both draw the tombstone; a `410` from the viewer persists `purged` and survives a reload | 3.5 | RC-1, RC-2 |
| **RC-7** | **Push** (BUILT 2026-10-19, section 12): `mediaKind` reel and the `PushText::Reel` line in the shared Rust scanner, which Android, the iOS NSE and `canari_push.mm` all call; no thumbnail | Rust unit tests (Kotlin changed by comments only, nothing to unit-test there; no native string table changes); on a phone with the app killed, a DM, a group and a salon each read on the lock screen (the device-verification check B pattern) | 2 | RC-1 |
| **RC-8** | **Salons and moderation**: the salon send path, social-service's moderator delete purging through `chat-reel-purge` (ownership allowlist), the user-report entry from the tile's menu, optionally the disclosed report (D8) | social-service unit and the real-database path for the delete; a moderator run on the bench | 2.5 | RC-2, RC-6 |
| **RC-9** | **Campaign rows and the hardware pass**: DM, group and salon, web + Android + iOS, a weak-network run, the 30-day crossing on a bench with the window shortened, an expiry read of every surface. **Amended 2026-10-30**: one take sent from the tab to a DM, a group and a salon at once (one upload on the server, three messages); a send refused in one target while the others go; a moderator's purge in the salon read as a tombstone in the DM; the two encoders never running together (15.2) | new rows on [cross-client-testing](../../cross-client-testing.md) through `bun rows.mjs`; the user's look on both phones | 3 | RC-4 to RC-8, RC-12 to RC-14 |
| RC-10 | *Later*: "opened" signal (D3), then view once for DMs (3.4, with its own `minClientVersion` gate) | its own study when asked | - | RC-9 |
| RC-11 | *Later*: prepare while the member reviews | measured battery cost on discarded takes | 1.5 | RC-5 |
| **RC-12** | **The "Envoyer à..." sheet** (15.1, 15.8): the tab's review action, `ReelSendSheet` with "Publier sur CanaReels" first, the list source and its permission filter, the search, multi-select and the server's target cap, the hand-over to `ReelPublishSheet` when the feed row is ticked, i18n, accessibility | component tests: the feed row is first and alone reproduces today's path byte for byte; a read-only or muted salon is not listed; the cap; Back returns to the take; a press writes ONE take and N sends (asserted on the outbox fake) | 3 | RC-13 (to send); RC-8 for the salon rows |
| **RC-13** | **The multi-target outbox** (15.2, 15.7): the take row and N send rows written in one transaction, the take withdrawn when no send names it (durable reference, no counter), per-send failure and retry, the "expired before it was sent" refusal, the sent-take record and "Supprimer partout", the encoder lease shared with `publishReel`; the take ADOPTING the publish step's upload (`awaitsPublish`, the ref written before the post, the chat hold before the first send - 15.5); **RC-5's single-target entry becomes the one-send case** (one path) | the RC-5 kill-at-each-stage suite re-run with 3 sends, plus: a kill between the take and its sends (impossible by the transaction, asserted), one send refused for good while two go, a cancel of one send keeps the take, the last cancel releases the session and deletes the blob, a send held past its hint fails for good; feed + chats: ONE upload on the fake server, a post refused after the upload still sends the chats, a publish step left before its upload makes the take upload its own | 5 | RC-5, RC-14 |
| **RC-14** | **Server changes for a shared file** (15.3, 15.4, 15.7): media-service HOLDS per object (`post`, `chat` with its due time), the sweep and stats reading them, an owner-only idempotent chat-hold route (moving a `reel-pending` to `chat-reel`), the post claim accepting `chat-reel` -> `reel`, `reel-purge` carrying its reason (`moderation` purges, `author`/`retention` release), the sender's `DELETE` releasing its hold; the salon send declares the reel's `mediaId` on its `channel_messages` row (**a migration: the owner's yes**); `chat-reel-purge`'s allowlist = moderator of THAT salon + the row names the id + the blob's owner is the row's proven author + a `chat` hold; `chatReelMaxTargets` in `reel-limits`; the owner-delete justification rewritten in [media-service](../../services/media-service.md#the-chat-reel-class-a-reel-sent-in-a-conversation-rc-2-2026-10-09) | media-service: a published-and-sent file survives its post's author delete and its 30-day chat hold alone, goes with the last hold, goes at once on a moderation purge; a held `reel-pending` is not swept at 24 h; social-service spec and the real-database path: a moderator of salon S cannot purge a blob only salon T names, nor one whose owner is not the row's author; a lying declaration of another member's id is refused; every later reader gets `410` | 4.5 | RC-2; lands WITH RC-8's purge, deployed on both estates before any client creates a hold |
**Total for the first usable version (RC-0 to RC-9): about 21-23 engineer-days; send-to-many
(RC-12 to RC-14 and the RC-6/RC-9 amendments) adds about 15.** The ordering puts the
two server/contract packages (RC-1, RC-2) first because everything else is blind without them, and the
pipeline (RC-5) before the UI polish because a reel that cannot survive a weak network is a feature
that works in the office.

**What must exist before `CHAT_REEL_WRITER_ENABLED` turns on (re-ordered 2026-10-30).** Built and
merged: RC-1 to RC-5, RC-7. Owed, in this order: (1) RC-3's profile and 60 s cap wired into
`prepareQueuedChatReel` (section 14); (2) the session-leak P2 ([backlog](../../backlog.md#p2---a-withdrawn-or-wiped-chat-reel-can-leak-its-upload-session-for-24-h-owed-before-chat_reel_writer_enabled));
(3) RC-14 then **RC-13 - before the switch, not after: once a reel is written in the field, a
single-target RC-5 row persisted in a member's outbox would need a legacy decoder when the shape
changes; while the switch is off no such row exists anywhere**; (4) RC-6 (with its 410 amendment,
since a shared blob can vanish under any tile); (5) RC-8 with RC-14's allowlist, or the salons left
out of both entries until it lands; (6) the readers at the `minClientVersion` floor. **RC-12 (the
sheet) may follow the switch**: the in-conversation camera is a complete writer on its own, and the
sheet only adds targets to the same outbox shape. RC-9 closes both.

**Release shape.** The reader (RC-1 contract + RC-6 tile, so every client can DRAW a reel message and
its tombstone) ships before the writer (RC-4 camera entry), the order used for Graine v2 and the
segmented media writer: a message a client cannot draw is worse than one it draws as a plain video.
RC-2's `chat-reel` class is server-side and safe to ship first (nothing sets it yet). The stable follows
the usual two-release sequence ([CLAUDE.md](../../../../CLAUDE.md) "gesture two") with a pre-release on dev
and the testers.

## 8. Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Storage growth** | 30-day, ~14-35 MB each, any member, any conversation; the shared host measured 60 % used on 2026-10-09 ([backlog](../../backlog.md)) | RC-0 forecast, chat profile, the per-member daily cap (D7), the `/admin/storage` line and an `overdue` figure |
| **A 90 s preparation on a phone** | unmeasured; may be minutes on the iPhone 12 | RC-0 first; the raw-take store (a kill loses nothing); the review-time prepare (RC-11) |
| **The outbox holding the file** | a 37 MB row is the wrong shape | the file outside the row (RC-5) |
| **Single-request upload** | 90 % lost on a cut | the resumable part upload; depends on the weak-network work |
| **The promise** | "ephemeral" read as "private from the recipient" | the copy of 3.3, nothing claims screenshots are blocked, `FLAG_SECURE` is NOT the default |
| **Old clients** | draw a reel as a video with a download, which is softer than the promise | accepted for the plain reel (the server's copy still goes at 30 days); view once is gated on `minClientVersion` |
| **E2E means no server moderation** | a DM or group reel cannot be reviewed | block, user report, the optional disclosed report (D8); said on the page, not hidden |
| **Salon access rule unverified** | who may fetch the blob | WP-RC-0 audit; consistent with every salon attachment until proven otherwise |
| **Hold-only shutter** | a motor-access regression, now repeated in a chat | the accessible toggle in RC-4, then given back to the tab |
| **A branch no test mounts** | #1229 lost every photo to a video branch | the mounting test is a stated deliverable of RC-6 |

## 8b. What the reader package (RC-1) built, and what it did not (2026-10-09)

**Draft pull request, waiting for review after the 1.2.0 stable: it changes the wire format.** READER
ONLY - nothing in the app can send a reel message yet (no RC-4 camera entry, no RC-5 upload), so a
`REEL_MESSAGE` only ever arrives from a client built later.

- **Wire** (`libs/proto/canari.proto`): `MediaMsg.intent = 14` (`MediaIntent`: `NONE = 0`,
  `REEL_MESSAGE = 1`, 2 reserved for view-once), `duration_ms = 15`, `expires_at_ms = 16`. Written ONLY
  when set. An OLD client skips the three fields and plays the blob as a plain video (pinned by
  `codec.reelMessage.test.ts` against the schema as it stood); a client that knows the field but not the
  VALUE reads an ordinary attachment, never an error. The native push readers (Rust `proto_fields.rs`,
  Kotlin, Swift/NSE) read `MediaMsg` by field number and ignore the three, so a push still says "video"
  until RC-7 (section 12 - it now reads `intent`): **compile-checked and unit-tested in Rust only, NOT run on a device.**
- **Model**: `MediaRef.intent / durationMs / expiresAtMs`, the stored JSON envelope, the outbox payload
  (`prepareMedia` writes the declaration; nothing sets it yet), `mediaReelProtoFields` /
  `mediaReelFromProto` in `proto/codec.ts`, the ONE place that spells the mapping.
- **Tile** (`ChatReelTile.svelte`, drawn by `MessageMediaRenderer` BEFORE the video branch): 9:16 box
  from `width`/`height`, ThumbHash fill, a play glyph, "Appuyer pour voir", the length. **Nothing is
  fetched before the tap**: `MessageBubble`'s download effect returns early for a reel message and the
  viewer downloads and streams. **Tombstone** once `expiresAtMs` has passed: same box, no ThumbHash, "CanaReel
  expire" and the age only. A `410` met INSIDE the viewer shows the player's own expired state; the tile
  behind it is only told by the hint (a tile that learned from the `410` would need the viewer to report
  back - left for RC-9 to measure).
- **Viewer**: the feed's `ReelViewer` on ONE post-shaped entity (`reelMessageAsPost`), `loadPage` empty
  (a conversation's reels are not the feed's; the chain through the conversation's other reels of 3.2 is
  not built). **The save button is in the bar next to the volume, for every reel** (D-save), so the feed
  viewer changed too. A reel message is NOT forwardable (the bubble drops the action).
- **Not built**: the sender, the retention class beyond the RC-2 draft, the resumable upload, push text (RC-7, section 12),
  salons' moderator purge. (The 60 s cap field and the chat encoding profile were built by RC-3, section 11.)

## 9. Decisions

### 9.1 Decided - the UI target is Snapchat (user, 2026-10-09)

| # | Decision | Ruling | Decided by, when | Replaces in this page |
| --- | --- | --- | --- | --- |
| D-view | Replaying a received reel | **Replayable for the 30 days of its life**; the tile reads "Appuyer pour voir"; **NO view-once now** (RC-10 stays later) | the user, 2026-10-09 | 3.4: view once stays a later, separate mode |
| D-size | Caps | **Chat cap 60 s**, profile **about 540p at 1.2 Mb/s** (about 9 MB at 60 s); published reels stay 90 s / 720p. The chat cap is a field of `reel-limits`, never a client constant | the user, 2026-10-09 | 1 (point 2) and 4 (point 1): "90 s" and "14 MB" now read 60 s and about 9 MB |
| D-opened | An "Ouvert" signal | **None**; the existing read receipts only | the user, 2026-10-09 | 3.4 (D3 closed: no) |
| D-save | Saving a received reel | **A SAVE button for ALL reels, public or not**, in the viewer bar NEXT TO THE VOLUME BUTTON (the existing `ReelSaveButton` and gallery plugin) | the user, 2026-10-09 | 3.2 ("no save"), 3.3 (the recipient row), D9 |
| D4 | `FLAG_SECURE` / screenshot blocking | **NOT USED, dropped from the design.** A save button beside a blocked screenshot would contradict itself. **The UI never claims protection**: no "protected" badge, no "screenshots are blocked"; the sender's note says only that the SERVER copy goes after 30 days | follows D-save (the user), 2026-10-09 | 3.3 (the Android row), 5, 8 |
| D5 | Poster on the tile | **Opaque tile from the ThumbHash**, no poster blob | the design's recommendation, taken on the user's instruction, 2026-10-09 | none |
| D6 | Ephemeral photos | **None**: a tap sends an ordinary image | same | none |
| D7 | Per-member daily cap | **500 MB per day for `chat-reel`**, from `ownerId`, answered `429` | same | none |
| D8 | "Disclosed report" of a DM/group reel | **Not in v1** | same | none |
| D11 | Expiry display | **Tombstone with the age only**, no "N days left" chip | same | none |
| D-camera | Which camera a conversation opens | **The in-app CanaReel camera only, no native camera**; ONE "Ouvrir la camera" in the chat and the new-post composer, the gallery picker kept; retention by DESTINATION (post: the post class, published reel: `reel` 30 days, chat: `chat-reel` 30 days); AMENDED 2026-10-19 by the user: a video filmed from the NEW-post composer is a CanaReel (`reel`), the editor and a gallery video stay posts | the user, 2026-10-11 | 1 (the camera entry) |
| D-sendto | What the camera TAB does after a take | **The review's main button is "Envoyer à..."**: a list whose FIRST row is "Publier sur CanaReels" (Snapchat's "My Story"), then conversations, groups and community salons, with a search; **several targets ticked and sent at once** | the owner, 2026-10-30 | section 15; the tab's "Suivant" ([reels](reels.md#publishing-r3-on-c2-and-c3)) |
| D-oneblob | Storage of a take sent to several conversations | **ONE shared file for every chat target**: one upload, one content key carried in each conversation's encrypted message - chosen knowing that a moderator's deletion then erases it everywhere | the owner, 2026-10-30 | 2.2 and 2.3: "one blob, one conversation" (section 15) |
| D-onefile | A take published on CanaReels AND sent to conversations | **ONE stored file**, verbatim: *"Un seul fichier. Il faut réduire au max la charge serveur quand on le peut je pense ;)"* - reference-counted holds, the feed profile and the post's key for the chat copies (no E2E secrecy for them) | the owner, 2026-10-30 | the design's recommendation of two files (15.5) |

**What the save button changes elsewhere.** Forwarding stays not offered (it copies the `MediaRef`,
so the CEK). A save writes the DECRYPTED video to the gallery through the plugin that already saves a
feed reel: the member's own act on a video they were sent, and the reason nothing here may be sold as
unsaveable. The cache rule of 3.3 (drop the ciphertext at the expiry) is unchanged; a saved copy is
the member's, outside the app.

### 9.2 Still open

| # | Question | State |
| --- | --- | --- |
| D10 | View once for DMs (best-effort), and when | later, after the plain reel message has run for a release; D-view rules it out for now |
| - | The 60 s encode time and real sizes at the decided profile | unmeasured, owed to RC-0 on both phones |
| - | The salon media-download access rule (2.3) | owed to RC-0 |
| Q1 | A take published to the feed AND sent to chats: one blob or two | **ANSWERED by the owner 2026-10-30: ONE file** (*"Un seul fichier. Il faut réduire au max la charge serveur quand on le peut je pense ;)"*), designed in 15.3 and 15.5 |
| Q4 | The author's delete of the feed post: does it erase the chat copies? | **owed to the owner**; recommended no (15.7) |
| Q2 | "Supprimer pour tout le monde" on a take sent to several conversations | **owed to the owner**; recommended: that conversation only, plus "Supprimer partout" on the sending device (15.7) |
| Q3 | A PHOTO taken in the tab: the same "Envoyer à..." sheet | **owed to the owner**; recommended yes (15.1) |

**Not decided here, deliberately:** live streaming (C9, behind the calls revival); stories (C8:
"not now"); and anything that would make the published reel a conversation attachment.

## 10. What the retention package (RC-2) built (2026-10-09)

**Draft pull request, waiting for review after the 1.2.0 stable.** The server class `chat-reel`, in
[media-service](../../services/media-service.md#the-chat-reel-class-a-reel-sent-in-a-conversation-rc-2-2026-10-09):
age sweep from upload through the shared `isDue`, `reel_expired` / `reel_deleted` tombstones answered
`410`, the 500 MB per member per day budget (`429`), the sender's owner-only `DELETE`, stats lines.
Unit specs only; the real-service bench run is owed. The client type `MediaRetentionClass` accepts
`'chat-reel'`; nothing sends it until RC-4/RC-5.

## 11. What the chat profile (RC-3) built (2026-10-18)

**Draft pull request. Nothing sends with it yet**: the writer is RC-4, and it waits for RC-5 (resumable upload) and RC-7 (native push) before any stable (user, 2026-10-14).

- **A profile is a row, not a pipeline.** `videoEncodingPlan.ts` gains `VIDEO_PROFILES`: `feed` (720p short side, 2.5 Mb/s, AAC 128 kb/s: C3, what every call without a profile gets, byte-identical to before) and `chat` (540p, 1.2 Mb/s, AAC 96 kb/s: D-size). `prepareVideoForUpload({ profile: 'chat' })` threads it through the plan, the audio route (a copied AAC-LC track dearer than the profile's audio bitrate is re-encoded) and the AAC probe. Container and codecs are unchanged.
- **The chat cap is the server's.** `GET /api/posts/reel-limits` serves `chatMaxDurationMs` (60 000, `CHAT_REEL_MAX_DURATION_MS`); the client type `ReelLimits.chatMaxDurationMs` is OPTIONAL, so an older server's answer reads as "no chat cap" and no client carries the number. Old clients ignore the extra field.
- **Pinned** by `videoEncodingPlan.test.ts` (540x960 at 1.2 Mb/s; sizes at 20, 60 and 90 s under `maxBytes`; about 9 MB at 60 s; the feed plan unchanged), `prepareVideoForUpload.test.ts` (audio route against the profile's bitrate) and `reel-rules.spec.ts` (the served field).
- **OWED, HARDWARE: the RC-0 device table re-run** at the shipped numbers (encode time and real output size of a 60 s in-app take at the `chat` profile, on the Mi 9T and the iPhone 12). The plan's arithmetic is tested; how long the phones take and what the encoder really lands at is not measured.

## 12. What the push package (RC-7) built (2026-10-19)

**Draft pull request. Inert until the writer ships**: a push for a reel message exists only once a
reel message does, and nothing sends one until RC-4 (behind its OFF switch); the user's rule of
2026-10-14 (no chat-reel writer in a stable before RC-5 and RC-7) is what this package serves.

- **One branch, in Rust, for every platform and every conversation.** `extract_full_message_info`
  (`mobile/proto_fields.rs`) reads `MediaMsg.intent` (field 14) beside `voice_note`: a VIDEO declaring
  `REEL_MESSAGE` (1) - the rule of `isReelMessage` - returns `mediaKind: "reel"` and the line
  `PushText::Reel` (`mobile/push_text.rs`), in the app language each native caller passes down. The
  three decrypt paths all go through it - MLS for a DM and a group, the commit catch-up, and the Graine
  open for a salon - on Android (`CanariFirebaseMessagingService.kt`), in the iOS NSE and in
  `canari_push.mm`, so a reel reads on the lock screen of a killed app exactly where a voice note does.
- **The key is withheld for a reel whatever its encoding**: `mediaKey`/`mediaIv` come back empty, so
  no native caller can fetch or decrypt it for a picture. The native code changed only by comments:
  each caller already passes `mediaKind` through untouched and draws a picture for `image` alone.
- **No string table changed.** The study's plan of two strings in `strings.xml` and the two
  `Localizable.strings` copies predates WP-PUSH-I18N, which moved every sentence the scanner composes
  into Rust; a native copy would be a second table nothing reads. The server is untouched too: a chat
  message is ciphertext to it, and `contentKey` (`PushContentKey`) is social-service's, for posts and
  events, so `push-content.spec.ts` and `nativeStrings.test.ts` have nothing to pin.
- **The FCM cache** stores `mediaKind: "reel"` (the TS reader types it `string`, reads it nowhere) and
  the line as the preview row's content, upgraded by the envelope like every media push row
  ([mobile](../mobile.md)).
- **Pinned** by `proto_fields.rs` (`a_reel_message_is_announced_as_a_canareel_and_never_hands_over_its_key`,
  `a_reel_caption_follows_the_announcement`, `a_single_block_reel_still_withholds_its_key`,
  `only_a_video_declaring_reel_message_is_a_reel`) and `push_text.rs`
  (`every_sentence_is_written_in_both_languages`).
- **NOT verified: everything native.** Kotlin, Swift and Objective-C++ were neither compiled nor run
  for this package (the change there is comments only), and no phone has shown the line. **Owed: check
  [B-reel](../../device-verification.md#b-reel-a-canareel-announces-itself-on-the-lock-screen-of-a-killed-app---owed-on-both-platforms)**
  on the Mi 9T and the iPhone 12 - a DM, a group and a salon, app killed, in French and English -
  which needs a sender with the RC-4 writer switched on.

## 13. What the writer wiring (RC-4) built, and what it did not (2026-10-18)

**Draft, and OFF: `CHAT_REEL_WRITER_ENABLED = false` in `reels/chatReelWriter.ts` is the whole of its safety**, the precedent of `SEGMENTED_MEDIA_WRITER_ENABLED`. Flipping that one line needs RC-3 (#2049) wired into the queued preparation (`profile: 'chat'` and the 60 s cap, section 14), RC-5 and RC-7 shipped and the readers at the `minClientVersion` floor; a test pins it `false`.

- **The camera**: `destinationRules('chat', chatFilms)` lets a chat camera film (`photoOnly` off, the microphone asked `separate`, as the post camera does, so a refused microphone keeps the photos). `ChatArea` passes `reelMessages = !isChannel`, so **a salon never films** (its send path is RC-8's); `ChatComposer` asks `chatReelAllowed(...)`.
- **The mark**: a video handed back by the chat camera is marked on the FILE (`markChatReelTake`, a `WeakSet` like `capturePoster.ts`), because the composers' one attachment path is `File[]`. A gallery pick is never marked.
- **The declaration**: `prepareOneChatVideo` carries the mark onto the PREPARED file with its length; the MLS send builds `intent`, `durationMs` and `expiresAtMs` (send time + 30 days, `chatReelDeclaration`, the clock passed in) into BOTH the optimistic envelope and the outbox payload, so the tile draws at once. The ThumbHash comes from the camera's poster.
- **The class**: the outbox uploader names `chat-reel` for a declared reel (`uploadClassFor`), `ephemeral` for everything else.
- **Not built**: the cap and the chat encoding profile (RC-3, #2049 - the take still reads `reel-limits`' 90 s until it merges), the salon path (RC-8), push (RC-7). The raw-take store, the resumable outbox states and "Envoyer" sending at once are RC-5's (section 14) - since RC-5 a filmed take is no longer STAGED.

## 14. What the resumable outbox (RC-5) built, and what it owes on devices (2026-10-19)

**Draft, stacked on RC-4 (#2098), and OFF behind the same switch**: nothing creates a raw-take entry
while `CHAT_REEL_WRITER_ENABLED` is `false`, because the chat camera cannot film. No migration: every
new field lives in the encrypted outbox payload.

**The path of a take, and the states the bubble shows:**

```
 "Envoyer" in the review (the gesture IS the send, like a voice note)
   -> sendChatReelTake: the RAW take queued at once, `media.prepare = 'chat-reel'`,
      the declaration WITHOUT its length (chatReelPendingDeclaration), the poster's ThumbHash
   -> [blob slot A = raw take, row names A]                                    bubble: queued
   -> upload task (holds an upload slot, outside the lane - WP-OFF-9):
        prepareQueued: prepareVideoForUpload, cancellable          bubble: preparing NN %
        -> prepared bytes written to slot B, THEN the row names B,
           THEN slot A deleted (writeOutboxWithBlob)
        -> uploadResumable (media.ts uploadResumably):
             POST /upload/session -> `media.upload` recorded in the row
             BEFORE the first part                                 bubble: sending NN %
             PUT /parts/:i (1 MiB, sealed one part at a time)
             POST /complete
        -> uploadedRef recorded, `upload` dropped, both slots deleted
   -> the MLS send (durationMs now known)                                      bubble: sent
 failures: transport (or an EDGE 404/409 page) -> waiting, Retry resumes the session;
 preparation failed this time (`encode`) or its result not stored -> error, take KEPT, Retry
 prepares again; preparation REFUSED for good (unreadable, too long, unsupported) -> failed for
 good, the composer's sentence in the thread; app refusal (400/403/404/422) -> failed for good;
 cancel at any stage (running, in backoff, parked, after a relaunch) -> row and both slots gone,
 the server session DELETEd by the WITHDRAWAL (its budget given back)
```

**What each piece is, and where:**

- **The raw-take store is the outbox blob store** (`db/outboxBlob.ts`, offline-and-weak-network
  13.7): AES-256-GCM under a per-entry key that lives only in the encrypted row, in
  `CanariDBOutbox_<userId>`, so the take and the prepared file follow the media-at-rest rule that
  already exists - encrypted at rest, deleted with the entry, erased by the account wipe
  (`accountLocalWipe`) and the device reset (every `CanariDB*` database). Nothing new to erase.
- **Two blob SLOTS per entry** (`<id>` and `<id>#b`, `OutboxBlobRef.slot`). Replacing an entry's
  bytes writes the slot the committed row does NOT name, then the row, then deletes the old slot.
  Overwriting in place put new bytes under a new key while the committed row still held the old one:
  a kill between the two and the take could never be opened again. Entry delete and upload release
  delete both slots; the sweep reads a blob's owner as the id before `#`.
- **Preparation runs in the upload task** (`OutboxDeps.prepareMedia`, wired in `sessionAuth.ts` to
  `prepareVideoForUpload` with the server's plaintext ceiling, the options RC-4 used). Its progress is
  `UploadView.prepared` (`upload_preparing_progress`). A cancel or a Retry aborts the encoder. A
  fault that is a FACT of the take or the engine (`isUnpreparableFault`: unreadable, no video track,
  too long, too large, unsupported) is classified at the preparer's throw as
  `OutboxPrepareRefusedError` and FAILS FOR GOOD (`failPermanently` cause `unpreparable`, the
  composer's own sentence posted in the thread) - a Retry would be refused the same way. `encode`
  (the encoder failing while working) and any other failure is `OutboxPrepareError`, parked as
  `error` with the take kept. A prepared file whose row write fails is NEVER uploaded
  (`OutboxPrepareError` too): a kill after such an upload would prepare again and send a second
  file under the same message.
- **The resumable upload** (`utils/resumableUpload.ts`) is the first client of media-service's upload
  sessions (WP-S1, [media-streaming-upload](../../services/media-streaming-upload.md)) - no server
  change was needed. The SERVER's status says which parts it holds; only the others are sent. The
  state (`OutboxResumableUpload`: CEK, IV, session id, part size, and the SHA-256 and length of the
  plaintext) is persisted before the first part. Parts are sealed on demand (`sealBlobRange`, one
  segment-aligned slice in memory, never the whole blob); the same CEK, IV and plaintext give the
  same bytes, so a re-sent part is harmless. **The digest is the nonce-reuse guard**: a state opened
  for other bytes is discarded (new key, new session), never resumed. A session the server no longer
  has (a JSON 404 from media-service: the 24 h window, the 15 min empty window, a withdrawal) is
  reopened under the SAME key, every part again, said once in the log. **"Gone" is read from the
  ORIGIN as well as the status** (`responseOrigin`, mediaErrors.ts): a non-JSON 404/409 is the edge
  or a proxy during a deploy, says nothing about the session, and is thrown and retried like any edge
  answer - the session kept. The uploader releases a session on a REFUSAL FOR GOOD only; a transport
  failure, a 5xx, an edge page, a local failure and EVERY abort keep it - a teardown (`dispose`, a
  sign-out's controller swap) aborts with the same reason a cancel uses, and its row resumes next
  launch.
- **The WITHDRAWAL releases the session** (`outbox.ts` `withdraw` -> `releaseSessionOf` ->
  `OutboxDeps.releaseUpload` -> `MediaService.releaseResumableUpload`, a `DELETE`). It reads the id
  BEFORE the row goes - this page life's (`openSessions`, which a failed row write cannot lose), else
  the row's `media.upload.uploadId` decoded WITHOUT its file (`getOutboxEntry(..., { withFile: false
  })`, so a cancel never decrypts a 90 s video to learn an id). So a cancel releases whatever the
  entry was doing: a transfer running, waiting in backoff, parked as failed, or never restarted since
  a relaunch - the cases where no abort exists to reach an uploader. A session whose init was in
  flight at the withdrawal is released when that transfer ends - IF its answer arrived. **An init the
  server created whose answer never reached the client** (the abort, a kill or a cut landing between
  the server's write and the response) leaves a session whose id the client never learns, so nothing
  here can release it: it holds an open slot until the server's 15-minute empty-session sweep, the
  only mechanism that covers it (no part was ever staged, so no bytes and no budget beyond the
  slot). A permanent failure that deletes the
  row (group deleted, eviction, an unpreparable take) releases it the same way.
  **Best effort, and what it does not cover**: a `DELETE` that gets no answer (the cancel was made
  offline, on the weak link the reel was stuck on) is logged `NOT released` and left to the server's
  sweep - 24 h holding one of the owner's 4 open sessions, up to 256 MiB staged and its share of the
  daily `chat-reel` budget. Four such cancels in a day would be answered 429 until the sweep. A
  sign-out, an account erasure and an account deletion wipe the outbox without a `DELETE` either:
  the same sweep holds those sessions. **Filed as a P2 owed BEFORE the writer is switched on**
  ([backlog](../../backlog.md#p2---a-withdrawn-or-wiped-chat-reel-can-leak-its-upload-session-for-24-h-owed-before-chat_reel_writer_enabled)):
  a durable "to release" mark swept at the next start or sign-in.
- **The tile** shows the sender's own unsent reel with the attachment bubble's figure, cancel and
  retry (`ChatReelTile` `upload`/`uploadFailed`/`orphan`); with no `mediaId` there is nothing to open,
  so no tap is offered. Queued with no transfer running yet it still offers the cancel. Drawn with
  the theme tokens (`cn-scrim`, `red-err`, `cn-yellow`), no raw palette class.
- **Memory**: the upload task takes the payload out of a holder (`launchUpload`), so no closure keeps
  the raw take alive beside its prepared file through the transfer, and a chat reel is sealed from the
  outbox's own `Uint8Array` (`uploadResumably(plaintext, ...)`), no `File` copy. What is left: the
  preparation reads the raw take into a `File` for mediabunny (one copy), and the prepared `File` is
  read into bytes once before it is stored - the peak is about raw + 2 x prepared during the
  preparation's last step, unmeasured on a phone (device table below).
- **RC-4's foreground reel path is DELETED**: a DM or group take never reaches the composer's
  `prepareChatVideo` any more, so `PendingMediaFile.reelDurationMs`, its declaration in
  `handleSendChat`, its poster block in `prepareMediaFiles` and `chatReelDeclaration` are gone. A take
  in a salon (none can be filmed there, RC-8) would be an ordinary video, as it always was.
- **Only chat reels take this path** (`uploadClassFor(media) === 'chat-reel'`); every other attachment
  keeps the one-shot `encryptAndUpload`.

**Tests**: `outbox.reelResume.test.ts` kills the app at each stage on the REAL `SqliteStorage` (a
Map-backed SQL fake, `src/test/outboxSqlFake.ts`) and the real `uploadResumable` against a faithful
fake of the sessions (`src/test/fakeUploadSessionServer.ts`): during preparation, after the prepared
blob before its row, after the row before the raw slot's delete, mid-upload, after `complete` before
its answer, after the ref before the MLS send - each time no take lost and no part sent again beyond
the one cut. Plus cancel during preparation, during upload, in backoff, parked as failed (the
backoff timer advanced by hand) and after a relaunch - each one a `DELETE` the server sees; a
teardown that releases nothing; a prepared file whose row write fails (no PUT, parked); a failed
preparation and its Retry; a refused one that fails for good; and a seeded flaky link.
`resumableUpload.test.ts` pins the protocol, the edge-404/409 cases included; `outboxBlob.test.ts` the slots;
media-service's `upload-session.service.spec.ts` walks the client's resume sequence across server
restarts.

**A BLOCKER OF `CHAT_REEL_WRITER_ENABLED`, owed at the switch-on and not before**: RC-3 (#2049)
merged the chat profile after #2098 branched, so `prepareQueuedChatReel` must pass `profile: 'chat'`
and RC-3's 60 s cap before the switch is flipped. Nothing on this branch needs it while the switch is
off.

**Not built**: a caption on a reel (the review has no text field; "Envoyer" sends the take alone),
preparing while the member reviews (RC-11), and a background upload a suspended app continues (the
upload runs in the WebView; a backgrounded iOS app pauses it, and the next foreground resumes it).

**Owed on devices - nothing below has run on a phone:**

| Check | Phone | What it proves |
|---|---|---|
| Kill the app during "Preparation NN %", relaunch | Mi 9T, iPhone | the raw take is read back from IndexedDB and prepared again |
| Kill mid-"Envoi", relaunch | Mi 9T, iPhone | `[UPLOAD-RESUME] session ... resumed: the server holds k/n` and only n-k PUTs |
| A weak link (airplane toggles during the send) | Mi 9T, iPhone | each Retry resumes, one object on the server |
| Progress of a PUT through WKWebView's XHR | iPhone | `xhrUpload` progress events on a raw `Blob` body |
| A 90 s take's real preparation time inside the upload task | Mi 9T, iPhone | the bubble's percent moves, the slot is held, a text sent meanwhile is not held back |
| IndexedDB eviction of a queued take under storage pressure | iPhone | the typed "no longer readable" park, not a ghost |
| The part size through the dev estate's relay | dev, any phone | 1 MiB bodies pass the relay that refused over 1 MiB |
| Peak memory while a 90 s take is prepared and stored | Mi 9T, iPhone | raw + about 2 x prepared at the last step stays under the WebView's ceiling |
| A take prepared while the app is BACKGROUNDED, on Android | Mi 9T | hypothesis to refute: a WebView that reports the AVC/AAC encoder unavailable for a moment (backgrounded, the codec taken by another app) gets `unsupported`, which `isUnpreparableFault` treats as FINAL - the reel would fail for good where a later attempt would have worked. Look for `REFUSED by the preparer` with `unsupported` after a background/foreground cycle |
| Cancel while offline, then online | any phone | `NOT released` logged; the session is the server sweep's, and a later reel still opens a session |

## 15. Send to many - decided 2026-10-30 (designed, not built)

**Decided by the owner on 2026-10-30** (relayed in French; rows D-sendto and D-oneblob of 9.1):

- From the camera opened by the swipe left (the tab, `CAMERA_PLACE`, [reels](reels.md#the-tab-c5)),
  after a take the main button is "Envoyer à...". It opens a list whose FIRST row is "Publier sur
  CanaReels" (Snapchat's "My Story"), then the conversations, groups and community salons, with a
  search. **Several targets can be ticked and sent at once.**
- **ONE shared file for every chat target**: one upload, one content key carried in each
  conversation's encrypted message. The owner chose it knowing that a moderator's deletion then
  erases it everywhere.
- **And ONE file for the feed and the chats too** (Q1, answered the same day), verbatim: *"Un seul
  fichier. Il faut réduire au max la charge serveur quand on le peut je pense ;)"*. A take published
  on CanaReels AND sent to conversations is ONE stored file (15.5).

**What this breaks in the sections above, on purpose.** Until now a reel message was filmed inside
ONE conversation (section 1) and its blob served that conversation alone: 2.2 and media-service
justify the sender's `DELETE` by "a reel message cannot be forwarded, so no other conversation can
cite the blob". With D-oneblob the SENDER's own fan-out cites one blob from N conversations. Every
place that leaned on "one blob, one conversation" is designed below rather than found in the field.
Nothing here changes the wire contract of RC-1: each target receives an ordinary reel `MediaMsg`.

### 15.1 The flow

```
/camera tab (ReelCapture destination="feed")
  take -> review (unchanged: editor, sound removal, "Enregistrer")
  main action: "Envoyer à..."                      (was "Suivant")
    -> ReelSendSheet, its own history entry above the take's (Back returns to the take)
         [ ] Publier sur CanaReels                   <- always the first row
         [ search ...                ]
         [ ] the list of 15.8 (DMs, groups, salons, one list)
         footer: chips of the ticked targets, "Envoyer (N)", disabled at N = 0
    -> the press:
         k >= 1 chat targets : ONE take and k sends written to the outbox in ONE transaction (15.2);
                               the camera is free again at once, every target shows its bubble
         CanaReels ticked    : the EXISTING publish step (ReelPublishSheet) opens for the caption and
                               the identity, exactly as "Suivant" did; ITS upload is the take's file
                               (15.5), and its Back never withdraws the chat sends, already queued
         CanaReels alone     : today's path, byte for byte
```

- **The in-conversation camera keeps its direct "Envoyer"** (section 1, RC-4): its conversation IS
  the target. It writes the same outbox shape with ONE send, so there is one path, not two.
- **The new-post composer's camera is unchanged.** Its context already chose the feed; the
  2026-10-19 rule ([reels](reels.md#the-two-ways-into-the-camera-publish-the-same-thing-2026-10-19))
  is about what a FEED publish produces, and that does not move. The tab gains destinations; the
  composer's camera does not.
- **No caption on the chat sends in v1** (RC-5 has none; section 14). The feed caption is the
  publish step's.
- **A photo taken in the tab** (Q3): recommended the same sheet. The first row then publishes an
  ordinary post (the photo rule of [reels](reels.md#one-shutter-and-a-capture-that-is-the-preview-2026-10-05)),
  each chat target gets an ordinary image message (D6), one upload under the `ephemeral` class - a
  photo already reaches several conversations through one blob whenever it is forwarded, so nothing
  new is asked of the server. Until the owner answers, a photo keeps today's publish step.

### 15.2 The outbox: one take, N sends

RC-5's entry is ONE row that owns the take, prepares it, uploads it and sends it to ONE conversation.
It is split in two kinds of row (RC-13):

- **The take** (`reel-take`): the two blob slots, the preparation at the chat profile, the resumable
  session, then `uploadedRef`. It has no conversation and no lane - RC-5's upload task already runs
  outside the lane (WP-OFF-9). It also holds the declaration every send copies: `expiresAtMs`
  (15.3) and, once prepared, `durationMs`. **When CanaReels is ticked too, the take ADOPTS the
  publish step's upload instead of making its own** (15.5): it waits, marked `awaitsPublish`, and
  prepares and uploads at the chat profile only if the publish step ends without an upload.
- **Before the first send, the take puts a CHAT HOLD on the blob** (15.3), so neither a `reel-pending`
  sweep nor the post's end can delete it under the messages.
- **The sends**, one per chat target: an ordinary outbox entry in ITS conversation's lane, naming
  its `takeId`. A send is not sendable while its take has no `uploadedRef`; then it goes through MLS
  (DM, group: `canSendInGroup`, the epoch barrier) or Graine (salon, RC-8) like any media message.
- **Written together.** The take and its N sends are committed in ONE outbox transaction at the
  press: a kill can leave neither a take nobody sends nor a send with no take.
- **The take lives while a send names it - read from durable rows, never a counter or a timer.**
  When the last send row naming it goes (sent, cancelled or failed for good), the take is
  withdrawn: RC-5's session `DELETE` if the upload is unfinished, both slots deleted, and the
  blob deleted by the owner's `DELETE` if NO send ever went out (a blob nobody can cite). Once at
  least one send went, the take becomes the small sent-take record of 15.7 instead.

| Event | What happens |
| --- | --- |
| A kill during preparation or upload | the take resumes exactly as in RC-5 (raw slot, prepared slot, the parts the SERVER reports); every send waits; nothing is sent twice |
| A kill after the upload, some sends done | each send is its own row: the done ones are gone, the rest resume in their lanes; the blob is never uploaded again |
| Cancel from one conversation's bubble | withdraws THAT send; the take survives while another send names it |
| "Annuler partout" (offered on a bubble while the take is not uploaded) | withdraws every send, hence the take and its session |
| The take fails for good (unpreparable, refused) | every send fails for good with the take's cause, its sentence posted in each thread |
| One send refused for good (removed from the group, a `403`, a salon muted or its permission withdrawn since the press) | that send only: its bubble shows the failure with its own sentence; the others go |
| A send still waiting when its `expiresAtMs` has passed (an offline queue of weeks) | fails for good, "expired before it could be sent" - a dead reel is never sent |

**What the member sees.** Each target conversation shows its own bubble from the press (optimistic,
as RC-5's), drawing the SHARED preparation and upload figure. A Retry on any bubble retries the take
while the take is what failed, and only that send once the take is uploaded. The tab shows one
transient line after the press ("Envoi à N conversations") and nothing that stays; a send that
fails for good ALSO posts one notice naming its conversation (`reel_sendto_failed_in`), because the
member is no longer in that thread to see the bubble. No per-recipient "delivered" or "opened" list
(D-opened).

**One encoder at a time.** With one file (15.5) the normal case encodes ONCE. The exception is a
publish step that ends without an upload while the take then prepares its own: the two must never
run together (two WebCodecs encodes of a 60 s take at once is unmeasured on either phone, and each
peak is already large: `publishReel` ~100-150 MB read at the 90 s cap,
[reels](reels.md#is-a-reel-on-the-outbox-path-and-does-the-12-gb-peak-reach-it-no-and-that-is-its-own-finding);
the outbox raw + about 2 x prepared, section 14). So the preparation takes an encoder lease that
`publishReel` also takes; whoever started first holds it. Measured on both phones by RC-9.

**Bounds, in the server's voice.** The number of targets per press is `chatReelMaxTargets` in
`reel-limits` (proposed 15; one press is N MLS or Graine sends), never a client constant. The
500 MB daily `chat-reel` budget is charged ONCE per take, whatever N - at the upload, or at the chat
hold when the take adopts the publish step's file.

### 15.3 Retention - the file lives as long as its longest hold

**Chats only: one blob, one clock.** The `chat-reel` class counts 30 days from the upload, and a
shared blob has ONE upload. What must not drift is the HINT each message carries: every send
declares the TAKE's `expiresAtMs`, written once (today `chatReelPendingDeclaration`: the press time +
30 days), never its own send time. Since the press precedes the upload and the hold, that hint is
never later than the server's deletion: a take queued offline for days draws its tombstone that many
days early, never a live tile over a deleted blob. Accepted. The server's clock stays the authority
(2.4).

**Feed AND chats: no class "wins" - the object is reference-counted.** The two lives differ in kind,
not only in length: a published reel (`reel`) is kept until social-service's `reel-purge` ends it
(its post's retention, the author, a moderator - [reels (server)](../../services/reels.md#the-retention-class-reel-and-the-claim)),
while a chat reel goes by AGE. Letting either clock delete the object would pull it from under the
other. So media-service records, per object, a set of HOLDS, and deletes the object only when the
last one goes (RC-14):

| Hold | Created by | Released by |
| --- | --- | --- |
| `post` | social-service's claim at post creation (the move `reel-pending` -> `reel` today) | `reel-purge` with reason `author` or `retention` |
| `chat` | the take, owner-only, idempotent, before its first send; it carries its own due time (hold + 30 days) | the age sweep at that time; the sender's `DELETE` (which now releases this hold, 15.7) |

- **A purge ends every hold at once**: a moderator (feed or salon, 15.4) and the account deletion.
- **A chats-only take is the degenerate case**: one `chat` hold, exactly today's `chat-reel` object.
  The recorded class stays, DERIVED from the holds (`reel` while a `post` hold exists, `chat-reel`
  otherwise), for the stats and for an older build reading the same index.
- **The `isSweepable` allowlist reads holds**: an object is swept when it has no hold left and its
  class allowed it, never by omission. A `reel-pending` file the take holds is NOT swept at 24 h.
- **Rollback hazard (in the index, as RC-2's):** a build older than RC-14 ignores holds. A `reel`
  object is kept by omission there - the safe direction. A `reel-pending` object with a chat hold
  would be swept at 24 h - the UNSAFE one, so the chat-hold route also moves such an object's class to
  `chat-reel` (which every build since RC-2 sweeps at 30 days by age), and the post claim accepts
  `chat-reel` -> `reel` when it finds a chat hold. No client creates a hold before that server is
  deployed on both estates.

### 15.4 A moderator's delete in one place erases the file everywhere

**Accepted by the owner, said plainly**: a moderator who removes the reel in ONE place - a salon
message, or the feed post when the take was also published - erases the file for EVERY conversation
it was sent to and for the feed. The tiles elsewhere become tombstones. The feed half needs only
`reel-purge` to carry its REASON (`moderation` purges every hold; `author` and `retention` release
the `post` hold alone, 15.3). Two things must be built so that a salon moderator's purge is ONLY
that:

**The purge allowlist still names one salon.** RC-8's `chat-reel-purge { mediaId, ownerId: <author> }`
(2.3) proves the OWNER; with a shared blob it must also prove that the moderator's salon cites it.
Social-service cannot read a Graine body, so the salon send DECLARES the reel's `mediaId` beside its
ciphertext, on its `channel_messages` row (a nullable column: a migration, the owner's yes). The
purge is allowed when ALL hold:

1. the caller holds the moderation permission in the salon of that row;
2. the row declares that `mediaId`;
3. the blob's recorded owner is the row's PROVEN author (Graine v2) - checked by media-service;
4. the blob carries a `chat` hold (class `chat-reel`, or a published reel the take holds).

A moderator can therefore purge only a blob that a message of THEIR salon names, and only one its
author uploaded. What a lying author can do: declare another blob of THEIR OWN, which a moderator
could then erase - harm to the author alone; declare another member's id - owner mismatch, refused.
The declared id tells the server nothing it did not know: it stored the upload and serves every
fetch.

**The other tiles draw the tombstone cleanly.** A tile fetches nothing before a tap (3.1), so a DM
learns of a salon's purge on the TAP: the viewer gets the `410`, shows the player's expired state,
and reports back to the tile, which records `purged` on the message's LOCAL row - durable, one `410`
per message per device, never one per scroll. RC-1 left this report "for RC-9 to measure"; with a
shared blob it is required, so it moved into RC-6. The tile then reads "CanaReel supprimé" when the
`410` arrives before the hint's expiry, "CanaReel expiré" after, and never the REASON: a DM is not
told that a salon was moderated. An account deletion already erases the blob everywhere the same way.

### 15.5 Feed publish and chat sends of one take: ONE file (decided by the owner, 2026-10-30)

*"Un seul fichier. Il faut réduire au max la charge serveur quand on le peut je pense ;)"* - the
design had recommended two; the owner chose one, to store and upload the take once. What follows
from it, designed:

1. **One encode, at the FEED profile.** The publish step's file (720p, 2.5 Mb/s) is the one the
   chats receive: a chat recipient downloads about twice what a chat-only reel costs (~20 MB rather
   than ~9 at 60 s; nothing is fetched before a tap, 3.1). **The chat cap still holds**: with any
   chat row ticked, a take longer than `chatMaxDurationMs` (60 s) cannot be sent to the chats - the
   rows say so in the sheet, and CanaReels alone takes the 90 s.
2. **One upload, the publish step's** (`reel-pending`, then claimed by the post). The take adopts it
   (15.2): the publish step writes its `uploadedRef` into the take's row DURABLY, right after the
   upload and BEFORE `POST /api/posts`, then the take puts its chat hold (15.3) and the sends go -
   so a post that fails or is cancelled after the upload still leaves the chats their file. A publish
   step left before its upload ends (Back, cancel, a refusal) leaves the take to prepare and upload
   its own at the chat profile. One accepted gap: a kill between the upload's answer and that row
   write leaves an unclaimed `reel-pending` (the 24 h sweep's, as today) and a second upload.
3. **One lifecycle, reference-counted** (15.3): the post's end releases the `post` hold, the 30 days
   release the `chat` hold, the file goes with the last.
4. **One content key - and the chat copies are then NOT end-to-end secret.** A post's CEK travels in
   the post row ([reels](reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29)):
   feed media is sealed against the storage, not against the server. The chat messages carry THAT
   key, so the chat copies are readable by the server and by anyone who can read the post. **This is
   acceptable only because the post's audience is a superset of what the chat copy reveals**: the
   bytes are exactly the published video, so a chat recipient learns nothing a reader of the post
   cannot, and a reader of the post learns nothing about the chats (the key sits in the post; no
   conversation, recipient or message is reachable from it). Two consequences, stated rather than
   discovered: the UI never calls such a tile end-to-end encrypted, and the sheet says, when the
   CanaReels row and a chat row are both ticked, that the conversations receive the published video
   itself (`reel_sendto_same_as_post`). After the post is deleted, the key the server held goes with
   its row; the chat copies keep playing, but they were never secret from the server, and nothing
   may claim otherwise afterwards.

**The cost the owner took knowingly**: a heavier download per chat recipient, a 60 s ceiling for a
take sent to both, and no E2E secrecy for a published take's chat copies - against one upload and
one stored file instead of two.

### 15.6 One content key across several conversations - what it leaks

- **The CEK is random per take**, derived from no group's secret, and carried inside each
  conversation's own MLS message or Graine body. One encryption under one CEK and IV; RC-5's digest
  guard against nonce reuse is unchanged.
- **A member of A learns the CEK and `mediaId` of a video they were sent, and nothing about B**: not
  that B exists, not its members, not that the take went there. A member of BOTH sees the same
  `mediaId` twice and knows it is the same take - inherent, since they see the same video.
- **The video is as confidential as the weakest of its N conversations**: an epoch secret of ANY
  one of them reveals the CEK. N blobs under N keys would expose the same plaintext under the same
  compromise, so nothing is lost against the alternative; and no OTHER message of B is exposed - the
  MLS secrets are untouched.
- **A leaver keeps the key to a blob they already had** and may fetch it until the 30 days or a
  purge, under the download rule RC-0 still owes (2.3) - the rule of every attachment today. A
  member who joins later never received the message, so never the key (CLAUDE.md queue 2b: a new
  member does not receive the past).
- **The server** stores one object and sees which accounts fetch it, so it can link that fetchers in
  A and B received the same object. N blobs uploaded by one owner in the same second at near-equal
  sizes tell it nearly the same. Stated, not mitigated.
- **Everything above assumes a chats-only take.** A take ALSO published uses the post's key (15.5,
  point 4): the server holds it, and it can tie the published reel to the accounts that fetched it
  from conversations - which it learns of a published reel anyway, minus the fact that those fetches
  came from a chat.

### 15.7 The sender's delete: one message, or the blob everywhere (Q2)

Two different acts. Deleting a MESSAGE is the existing "Supprimer pour tout le monde" control event
in one conversation; deleting the BLOB is `DELETE /api/media/chat-reel/:id`. RC-2's justification
for the owner's delete now reads "no other PERSON's message cites the blob": every citation is the
sender's own fan-out. Recommended:

- **"Supprimer pour tout le monde" in one conversation deletes that message there.** The blob goes
  too only when it was the take's LAST live send this device knows of; a take sent to one
  conversation therefore behaves exactly as before.
- **A take sent to several conversations also offers "Supprimer partout"** in the sender's menu:
  the message in every conversation it went to, then the blob.
- **How the device knows the siblings: durable state, not a scan.** Once a send has gone, the take
  row becomes a small sent-take record (take id, `mediaId`, the conversation and message ids,
  `expiresAtMs`), encrypted with the outbox and dropped at the expiry. A sender's OTHER device holds
  no such record: there "Supprimer pour tout le monde" deletes the message and never the blob - the
  safe direction, it still goes at 30 days - and "Supprimer partout" is not offered. Carrying the
  sibling list to the sender's other devices would need a self-sync channel that does not exist.
- **The sender's `DELETE` releases the `chat` hold, not the file** (15.3): on a take also published,
  the post keeps it; on a chats-only take it was the only hold, so the file goes as today.
- **The AUTHOR deleting the feed post leaves the chat copies playing** (Q4, recommended): it
  releases the `post` hold only, and the file lives on for the messages until their 30 days. A post
  delete is a statement about the FEED; a member who wants everything gone also uses "Supprimer
  partout" on the sending device. The alternative - a post delete that erases the chats too - would
  turn the author's feed gesture into a purge of conversations the post screen does not show.

### 15.8 The sheet's list

- **Row one, always: "Publier sur CanaReels".** Disabled with the composer's mute sentence when
  the member is muted where it would publish (the check `publishReel` makes, asked when the sheet
  opens; the server answers again at the publish).
- **Then one list in the conversation list's own order** (last activity first): DMs, groups and
  salons mixed, each with its avatar; a salon reads "<community> - <salon>".
- **Search** filters, locally, on what the client already holds: the conversation name, the DM
  peer's display name, the salon and community names. No server search.
- **Listed**: the DMs and groups the member belongs to (a group not ready to send queues like any
  message); the salons where (a) RC-8 has shipped - before it no salon is listed, as the
  in-conversation camera films in no salon today (`reelMessages = !isChannel`, section 13); (b) the member holds `SEND_MESSAGES` in that
  channel's roles; (c) the member is not muted in the community; (d) the salon is not read-only
  for them. **Not listed**: a DM with a person the member blocked, a pending invitation or message
  request, a conversation the member left.
- **The list is a courtesy, the server the authority**: a permission withdrawn between the sheet
  and the send is a failure of THAT send only (15.2).
- **Selection**: a checkbox per row with an accessible name ("<name>, conversation de groupe,
  non sélectionné"), the ticked targets as chips in the footer (removable), a tick past
  `chatReelMaxTargets` refused with a sentence, never silently.
- **i18n keys** (Paraglide, fr then en): `reel_sendto_action` ("Envoyer à..."),
  `reel_sendto_feed_row` ("Publier sur CanaReels"), `reel_sendto_search`, `reel_sendto_send`
  (with the count), `reel_sendto_cap`, `reel_sendto_sending` (the tab's transient line),
  `reel_sendto_failed_in`, `reel_sendto_cancel_all`, `reel_sendto_delete_everywhere`,
  `reel_sendto_same_as_post`, `reel_sendto_too_long_for_chats`, `reel_chat_purged`.

### 15.9 Questions for the owner

| # | Question | Recommended answer |
| --- | --- | --- |
| Q1 | A take ticked for CanaReels AND for chats: one blob or two? | **ANSWERED 2026-10-30: one file** (15.5) |
| Q4 | Does the author's delete of the feed post also erase the copies sent in chats? | **No**: it releases the post's hold; the chats keep it until their 30 days, and "Supprimer partout" is the gesture that ends them (15.7) |
| Q2 | On a take sent to several conversations, does "Supprimer pour tout le monde" in one of them delete the video everywhere? | **No**: that conversation's message only (the blob too when it was the last), plus "Supprimer partout" offered on the device that sent it (15.7) |
| Q3 | A PHOTO taken in the tab: the same "Envoyer à..." sheet (an ordinary post first, ordinary images to the chats)? | **Yes** (15.1): one camera, one sheet; a photo needs no new server rule |
