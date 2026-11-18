## P2 - a live viewer suspended mid-request stops as "Live indisponible" on a transport failure

target: 1.7.1

**Found by:** sitting S6 on `1.7.0-alpha.12`, iPhone 12 as `gamma`, by accident
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).
Queued WebDriverAgent taps opened `delta`'s desktop live from the feed, and a queued home press sent
the app to the background a second later. The pulled in-app log:

```
07:50:24.599 L [API] → GET /api/lives/7ee4ad11…/manifest
07:53:18.520 E [LIVE] viewer 7ee4ad11…: stopped (TypeError) TypeError: Load failed
07:53:18.520 L [LIVE] viewer 7ee4ad11… (unavailable): 2 segments played, 0 skipped, 0 seeks, at 12
```

The manifest request in flight when iOS suspended the app never answered; on the return its fetch
rejected with WebKit's bare `TypeError: Load failed`, which `liveFailureOutcome`
(`src/lib/live/liveViewerState.ts`) does not count as a transport failure (`isTransportFailure` knows
only `TransportFailureError` and `RequestDeadlineError`), so the viewer stopped on "Live indisponible -
Ce live ne peut pas être affiché" instead of retrying. The live had in fact ended 74 s earlier
(`endReason` `broadcaster`), which a retry would have been told ("ended"). A transport failure is not
an answer (CLAUDE.md). Whether `v1.6.12` behaves the same was not checked, so it is not shown a
regression; seen once.

**The fix:** classify at the throw - the request layer the manifest poll uses wraps a fetch rejection
as `TransportFailureError`, so the viewer's one decision (`fail`) retries it and learns the live's real
state. A unit test: a `TypeError` from the manifest fetch gives `retry`, not `unavailable`; then the
reading on the iPhone (open a live, send the app home for a minute, come back).
