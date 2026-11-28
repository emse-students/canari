## Reading owed - a verdict the plugin earned is lifted by the plugin alone, and a salon of the history flap is counted once

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

Built and unit-tested, never run on a device ([offline-and-weak-network](../frontend/offline-and-weak-network.md#two-stacks-one-verdict-183)).

1. **The DNS hiccup, on the Mi 9T.** Block the resolver for the app process only (a firewall rule on the app's uid, or a private-DNS name that fails) while the Wi-Fi stays up, send a message, and count `[CONNECTIVITY]` lines in the in-app log. **Passes when** there is ONE `server unreachable (transport failure: string, plugin stack)`, no `server reachable again` while the resolver stays blocked (reads the WebView answers do not lift it), and ONE `server reachable again (N answer(s) from the webview stack did not lift it)` followed by one outbox flush once the block is removed.
2. **The history load, on the iPhone 12 and the web** (the half of the former P3 "opening a salon loads the history page four times within 50 ms" that is still owed): open one salon and count the history requests of that ONE open, with the `[CHANNEL] history load ... joins the one in flight` lines. The stale counter is per salon since 2026-11-25 (`staleDeclarationsOf`); if one open still shows more than one request, the log names the opener that declared the salon stale, and that opener is the next fix. The code reading could not decide it ([history-reconciliation](../protocols/history-reconciliation.md)).
3. **The reload noise, on the iPhone 12.** Switch the language (a reload) and count `[TAURI] Couldn't find callback id` over ninety seconds: expected 0 (the release of the native socket on `pagehide` now sends the disconnect frame and the native release together, never after an awaited frame). **Read 2026-11-27 on `1.8.3-alpha.1`: ONE id remained** - the server's answer to our own close, forwarded by the plugin's reader into the dead page. The close is now coded 1001 and the plugin forwards nothing after it ([mobile](../frontend/mobile.md)); this row stays owed on the next alpha, expected 0.

Row 2 (the history load) was read on the same build and PASSED on the iPhone 12 (one salon of 110 rows: one request, no stale declaration); the web half stays owed.
