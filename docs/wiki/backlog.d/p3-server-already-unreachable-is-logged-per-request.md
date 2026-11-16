## Reading owed - one "server already unreachable" line per spell, read on a phone log after a real outage

target: 1.7.0

`connectivity.svelte.ts` now says `(server already unreachable)` once per unreachable spell and reports
the deadlines it did not repeat on the line that closes the spell
([offline-and-weak-network](../frontend/offline-and-weak-network.md#21-server-already-unreachable-is-said-once-per-spell-2026-11-16)).
Guard: `connectivity.test.ts`, fail-first (three deadlines inside a spell print one line, the closing
line carries `2 more request deadline(s)`, and the next spell speaks again).

**What a reading must show**, on a phone log after a real outage (airplane mode on, a screen of
requests left stalling, then off): at most one `already unreachable` line per spell, followed by
`server reachable again (N more request deadline(s) expired while it was unreachable)`; and no spell
that ends without its closing line.


**Mi 9T half, tried 2026-11-16 on `1.7.0-alpha.6`, `NOT READ` ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-fifth-sitting-on-170-alpha6-the-salon-badge-and-grant-rows-the-live-bars-the-push)).** Wi-Fi and data cut over six in-app navigations: the page console held only `browser reports offline` and `online`, because nothing the screens needed was a request that could fail. A system HTTP proxy to a non-routable address (to make requests stall) is not honoured by the WebView. The line needs a request DEADLINE after the "unreachable" verdict, which needs packets dropped on the way. **What would read it:** a Wi-Fi network whose uplink silently drops (a hotspot with its upstream cut) with a screen of requests left stalling; the bench has no such network yet.

**Mi 9T half, 2026-11-17: DELETED under the owner's decision (20)** ([readings](../device-verification.md#the-mi-9t-night-readings-of-2026-11-17-170-alpha6)): tried twice on `alpha.6`; the line needs a request deadline while the verdict is "unreachable", which needs packets dropped on the way, and the bench has no silently-dropping network (a downed link and a WebView-ignored proxy produce none). The iPhone half stays.
