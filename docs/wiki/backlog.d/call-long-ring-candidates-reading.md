## P2 - after a 30-55 s ring, does the caller still send ICE candidates? Read on the bench phones, fixed if not

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

_2026-11-27: moved to 1.8.3 when 1.8.2 shipped._

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

A 1:1 call answered from the native ring never connected (Android `1.7.2`, 2026-11-22): the
caller sent its offer and then no ICE candidate at all, and its signalling socket reset 7.7 s later.
A network that went away explains both; a peer connection pre-warmed during the ring
(`iceCandidatePoolSize`, `CallLeg.awaitingPeer`) that has nothing left to trickle after a LONG ring
is not excluded. Built: `cands_in=` / `cands_out=` in `[CALL_REPORT]`, the first local and remote
candidate of each type, and the relay's `PeerAway.disposition`
([calls](../frontend/modules/calls.md#a-call-that-never-connected-is-said-and-written-so-2026-11-22)).

The reading that decides it: on the Mi 9T and the iPhone 12, each way, a voice call left ringing 30 s
and then 55 s before it is answered. PASS when both ends' `[CALL_REPORT] phase=end` read
`cands_out` with at least one `h` and one `s` or `r`, the callee's `cands_in` equals the caller's
`cands_out`, and the call connects. A caller reading `cands_out=h0/s0/r0` after a long ring with its
network up is the defect, and its fix belongs in how the ring's peer connection is adopted.

**Blocked on the bench, not a defect (iPhone 12, `1.8.3-alpha.1`, 2026-11-27).** A web seat's audio call never rang the phone: dev's delivery log shows `initiate` and the ICE servers for both attempts, then NO `ringGroup`, no MLS invite and no call-service socket until the caller's `ring-end reason=cancelled` - the caller stopped at its microphone, which comes before the ring by design ([calls](../frontend/modules/calls.md)). The seat's profile holds no microphone grant for dev and a seat started without `--fake-media` waits on the prompt for ever (reproduced: `getUserMedia` still pending after 8 s on a fresh profile); the harness already says so ([README](../../../tools/cross-client-harness/README.md), "A web-seat DIAL must be started with `--launch`"). Retake with the seat started `--fake-media`.
