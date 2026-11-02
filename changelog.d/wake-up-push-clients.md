### Added - the content-free wake-up push, client side

Android, the iOS extension and the iOS app fetch a wake-up push's frame from `GET /api/mls/push/wake` and run it through their existing dispatch; a failed fetch says the message could not be loaded. Registrations now declare `wake: true`; nothing changes until the server switch moves ([design](docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md)).
