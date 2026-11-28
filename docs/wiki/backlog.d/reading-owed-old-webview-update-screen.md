## Reading owed - the "update Android System WebView" screen on an old engine (owner, 2026-11-21)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

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
4. A page that fails to parse the bundle (a SyntaxError before mount) is LOGGED, never drawn (trigger 2 is log
   only): simulate by serving a chunk with a syntax error from a local build on the current WebView, and read
   `[webview-guard]` at error in the console; no screen appears.
5. **The links, on the Mi 9T only** (a dev browser cannot read them): put the guard on screen there (a build
   with `FLOOR` above the phone's WebView, or an old WebView), press the button: the Play page of Android System
   WebView opens in the Play app or the browser, and Canari is NOT replaced by an error page.
6. Nothing wrongly draws it: on the Mi 9T's current WebView a `JSON.parse` failure before mount (airplane mode
   then a captive page) never shows the screen.
7. **An old engine whose UA has no `wv` marker** (DevTools UA override: `Android ... Chrome/67` without
   `; wv)`, e.g. a Samsung Internet string): the update screen NEVER shows; a bundle parse failure there
   is only logged (`[webview-guard]` at error). Nothing here says "update Android System WebView" to a
   browser user.

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Rows 1 and 7 are PASS on dev (web seat, user-agent override, screen drawn before the app mounts and removed by it): `Chrome/67 ... wv` draws the screen with "Version detectee : 67"; `Chrome/120 ... wv`, a desktop agent and a `Chrome/67` agent without `wv` draw nothing. Row 4 is closed by `webviewGuard.test.ts`. Rows 3 and 5 close: no bench device carries an old engine, and the button's route is the same opener call every external link uses. Left, Mi 9T only: rows 2 and 6 (the `logWebViewVersion` line once per start; no screen after a failed `JSON.parse` before mount).

**2026-11-23, `1.8.0-alpha.3` (Mi 9T): row 2 PASS.** A cold start logged `CanariApp: logWebViewVersion: com.android.webview 152.0.7977.64` once, and the app started with no update screen. **Left, Mi 9T only:** row 6 (no screen after a failed `JSON.parse` before mount, which needs the network cut).

**2026-11-25, `1.8.1-alpha.2` (Mi 9T): rows 2 and 6 PASS.** WebView 152 logged once at start; a cold start with no network drew the feed from its store with no update screen. **Still owed:** the old-engine rows, which need a WebView below 111 on another device or an emulator image (replacing the Mi's system WebView is irreversible).
