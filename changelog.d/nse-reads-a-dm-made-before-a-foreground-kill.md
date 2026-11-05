### Fixed - a DM created in the foreground showed the generic iPhone banner once the app was killed

The notification extension's copy of the MLS state now follows every write of that state instead of
the next activation or resignation, which a process killed in the foreground never reaches; the
extension's log lines are readable on a store build ([mobile](docs/wiki/frontend/mobile.md#the-extensions-copy-of-the-state-follows-every-write-2026-11-05)).
