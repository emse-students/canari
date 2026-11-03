### Fixed - a DM read while both devices are online shows as read again

The gateway dropped the server time of every live frame, so since `v1.6.0` each live read mark was refused and the sender kept one check ([chat](docs/wiki/frontend/modules/chat.md#conversations-are-ordered-by-the-servers-clock-decided-by-the-owner-2026-10-31)).
