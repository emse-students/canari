### Added - a phone states what its OS lets notifications do, and the push-coverage alarm counts phones only

`register-device` carries the real notification permission (Android: permission, app switch, channel
importance; iOS: authorization and alerts), stored with the device (migration 054) and counted by the
daily coverage as "registered but the OS will not show it". The coverage counts installed-app devices
only: about 93 mobile-browser devices had made it mostly false, and browser-only members are now one
information line. The page reads the state through one read-only command, `notification_delivery_state`
([chat-delivery](docs/wiki/services/chat-delivery.md#registered-is-not-permitted-2026-11-21)).
