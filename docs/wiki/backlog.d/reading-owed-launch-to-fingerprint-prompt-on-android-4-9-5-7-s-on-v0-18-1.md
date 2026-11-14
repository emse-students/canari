## Reading owed - launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1`

target: 1.7.0

**What is built:** launch to fingerprint prompt on Android, 4.9 - 5.7 s on `v0.18.1`

**The reading that closes it:** HARDWARE, a build from this tree: `bun tools/cold-start/launch-trace.mjs --heartbeat`, the offset of `BiometricService/handleAuthenticate` ([tools/cold-start](../../../tools/cold-start/README.md)). Target **under 1 s all-in** (user, 2026-09-15); the revocation round trip left in front of the prompt was measured and its move reverted, not to be re-opened (backlog, removed by #2381 on 2026-10-24)

**Tried on the Mi 9T 2026-11-14 (`1.6.12-alpha.2`, dev), WAITS on a precondition:** the bench phone
has NO fingerprint enrolled (`dumpsys fingerprint`: 0 prints), and its account runs "stay signed in"
on the hardware-held key, so no prompt is ever raised (`[PIN] Stay signed in on a hardware-held key -
keystore unlock, no prompt`). Enrolling needs a finger on the sensor, once, by hand. What the same
launch measured instead, two cold starts: `am start` -> the keystore unlock decision **2.61 s and
2.93 s**, `MLS ready` 3.99 s and 4.27 s, worst main-thread gap 382 / 350 ms
([cold-start](../frontend/cold-start.md#the-phones-answer-mi-9t-1612-alpha2-on-dev-2026-11-14-evaluation-is-the-largest-term-before-the-app-runs)).
Owed: enrol one finger on the Mi 9T, turn "stay signed in" off, run the trace.
