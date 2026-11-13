## P3 - CALL-PATH-LINE: the `selected path ... relayed=` line over-counts relayed calls (2026-10-20, not built)

target: 1.8.0

**Re-read 2026-11-11: unchanged** - `CallService` still logs `selected path` once, at `connected`.
The client's path line ([calls](../frontend/modules/calls.md); a diagnostic since 2026-10-21 - the TURN budget reads Cloudflare's meter, never this line) is written ONCE, at `connected`; ICE may move to a better pair afterwards. Bench P1 logged `relayed=yes` on both ends while `getStats` read `host/udp -> host/udp` at the end ([readings](../device-readings-2026-10.md)). Fix: log the pair again when the selected pair changes (or at hang-up), so the last line names the path the call ended on. Delete with its fix.
