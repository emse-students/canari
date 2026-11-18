## P3 - iOS: a foreground ring flashes the CallKit banner over the in-app ring, because the server still sends the VoIP push

target: 1.8.0

**Seen 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, dev, Canari open in front past its
PIN, Canari Test Delta calling from a web seat). The in-app ring filled the screen. A CallKit banner
"Canari Audio... / Canari Test Delta" with its Decline/Answer buttons was drawn over it for about three
seconds, then went away. The syslog names the path. It is NOT the web's local notification, which is
deferred while the page is visible ([calls](../frontend/modules/calls.md#the-bar-is-never-under-a-layer-call-bar-covered-2026-10-19)):

- `[CanariCallKit] call=... voip push with the page holding the socket - the in-app overlay rings; reported and ended`
- `reported call=... (voip, -1794712884117 ms left)`, then `call ... ended (reason=2)` 0.3 s later

**The cause is the server's ring push reaching a device whose socket is live and in the foreground.**
iOS requires every VoIP push to be reported to CallKit, so the app reports the call and ends it at
once, and the banner flashes. The fix belongs where the push is chosen: do not send the VoIP push to
a device that holds a live, foreground call socket (the socket ring already reaches it). Alternatively,
carry the fact that the device is in the foreground to the server. Pin it in the ring-dispatch spec.
The client's `ms left` figure (a deadline read as 0) is noise to fix in the same change.
