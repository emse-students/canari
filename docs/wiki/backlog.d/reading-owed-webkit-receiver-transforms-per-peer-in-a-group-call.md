## Reading owed - WebKit opens each participant's frames with that participant's key in a group call

target: 1.7.0

**What is built:** a group call's receiver transforms carry `peer` (the participant whose key opens
their frames) and each leg its own `epoch`
([calls](../frontend/modules/calls.md#group-calls---the-mesh-client-half-wp-gc2-2026-11-13)).
Chromium's path is the 1:1 one; whether WebKit hands each receiver transform ITS options when one
page holds two peer connections is not measured.

**The reading that closes it:** on the iPhone 12, in a three-way call on dev, the worker's
`E2E receiver transformer #N` lines (one per participant), no `E2E key mismatch` and no
`undecryptable` line, both voices heard, and the `[CALL_REPORT]` line of each leg
(`callId/<user8>`) carrying decrypted frames.
