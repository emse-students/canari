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
