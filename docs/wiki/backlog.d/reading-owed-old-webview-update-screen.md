## Reading owed - the "update Android System WebView" screen on an old engine (owner, 2026-11-21)

target: 1.7.3

Built ([the guard](../frontend/mobile.md#an-old-android-system-webview-shows-an-update-screen-not-a-blank-page-owner-2026-11-21)):
the ES5 guard in `app.html`, the `webview_outdated_*` strings, `window.__canariMounted`, and the startup
WebView log in `CanariApplication`. The unit tests drive the guard with fake pages; nothing has run it in a
real engine. Owed, by the lead, on the pre-release:

1. **A dev browser, user agent override**: on dev, in Chrome DevTools, network conditions, set the user
   agent to an Android WebView string with `Chrome/67` (`...; wv) ... Version/4.0 Chrome/67.0.0.0 Mobile Safari/537.36`),
   reload: the update screen shows at once, with "Version détectée : 67", over the splash. With `Chrome/120`
   it never shows. A desktop user agent never shows. **This reading does NOT exercise the links**: a dev browser has no Tauri opener and no Play Store.
2. **The Mi 9T (a current WebView)**: the app starts as before, no screen; `adb logcat -s CanariApp` carries
   `logWebViewVersion: com.google.android.webview <version>` once per start.
3. **If feasible**: an old engine for real (an emulator image with a WebView below 111, or the Mi 9T's
   WebView disabled in favour of an older one): the screen shows, the Play button opens the store page (the
   button is https, opened through `plugin:opener|open_url`).
4. A page that fails to parse the bundle (a SyntaxError before mount) shows the screen: simulate by serving a
   chunk with a syntax error from a local build.
5. **The links, on the Mi 9T only** (a dev browser cannot read them): put the guard on screen there (a build
   with `FLOOR` above the phone's WebView, or an old WebView), press the button: the Play page of Android System
   WebView opens in the Play app or the browser, and Canari is NOT replaced by an error page.
6. Nothing wrongly draws it: on the Mi 9T's current WebView a `JSON.parse` failure before mount (airplane mode
   then a captive page) never shows the screen.
7. **An old engine whose UA has no `wv` marker** (DevTools UA override: `Android ... Chrome/67` without
   `; wv)`, e.g. a Samsung Internet string): the update screen NEVER shows; a bundle parse failure there
   is only logged (`[webview-guard]` at error). Nothing here says "update Android System WebView" to a
   browser user.
