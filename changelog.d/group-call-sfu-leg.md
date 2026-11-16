### Added - group calls: the app's SFU leg, one connection to the relay (WP-GC4 client)

`CallSfuLeg` carries a group call through call-service's relay with the per-sender E2E keys, the room's mode is read from its token, and the relay's `Joined` now states `others`; not yet wired into the call screen ([calls](docs/wiki/frontend/modules/calls.md#the-apps-sfu-leg-wp-gc4-client-2026-11-16)).
