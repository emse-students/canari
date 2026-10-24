# live-bench - the WP-L1 feasibility bench for lives

A throwaway instrument, **not shipped and not product code**: it answers with numbers what
[live](../../docs/wiki/frontend/modules/live.md#wp-l1---measured-2026-10-19) planned for architecture C
(the phone records short fMP4 segments, seals them, uploads them to the lives ingest; viewers poll the
manifest and play a growing source through MSE). The readings it produced are on that page.

| File | What it is |
| --- | --- |
| `bench.js` | The page side, evaluated in an inspectable page: a **broadcaster** (camera -> `MediaRecorder` with a timeslice -> AES-GCM seal -> `PUT /api/lives/:id/segments/:i`) or a **viewer** (manifest poll -> `GET /api/media/live/...` -> open -> `MediaSource` / `ManagedMediaSource`). Results in `window.__LB`. |
| `inject.mjs` | Evaluates `bench.js` (or any expression) in a page over CDP. Target: a `ws://` url or `<port>:<url substring>`. |
| `collect.mjs` | Drains each page's `__LB` into ndjson every N s, and samples the Mi 9T (`adb`) and iPhone (`pymobiledevice3 diagnostics battery`) beside it. |
| `analyze.mjs` | Turns a run directory into the quoted numbers (percentiles of upload, fetch, glass-to-glass, stalls; battery and heat). |
| `server.mjs` | Optional bench server: a clock, a STATIC MIRROR of a live (sealed files, no auth - the WP-L4 shape) and a log sink, for a page that cannot reach dev. |

## How a run is taken

1. **Pages.** Broadcaster and viewers must be pages of the web app or the Tauri app **signed in to
   dev** with a TEST account. The bench reuses the page's own `Authorization` header (a fetch
   wrapper, kept in the page) or, for a web page parked on the PIN screen, `selfRefresh: true` (the
   page's refresh cookie, as the app does). No credential leaves the page.
   - Mi 9T, the app: a tester build points at dev and its WebView is inspectable;
     `adb forward tcp:9301 localabstract:webview_devtools_remote_<pid>`.
   - iPhone 12, Safari (the TestFlight WKWebView is not inspectable):
     `pymobiledevice3 webinspector cdp --port 9310`, Safari in front.
   - PC: a harness Chrome profile on dev (`cross-client-harness/launch.mjs`, port 9225).
2. **Broadcast:**
   `bun inject.mjs 9301:tauri.localhost start '{"role":"broadcast","target":"dev","api":"https://dev.canari-emse.fr","segMs":2000,"bitrate":2500000,"kfMs":2000,"name":"mi9t"}'`
   then read `__LB.liveId`.
3. **View:** `bun inject.mjs 9310:dev.canari-emse.fr start '{"role":"view","source":"dev","selfRefresh":true,"api":"https://dev.canari-emse.fr","liveId":"<id>","name":"iphone"}'`.
4. **Collect:** `bun collect.mjs --out <dir> --every 30 --page mi9t=9301:tauri.localhost --page iphone=9310:dev.canari-emse.fr --adb <serial> --ios <pymobiledevice3>`.
5. **End:** `bun inject.mjs 9301:tauri.localhost eval '__LB.stop()'` (ends the live on dev), then
   `bun analyze.mjs <dir>`.

**One clock.** Every page syncs to dev's `serverNow` (min-RTT of 7 manifest reads; the error is
at most half the best RTT, 35-90 ms here). Glass-to-glass is `now - (recStart + video.currentTime)`:
the frame on screen was captured at the recorder's start plus its media time. It leaves out the
camera's and the display's own latency (tens of ms).
