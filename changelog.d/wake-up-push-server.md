### Added - the content-free wake-up push, server side, behind a switch that is off

`platform_config.push_mode` (`full` by default, editable at `/admin/platform`) and a per-device `wakeCapable` flag decide whether an MLS push carries only a wake-up and an opaque id; the device fetches the rest from `GET /api/mls/push/wake` ([design](docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md)).
