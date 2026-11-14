## Reading owed - the checkpoint every commit awaits under the MLS lock before its first request

target: 1.7.0

**What is built:** the checkpoint every commit awaits under the MLS lock before its first request (`checkpointStageBeforeSend`, the leaf-refresh PR #2269): ~1.4-2 s per commit on a Mi 9T DEBUG capture, a burst of N commits ~2N checkpoints ([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh))

**The reading that closes it:** in the pre-release carrying #2269, on a RELEASE build on the Mi 9T AND the iPhone 12: the `[COMMIT]` stage-checkpoint duration of one commit (a leaf refresh or an invite), and of a burst (a group creation adding several devices), read from the device log; the rig rows LEAF-REFRESH-1..4 ([cross-client-testing](../cross-client-testing.md)) on the same build
