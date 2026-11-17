## Reading owed - a salon push's catch-up at a key group of production size, on the phones (2026-11-17)

target: 1.7.0

**What is built:** the P1 "a salon push's seed frame opened against a key group of production size,
on the bench" is answered on the workstation
([channel-encryption section 28](../protocols/channel-encryption.md#28-a-salon-pushs-catch-up-against-a-key-group-of-production-size---measured-2026-11-17)).
The frame opens at every size measured (206 and 400 devices, up to 400 commits behind), but the
replay cost 0.6-88 s of work per push on one workstation, 85-95% of it a quadratic device-trust observer on
every merged commit. That observer is now linear (`a_merged_commit_is_observed_in_time_linear_in_the_tree`,
bench `mls-core/tests/push_catchup_at_scale.rs`): a month behind production's largest key group is
~0.6-0.9 s instead of ~4.5 s on that workstation, 3-6 s estimated on a phone. The Android service and the iOS extension now say what
each catch-up cost: `catchup: replay since epoch=<e> took <ms> ms (state <n> B, commits <n>
ch) ...` (logcat `CanariFCM`; the extension's `[CanariNSE]` at info). Both lines are compiled only
by CI.

**The reading that closes it, on a pre-release carrying it, on dev with the rig:**

1. On the Mi 9T, kill the app; grow a dev key group with `newdevice.mjs` cycles until the phone is
   at least 30 commits behind it (each cycle is one commit), then send a salon message of a session
   minted after them. The banner shows the text; logcat reads `fetchCommitsFromBackend: <n>
   commit(s)` and the `catchup: replay ...` line - its milliseconds are the phone's figure for
   section 28's table. A blind banner is a defect, named by its log line.
2. The same on the iPhone 12 (`pymobiledevice3 syslog live`), the extension as the receiver: the
   `[CanariNSE] catchup: replay ...` line, and the extension's outcome line for its memory.

**What would reopen work:** a phone figure above ~10 s for 30 commits (the bench predicts under one second on a workstation), or the extension killed for memory - then persisting the catch-up from the background
(section 28, what it leaves) becomes the next step, and is planned as its own entry.
