## P2 - a live ended itself (`upload-too-slow`) after 256 s on the iPhone, cause unproven

target: 1.7.0

**Read once, 2026-11-16, iPhone 12, `1.7.0-alpha.5`, dev ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-fourth-sitting-b-170-alpha5)):** a live ("IPH5B on air") ended on its own at 11:59:18 with `ended (upload-too-slow) after 256 s: 124 segments`. The log before it: reconnecting at 11:56:48 and 11:58:21, `segment 41/79 not stored`, `manifest had no response after 20000 ms`, `LIVE_POSTER_TOO_FAST 429`, then `36 segments waiting, over the 35 the reconnect window holds`.

**Unknown:** whether the cause is the dev estate's load that minute, the phone's path, or the poster's pacing against the server's rate limit (a 429 appears in the chain). **To do:** a second on-air run of about five minutes on the same phone while the dev estate is quiet, and read whether the 429 and the missing manifest reappear; if they do, the poster's backoff against the limiter is the lead. Not filed as a defect of the ending logic: ending after the reconnect window is by design.
