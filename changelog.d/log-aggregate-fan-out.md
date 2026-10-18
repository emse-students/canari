### Changed - the delivery service prints one line per fan-out, not one per device

A frame queued to about 100 seats wrote about 200 lines and rolled production's log over in ~20 minutes; `DONE` now carries `offline=N`, one `FCM sent batch` line replaces the per-device ones, and the skipped-device list is capped at five ([prod-queue-and-epoch-audit](docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#log-lines-per-frame-and-what-aggregates-them-2026-10-18)). No retention change.
