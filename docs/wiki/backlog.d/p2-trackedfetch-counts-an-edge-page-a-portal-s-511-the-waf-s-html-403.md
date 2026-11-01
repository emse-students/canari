## P2 - `trackedFetch` counts an edge page (a portal's 511, the WAF's HTML 403) as proof the server is reachable, for every REST call and the probe

**The rule it breaks:** a captive portal must never prove reachability. `trackedFetch` calls
`answered()` on ANY response, so a portal's `511` or the WAF's HTML `403` clears `isOffline`,
fires the reconnect listeners (outbox flush, owed archive replays) and ends the reachability
probe, all on the say-so of something that is not the server.

**Why the pull alone was not changed further:** the pending pull and the history batch now clear
`isOffline` only on the gateway's answer, and leave it as it was on an edge page
([section 20](../frontend/offline-and-weak-network.md#20-a-catch-up-that-gets-no-answer-stops-and-the-mailbox-is-owed-to-the-reconnect-2026-10-30)).
Making the pull also MARK the server down on an edge page would flip-flop: the probe, which goes
through `trackedFetch`, would get the same edge page, call it reachable, and undo the mark, with a
reconnect edge each round.

**Fix shape:** require a gateway answer (`responseOrigin(res) === 'gateway'`) in `trackedFetch` and
in the probe, in ONE change, so that every route reads an edge page the same way. Measure it on
dev, because it changes reachability for the whole app.
