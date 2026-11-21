## Reading owed - the "update Android System WebView" screen on an old engine (owner, 2026-11-21)

target: 1.7.3

Built ([the guard](../frontend/mobile.md#an-old-android-system-webview-shows-an-update-screen-not-a-blank-page-owner-2026-11-21)):
the ES5 guard in `app.html`, the `webview_outdated_*` strings, `window.__canariMounted`, and the startup
WebView log in `CanariApplication`. The unit tests drive the guard with fake pages; nothing has run it in a
real engine. Owed, by the lead, on the pre-release:

1. **A dev browser, user agent override**: on dev, in Chrome DevTools, network conditions, set the user
   agent to an Android WebView string with `Chrome/67` (`...; wv) ... Version/4.0 Chrome/67.0.0.0 Mobile Safari/537.36`),
   reload: the update screen shows at once, with "Version détectée : 67", over the splash. With `Chrome/120`
   it never shows. A desktop user agent never shows.
2. **The Mi 9T (a current WebView)**: the app starts as before, no screen; `adb logcat -s CanariApp` carries
   `logWebViewVersion: com.google.android.webview <version>` once per start.
3. **If feasible**: an old engine for real (an emulator image with a WebView below 111, or the Mi 9T's
   WebView disabled in favour of an older one): the screen shows, the Play button opens the store page (the
   `market://` link inside the Tauri WebView is NOT verified - if it is refused, the https link under it is the
   way out, and the button should then use it), the https link opens a page.
4. A page that fails to parse the bundle (a SyntaxError before mount) shows the screen: simulate by serving a
   chunk with a syntax error from a local build.
