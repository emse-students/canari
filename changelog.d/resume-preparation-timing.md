### Changed - the foreground line says what the reconnect waited for

`[LIFECYCLE] App in foreground` now names each resume step's duration. It showed that a warm notification tap's reply waits on the landing's render, not on a late foreground signal. Two silent outbox-reconcile catches now log ([notification-to-conversation-latency](docs/wiki/frontend/notification-to-conversation-latency.md#f5---the-warm-diagnosis-was-wrong-and-the-fix-it-suggested-measured-to-nothing)).
