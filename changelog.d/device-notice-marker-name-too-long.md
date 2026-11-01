### Fixed - the new-device alert was never posted: its marker's file name was too long

A device-notice marker was named by its whole key in hex (~320 bytes), which the filesystem refused,
so no background engine announced a new device since 1.4.1-alpha.2; it is now named by the key's
SHA-256 ([mls-protocol](docs/wiki/protocols/mls-protocol.md#new-device-notices-decided-by-the-user-2026-10-22-refined-the-same-day)).
