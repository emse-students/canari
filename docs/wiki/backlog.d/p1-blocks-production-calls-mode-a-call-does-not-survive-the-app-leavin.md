## P1 (blocks production `calls_mode`) - a call does not survive the app leaving the screen on either phone (2026-10-19)

The web half is done (full screen + top banner, timer from timestamps, Media Session, one audio
sink, a log line per background transition). What only native code can do, each a work package of
its own ([calls](../frontend/modules/calls.md#the-call-in-the-background-2026-10-19)):

- **WP-C-BG-A (Android): SHIPPED in `v1.3.1` (#2162), OWED THE Mi 9T READING** - a `microphone`
  foreground service (not `phoneCall`: that needs a `ConnectionService`), the ongoing `CallStyle`
  notification, `setCommunicationDevice` in place of `setSinkId` (the mode left to Chromium when
  Chromium set it), in the main manifest since #2299; started at the caller's `ringing` / the callee's `connecting` once the microphone
  is held. Twelve readings owed (the API 28-30 paths have no bench device); the Play declaration was
  filled by the owner on 2026-10-21: [calls](../frontend/modules/calls.md#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20).
- **P3 - `canariCall` is an `addJavascriptInterface` bridge, reachable from ANY frame the WebView
  loads**, not only the app's origin. `WebViewCompat.addWebMessageListener` takes an origin
  allowlist and would bound it to the app's own origin. Today the WebView loads only the embedded
  frontend, and the methods can do no more than start, update or stop a call notification the app
  itself could, so this is hardening, not an open hole; it applies to every bridge `MainActivity`
  registers, not to this one alone, and would move them together.
- **WP-C-BG-I (iOS) - SHIPPED in `v1.3.1` (#2164), owed its hardware reading.** Measured first: a locked
  iPhone is NOT suspended (same pid, WebRTC stack alive, the partner's audio received) - only its
  microphone is muted, by WKWebView, for want of the `audio` background mode. So the fix is that
  mode, in the committed plist since #2299, plus the partner
  told over the relay (`MicSuspended`) - no CallKit and no native audio session, neither shown
  missing ([calls](../frontend/modules/calls.md#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20),
  which carries the owed steps). CallKit for every call stays with the `voip` revival.
- **Read on both phones before either was written** (`1.3.1-alpha.3` and `-alpha.4`, 2026-10-20,
  [device readings](../device-readings-2026-10.md)): the Mi 9T loses its call socket and all audio 5 s
  into a lock (WP-C-BG-A's case); the iPhone keeps the call and loses only its microphone (WP-C-BG-I's).
