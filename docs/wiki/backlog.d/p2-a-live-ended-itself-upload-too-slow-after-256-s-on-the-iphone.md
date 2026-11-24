## P2 - a live ended itself (`upload-too-slow`) after 256 s on the iPhone, cause unproven

target: 1.9.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_Moved 2026-11-18 under the 1.7.0 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md)): not a regression, and not reproduced on `1.7.0-alpha.5`, `alpha.9` or `alpha.10`._

_2026-11-17, scope cut: KEPT in `1.7.0` - the broadcaster that ends on `upload-too-slow` changed since `v1.6.12`: `git log v1.6.12..origin/main` on `frontend/src/lib/live/liveBroadcast.svelte.ts` lists #3508 (desktop scenes), #3521 and #3604, and `LiveBroadcaster.svelte` #3690 and #3701 ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

**Read once, 2026-11-16, iPhone 12, `1.7.0-alpha.5`, dev ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-b-170-alpha5)):** a live ("IPH5B on air") ended on its own at 11:59:18 with `ended (upload-too-slow) after 256 s: 124 segments`. The log before it: reconnecting at 11:56:48 and 11:58:21, `segment 41/79 not stored`, `manifest had no response after 20000 ms`, `LIVE_POSTER_TOO_FAST 429`, then `36 segments waiting, over the 35 the reconnect window holds`.

**Unknown:** whether the cause is the dev estate's load that minute, the phone's path, or the poster's pacing against the server's rate limit (a 429 appears in the chain). **To do:** a second on-air run of about five minutes on the same phone while the dev estate is quiet, and read whether the 429 and the missing manifest reappear; if they do, the poster's backoff against the limiter is the lead. Not filed as a defect of the ending logic: ending after the reconnect window is by design.

**Re-run, 2026-11-16, iPhone 12, `1.7.0-alpha.5`, dev ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-sixth-sitting-170-alpha5-a-ten-minute-live-and-a-newcomer-after-a-nickname)): NOT REPRODUCED, 1 run of 1.** A live from the composer ran 10 min 21 s with no viewer and was ended by killing the app (the End button is off-screen on this build): 276 segment PUTs logged and all `200` (mean 664 ms, p50 630, p95 971, p99 1 340, max 3 082 ms for a 2 s, about 484 kB segment), 35 poster PUTs all `200`, no reconnect line, no waiting-segments line, no missing manifest, no `LIVE_POSTER_TOO_FAST` and no `429` in the app or the server window; the server swept it at `duration=621s segments=302`. The upload ran at about three times the media rate, so the phone's path does not by itself explain the 256 s ending; one clean run neither confirms the dev-load lead nor the poster-pacing lead. **Left:** a second clean run is not worth more; what would decide is a run while the dev estate is loaded (a viewer or two, a parallel run) or the next occurrence, whose log should carry the same PUT durations. The entry stays open until then or until the owner closes it as unreproduced.
