### Changed - the key group's 109 orphan devices are revoked in production (2026-10-24)

Devices with neither a session nor a push token held 184 457 undeliverable queued rows, most of the nightly archive; they went through the revoke path, one at a time ([audit](docs/wiki/infrastructure/prod-queue-and-epoch-audit-2026-10-12.md#third-pass---2026-10-24-the-key-groups-orphan-devices)).
