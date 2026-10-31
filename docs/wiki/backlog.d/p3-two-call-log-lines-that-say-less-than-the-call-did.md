## P3 - Two call log lines that say less than the call did (Tier A K1, `1.5.1-alpha.8`, 2026-10-29; ride 1.5.2)

- **The ICE-server line never names the TURN relay.** `CallService.ts:1437` prints `N ICE server(s) (direct first, TURN relay last)` followed by `urlPreview`, which is the flattened URL list cut by `.slice(0, 2)`. The STUN entry carries two URLs, so the preview is always the two STUN ones and the relay listed "last" is never shown. On K1, both ends read `2 ICE server(s) ... stun:...:3478, stun:...:443`, yet gathering found 10-12 relay candidates and `CALL_REPORT` said `turn=turn.cloudflare.com:443`. Fix: preview one URL per server entry, or count URLs and name the relay host.
- **An answered call ends with `outcome=answered-or-unrung`.** At `CallService.ts:1030`, `outcome` is `undefined` both for an answered call and for one whose invite never rang, and the line prints the two cases as one word. K1 was answered and lasted 37 s, but the caller's line could not say so. Fix: name the two cases apart where they are already known (`peerArrived`, `inviteSent`).

Mechanism: [calls](../frontend/modules/calls.md). Delete each with its fix.
