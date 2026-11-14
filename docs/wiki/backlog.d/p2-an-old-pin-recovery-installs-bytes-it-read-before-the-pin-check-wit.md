## P2 - An old-PIN recovery installs bytes it read before the PIN check, with no compare under the lock (review of #2782, 2026-10-31)

target: 1.10.0

The recovery reads `mls.bin` early (`sessionAuth.ts`, `loadMlsState(userId)`), checks the PIN, then
hands those bytes to the native login, which installs them via `mark_foreground_manager_loading`
(`commands/mls.rs`, the `(supplied, _)` arm) - never re-reading the file under `mls_bin_write_lock`.
With #2782 the guard is no longer held at the PIN gate, so an in-process background write (a CallKit
Decline, a quick reply) landing during the PIN check can be erased by the recovery's next blind
write. Mitigated by `reconcileSendRatchets`. Fix: pass `stateOnDisk` so the native side reads under
the lock, or compare a digest of the supplied bytes under the lock and refuse on a difference.

**Agent brief (batch 18, 2026-11-12; Rust and the sign-in path, Opus).** Still open, read in the
code: the `(supplied, _)` arm of the native login (`commands/mls.rs`, around the `state_on_disk`
match) checks only that the claim is current and installs the bytes the page supplied, read before
the PIN check (`sessionAuth.ts`, `loadMlsState` in the recovery). Preferred fix, the one that removes
the window rather than detecting it: the recovery passes `stateOnDisk: true` and NO bytes, so the
blob is read under `mls_bin_write_lock` by `foreground_load_mls_bin_claimed`, as every ordinary
sign-in already does - the bytes the PIN check needed are only read, never handed to the install.
If the PIN check must decrypt those exact bytes, the fallback is a digest of the supplied bytes
compared with the file under the lock, refusing on a difference with a typed refusal (never a
message). Start: `sessionAuth.ts` (both `loadMlsState` calls, ~1557 and ~3450), `TauriMlsService`
(`stateOnDisk`), `commands/mls.rs` (the match), `concurrency.rs`. Proof: a Rust test that a write
landing between the read and the install survives; `TauriMlsService.stateOnDisk.test.ts` extended
for the recovery.
