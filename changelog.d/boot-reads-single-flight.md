### Changed - simultaneous readers of the account's devices and groups share one request at boot

Simultaneous readers of `devices/<id>` and `users/<id>/groups` now share one request ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#17-wp-w4-first-part-the-account-level-reads-of-a-boot-are-shared-while-in-flight-2026-10-18)).
