### Changed - an association is a BDE exactly when it is the BDE of a space

The `isBDE` tick on `/admin/associations` and its column are gone (migration 072, which refuses to run while a flagged association governs no space); BDE-only grants now follow the BDE designated per space on `/admin/spaces` ([profiles-and-access](docs/wiki/profiles-and-access.md)). Per-space scoping of validation comes next.
