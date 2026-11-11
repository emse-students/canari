# Screen orientation - portrait everywhere, rotation on the video and camera screens

**Decided by the owner, 2026-11-09.** The app stays PORTRAIT (the feed, the conversations, the
settings). Three kinds of screen may turn: the full-screen video viewer, the live viewer and the
live broadcaster. **The camera (chat and post photos and videos, AND CanaReels) no longer turns
since 2026-11-11**: its layout stays upright like the system camera apps', its glyphs turn in place,
and a photo or reel made sideways is still a landscape file, letterboxed in the vertical pager
([below](#the-camera-keeps-its-layout-and-the-volume-keys-are-its-shutter-2026-11-11)). On the
turning screens:

- **auto-rotation follows the accelerometer and RESPECTS the phone's rotation lock**;
- **a rotate button forces landscape even with the lock on** (YouTube's full-screen button), and a
  second press returns to portrait;
- **a live keeps the broadcaster's orientation**: a viewer in portrait sees the whole landscape
  picture with bars, and goes full-screen landscape by turning the phone or with the button.

The work is three steps, tracked in [the backlog entry](../backlog.d/rotation-on-video-and-camera-screens.md).
This page is the mechanism.

## Ownership - one stack of requests, released on unmount

`frontend/src/lib/mobile/screenOrientation.svelte.ts` is the ONE owner of the orientation.

- **A screen REQUESTS a mode while it is mounted** (`requestOrientation(mode, owner)`, or
  `useScreenOrientation(owner)` in a component, which requests `auto` at mount and releases at
  unmount). Four modes: `portrait`, `auto`, `landscape`, and `locked` (the hold, below).
- **The newest live request decides; none means `portrait`.** A viewer opened over the camera wins
  while it is open, and its release hands the turn back to the camera.
- **The release on unmount is the ONLY path back to portrait.** No timer, no "if nothing asked for
  5 s": the mode changes only when a request is made, changed or released.
- **Every page load posts the effective mode** (`initScreenOrientation`, from the root layout), because
  native's orientation lives in the PROCESS: a reload or a WebContent kill while a screen held
  landscape would otherwise leave the app turned with nothing owning it. It is the twin of
  `releaseIosProximityOfPreviousPage`. A child mounts before the layout, so a page that boots ON a
  camera posts that camera's `auto`, not portrait.
- **One `[ORIENTATION] a -> b (why)` line per change** in the in-app log; native logs its own line
  per applied change. An unchanged request posts and logs nothing.

### The button and the hold

- **The rotate button asks for the OTHER orientation from the one on screen** (`rotateTarget`):
  landscape from portrait, portrait from landscape - whether the phone or the button turned it. Its
  choice is kept until the screen unmounts, so the second press is portrait FORCED: with the lock off
  and the phone held sideways, the press still returns to portrait (the press would otherwise do
  nothing). Auto-rotation comes back with the next visit of the screen. *Decided by the lead under
  the owner's delegation (reversible): YouTube re-enables the sensor once the phone is held upright
  again, which needs a device-orientation listener this first cut does not have.*
- **A take and a live on air FREEZE the orientation on screen** (`hold(true)`, the mode `locked`): a
  camera take is recorded through a canvas of one size (`FramedStream`) and a live through one
  `MediaRecorder`, so the screen may not turn under either. `locked` is its own mode, never the
  `portrait` or `landscape` on screen restated: a tablet's `portrait` is free rotation, and
  `landscape` still allows the flip to the other side, so either would turn under a recording
  (adversarial review, 2026-11-09). The button stands down while frozen; `hold(false)` gives the turn
  back. The broadcaster's orientation is chosen in its PREVIEW and kept for the whole live.

### What the page sees

A rotation resizes the WebView: the page reads it as a viewport change. `viewportOrientation.landscape`
is `matchMedia('(orientation: landscape)')`, reactive; layouts use Tailwind's `landscape:` and
`portrait:` variants. **The safe area of the SIDES**: Android's WebView answers
`env(safe-area-inset-left/right)`; on iOS WebKit answers 0 for every `env()` in this WebView
([mobile](mobile.md)), so `canari_ios.mm` publishes `--safe-area-inset-left/right` beside the top and
bottom ones, again at every change of the root controller's safe area. A turned screen therefore pads
with `var(--safe-area-inset-left, env(safe-area-inset-left, 0px))` - the notch's side in landscape.

### Who pads a full-screen place

**One rule: on a full-screen place (`isFullScreenPlace`, today `/camera`), the shell pads NO side and
the page pads its own controls; everywhere else the shell pads and the page does not.** The camera's
preview is the page and runs under the status bar and, turned, under the notch; its controls carry
the inset themselves (`CameraScreen`, `ReelReview`, `ReelPublishSheet`). The overlays (the composers'
camera, the live broadcaster) are portalled and `fixed`, outside the shell, so they are the same case.
In `app.css`, `.fullscreen-place-open .app-shell` gives back the top AND the two sides (the sides added
2026-11-09: the shell's `env()` side padding was a strip beside the turned preview and doubled the
controls' `sideSafePadding` on Android). The one exception is a minimised call: the bar must clear the
notch, so the shell pads the top again (`--app-status-top`, resolved on the root) and zeroes
`--safe-area-inset-top` for its subtree, so the controls below the bar do not add the status bar a
second time. Pinned by `callBarLayer.test.ts`.

## Android

`MainActivity` registers `window.canariOrientation.set(mode)` (`OrientationBridge`), mapped by the
pure `fr.emse.canari.orientation.requestedOrientationFor` (unit-tested in `android-tests`,
`OrientationModeTest`) to `Activity.setRequestedOrientation`:

| Mode | Phone (`canari_lock_portrait` true) | Tablet (`values-sw600dp`, a PC here) |
| --- | --- | --- |
| `portrait` | `SCREEN_ORIENTATION_PORTRAIT` | `UNSPECIFIED` (rotates freely, as before) |
| `auto` | `SCREEN_ORIENTATION_USER` | `UNSPECIFIED` |
| `landscape` | `SCREEN_ORIENTATION_USER_LANDSCAPE` | `USER_LANDSCAPE` |
| `locked` | `SCREEN_ORIENTATION_LOCKED` (the rotation on screen) | `LOCKED` |

- **"Respect the lock" is the platform's, not a reading of ours.** `USER` is the sensor while
  auto-rotate is on and the user's own rotation while it is off; `SENSOR` / `FULL_SENSOR` would turn
  the screen with the lock on, which is exactly what the owner refused. So nothing reads
  `Settings.System.ACCELEROMETER_ROTATION`: a value read once would be stale the moment the user pulls
  down the quick settings. With the lock on, Android 9+ offers its rotate suggestion in the navigation
  bar when the phone is turned on such a screen - the user's gesture, not ours.
- **`USER_LANDSCAPE`, not `SENSOR_LANDSCAPE`, for the button**: landscape whatever the lock, and the
  180-degree flip between the two landscape sides still respects the lock.
- **The activity is NOT recreated by a turn**: `orientation|screenSize|smallestScreenSize|screenLayout`
  are in the manifest's `configChanges` (pinned by `androidWindowLayout.test.ts`), so the WebView, the
  MLS state and an in-flight send survive. `onConfigurationChanged` logs `configuration changed in
  place: landscape (activity not recreated)` - THE line a phone reading looks for, with no second
  `onCreate` after it.
- The manifest still has no `android:screenOrientation` literal (one value cannot serve a phone and a
  tablet - [mobile](mobile.md#portrait-is-locked-by-a-resource-qualifier-not-by-the-manifest)).

## iOS

- **Info.plist lists Portrait, LandscapeLeft and LandscapeRight for the iPhone** (Portrait first: the
  launch orientation), as `project.yml` already did. That only says the scene MAY turn.
- **The gate is tao's root view controller.** `canari_ios.mm` replaces
  `TaoUIViewController -supportedInterfaceOrientations` (installed at the launch notification, retried
  at the scene's connection and at the first request) by the mask of the requested mode: `portrait`
  -> Portrait, `auto` -> AllButUpsideDown, `landscape` -> Landscape, `locked` -> the one orientation
  the scene's `effectiveGeometry` has now (no geometry request). The app delegate's
  `application:supportedInterfaceOrientationsForWindow:` is NOT used: tao's `AppDelegate` does not
  implement it, and UIKit reads which selectors a delegate answers when the delegate is set, before
  any hook could add one.
- **"Respect the lock" is the OS's.** iOS never AUTO-rotates against the rotation lock, so `auto`
  only widens the mask and calls `setNeedsUpdateOfSupportedInterfaceOrientations` (iOS 16+, the
  deployment target is 16.0).
- **The button forces landscape with the lock on** through
  `UIWindowScene requestGeometryUpdateWithPreferences:` (`UIWindowSceneGeometryPreferencesIOS` with the
  Landscape mask): an app-requested orientation is not an auto-rotation, so the lock does not stop it.
  `portrait` makes the same request with the Portrait mask, so the way back is immediate too. A refusal
  is logged (`ERROR the scene refused`).
- **The safe area follows UIKit's own signal**: `TaoUIViewController -viewSafeAreaInsetsDidChange` is
  hooked the same idempotent way as the mask (`CanariHookTaoController`), calls tao's implementation,
  logs `[CanariOrientation] safe area changed: top/left/bottom/right` and re-publishes
  `--safe-area-inset-*`, the sides included. UIKit calls it in the layout pass with the turned insets
  final; the first cut observed the scene's `effectiveGeometry` and hopped to the next run-loop turn,
  which said nothing about whether the insets were updated yet (adversarial review, 2026-11-09).
- An iPad keeps tao's mask (every orientation) for `portrait` and `auto`; only `landscape` and
  `locked` force it - the same rule as an Android tablet.

## The web build

Nothing to ask. A browser tab turns with the phone already (the app is portrait only inside the
native shell), and `screen.orientation.lock()` is honoured only in FULLSCREEN, which the app's
viewers are not. So `orientationCanBeForced()` is false, the rotate button is not drawn, and a request
posts nothing and logs nothing.

## What a turn does to each screen

The rotate button is the kit's `ui/player/RotateButton.svelte` (a `VideoChipButton`, 44 px target,
its label from Paraglide `screen_rotate_landscape` / `screen_rotate_portrait`), and a row of controls
pads its sides with `utils/sideSafeArea.ts`.

- **The camera** (`CameraScreen`, the reel tab and both composers' overlays): no longer turns - see
  [its own section](#the-camera-keeps-its-layout-and-the-volume-keys-are-its-shutter-2026-11-11). The
  frame still follows the SCREEN (9:16 upright, 16:9 where the screen itself is landscape: a tablet,
  a browser window), and the review, the editor and the reel slide take the MEDIA's own ratio, so a
  landscape reel is letterboxed in the vertical pager with the blurred backdrop (`ReelBackdrop`).
- **The live broadcaster**: the recorder records the camera track as it comes (no 9:16 canvas, no
  rotation metadata), so a live filmed in landscape IS a 16:9 stream; the viewer's player already
  takes a new initialization segment whose resolution differs ([live](modules/live.md)). The
  orientation is chosen in the preview and frozen from `starting` to the end. The pre-live sheet takes
  the left side when turned (`landscape:max-w-md`), the on-air chat a column (`landscape:max-w-sm`).
  A double tap on the preview switches the lens (owner, 2026-11-09), exactly where the lens button is
  offered - the sheet and the chat are out of it (`data-no-double-tap`).
- **The full-screen viewer and the live viewer**: owed, written in the backlog entry (their files are
  being rewritten by the video-player stack).

## Known and accepted

Found by the adversarial review of 2026-11-09 and accepted as they are (no code):

- **A tablet's "back to portrait" is not forced.** On an Android tablet `portrait` is `UNSPECIFIED`,
  and on an iPad the mask stays tao's free one, so the rotate button's second press does not hold the
  screen upright against the way the tablet is held. A tablet is a PC here and rotates freely; only
  `landscape` and `locked` bind it.
- **An iPad leaving a forced landscape is asked for portrait.** `portrait` makes a geometry request
  with the Portrait mask, which turns an iPad upright even if it is held sideways; the next physical
  turn rotates it again under its free mask.
- **The web camera is 16:9 in a landscape window.** The frame follows `viewportOrientation`, so a
  desktop browser, or a phone browser turned, films 16:9 where it filmed 9:16. Accepted: the owner
  allowed landscape CanaReels, and a landscape reel is letterboxed in the pager.

## Readings owed on the phones

Native is verified by COMPILING, which proves nothing about running. Each row on a pre-release, on the
Mi 9T and the iPhone 12, is in [the backlog entry](../backlog.d/rotation-on-video-and-camera-screens.md#readings-owed-on-a-pre-release).

## A turned phone is still a phone, and a full-screen place draws no chrome (2026-11-11)

**Defect (owner, Android `1.6.10`):** turned to landscape, the camera showed the DESKTOP shell - the
top bar ("Canari", status, apps, avatar) and the left rail - with the camera shrunk into what was
left. **Cause:** the root layout hid only `MobileHeader`, `BottomNav` and the native tab bar on a
full-screen place; `Navbar` and `AppSidebar` are `md:` pieces (`hidden md:block` / `md:flex`) and the
shell reserved `md:pl-24` for the rail. A phone turned is 800+ px wide, so it crossed `md` and the
two came back. **Fix, at the one place that decides it:** `routes/+layout.svelte` renders `AppSidebar`,
`Navbar`, `MobileHeader`, the tab bars and the gutter only when `!isFullScreen` - chrome follows the
PLACE, never a width. Pinned by `styles/fullScreenChrome.test.ts`. The overlays (reel viewer, video
and live viewers, the composers' camera, the broadcaster) are `fixed inset-0` at `--z-viewer` (300),
above every shell layer, so they were never affected.

**The phone question (decided, and left alone):** `PHONE_VIEWPORT_QUERY` is NOT changed. A first cut
added a rotated-phone term (`(max-height: 500px) and (pointer: coarse)`) and was dropped in review:
rotation exists only on the camera and video screens, where chrome is now gone through `isFullScreen`,
so nothing needs it; and it was harmful - the guide's `phone` fact (`guideTypes.ts`, the welcome-tour
and booking-week wording) would no longer match the chrome drawn on a turned phone, and a coarse
tablet with a short viewport (keyboard open, split-screen) would be classed as a phone. **The layout
never asks the width whether a place is full screen.** The reel viewer's prev/next rail was `md:flex`
("a pointer has no swipe") and showed on a turned phone; it is `any-pointer-fine:flex`, so an iPad
with a trackpad keeps it and a phone, with no fine pointer at all, does not.

**A desktop browser on `/camera` has no shell either** (lead decision, 2026-11-11): the camera is a
full-screen place on every device, with its own close button.

**The rotate button** was the video kit's 28 px chip (`VideoChipButton`, glass), a bordered circle
turned, beside 44 px circles. It is now `ui/CameraControlButton.svelte` - the ONE round control of the
camera and the broadcaster (close, flip, flash, rotate, share, chat) - with the siblings' 22 px glyph.
The ratchet of hand-built controls went down by the buttons it replaced.

## The camera keeps its layout, and the volume keys are its shutter (2026-11-11)

**Owner, 2026-11-11, on a screenshot of the camera drawn for portrait on a phone held sideways:** the
controls must not move - the shutter stays under the thumb, close / flip / flash keep their places -
and each glyph turns in place to read upright, as the system camera apps do; and a volume key takes
the picture as the white shutter does.

**Decided (lead): the camera's layout is LOCKED PORTRAIT, and the phone's angle is read from the
sensor.** The turning camera of 2026-11-09 moved every control with the screen, which is exactly
what was refused; the system camera apps keep their layout and read the accelerometer. So
`CameraScreen` requests `portrait` (not `auto`) for its mount and has no rotate button (the
broadcaster keeps its own); a take still holds `locked`, which binds a tablet whose `portrait` is free.

### One flag, owned by the live camera

`frontend/src/lib/mobile/cameraHardware.svelte.ts` is the ONE owner. `CameraScreen` holds the flag
(`useCameraHardware`) while its preview is LIVE and IN FRONT: not held off by a review (`paused`),
and not under the gallery picker or anything else its owner opened over it (`deferOpen` - iOS's
PHPicker runs in the app's own process, so a key pressed behind it would have shot). The `$effect`
arms it and its teardown - an unmount included - is the only way down on screen. Native
also clears it ITSELF when the app leaves the screen (Android `onPause`, iOS `didEnterBackground`),
so no stale flag survives the background; the page re-arms it on the return
(`onAppScreenChange`) only if a camera still holds it. Every page load posts what that page holds
(`initCameraHardware`, from the root layout), so a reload never leaves native swallowing the volume
keys. No timer anywhere. `[CAMERA-HW] armed / disarmed (why)` is the page's line per change.

- **What native holds is cached only when native HEARD it.** iOS registers `canariCamera` at the
  app's activation, which can follow a page's first post; a post to an absent handler leaves the
  cache empty, and the handler's registration dispatches `canari:camera-bridge`, on which the page
  says again what it holds. iOS sets its own armed flag only once the volume interaction is actually
  installed (no WebView: it stays disarmed and the next `on` tries again).
- **A hold cut short is CANCELLED, never lost.** A disarm while a volume key is down (a release, the
  app leaving the screen) hands the holder `cancel`: a take started by the key is ended and kept, an
  undecided press takes no photo, and the key's late `up` is dropped. On Android the key's repeats
  and its `up` stay swallowed after the disarm (`cameraKeysHeld`), so the volume never ramps and the
  system never receives the `up` of a `down` it did not see.
- **The phone's last quadrant outlives a disarm** (a review, the background) and is forgotten at the
  camera's unmount, so the first shot after a review is not taken upright while the sensor's first
  reading is on its way.
- **During a call the camera takes the volume keys too** (decided 2026-11-11, accepted): the camera
  is in front, so a press is the shutter, not the call's volume; the call's volume is back the moment
  the camera leaves the screen.

- Page -> native: `window.canariCamera.set('on' | 'off')` (Android), `webkit.messageHandlers.canariCamera`
  (iOS).
- Native -> page: `canari:camera-key` (`{phase: 'down' | 'up' | 'cancel'}`) and `canari:device-angle`
  (`{degrees}`, the phone's clockwise turn from upright, sent when it moved by 10 degrees or more).

### The glyphs turn, the file comes out upright

- **The quarter turn** (`quadrantFor`) keeps the current quadrant until the phone is 15 degrees past
  the diagonal, so a phone held near 45 degrees does not flicker.
- **The capture's turn** (`captureTurn`) is the phone's turn plus `screen.orientation.angle` - 0 on a
  phone locked upright; on a tablet whose layout turned with it, the two cancel. No sensor (the web)
  means no turn: a browser tab turns its own layout. The angle is re-read at every
  `screen.orientation` `change`, because a tablet's 180-degree flip between its landscape sides
  changes it without changing the viewport's orientation.
- **The glyphs** turn by the opposite angle, the SHORT way from the angle drawn now
  (`nextGlyphRotation`, cumulative, so 270 -> 0 is one quarter forward), through
  `--camera-glyph-rotation` on the camera's section and `.camera-glyph-turn` (`app.css`, the CSS
  `rotate` property, 250 ms, none under reduced motion) on every `CameraControlButton` and the
  gallery button. The shutter is a circle and is left alone.
- **The file**: the engines deliver the frame upright FOR THE SCREEN, and the screen stays portrait,
  so a phone held sideways films a portrait frame with the world on its side. `framedCapture.ts`
  turns the capture by `PreviewBox.turn` (`turnedSize`, `turnTransform`): the photo, its thumbnail
  and the take's canvas are landscape, mirrored first in the preview's frame for the front lens. A
  take reads the turn ONCE, at its start - its canvas has one size, as a system camera's take keeps
  the orientation it began in.
- **The assumption is guarded** (`effectiveTurn`): a frame whose orientation disagrees with the
  preview box (a LANDSCAPE frame in a portrait preview - an engine that already turned it to the
  device, suspected of WebKit and unverified) is not turned a second time; the capture keeps it as it
  came and says so at ERROR (`the frame WxH is already turned against the box`).

### The volume keys

**A key mirrors the finger on the white button** (`hardwareShutterEvent`, `reelCapture.ts`): down is
the press, up the release, so a short press is a photo and a key held past the hold threshold films
until it is let go - the same reducer and threshold as a touch. A press the button would refuse
(`shutterDisabled`) is refused; a release always passes, so a take started by the key ends when it is
let go. iOS's `cancelled` is the reducer's cancelled touch (no photo; a take is ended and kept).

- **Android**: `MainActivity.dispatchKeyEvent` sees every key before the WebView and the system.
  While armed, `cameraKeyAction` (`camera/CameraHardware.kt`, JVM-tested in `CameraHardwareTest`)
  consumes `KEYCODE_VOLUME_UP/DOWN`: the first `down` is the press, `up` the release, a held key's
  auto-repeat is swallowed - so the volume never moves on the camera. Disarmed, or any other key:
  `super.dispatchKeyEvent`. The angle comes from an `OrientationEventListener`, enabled only while
  armed, filtered by `angleWorthSending`.
- **iOS**: Apple's public API for camera apps, `AVCaptureEventInteraction` (AVKit, iOS 17.2+), added
  to the WebView while armed and removed when disarmed; `began` / `ended` / `cancelled` become `down` /
  `up` / `cancel`. Before 17.2 nothing is installed and the buttons stay the system's. The angle comes
  from `CMMotionManager`'s accelerometer (`UIDevice.orientation` stops at the rotation lock; a camera
  must not). **Apple delivers capture events only to an app using the camera, and this app's camera
  is WebKit's `getUserMedia`**: whether that counts is the first iOS reading.
- **Web**: nothing - no volume key reaches a page.

Readings owed: [the entry](../backlog.d/camera-keeps-its-layout-and-volume-shutter.md).
