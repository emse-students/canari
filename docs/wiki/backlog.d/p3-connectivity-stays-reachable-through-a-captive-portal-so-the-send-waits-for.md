## P3 - Connectivity stays "reachable" through a captive portal, so the send waits for the ladder (review of #2428, 2026-10-25)

target: 1.9.2

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

`trackedFetch` no longer counts the portal's page as an answer, and the probe no longer ends on it
([offline-and-weak-network section 22](../frontend/offline-and-weak-network.md#22-only-our-apis-answer-proves-the-server-is-there-2026-11-01)):
it settles the request and moves no reading. But nothing MARKS the server down either, so the store
never leaves "reachable", and when the portal ends there is no transition for the reconnect resume to
fire on: a kept send goes on its backoff ladder, up to 60 s later. It is not a local fix. Reporting
`tracked.failed` on the send alone would flip the store, and the next poll answered by the same
portal would flip it back and fire a resume into the portal. The fix needs `trackedFetch` to know
which routes speak JSON, the version probe included.

Re-read 2026-11-11 (batch 12): still real - nothing marks the server down on a portal answer; the fix still needs `trackedFetch` to know which routes speak JSON. Re-read again 2026-12-11.

_2026-11-25 (batch 10): held, moved to 1.9.0. It touches `trackedFetch` and the connectivity store, which the open draft PR #4111 (connectivity and captive-portal changes) is editing; it is rebased onto that PR after it merges, not built beside it. The `p3-connectivity-flaps-when-the-two-http-stacks-disagree` entry that PR adds is a DIFFERENT mechanism (one `serverReachable` for two HTTP stacks) with its own per-stack decision, so it was not bundled._
