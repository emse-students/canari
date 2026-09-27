### Fixed - The gateway no longer claims a control frame "stays in DB queue"

A control frame for an absent device has no queue row, and the gateway now says it was not delivered
instead of promising a reconnect would fetch it
([cross-client-testing](docs/wiki/cross-client-testing.md), NOTIF-20).
