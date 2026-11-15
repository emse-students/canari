## Reading owed - the checkpoint every commit awaits under the MLS lock before its first request

target: 1.7.0

**What is built:** the checkpoint every commit awaits under the MLS lock before its first request (`checkpointStageBeforeSend`, the leaf-refresh PR #2269): ~1.4-2 s per commit on a Mi 9T DEBUG capture, a burst of N commits ~2N checkpoints ([mls-protocol](../protocols/mls-protocol.md#the-periodic-leaf-refresh))

**The reading that closes it:** in the pre-release carrying #2269, on a RELEASE build on the Mi 9T AND the iPhone 12: the `[COMMIT]` stage-checkpoint duration of one commit (a leaf refresh or an invite), and of a burst (a group creation adding several devices), read from the device log; the rig rows LEAF-REFRESH-1..4 ([cross-client-testing](../cross-client-testing.md)) on the same build

**Triage 2026-11-14: Mi 9T about 15 min and iPhone about 15 min (the `[COMMIT]` stage-checkpoint durations on the store RELEASE builds that dev serves), plus the rig rows LEAF-REFRESH-1..4 on the local estate, about 10 min.**

**iPhone 12 half, READ 2026-11-15 on the TestFlight build `1.6.12-alpha.2` (dev).** No `[COMMIT]` line reports a stage checkpoint that SUCCEEDS: `checkpointStageBeforeSend` logs only its failure. The duration is read from the native line every checkpoint writes, `[MLS] checkpoint: manager lock held N ms (export), seal + write M ms off it` (`frontend/src-tauri/src/concurrency.rs`). That line lands in the app's own `Canari.log`, pulled over USB through house_arrest (`pymobiledevice3 apps pull`), so a store build reads it with no inspector. The iPhone made one Add: a new group, then Canari Test Delta invited. That is ONE commit carrying 7 key packages (`add_members_recorded ... (7 key packages)`, group `ef160214`), the burst shape of a group creation adding several devices.
- The stage checkpoint held the manager lock **2 ms** and sealed + wrote **9 ms** off it (1.39 MB state).
- The merge checkpoint after it took 2 ms + 11 ms.
- The seven Welcome deliveries that followed each paid one checkpoint of 0-3 ms + 4-13 ms.

**So a commit costs the iPhone about 11-16 ms of checkpoint, not the 1.4-2 s of the Mi 9T DEBUG capture.** Left: the Mi 9T half, and LEAF-REFRESH-1..4 on the local estate. The test group was deleted afterwards.
