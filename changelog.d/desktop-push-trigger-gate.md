### Added - a gate that a desktop build hands over no push token

`useNotifications.singleBuilder.test.ts` now reads `commands/push.rs` and fails if `get_fcm_token` or `get_voip_token` grows a desktop branch, the second trigger behind a doubled notification ([mobile](docs/wiki/frontend/mobile.md#one-builder-two-triggers)).
