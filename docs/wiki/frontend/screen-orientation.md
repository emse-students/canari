# Screen orientation - portrait everywhere, rotation on the video and camera screens

**Decided by the owner, 2026-11-09.** The app stays PORTRAIT (the feed, the conversations, the
settings). Four kinds of screen may turn: the full-screen video viewer, the live viewer, the live
broadcaster and the camera (chat and post photos and videos, AND CanaReels - a reel filmed in
landscape is stored with its real aspect and shown letterboxed in the vertical pager). On those
screens:

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
bottom ones, again after every turn of the scene. A turned screen therefore pads with
`var(--safe-area-inset-left, env(safe-area-inset-left, 0px))` - the notch's side in landscape.

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
- **The safe area follows the scene**: the scene's `effectiveGeometry` (KVO-observable since iOS 16)
  re-publishes `--safe-area-inset-*`, the sides included.
- An iPad keeps tao's mask (every orientation) for `portrait` and `auto`; only `landscape` and
  `locked` force it - the same rule as an Android tablet.

## The web build

Nothing to ask. A browser tab turns with the phone already (the app is portrait only inside the
native shell), and `screen.orientation.lock()` is honoured only in FULLSCREEN, which the app's
viewers are not. So `orientationCanBeForced()` is false, the rotate button is not drawn, and a request
posts nothing and logs nothing.

## What a turn does to each screen

- **The camera** (`CameraScreen`, the reel tab and both composers' overlays): the frame follows the
  screen - 9:16 upright, 16:9 turned (`ReelFrame`'s `ratio`) - so a capture is cropped to what the
  preview showed in either orientation (`framedCapture.ts` already sizes the output from the box). The
  review, the editor and the reel slide already take the MEDIA's own ratio (a gallery import has
  always been allowed to be landscape), so a landscape reel is letterboxed in the vertical pager with
  the blurred backdrop (`ReelBackdrop`). A take freezes the orientation.
- **The live broadcaster**: the recorder records the camera track as it comes (no 9:16 canvas, no
  rotation metadata), so a live filmed in landscape IS a 16:9 stream; the viewer's player already
  takes a new initialization segment whose resolution differs ([live](modules/live.md)). The
  orientation is chosen in the preview and frozen from `starting` to the end.
- **The full-screen viewer and the live viewer**: owed, written in the backlog entry (their files are
  being rewritten by the video-player stack).

## Readings owed on the phones

Native is verified by COMPILING, which proves nothing about running. Each row on a pre-release, on the
Mi 9T and the iPhone 12, is in [the backlog entry](../backlog.d/rotation-on-video-and-camera-screens.md#readings-owed-on-a-pre-release).
