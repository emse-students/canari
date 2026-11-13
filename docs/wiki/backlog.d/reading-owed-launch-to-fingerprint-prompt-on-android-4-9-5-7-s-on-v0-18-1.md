## Reading owed - launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1`

target: 1.7.0

**What is built:** launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1`

**The reading that closes it:** HARDWARE, a build from this tree: `bun tools/cold-start/launch-trace.mjs --heartbeat`, the offset of `BiometricService/handleAuthenticate` ([tools/cold-start](../../../tools/cold-start/README.md)). Target **under 1 s all-in** (user, 2026-09-15); the revocation round trip left in front of the prompt was measured and its move reverted, not to be re-opened (backlog, removed by #2381 on 2026-10-24)
