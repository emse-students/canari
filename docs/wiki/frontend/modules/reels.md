# CanaReels - the client half (R3: decisions C4, C5, C6, C7)

The camera tab, the capture screen, publishing, the full-screen viewer and save-to-gallery. The
decisions are the user's ([backlog](../../backlog.md#the-composer-and-canareels-chantier---compared-on-the-mi-9t-2026-09-29-every-decision-taken));
the server contract is [reels (server)](../../services/reels.md); the one format a video is brought
to before upload is the on-device preparation (`lib/video/prepareVideoForUpload.ts`). This page owns
what the PHONE does.

## The first camera open, read on both phones (2026-10-01, before anything was built on it)

Permissions were declared and had never run for VIDEO - the only live `getUserMedia` caller asked for
audio. So the first thing done was to open the camera from the app's own WebView on both phones,
over the inspector, with no code of this chantier in the build: what the platform does is a fact,
and the screens below are built on it.

| | Mi 9T (A1) | iPhone 12 (I1) |
| --- | --- | --- |
| Build | Android 16, WebView Chrome 152, debug APK `1.0.0` | iOS 27.0.1, bench build `1.0.0` |
| What asks | Android's runtime dialog, raised by `RustWebChromeClient.onPermissionRequest` turning `VIDEO_CAPTURE` into `CAMERA` | iOS asks the MICROPHONE first, then the CAMERA, each with its `Info.plist` purpose string |
| A refusal | `NotAllowedError: Permission denied`; Android offered the dialog a second time on the next request | not tried: a refusal on iOS is permanent until Settings, and the phone is shared |
| `permissions.query({name:'camera'})` | `prompt` even AFTER the refusal | `prompt` before, `granted` after |
| A grant, `ideal` 1280x720 | **720x1280 portrait**, 30 fps, `camera 0, facing back` | **720x1280 portrait**, 30 fps, `Double caméra grand angle arrière` |
| Torch | back lens lists `torch: true` and lit; the front lens does not list `torch` at all | back lens lists `torch: true` and lit |
| Two lenses at once | the front opened while the back was held (no `NotReadableError`) | not tried |
| `MediaRecorder` | VP9/Opus WebM by default (`1a45dfa3` EBML header, 758 KB for 3 s at 2.5 Mb/s); `video/mp4;codecs=avc1.42E01E,mp4a.40.2` also supported | MP4 `avc1.42000a, mp4a.40.2`, an `iso5` (fragmented) file, 613 KB for 3 s; WebM VP8/VP9 reported supported too |

What that decided:

- **The outcome of the request is the only fact.** `permissions.query` answered `prompt` after a
  refusal on Android, so nothing predicts a refusal and nothing is asked ahead of the request.
- **The refusals are TYPES classified at the throw** (`lib/reels/cameraAccess.ts`): `denied`
  (`NotAllowedError`, `SecurityError`), `busy` (`NotReadableError`, `AbortError` - another app holds
  the hardware), `unavailable` (`NotFoundError`, `OverconstrainedError`, or no `getUserMedia` at all).
  An unknown name is logged with the name and read as `unavailable`. Each has its own sentence and a
  retry on the camera screen.
- **The torch is a capability of the LENS**, read from the open track - so its button exists on the
  back lens and not on the Mi 9T's front one.
- **Releasing a lens before opening the other** is what the session does anyway (a recorder cannot
  swap a track mid-file), so whether a phone can hold two at once does not matter to it.
- **The recorder's container is the platform's** - WebM on Android, MP4 on iOS - and does not matter
  past the shutter: `prepareVideoForUpload` brings both to ONE fragmented H.264/AAC MP4 (C3), which is
  also the format the iOS Photos library accepts for the save to gallery (C6).
- **The iOS purpose strings named voice messages and conversations only**, which is what the member
  reads in the system dialog; both now name CanaReels (`Info.plist` and both `InfoPlist.strings`).

## The tab (C5)

**The camera is a swipe place, LEFT of the feed, and nothing else.** `MOBILE_SWIPE_PLACES` is its own
list, `[CAMERA_PLACE, ...MOBILE_NAV_PLACES]` (`utils/swipeNavigation.ts`), so the swipe right from
`/posts` is its `prev` and the feed's right-hand rubber band became a commit. `CAMERA_PLACE`
(`navigation/places.ts`) is not in `APP_PLACES`: a `mobileNav` camera would have drawn a fifth icon in
`BottomNav`, in the native iOS bar and in the desktop sidebar. Pinned by `swipeNavigation.test.ts`.

**`/camera` is full screen.** `isFullScreenPlace` is the layout's predicate: no `MobileHeader`, no
`BottomNav`, `NativeTabBar` passed `visible={false}`, and `fullscreen-place-open` on the document
cancels the wrapper's bar reservation and scroll (`app.css`). Unlike an open conversation it does
NOT stand the swipe down - swiping left from the camera is the way back to the feed. Back (Android)
steps the WebView history like any tab; the close button steps back too, or REPLACES onto the feed
when the camera was the first page, so Back from the feed does not reopen it. `/camera` is a
`PRIVATE_PREFIXES` path for the SEO head.

**The start is honest about the slide.** The tab swipe mounts its destination only after the finger
lifts ([design-reference section 38](../design-reference.md#38-the-page-a-swipe-was-going-to-never-appeared-and-a-taps-drift-went-to-a-different-one)),
so the preview cannot be under the finger: the page arrives dark, saying the camera is opening, and
the preview fades in when the first track is in hand. A permission dialog, the first time, sits on
that state.

**The preview is never visible before its first frame** (user, 2026-10-02, Mi 9T: *"quelques frames le
placeholder moche d'Android"*). `live` only says a track is in hand; from there to the first decoded
frame the `<video>` draws the engine's own placeholder (a grey play glyph, scaled to the screen). So
the element keeps the transparent poster (`TRANSPARENT_VIDEO_POSTER`) AND stays at opacity 0 until
`loadeddata`/`playing` reports a real picture (`videoWidth > 0`, reset on every new stream so a lens
switch is covered too), while a stand-in of the app's own - the dark `cn-ink` -> `cn-scrim` surface
with a calm pulsing camera glyph and the "opening" line, same layout, no shift - stays up and cross-fades
out over the preview fading in. The refusal screens replace the stand-in with their own state. The
close button, the lens controls and the shutter are already in place. Pinned by
`CameraScreen.svelte.test.ts`; read on the Mi 9T by screen-recorded frames
([design-reference section 40](../design-reference.md#40-the-bar-arrived-after-the-page-and-the-camera-showed-androids-own-glyph-mi-9t-2026-10-02)).
The review and the publish step already carry the poster over `VideoPoster` (#1354).

**ONE `<video>` PER STREAM (iPhone 12, 2026-10-02).** After the app went to the background and came back, the
live preview was a ~65 % x 55 % letterboxed rectangle while the element's CSS box stayed 390x844, `object-fit: cover`
(read over the Web Inspector: `getBoundingClientRect`, `videoWidth` 720x1280 and the track settings were all right;
reproduced 5 of 5 on a home-and-return, 0 of ~40 on plain opens, flips and cold starts). WKWebView kept the reused
element's media layer at its old size: ANY style change on the element healed it (`object-fit`, `scale`), and an element
created fresh for the same stream drew full screen. So `CameraScreen` wraps the video in `{#key session.stream}` - an
element only ever sees one stream. Pinned by `CameraScreen.svelte.test.ts` (identity only; the picture is the phone's).

**The camera is given back** when the tab is left, when the app goes to the background
(`visibilitychange`), and when the lens changes. The device is acquired asynchronously, so
`CameraSession` numbers every open, and an open that returns to a session that has moved on releases
its own stream rather than installing it - a fact recorded at the request, never a delay
(`reels/cameraSession.svelte.ts`, pinned by its test).

**Read on both phones through a real swipe from the feed (2026-10-02).** Mi 9T, through harness row
REEL-1: live in 1211 ms, 720x1280 from `camera 0, facing back`, 30 fps, torch offered, and the track
ended once the swipe back reached `/posts`. iPhone 12 (iOS 27.0.1), through the WebKit bridge: live,
720x1280 from the dual wide back camera, 30 fps, torch offered, and no `[data-camera-phase]` left
once the swipe back reached `/posts`. On both phones the shutter stayed disabled, with the
"unreachable" line under it, because the bench estate had no reel routes yet. That line was false
(the server was up), and the capture screen now tells the two cases apart (see the table below).

## The capture screen (C4)

The app's own, never the system camera (`components/reels/ReelCapture.svelte` over `CameraScreen`):
a full-screen preview, the close and lens controls at the top (switch, and the torch where the lens
has one), the gallery bottom-left, and the shutter in the middle.

**ONE shutter: a TAP is a photo, a LONG PRESS is a video** (`reels/reelCapture.ts`, user, 2026-10-05;
it replaced the tap-to-toggle take and the separate Photo button). A press arms a timer of
`SHUTTER_HOLD_THRESHOLD_MS` (350 ms); if the finger is still down when it fires the press is a video
and recording starts UNDER the finger, and its release ends the take. A release before it is a photo.
A cancelled touch (`pointercancel`) before the threshold takes nothing; during a take it ends the take
and keeps it. The timer only reports that a press stayed down - the recording's end is the release,
the 90 s cap or a cancel. The shutter opts out of the tab swipe and captures its pointer, so a held
take whose finger drifts neither turns the page nor loses its release; the context menu, text
selection and iOS callout are switched off on it. It buzzes (`settings.vibrationsEnabled`) on a photo
and on the start of a take.

**The ring fills to the server's cap and the take ends there.** `GET /api/posts/reel-limits` is the
one copy of the 90 s, so the shutter (and the gallery) stay disabled until it has answered. The
line under the shutter says WHY it has not, from the error's status (`classifyLimitsFault`; the
posts API throws an `ApiRefusalError`, never a sentence):

| Fault | When | French line |
| --- | --- | --- |
| `unreachable` | no status: nobody answered | "Canari est injoignable - toucher pour réessayer" |
| `refused` | any status | "Les CanaReels ne répondent pas pour l'instant - toucher pour réessayer" |

Both lines offer a retry. Until 2026-10-02 every failure said "unreachable", and both phones showed
it on a bench server that was up and answering everything else but did not have the reel routes.
**There is no third "this server has no reels" line, because no status names that case.** A server
older than CanaReels sends `GET /api/posts/reel-limits` to its `GET /api/posts/:postId` route. The
bench log shows a `500` (Postgres refusing "reel-limits" as a UUID), and a server with #1344 answers
`400`. Neither sends a `404`, so a line keyed on 404 would never have appeared.

The deadline that ends a full take IS the product rule (C4), not a timer standing in for a fact.

**The take is the platform's container** (`reels/reelRecorder.ts`): MP4 on iOS, VP9 WebM elsewhere,
at up to 4 Mb/s (`REEL_RECORD_BITRATE_MAX`, scaled DOWN with the pixels of a smaller screen) - above
the 2.5 Mb/s target on purpose, since the preparation re-encodes once and recording at the target
would compress twice. Its bytes are handed over at the recorder's `stop`
event, after the last chunk. Every failure is a typed `ReelRecorderError` (`unsupported`, `start`,
`record`, `empty`) and a toast.

**A take is one history entry from its first frame to the end of its review**, so Back ends a
recording or discards a review before it leaves the camera, and the tab swipe stands down meanwhile
(it reads the overlay depth). The lens switch and the close button stand down during a take. The
review plays the take full screen and looping in `VideoPlayer`, with the camera held OFF
(`CameraScreen`'s `paused`) so the privacy dot is not lit for nothing; discarding reopens it. Going to
the background mid-take ENDS the take and keeps it (`onBeforeRelease`) rather than losing it with the
camera.

**The gallery is a tile with an icon, not a thumbnail of the last video.** Drawing the last item
would need READ access to the library: `READ_MEDIA_VIDEO` on Android, which Play restricts to apps
whose core purpose is a gallery, and a full photo-library grant on iOS - a privacy question asked
only to draw a picture. The tile opens the system picker instead, which needs neither; a video over
the cap is refused the moment it is picked (`reels/videoDuration.ts`), and one whose header has no
duration is left to the preparation's own `too-long`.

### One shutter, and a capture that IS the preview (2026-10-05)

`reels/framedCapture.ts`. User report from the Mi 9T and the iPhone: the saved image did not match
what the preview showed, and the camera lagged. Causes read in the code (hardware measurement is
OWED, see below):

- **A different frame.** The photo and the take were the SENSOR's whole frame; the preview is that
  frame under `object-fit: cover` in a box with the phone's aspect. Both are now the preview's crop
  (`coverCropRect`) drawn through a canvas, so the file has the preview's aspect exactly. A take is
  recorded from `canvas.captureStream` plus the camera's audio tracks (`FramedStream`): a
  `MediaRecorder` has no crop of its own.
- **More pixels than the screen.** The request was 1280x720 whatever the phone, and the recorder
  encoded the sensor's frame. `cameraVideoConstraints` now asks for the screen (`screen x dpr`) in its
  aspect, capped at `REEL_CAPTURE_MAX_LONG_SIDE` (1280, what the upload is prepared to), plus 30 fps;
  the saved size never exceeds the screen, the cap or the crop (`framedOutputSize`), and the bitrate
  follows the pixels (`videoBitrateFor`).
- **Mirroring.** The front preview is mirrored by a CSS transform; a canvas read of the decoded
  frame ignores it, so the saved photo and take are NOT mirrored - Instagram's convention, so text in
  frame reads right. The rear lens is never mirrored. The code never flipped a saved frame; if a
  device still shows a flip, it is the review comparing an un-mirrored take with a mirrored preview,
  or a platform fact to read on that device - not a transform to find here.
- **Not changed, and a lead if the lag remains:** Android still prefers VP9 WebM in
  `reelRecorderMimeCandidates`, a SOFTWARE encoder on the Mi 9T; H.264 MP4 (hardware) first is the
  next candidate, to be measured, not guessed.

**The camera also takes still photos.** A photo is captured from the live frame, reviewed, and can
be edited before publishing. The editor draws freehand strokes and app-font text, then bakes those
decorations into a WebP before the normal archive-media upload. It deliberately publishes the result
as an ordinary post: the server contract defines a reel as exactly one video with a duration, so a
photo must not be disguised as a reel. Video decorations use the same editor and are rendered into a
local MediaRecorder stream before the existing H.264/AAC preparation path.

## Publishing (R3, on C2 and C3)

**The review, the editor and the sound removal are on [reel-editor](reel-editor.md)** (2026-10-05):
"Next" has a bar of its own, and a take whose sound the member removed (`clip.soundRemoved`) is
published with NO audio track (`prepareVideoForUpload`'s `removeAudio`).

"Suivant" on the review opens the publish step (`components/reels/ReelPublishSheet.svelte`) IN
PLACE of the review, as its own history entry above the take's: Back returns to the take, a second
Back discards it. It asks what a post asks and nothing a reel cannot carry: a caption (optional on
the server for a reel) and **who is publishing**, through `PostIdentityPicker` - the post composer's
choice extracted into one component, with `posts/postIdentity.ts` as the one reading of it (the
associations a member may speak for, and the payload fields a choice adds). A poll, a form, a
linked event or a schedule are refused on a reel by the server, so they are not offered.

"Publier" runs `reels/publishReel.ts`, in the order the server's contract asks
([reels (server)](../../services/reels.md)): the mute check, the media token, the re-encode on the
device to ONE fragmented H.264/AAC MP4 (`prepareVideoForUpload`, bounded by the server's cap and the
upload ceiling, with the shared progress line and its cancel), the upload under the `reel` retention
class, then `POST /api/posts` with `kind: 'reel'` and the declared `durationMs`. A failure is a
`ReelPublishError` naming its stage, and the sentence is `publishFailureMessage`'s, the composer's
own; a cancelled re-encode says nothing. Success lands on the feed, REPLACING the camera in the
history so Back from the feed does not reopen it.

**No reel video ever shows the engine's own placeholder** (user, 2026-10-02: Android's grey play glyph
appeared right after a recording). Every `<video>` of the flow carries `TRANSPARENT_VIDEO_POSTER` and
sits under Canari's `VideoPoster` until `loadeddata`: the review and the viewer through `VideoPlayer`,
the feed card through `InlineVideo`, and the publish step's 9:16 preview - which had neither, and
now reserves its box (`aspect-9/16`) from the first paint. Pinned by `ReelReview.svelte.test.ts` and
`ReelPublishSheet.svelte.test.ts`. There is no "my reels" list screen; the member's own reels are the
feed cards and the viewer.

**The declared duration is clamped to the cap, and that is not a correction.** The preparation
accepts a source up to half a second past the cap (`VIDEO_DURATION_GRACE_SECONDS`), because a
recorder stopped at 90 s writes a container ending a few hundredths later; that take IS a 90-second
reel, and the server refuses a declaration over the cap, so it declares the cap
(`declaredReelDurationMs`, pinned by `publishReel.test.ts`).

## Watching: the feed card and the full-screen viewer (C7)

**In the feed a reel is a VERTICAL box** (`PostContent`): 9:16, 70 % of the screen's height, the
video covering it. An ordinary attachment's box follows the file's ratio under the 60 % ceiling and
cropped a phone's portrait clip into a wide strip; a reel is always portrait, so its box says so
before the first frame. It plays muted while on screen like any feed video (`InlineVideo`), and a
touch opens the viewer instead of the media viewer.

**The viewer** (`components/reels/ReelViewer.svelte`) shows the touched reel first, then the reels
`GET /api/posts?kind=reel&feed=all` lists, without repeating it, one per screen. Drag up for the
next, down for the previous, to the right (or Back, or the X, or Escape) to close; a wide screen has
two step buttons and the arrow keys. Every decision is `reels/reelViewerNav.ts`, ON THE MEDIA
VIEWER'S OWN GESTURE MATH (`utils/viewerGestures.ts`: `classifyMove` locks the axis,
`decideSwipe` decides the release, `dragOffset` resists past an end) rather than a second copy of
it. The reels sit one screen apart in ONE track, so a swipe is one transform, and its own
`transitionend` says when it has landed - reduced motion lands at once. The next page is asked for
two reels before the end.

**Only the current reel mounts a player.** It is `PostMedia` in gallery mode - the same download,
the same streaming of a segmented video as it arrives, the same failure and retry - so `VideoPlayer`
brings its bar, its loop and the app's ONE sound answer: a reel plays with sound once the member
has turned sound on anywhere, and muted until then. A neighbour draws the poster instead, because a
mounted player claims playback (`followVideoSound`) and would pause the reel being watched.

**The next reel PRELOADS** (`reels/reelPreload.ts`): its video is fetched and decrypted into the
media cache while the current one plays, so when the swipe lands its player takes the WARM path and
the first frame is there. A reel is never fetched twice: if it becomes current before its preload
has finished, the preload is ABORTED and the player fetches (or streams) it alone. One cost is
known and accepted: a reel whose FEED card is still streaming when it is opened is fetched a second
time by the viewer, since an MSE URL feeds one element - the same rule the media viewer lives by.

## Saving before the deletion (C6)

**What says a reel is the member's own is the server's list**, `GET /api/posts/my-reels`
(`reels/myReels.svelte.ts`), never `authorId`: a reel published as an association or anonymously
carries no author for anybody, its author included, and is still theirs to save. The list is asked
once, held FOR THE ACCOUNT THAT ASKED (another account signing in on the same device sees none of
it), and asked again only when a reel being drawn was created AFTER the list's `serverNow` and is
absent from it - a fact, never a timer.

**There is no "deleted in N days" chip, and that is a decision** (user, 2026-10-02: *"ce n'est pas
discret"*; the 30 days are known). #1340 had put one on the member's own reels, amber once the server
said `expiringSoon`; it is gone from the feed card and the viewer, with its two strings
(`reels_expires_in`, `reels_expires_today`), `myReels.daysLeft` and `reelDaysLeft`. What a reel shows
instead is its AGE, discreetly and from the one helper (`timeAgo`, with `exactDate` as its title): the
feed card has it in the post header, and the viewer - which has no header - carries it beside the
author's name. `expiresAt`, `expiringSoon` and `serverNow` stay on the server's `my-reels` answer
([reels (server)](../../services/reels.md)); `serverNow` still decides when the list is asked again.
The publish step's own note ("visible 30 days...") is unchanged and is the user's to rule on.

**The save** (`ReelSaveButton`, the member's own reel, in the viewer) reads the video out of the
media cache with the key `my-reels` handed over, and gives it to:

| Where | Path | Permission |
| --- | --- | --- |
| Android 10+ | `tauri-plugin-gallery`: a pending `MediaStore` row in `Movies/Canari`, the bytes, then the row published (a failed write deletes the row) | none - ADDING to the shared collection needs none |
| Android 9 (`minSdk` 28) | the plugin copies into the public `Movies/Canari` and scans it | `WRITE_EXTERNAL_STORAGE`, declared `maxSdkVersion 28`, asked at the save |
| iOS | the plugin: `PHPhotoLibrary.requestAuthorization(for: .addOnly)`, then `PHAssetCreationRequest` | ADD-ONLY (`NSPhotoLibraryAddUsageDescription`): Canari can read nothing back |
| Web, desktop | `saveBlobAs` - the download, or the save dialog | none |

The file is the fragmented H.264/AAC MP4 every reel was prepared into (C3), which both Photos and
Android's gallery play, named `canari-reel-<day>-<id8>.mp4`.

**The bytes are STAGED in base64 chunks, never sent whole** (`reels/gallery.ts`). The first
design sent them as a raw IPC body, and the Mi 9T refused it (2026-10-02): on Android every Tauri
call travels through `postMessage` as JSON - Tauri's own script never uses the custom-protocol
transport there, because the WebView cannot read a request body - so a `Uint8Array` arrives as a
JSON array of numbers, several times the video's size in one string. So `append_video_chunk` takes
768 KiB at a time, read by the engine (`FileReader.readAsDataURL` on a `Blob` slice), each tagged
with its OFFSET: `0` creates the staged file in the app cache, any other offset must equal the
bytes already staged or the chunk is refused (`OutOfOrder`) rather than writing a video with a
hole in it. `save_video` hands the native side the staged PATH and removes it on every outcome;
`discard_video` removes it when a failure stops the save before that, and the plugin sweeps any
`gallery-*` file left in the cache at start-up, when no save can be in flight - a decrypted reel
does not outlive its save by more than one launch. The session is a `crypto.randomUUID()` and the
name a plain file name; anything that looks like a path is a typed refusal (`BadSession`,
`BadName`), never a default. The native copy runs off the main thread. The command names, their
arguments and the capability are pinned on both sides by `services/galleryCommands.test.ts`, which
reads the Rust sources.

**A refusal is an outcome, not a failure**: `denied` swaps the save button for "Open settings",
which opens the app's own page in the system settings (`ACTION_APPLICATION_DETAILS_SETTINGS`,
`UIApplication.openSettingsURLString`). The camera screen's refused state carries the same button in
the app, since a refused camera on iOS stays refused until Settings.

**Read on both phones (2026-10-02)**, each time from the app's own WebView with the calls
`gallery.ts` makes, using an 842 KB fragmented MP4 sent in 2 chunks:

| | Mi 9T (Android 16) | iPhone 12 (iOS 27.0.1) |
| --- | --- | --- |
| Asked | nothing | once, Photos' add-only dialog, with Canari's own sentence |
| Saved in | 311 ms (164 ms of it staging), copied on a worker thread | 115 ms |
| Landed | `Movies/Canari/`, 720x1280, nothing left in the cache | the camera roll |
| Played by | the system Gallery, the full 00:02 | Photos, 0:02 |
| Refusals | path-shaped session, out-of-order chunk and path-shaped name each answered typed | not re-run; the same Rust answers them |

MediaStore's `duration` column reads `0` for a fragmented file whose `moov` holds no samples. The
Gallery's player is not affected, but a list sorted or filtered by duration would see a 0-second
video.

## Read end to end on both phones (2026-10-02, `main` at `4b62429e4`, then the fixes of #1354 and #1355)

Bench builds against the local estate: a debug APK on the Mi 9T (Android 16, WebView Chrome 152), the
`ios.yml` bench IPA on the iPhone 12 (iOS 27.0.1). **Nothing here relied on the segmented-writer
flag**: it stays `false`, a reel is uploaded as ONE prepared MP4, and `minClientVersion` is untouched.

| Reading | Mi 9T | iPhone 12 |
| --- | --- | --- |
| REEL-1 (the camera tab opens a live portrait preview from a real swipe, gives the camera back) | `PASS`, server clean | camera opens on the swipe (green privacy dot), read by hand |
| REEL-2 (film, review, publish, vertical card in the feed) | `PASS` clean, 2.2-2.6 s from "Publier" to the feed | filmed 4 s, reviewed, published; the vertical card is in the feed |
| The full-screen viewer, swipe to the next reel | read; the next slide's caption and age replace the first | read; a drag up lands on the next reel |
| Save from the member's own reel, in the UI | file written to `Movies/Canari/` | `IMG_0007.MP4` in the camera roll after one press |
| The save confirmation | visible (after #1354's toast fix) | visible (after the fix) |

**What the readings found and fixed**: the publish step's preview had no poster (Android drew its own
glyph), the confirmation toast of a save was painted BEHIND the viewer (`--z-toast` 60 under
`--z-viewer` 300, so a save and its refusal answered nothing on screen), and the publish header
padded the safe area a second time on the iPhone (47 pt too low). The "deleted in N days" chip was
then removed by the user's decision (above).

**Fluidity, judged honestly.** On the Mi 9T (60 Hz) six swipes in the viewer measured by `gfxinfo`:
365 frames, **11.5 % janky**, median 12 ms, 90th percentile 29 ms (two refresh periods), 99th 36 ms,
no missed vsync - while a video decodes under the drag. Smooth enough to use, **not yet Instagram-smooth**:
the janks are the swipe commit while the next reel's player mounts. The iPhone was read by eye over
WDA (no frame timing taken): the tab swipe, the viewer drag and the card layout showed no hitch, but
that is an impression, not a measurement. Lens-covered takes read BLACK on both phones (the bench
phones lie on a desk), so no frame of real content was judged; the pretty-or-not question on content
is the user's look.

**Owed**: one real-content take on each phone (the user's eye); the iOS frame timing of the viewer
swipe; and the publish step's own "Visible 30 jours..." note, which the user may want gone with the
chip.

**The intermittent console line `Ignored attempt to cancel a touchmove event with
cancelable=false`**, seen ONCE in six REEL-2 runs on the Mi 9T, is closed by construction: every
non-passive `touchmove` that prevents a single-finger move now claims it through `claimTouchMove`
(`lib/utils/touchClaim.ts`) - the tab swipe since #1363 (the likeliest caller: it was found there on
the same phone the same day), the pull-to-refresh since #1350, and the reel viewer and the media
lightbox since 2026-10-04, which stand their drag down instead of half-claiming it
(`ReelViewer.svelte.test.ts` dispatches an uncancelable move and asserts it is never prevented).
