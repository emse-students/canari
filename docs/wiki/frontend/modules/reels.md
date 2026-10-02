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
"unreachable" line under it, because the bench estate had no reel routes yet. That line names a
missing ROUTE as an unreachable SERVER, and it is owed a look once the server is everywhere
([backlog](../../backlog.md)).

## The capture screen (C4)

The app's own, never the system camera (`components/reels/ReelCapture.svelte` over `CameraScreen`):
a full-screen preview, the close and lens controls at the top (switch, and the torch where the lens
has one), the gallery bottom-left, and the shutter in the middle.

**The shutter is HOLD-to-record AND TAP-to-toggle** (`reels/reelCapture.ts`). Holding is the gesture
the user named and Instagram's, and suits a few seconds. A reel runs to 90 s, and holding a button
that long on glass shakes the frame, tires the thumb and puts the lens switch out of reach - so a
press shorter than `SHUTTER_HOLD_THRESHOLD_MS` (300 ms) is a TAP that starts a take the release does
not end, and the next press ends it. The threshold classifies a gesture; it never decides whether a
recording exists. The shutter opts out of the tab swipe and captures its pointer, so a held take
whose finger drifts neither turns the page nor loses its release.

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
at 4 Mb/s - above the 2.5 Mb/s target on purpose, since the preparation re-encodes once and
recording at the target would compress twice. Its bytes are handed over at the recorder's `stop`
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

## Publishing (R3, on C2 and C3)

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

## Saving before the deletion, and the days left (C6)

**What says a reel is the member's own is the server's list**, `GET /api/posts/my-reels`
(`reels/myReels.svelte.ts`), never `authorId`: a reel published as an association or anonymously
carries no author for anybody, its author included, and is still theirs to save. The list is asked
once, held FOR THE ACCOUNT THAT ASKED (another account signing in on the same device sees none of
it), and asked again only when a reel being drawn was created AFTER the list's `serverNow` and is
absent from it - a fact, never a timer.

**The days left are counted on the server's clock** (`serverNow`), rounded up, so a phone set a day
wrong does not announce the wrong date. The chip (`ReelExpiryChip`) sits on the member's own reels
only - top-left of the feed card, over the caption in the viewer - and turns amber once the server
says `expiringSoon` (its warning window).

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
