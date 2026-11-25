## P3 - Connectivity flaps reachable/unreachable when the WebView's HTTP stack answers and the plugin's does not (owner's Android log, 2026-11-25)

target: 1.8.3

**What was read.** On a phone whose native resolver failed for a few seconds (the gateway's own
`failed to lookup address information: No address associated with hostname`), the store went
unreachable and reachable four times in four seconds. Each cycle: a send (`POST /api/mls/send`)
failed with `TransportFailureError` whose raw rejection was a `string` (the Tauri HTTP plugin,
reqwest) -> `[CONNECTIVITY] server unreachable (transport failure: string)` -> the probe
(`GET /api/version`) answered -> `server reachable again` -> the reconnect listeners flushed the outbox
-> the same send failed again, with two or three `[GroupMembers]` / `[DELIVERY]` warnings per cycle. It
ended only when the browser itself reported offline and online.

**The mechanism.** `fetchRouting.ts` (`shouldUseNativeFetch`) keeps first-party READS on the WebView's
own `fetch` (Chromium's network stack and resolver) and sends WRITES with a JSON body through the
plugin (reqwest, the system resolver). The probe is a read, so it measures the WebView's stack, and
any answered read (`trackedFetch` -> `answered()` -> `notifyServerReachable`) lifts a verdict that a
write on the other stack earned. The store has one `serverReachable` for two stacks that can disagree.

**Why it was not fixed in the noise batch.** Neither obvious fix is local:

- Probing through the plugin alone does not end the flap: every other read the WebView answers still
  calls `notifyServerReachable`.
- Reachability per stack (`webview` / `plugin`) needs the stack recorded at the throw (the two
  `conform*Fetch` wrappers in `transportFailure.ts`) AND on the answer (`trackedFetch` does not know
  which stack the routed `fetch` chose), and every `isOffline` consumer then has to say which stack it
  depends on - the outbox the plugin's, a feed read the WebView's.
- Letting a failing send's own outcome drive the state is what it does already; the defect is the
  lifting, not the verdict.

**What would settle it.** Decide the per-stack model (owner of the decision: the connectivity store,
[offline-and-weak-network](../frontend/offline-and-weak-network.md)), record the stack as a field of
`TransportFailureError` and of the tracked answer, lift a verdict only on an answer from the stack that
earned it, and probe through that stack. Test: a write failing on the plugin while the WebView's reads
answer leaves the outbox's stack unreachable, with ONE `server unreachable` line and no flush until the
plugin's own probe answers. Reading: the same DNS hiccup on the Mi 9T (a resolver blocked for the app
process only), counting `[CONNECTIVITY]` lines.
