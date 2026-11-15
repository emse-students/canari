## Reading owed - the checkpoint every commit awaits under the MLS lock before its first request

target: 1.7.0

**What is built:** the checkpoint every commit awaits under the MLS lock before its first request (`checkpointStageBeforeSend`, the leaf-refresh PR #2269): ~1.4-2 s per commit on a Mi 9T DEBUG capture, a burst of N commits ~2N checkpoints ([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh))

**The reading that closes it:** in the pre-release carrying #2269, on a RELEASE build on the Mi 9T AND the iPhone 12: the `[COMMIT]` stage-checkpoint duration of one commit (a leaf refresh or an invite), and of a burst (a group creation adding several devices), read from the device log; the rig rows LEAF-REFRESH-1..4 ([cross-client-testing](../cross-client-testing.md)) on the same build

**Triage 2026-11-14: Mi 9T about 15 min and iPhone about 15 min (the `[COMMIT]` stage-checkpoint durations on the store RELEASE builds that dev serves), plus the rig rows LEAF-REFRESH-1..4 on the local estate, about 10 min.**

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, the store RELEASE build):** the native line `[MLS] checkpoint: manager lock held N ms (export), seal + write M ms off it, B bytes` is in logcat (the page's `[COMMIT]` console lines are not, on a release build). Creating a group wrote 15 of them in ~4 s and adding the beta account to it (one commit adding that account's devices) wrote 8 within ~2 s of the tap, each with the manager lock held 0-2 ms and seal + write 5-18 ms off it, for 860-896 KB of state. So the checkpoint a commit awaits costs about 10-20 ms on this phone's release build, against the ~1.4-2 s per commit of the DEBUG capture the entry was written from; a burst of N commits is ~N-2N such lines. **Left: the iPhone 12, and the rig rows LEAF-REFRESH-1..4 on the local estate.**
