### Changed - two delivery-service lines that fired on every poll and every send now report a rate

`[DEVICE_MEMBERSHIPS]` is printed when a device's answer changes, `[PUSH_SEND] No push token` once per device then at its 10th, 100th... send, and both carry cut ids instead of full user and device ids ([chat-delivery](docs/wiki/services/chat-delivery.md)).
