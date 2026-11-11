## P2 - the camera keeps its layout and the volume keys are its shutter (owner, 2026-11-11): built, compiled, readings owed

The owner's two asks about the in-app camera (the reel tab and both composers' cameras,
`CameraScreen` under `ReelCapture`), and how they were built:
[screen-orientation](../frontend/screen-orientation.md#the-camera-keeps-its-layout-and-the-volume-keys-are-its-shutter-2026-11-11).

1. **Landscape**: the camera no longer turns with the phone. Its layout is locked portrait, every
   control stays where it is, and each round control turns in place (a quarter turn, animated) from
   the phone's angle read by the accelerometer; a photo or a take made sideways is a landscape file
   (the capture is turned in the canvas). The camera's rotate button is gone; the broadcaster keeps
   its own.
2. **Volume keys as the shutter**: press = the finger down on the white button, release = the finger
   lifted, so a short press is a photo and a held key films until it is let go. Android: the
   activity's `dispatchKeyEvent`; iOS 17.2+: `AVCaptureEventInteraction`; older iOS and the web:
   nothing.

**Compiled:** the Android app's Kotlin (`:app:compileArm64DebugKotlin`, on the workstation) and the
JVM tests `CameraHardwareTest` (6 pass). **Not compiled here:** `canari_ios.mm` (Windows), so CI's
Compile iOS is the first compile of the iOS half.

### Readings owed on a pre-release (Mi 9T and iPhone 12)

- **The layout holds**: phone turned either way, rotation lock OFF then ON - the shutter and the
  close / flip / flash / gallery buttons stay where they were; each round control turns a quarter in
  place, animated, and reads upright; back upright, they turn back the short way.
- **The file comes out the way the phone was held**: a photo and a take made sideways (both sides,
  front and rear lens) are 16:9 files with the world upright in the review, the editor and the
  published reel (letterboxed in the pager). The log line `[framed-capture] photo WxH ... turn=90`
  (or `take ... turn=`) names the turn. This also proves the engines deliver a portrait frame on a
  portrait-locked screen, which the turn assumes.
- **Android, the volume keys**: on the camera, a short press of either key takes a photo, a held key
  films and its release ends the take; the system volume slider never appears and the volume does
  not change. logcat: `camera armed by the page`, `volume key 25 down: the camera's shutter press`.
  On the review, after closing the camera, and in any other screen the keys change the volume as
  usual (`camera disarmed by ...`). Home with the camera open: `camera disarmed by onPause`; back on
  the camera, armed again.
- **iOS, the volume buttons** (iOS 17.2+): the same press / hold. syslog: `[CanariCamera]
  AVCaptureEventInteraction installed on the WebView`, then `volume button down` / `up`. **The open
  question**: Apple delivers these events only to an app using the camera, and this app's camera is
  WebKit's `getUserMedia`. If no `volume button` line comes and the volume moves, WebKit's capture
  does not count - say it, and the iOS half is withdrawn rather than patched.
- **The sensor ignores the rotation lock**: with the lock ON, the glyphs still turn (Android
  `OrientationEventListener`, iOS `CMMotionManager`).
