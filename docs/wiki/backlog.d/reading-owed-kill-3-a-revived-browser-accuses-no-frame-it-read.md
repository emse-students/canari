## Reading owed - KILL-3 on dev: a browser killed after a send or a receive accuses no frame it read (KILL-2 ledgers)

target: 1.7.0

**What is built.** The ledgers that describe the MLS state (the seen-ciphertext marks and the send
counts) travel inside the state's own write, and a send's `emitted` count is in IndexedDB before the
frame posts (#2515, merged 2026-11-15, on dev since `1.7.0-alpha.3`;
[mls-desync-prevention](../protocols/mls-desync-prevention.md#the-ledgers-that-describe-the-state-travel-inside-it-kill-2-2026-10-26)).
The KILL-1/2/3 rows now FAIL a run whose revived seat prints `frame never read here and unreadable
for good`, read over the page's whole console (`revivedAccusations`, `consoleSinceAttach`). Before,
the same line on `1.4.1-alpha.6` had only made KILL-3 `PASS-DIRTY`
([board](../cross-client-testing.md)).

**The reading that closes it.** On a `1.7.0` pre-release, with W1 and W2 free for 45 minutes and no
release in flight: `bun archive/kill.mjs --row KILL-3` from `tools/cross-client-harness/` - twelve
runs, three per window, every run `PASS` on the new assertion. A run that accuses
(`secret-reuse` after `after-receive`, or the next frame out lost after `after-send`) reopens the
defect: the kept `W1-run<n>-revived` console names the frame. KILL-2 (`--row KILL-2`) asks the same
question after a held commit and is worth the same window.

**Not covered by any row:** the native half (`mls.bin`, a Tauri app killed after a send), because no
rig tool holds the Tauri HTTP call (`KILL_BLOCKED`, `killrows.mjs`). The ledgers ride the same
`sauvegarder_mls_et_persister` write there, pinned by `storage.rs`
(`a_reload_keeps_the_ledgers_the_app_staged_into_the_live_manager`).
