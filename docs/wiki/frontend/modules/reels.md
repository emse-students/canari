# CanaReels - the client half (R3: decisions C4, C5, C6, C7)

The camera tab, the capture screen, publishing, the full-screen viewer and save-to-gallery. The
decisions are the user's ([below](#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29));
the server contract is [reels (server)](../../services/reels.md); the one format a video is brought
to before upload is the on-device preparation (`lib/video/prepareVideoForUpload.ts`). This page owns
what the PHONE does.

## The chantier: the comparison, the ten decisions, the build order (user, 2026-09-29)

Asked on 2026-09-29, after the user looked at the publish screen on the Mi 9T: *"Regarde a quoi
ressemble ce qui s'affiche quand on veut publier un post [...] Note les differences avec la facon de
faire de Canari, peu ergonomique [...] On peut aussi regarder la facon de faire d'instagram [...] Les
gens attendent les "CanaReels" avec impatience"*, then live streaming *"dans le futur"*. The composer
comparison R1 was built from is on
[posts](posts.md#the-composers-layout-full-screen-the-text-taking-the-height-the-actions-under-the-thumb-2026-09-29).

**What the video path was, read from the code that day.**

- Video was already accepted in a post, capped at 50 MB of ciphertext on both estates
  ([media-service](../../services/media-service.md)).
- It was drawn in a 16:9 box at most `max-w-md` wide (`PostMedia.svelte`): a vertical phone video was
  small and letterboxed.
- A media file was ONE AES-GCM operation under ONE IV (`mediaCrypto.ts`) and the download fetched the
  whole blob and decrypted it once, so **nothing played before the last byte arrived** - the upload was
  chunked for TRANSPORT only. R2 changed that (segmented encryption).
- A post's CEK travels in the post row: post media is sealed against the STORAGE, not against the
  Canari server - consistent with a post every member can read, and what makes a public live keyable.
- Live has its bricks and none has run: the SFU is `call-service` (webrtc-rs, one-to-many), frames
  are E2E-encrypted with MLS keys through `RTCRtpScriptTransform`, TURN is up in prod - and
  `CALLS_ENABLED = false` ([calls](calls.md)).

**Decided by the user, 2026-09-29.**

| # | Decision |
| --- | --- |
| C1 | **Markdown STAYS** in posts; its layout is ours to make clean (formatting on demand, not two rows of buttons above an empty field). |
| C2 | **Any member may publish a CanaReel**, as for a post; the existing reports cover moderation. |
| C3 | **The PHONE compresses, the server only stores** - *"il faut que la charge serveur soit minimale, sinon on va vite avoir des problemes de stockage et de memoire"*. No server transcoding, no server thumbnails. Target 720p at ~2.5 Mb/s: ~28 MB for 90 s, under the 50 MB cap. |
| C4 | **A CanaReel lasts 90 seconds at most.** |
| C5 | **The camera is a TAB, left of the feed** (user's proposal): a swipe right from the feed opens it through the tab swipe that exists since #1223 - no competing gesture. |
| C6 | **A CanaReel is kept ONE MONTH, then deleted - post, comments and reactions with it**; nothing dead stays on screen. The member can **save a reel to the phone's gallery** first, for memories. |
| C7 | **A reel is read in the feed, and touching it opens a full-screen vertical viewer** that swipes to the next one. No dedicated Reels tab. |
| C8 | **Stories: not now.** With one-month reels the two formats overlap. |
| C9 | **Live, when it comes, is for the WHOLE network**, keyed like a post (its key in the row, as a post CEK is), after calls are revived and the box's egress is MEASURED (~1.5 Mb/s x viewers). |
| C10 | **Delivered in stages**, each its own release (below). |

Also decided later: no expiry notification for reel authors (user, 2026-10-02); the "deleted in N
days" chip was removed (user, 2026-10-02), a reel shows its age.

**The order, and where each stage stands.**

1. **R1 - the composer: SHIPPED in `v0.18.32`** (#1226, #1227, #1229, then the in-app pickers and
   Instagram-style feed video).
2. **R2 - playable while downloading: SHIPPED.** Segmented media encryption (~1 MB segments, each its
   own tag, a nonce per segment bound to its index and to the last one), a reader that decrypts as it
   plays and seeks by segment, ranged reads on the media service; old single-block blobs stay
   readable. The segmented writer has been ON since 2026-10-05
   ([media-service](../../services/media-service.md#the-writer-flip---on-since-2026-10-05)); on-device
   compression (C3) is the `prepareVideoForUpload` seam ([video-preparation](../video-preparation.md)),
   composer wiring #1327.
3. **R3 - CanaReels: SHIPPED in `v1.0.0`-`v1.0.2`.** The camera tab, 90 s capture, publish in the same
   flow, the full-screen viewer, a `reel` retention class of 30 days that takes the post with it,
   save-to-gallery. The capture screen is the app's own (full-screen preview, hold the shutter to
   record, front/back switch, flash, a ring timer that stops at 90 s). The recorder writes WebM on
   Android and MP4 on iOS and R2's compression brings both to one format. The server half is
   [reels (server)](../../services/reels.md). The editor, called "catastrophic" by the user on
   2026-10-05, is [reel-editor](reel-editor.md).
4. **R4 - live** (C9), behind the calls revival: not started.

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
- **The lens is asked EXACTLY** (`facingMode: { exact }`, 2026-10-06). A bare value is an IDEAL, and
  WKWebView answered the BACK lens to `user` on an iPhone (alpha.4 reading) against the decision that the
  camera opens on the FRONT one (`CameraSession.facing` starts at `user`, the flip is per take, nothing
  persisted). A lens the phone lacks is an `OverconstrainedError` -> `unavailable`, logged; a track that
  reports another lens than asked is `console.error`ed. Nothing ever retries on the other lens.
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

The app's own, never the system camera (`components/reels/ReelCapture.svelte` over `CameraScreen`). **It is also the ONLY capture path of the composers (user, 2026-10-11, D-camera)**: `ReelCapture` takes a `destination` - `feed` (this tab: the review leads to the publish step), `post` (photo or video, handed back as a FILE to the post composer, post retention) or `chat` (PHOTOS ONLY, handed back to the chat as an ordinary image message) - and a composer mounts it inside `CameraOverlay`, a full-screen layer over the page, never the `/camera` tab ([reels-in-chat](reels-in-chat.md#1-entering-the-camera-from-a-conversation)). The tab:
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

**The take is the platform's container** (`reels/reelRecorder.ts`): MP4 on iOS, hardware H.264 in WebM on Android (VP9 only without it: software, it kept 19 of 30 fps, [device readings 2026-10-09](../../device-readings-2026-10.md)), the microphone with echo cancellation, noise suppression and gain control OFF (`REEL_AUDIO_CONSTRAINTS`), the review a full-bleed looping `object-cover` media with no player controls,
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
- **Mirroring - REVERSED 2026-10-07.** The front preview is mirrored by a CSS transform; a canvas
  read of the decoded frame ignores it, so the photo and take used to be saved NOT mirrored
  (Instagram's convention). The user then reported the photo as "inverted": it was exactly that, the
  review showing left and right swapped against the preview a second earlier. The capture now
  REPRODUCES THE PREVIEW: `draw` flips the front lens horizontally (`shouldMirrorCapture`, carried in
  `PreviewBox.mirror`), the rear lens never. Applies to photo and take alike, so the review always
  matches the viewfinder (Snapchat's convention; text on a shirt reads mirrored, as in the
  viewfinder). Nothing is rotated: the frame arrives upright and a canvas read applies no EXIF.
- **The ring is a function of the capture state** (`shutterRingFraction`): empty unless recording or
  finishing. It used to read an elapsed clock that only a new take zeroed, so a take dismissed by
  Back or discarded from its review left the ring where it stopped (2026-10-07); the clock is also
  zeroed on abandon and on return to `ready`. Its colour is `cn-yellow` (the app's yellow), not red.
- **THE PHOTO'S 4 SECONDS WERE `canvas.toBlob`, NOT THE CAMERA (2026-10-07, measured on the Mi 9T,
  alpha.2, through the app's own DevTools socket: `adb forward` to `webview_devtools_remote_<pid>`).**
  Tap to review was ~4.1 s; in JS the `drawImage` took 2 ms, the `toBlob` callback arrived 4066 ms
  after the call for a 35 KB JPEG, and the review painted 44 ms after that. It is not the audio
  track, the recorder, the stream release or the size: a 16x16 canvas, an empty PNG, `OffscreenCanvas.
  convertToBlob`, `createImageBitmap` then `toBlob` and `willReadFrequently` ALL took 4.0-4.2 s, with
  the camera live or stopped and on the dashboard too. `toDataURL` (same encoder, calling task) took
  41 ms. The async encode waits for an idle slot the WebView does not grant (WebView 152; the 'ASR' /
  'audio glitch' logcat lines were a red herring). iOS WebKit has no such wait (< 0.7 s, Master).
  FIX: `utils/canvasBlob.ts` (`canvasToBlob`, via `toDataURL`) replaces every `toBlob` that feeds a
  user wait: the photo, the reel editor's export, the image upload compressor (`media.ts`) and the
  square cropper. With the same change patched live on the phone: tap to review painted in 69 ms.
  NOT converted: `qrCode.ts` (a large PNG canvas, not on a tap path; it pays the same 4 s on Android).
  `pdfDocument.ts` encodes nothing since 2026-10-11 (pages stay canvases) and the PDF thumbnail goes
  through `canvasToBlob` ([posts](posts.md#making-the-reader-fluid-on-a-phone-2026-10-11)). Re-measure before touching `reelRecorderMimeCandidates`: VP9 is NOT the
  cause of the photo wait; it stays a lead for the TAKE's end only.

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

**A feed card fetches what its video is about to play, and gives it all back off screen (fix of
the 2026-10-11 audit's first P2).** The card's stream is PACED (`FEED_STREAM_PACING` in
`utils/segmentedMediaStream.ts`): the HEAD (2 segments, 2 MiB - the first frame needs 2 of 20) is
fetched once the card is within 400 px of the viewport, and the rest only while the inline
`<video>` is PLAYING and holds under 10 s past its playhead. The demand is read from the element
(`paused`, `buffered`, `currentTime`, its `play`/`timeupdate`/`waiting` events), never a clock, so a
card scrolled past (paused by `playWhileVisible`), a refused autoplay or a viewer open over it asks
for nothing more. LEAVING is reported by `nearViewport`'s two-way mode (`onleave`, video
attachments only) at a FARTHER edge, 1200 px, so a card resting on the 400 px edge does not reopen
its stream on every small scroll; both observers are rooted at the box the feed scrolls in
(`.page-scroll-wrap`), since an observer rooted at the viewport clips a target by its scrolling
ancestors without the margin. On leaving, `PostMedia` is deferred again, the stream is CLOSED (the segment
in flight aborted) and the `<video>` unmounts with its decoder; a deferred video takes no warm blob
either, so only the cards near the screen hold a player. Coming back opens a new stream, which
re-fetches the head (nothing else keeps those bytes). The segments the final file needs are kept as
`Blob`s, never as the decrypted `ArrayBuffer`s - the JS-heap second copy is gone - and a paced
stream builds the whole file only once the member has watched it to the end, or opened the media
viewer (`fetchAll`) - which opens AT THE TAP on the poster and fills when the file is in, and goes
away with the card if the card leaves the band. On an iPhone the pacing also honours
`ManagedMediaSource.streaming` (`startstreaming`/`endstreaming`); a range the engine EVICTS is not
fetched again (no time-to-segment index yet), and nothing is trimmed behind the playhead because a
feed video loops from its own buffer. The decrypted pool is capped by BYTES (64 MiB,
`BLOB_URL_POOL_MAX_BYTES`) as well as entries, SOFTLY: when a new blob takes it past the cap, the
least recently used IDLE blob is revoked, a held one - the video playing - never, and a release
alone evicts nothing, so a page torn down by a tab swipe keeps its grace. Pinned by `segmentedMediaStream.test.ts` (ten unplayed cards fetch 20
requests, two segments each, of an eight-segment file; close aborts the segment in flight),
`PostMedia.stream.svelte.test.ts` and `blobUrlPool.test.ts`. NOT measured on a phone with a 30 MB
reel: the decoder count and the bytes on the wire are owed one reading on the Mi 9T.

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

### The CanaReels filter - a VIEW on the feed, not a place (addendum to C7, user 2026-10-15)

The user asked for "CanaReels" at the top of the feed, *to get people talking about it*. C7 holds:
there is still no Reels tab in any bar. What was added is a filter, and these are its decisions.

1. **A reel is a post of `kind = 'reel'`** (`isReel`, `PostKind`), the column migration 069 added.
   Nothing else identifies one, and no client-side guess (a 9:16 video) is made.
2. **The SERVER filters, the client never does.** Filtering a paginated feed on the device gives
   empty pages. `GET /api/posts?kind=reel` already exists (typed `@IsIn(['post','reel'])`, every
   feed arm, pinned by `posts.service.reels.spec.ts`), and its predicate `kind = 'reel' AND
   "expiresAt" > NOW()` is the partial index `idx_posts_reels_expiry` (069), bounded by the 30-day
   life of a reel. **The server did not change; no migration.**
3. **The filter composes with the tab** (Associations / Suivis / Tout): `load` resolves `kind` as it
   resolves `feed` - `?kind=`, then the remembered choice, then none - and publishes it in
   `feedParams`, so the first page, the next pages and the refresh ask the same thing
   (`feedPageOptions`). A choice writes `kind=reel` OR `kind=all` into the URL, never a bare address,
   so the URL alone decides the view; the choice is also held for the session, so a storage that
   reads a stale value but refuses the write cannot undo it.
4. **It is drawn as `SegmentedControl`** ("Tous les posts" / "CanaReels" - not "Tout", which is
   already the name of a tab with another meaning), the fixed set of section-navigation, above the
   tab pills. The choice is a per-viewer convenience (`posts/feedKindFilter.ts`, its
   storage in `try`/`catch`): the feed renders with no storage at all.
5. **The local-first copy keeps one slot per (tab, filter)**: `storedFeedKey` is `feed:<tab>` or
   `feed:<tab>:reel`, the in-memory tab cache likewise - eight slots at most, same epoch and ledger.
6. **The "new" mark is not advanced by the filtered view** (`advanceLastSeen`): the last-seen time
   measures the whole feed, and seeing a reel says nothing of the posts between.
6a. **A post published while filtered lands on the whole feed, for that visit only**
   (`landingAfterPublish` writes `kind=all`); the next tab switch writes the viewer's CHOICE back
   (`kindForTabSwitch`), so the publish's `kind` does not stick.
7. **The viewer follows the filtered list** (`reels/reelFeedSource.ts`, a context the feed page
   sets while filtering): after the touched reel it reads `kind=reel` on the SAME tab by a CURSOR,
   the touched reel's `publishedAt`. `GET /api/posts` offers no cursor (offset only), so the loader
   walks the tab from its top with its own offset and keeps the reels published at or before the
   touched one: reels published since, or rows deleted above it, cannot shift where it continues. Its
   one limit is offset paging's own - a reel deleted between two page reads shifts the rest by one, as
   in the feed's scroll. Anywhere else (a chat, a post page, the unfiltered feed) it lists `feed=all`.
8. **An empty filtered feed says so honestly** ("Pas encore de CanaReels") with a button to the
   camera (`CAMERA_PLACE`), the one place a reel is made.

## Saving before the deletion (C6)

**The "my reels" list is gone from the client (2026-10-09).** The save used to need it: only the author
had the key, so a reel was the member's own when `GET /api/posts/my-reels` said so. The save is now for
EVERY reel (below), and it reads the ref the viewer's own player already holds, so `reels/myReels.svelte.ts`
and `getMyReels` were deleted; the server route stays ([reels (server)](../../services/reels.md)).

**There is no "deleted in N days" chip, and that is a decision** (user, 2026-10-02: *"ce n'est pas
discret"*; the 30 days are known). #1340 had put one on the member's own reels, amber once the server
said `expiringSoon`; it is gone from the feed card and the viewer, with its two strings
(`reels_expires_in`, `reels_expires_today`), `myReels.daysLeft` and `reelDaysLeft` (and, since
2026-10-09, `myReels` itself). What a reel shows
instead is its AGE, discreetly and from the one helper (`timeAgo`, with `exactDate` as its title): the
feed card has it in the post header, and the viewer - which has no header - carries it beside the
author's name. `expiresAt`, `expiringSoon` and `serverNow` stay on the server's `my-reels` answer
([reels (server)](../../services/reels.md)), which no client reads any more.
The publish step's own note ("visible 30 days...") is unchanged and is the user's to rule on.

**The save** (`ReelSaveButton`) is **for EVERY reel, public or not, in the player's bar right after the
volume button** (user, 2026-10-09: *"un bouton pour sauvegarder tous les reels, public ou non"*). It is a
`barActions` snippet that `ReelSlide` hands to `PostMedia` (gallery mode), which hands it to `VideoPlayer`;
it reads the video out of the media cache with the key the viewer's own ref carries, and gives it to:

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

## A take is never asked about once the screen is left (2026-10-09)

Mi 9T: "Discard this capture?" reappeared over the posts feed after publishing or cancelling. Root cause: the take holds a history entry whose handler, on a review, asks the discard question (Back semantics). A publish ends with `goto('/posts')`; the root layout's `beforeNavigate` calls `drainHistoryOverlayStack()`, which ran that handler, so the question was shown after the route had changed. Every drain of any route change did the same while a review existed.

Fix at the source: `historyOverlayStack` passes a reason to close handlers (`'back'` from popstate, `'navigation'` from the drain). The take's handler asks only for `'back'`; for `'navigation'` it clears the editor and publish step, aborts a recording and drops the take, with no question and no re-armed entry. Tests: `ReelCapture.svelte.test.ts` (review, publish step, editor, recording, discard) and `historyOverlayStack.test.ts`. Other handlers ignore the reason and are unchanged.


## Audit of 2026-10-11 - are CanaReels functional and optimised? (code read at `origin/main` `1a9b4b91d`, Mi 9T measured)

**Verdict.** The path WORKS end to end on the Mi 9T and nothing measured is broken: capture, review,
on-device re-encode, upload, publish, feed card, viewer, preload. What is NOT yet shown is the
WORST CASE (a busy 90 s take: ~28-35 MB) on either phone, and three real inefficiencies are in the
code (feed cards fetch every reel in full, a failed publish orphans a blob for ever, the reel upload
has none of the attachment upload's progress and cancel). Nothing found is a P1.

**What was run** (bench Mi 9T `fa71073b`, Android 16, WebView 152, app `1.2.3-alpha.4` on dev,
account "fourth", the app's own DevTools socket for the console, `ps`/`top`/`gfxinfo` sampled every
~4 s). The camera looked at a ceiling, so every take is a STATIC scene: sizes below are a floor, not
the 2.5 Mb/s the plan can reach.

| Measured | Value |
| --- | --- |
| Take A, tap-and-hold, released | 21.98 s, 7,447,378 B, `video/x-matroska;codecs=avc1,opus` (hardware H.264 since #1645), asked 2.75 Mb/s, got ~2.7 |
| Take B, ended by the app going to the background (a Play Protect install dialog raised by another session) | 47.3 s, 18,422,238 B, asked 3.08 Mb/s, ~3.1 actual. The take was KEPT and reached review, as this page says it must |
| Re-encode, take A | 11.2 s for 21.5 s of video (0.52x real time), 7.45 MB -> 2.26 MB, plan 588x1040 at 2500 kb/s, output `video/mp4; codecs="avc1.64001f, mp4a.40.2"` |
| Re-encode, three ~6 s takes | 3.3 s each (0.55x), 1.7-1.9 MB -> 0.8-1.1 MB |
| Publish after the re-encode (take A) | segment encrypt, single POST and `POST /api/posts`: ~2.3 s for 2.26 MB; "Publier" to the feed ~14 s |
| Capture cost, take B | renderer 105-140 % and app process 135-160 % of one core, renderer RSS 365 -> 545-575 MB (+~190 MB), 537 MB still held in review; `MemAvailable` never under 2.3 GB |
| Feed, 5 reels of 1-2 MB, 6 up and 3 down swipes | 1048 frames, p50 26 ms, p90 32, p99 38 (`gfxinfo`); the same swipes on the text-only "Associations" feed: 695 frames, p50 13, p90 29, p99 38. Reels playing roughly halve the median frame rate (~38 fps). Swipes were `adb input`, so read the ratio, not the absolute |
| Feed, resources while scrolling | renderer RSS 363 -> 385 MB; media-codec thread count (a PROXY: the platform lists no per-client codec) 4 idle, 12 scrolling, 4-6 at rest; app 30-45 % and renderer 15-40 % of a core |
| Viewer (opened by accident on the 6 reels) | `[reel-preload] start` and `ready` 1-12 ms apart (the feed had already cached the video); next/prev logged cleanly. No frame timing taken for the viewer this time |
| One `play()` refusal | one `[video] playWhileVisible: play() refused Object` warning at the first scroll. The error NAME was not captured; if it is the `AbortError` of a pause racing a play it is noise the rules forbid |

**The rig was disturbed**: at 11:06:35 another session installed an APK on the bench phone
(`installPackageLI`), killed the app and left it signed out, so the planned 90 s take and the viewer
frame timing were NOT done. A stray tap of mine also queued a `pic86.pdf` in the BenchR1 DM; it was
cancelled from its own cross.

### Is a reel on the outbox path, and does the 1.2 GB peak reach it? No, and that is its own finding

`publishReel` calls `MediaService.encryptAndUpload` directly (`reels/publishReel.ts:45`); the outbox
is not involved, so #1729, #1732 and #1733 (lazy decode, chunked base64, the orphan card) do not
touch it and the 1.2 GB transient of a queued 13 MB attachment is not a reel's. What a reel costs
instead (read, not measured at full size): the prepared file is built in a `BufferTarget`
(`prepareVideoForUpload.ts:218`, ~28-35 MB at 90 s), then `file.arrayBuffer()` (a copy), the
ciphertext (a copy) and 8 MiB slices plus `FormData` blobs per chunk (`media.ts:739-790`): roughly
100-150 MB of transient heap at the cap. What bounds the size: the recorder's bitrate
(`REEL_RECORD_BITRATE_MAX` 4 Mb/s, scaled to pixels, `framedCapture.ts:128`), the plan's 2.5 Mb/s
target lowered to fit `maxBytes` (`videoEncodingPlan.ts:92`, floor 400 kb/s, 90 % budget share), the
90 s cap from `GET /api/posts/reel-limits`, and the server's 50 MB ceiling (`too-large` after the
fact). Over 8 MiB the upload takes the chunk route (4 sequential 8 MiB POSTs for a 28 MB reel); the
resumable sessions of #1708 are SERVER ONLY, no client calls them.

### Ranked findings

**P2 - a feed reel card downloads the WHOLE video of every reel it comes near, and keeps it.**
`PostMedia.svelte:166` releases the download once `nearViewport` (400 px, one-shot, never un-set:
`PostContent.svelte:166/210/262`) has fired; the segmented stream then fetches EVERY segment with no
back-pressure and no abort when the card leaves the screen (`segmentedMediaStream.ts:139-154`), keeps
each decrypted segment in `parts` (a second copy of the video) next to the MSE buffer, and ends in a
`Blob` handed to the pool, whose cap is 200 ENTRIES, not bytes (`blobUrlPool.ts:5`), kept 5 minutes.
At 28-35 MB a reel, scrolling past ten reels is ~300 MB of mobile data and tens of MB of retained
memory per card. UNMEASURED at real size (the bench reels were 1-2 MB), and the likeliest cause of
the "decoders from feed autoplay" the Pixel agent saw: every near card holds a `<video>` with a
source. Fix: stream only the head until the card is the one playing, stop on back-pressure and on
leaving the viewport, put a byte cap on the pool.

**P2 - a reel whose upload succeeded and whose post did not is stored for ever.** The client names
class `reel` AT UPLOAD (`publishReel.ts:45`), the idle sweep takes only `ephemeral` and `chat-reel`
(`media.service.ts:1472-1477`), and the claim by social-service happens only in `createPost`. A
`createPost` failure, a kill between the two calls or a cancel there leaves 14-35 MB nobody
references and nothing reaps (account deletion only). Fix: promote the class at the claim, or sweep
unclaimed `reel` blobs older than N hours. Same family as the orphan audit of #1736.

**P2 - a reel's upload has none of an attachment's upload guarantees.** No `transport` is passed
(`publishReel.ts:45`), so there is no byte progress, no cancel of the body and no 45 s silence guard
(only `fetchWithAnswerDeadline`); any failure throws a `ReelPublishError`, the member re-taps
"Publier" and the prepared file is gone, so a retry re-encodes (~0.5x real time, so ~50 s for a 90 s
take - extrapolated, NOT measured) and re-uploads from byte 0. The take itself lives only in memory.
The design for durability exists ([reels-in-chat](reels-in-chat.md), RC-5) and is not built for the
feed.

**P2 - the worst case is unmeasured.** A busy 90 s take (28-35 MB, 4 chunks), its re-encode time and
peak RSS on the Mi 9T (5.6 GB) and the iPhone 12, the chunked reel upload over a weak link, and a
feed of ten full-size reels. Static-scene takes are not evidence for any of them.

**P3 - the capture is expensive and lossy twice.** The take is drawn through a canvas
(`framedCapture.ts:233`, `requestAnimationFrame` + `captureStream`) at ~2.5 cores and +190 MB RSS,
recorded at ~3 Mb/s, then re-encoded at 2.5 Mb/s or less. A documented trade-off (the preview's crop
IS the file); the heat of a 90 s take is unmeasured.

**P3 - the viewer preloads only the NEXT reel** (`ReelViewer.svelte:295`, `preload={i === index + 1}`), so
a swipe down meets the poster first unless the 5-minute pool still holds the video.

**P3 - the board contradicts this page.** `cross-client-testing.md` still lists REEL-2 `pending`
while this page records it `PASS` on 2026-10-02, and no harness row covers the feed card's autoplay,
the viewer or a long take.

**Open and only "owed a look" (unchanged, from the backlog):** the iPhone letterbox fix #1370
(shipped unverified by the user's choice), the live-mic echo #1368, the user's look at real content
on both phones, the iOS frame timing of the viewer swipe, the publish step's "Visible 30 jours" note,
the camera swipe being undiscoverable (backlog, 2026-10-09). Fixed and read since v1.0.0: #1539,
#1552, #1575, #1578 (the 4 s `toBlob`), #1641, #1645 (the VP9 software recorder dropping a third of
the frames, now hardware H.264), #1684.

### Tests: what exists and what is missing

Exist: a unit file per `reels/` module (recorder, capture state machine, framed capture, publish
order and payload, preload, viewer navigation, gallery staging, save, editor, strokes, overlays,
camera access and session), `video/` (plan arithmetic; `prepareVideoForUpload` over a SCRIPTED
mediabunny, so no real encoder), `ReelCapture`, `ReelViewer`, `ReelPublishSheet`, `ReelReview`,
`CameraScreen`, `PostContent.reel`, `InlineVideo`, the segmented writer, reader and stream, the
server reel claim and purge specs, and harness rows REEL-1 and REEL-2. Missing: any test that bounds
what a feed card FETCHES (nothing fails if a card downloads a 35 MB reel it never plays), a
real-encoder run of the 90 s plan, the publish-failure-after-upload orphan, the reel upload's chunk
route and retry, the decoder count in the feed, and a long-take harness row.

### Proposed fix list, in order

1. Feed card: head-only streaming with back-pressure and abort off-screen, plus a byte cap on the
   decrypted pool (P2). **Built (`fix/reel-feed-fetch`), see "Watching" above; the 30 MB reel
   reading on a phone is still owed.**
2. Orphan `reel` blobs: the claim promotes the class, or a bounded sweep (P2). **Built: the client
   uploads `reel-pending`, the claim promotes it to `reel`, the sweep takes an unclaimed one a day
   after upload ([media-service](../../services/media-service.md)).**
3. Give the reel upload the attachment `transport` (progress, cancel, stall guard) and keep the
   prepared file for a retry; later the RC-5 durable take (P2).
4. Measure the worst case on both phones (a scripted busy 90 s take) and write it above (P2).
5. Preload the previous reel; test the feed fetch bound; reconcile the board (P3).

## One frame (2026-10-11)

The camera preview, the review, the editor and the viewer share `ReelFrame` (9:16, shown whole, rounded
`--radius-2xl` over a blurred backdrop when the screen's shape differs, edge to edge when it matches),
and the camera records that frame, not the screen box. Detail and what is unverified:
[reel-editor](reel-editor.md#one-frame-for-capture-edit-and-publish-2026-10-11-replaces-the-cover-and-crop-of-1739).

### The backdrop is painted once (2026-10-16)

User report on the Mi 9T (`1.2.9-alpha.3`): around the video the viewer was "pixelise et saccade".
Read through the app's DevTools socket with the viewer left open, evidence in
`F:/Programmation/canari-harness/a1-bench/r1016-reelbg/` (out of tree):

- **What was drawn**: one `<canvas>` 24x43 stretched to 436x945 CSS px (1080x2340 device px, 45x),
  `opacity: 0.6`, no `filter`, over `cn-scrim`; one `<video>` in the frame (718x1278, `contain`). No
  second decoder, no `backdrop-filter`. A 45x bilinear stretch of 24 px draws each pixel as a square:
  the "pixelated".
- **Why it stepped**: `ReelBackdrop` re-sampled the playing video every 250 ms, so the bands changed
  4 times a second: the "janky". Each `drawImage(video)` into that small (CPU) canvas took **24.9 ms
  on average on the main thread** (20 reads in 5 s). rAF over 5 s: longest frame **33.4 ms, 5 frames
  over 25 ms**; the same 5 s with the reads made no-ops: **17.5 ms, 0**.
- **And it holed every take on this phone.** `ReelFrame` is also the camera's, and on a 20:9 screen
  the 9:16 frame never fills it, so the camera re-sampled the live preview every 250 ms while the
  canvas recorder drew its own frames. Two 4 s takes, same scene, read with ffprobe: reads ON, **80
  frames, 20.4 fps, 16 holes of 101-150 ms, one every ~250 ms**; reads OFF, **115 frames, 28.9 fps, 2
  holes** (the first half second). The published reel the user filmed carried the same pattern (65
  frames in 3.45 s, holes every ~250 ms, 16 fps in its last half second).

**Fix**: the picture is read ONCE per media (`loadeddata` / `load`, and not again for the same
source), blurred on the canvas (`reels/reelBackdropPaint.ts`: 12 px across then three bilinear
doublings to 96 px, a near-Gaussian), shown `object-cover` and dimmed. No timer, no animation frame,
no CSS `filter` (nothing for the compositor, WebView or WKWebView, to blur per frame). Live-patched on
the phone with the same algorithm: the bands are a smooth blur, one read of ~18-46 ms when the reel
starts, then **longest frame 17.9 ms, 0 over 25 ms** over 5 s. `dumpsys gfxinfo` is NOT the measure
here: it counts the activity's own HWUI frames under `screenrecord` (69 % "janky" before, 75 % after)
and does not see the page's main thread. Tests: `ReelBackdrop.svelte.test.ts` pins "no interval, no
animation frame, no second video, one paint per source". **Not read**: the iPhone (WKWebView reads a
video into a canvas through its own path; the blur needs no CSS filter, so its cost there is the one
read) and a landscape reel on the phone (the code path is the same `object-cover`).
