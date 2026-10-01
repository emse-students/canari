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
