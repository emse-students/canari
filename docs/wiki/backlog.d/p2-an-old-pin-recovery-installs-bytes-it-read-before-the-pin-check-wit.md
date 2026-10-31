## P2 - An old-PIN recovery installs bytes it read before the PIN check, with no compare under the lock (review of #2782, 2026-10-31)

The recovery reads `mls.bin` early (`sessionAuth.ts`, `loadMlsState(userId)`), checks the PIN, then
hands those bytes to the native login, which installs them via `mark_foreground_manager_loading`
(`commands/mls.rs`, the `(supplied, _)` arm) - never re-reading the file under `mls_bin_write_lock`.
With #2782 the guard is no longer held at the PIN gate, so an in-process background write (a CallKit
Decline, a quick reply) landing during the PIN check can be erased by the recovery's next blind
write. Mitigated by `reconcileSendRatchets`. Fix: pass `stateOnDisk` so the native side reads under
the lock, or compare a digest of the supplied bytes under the lock and refuse on a difference.
