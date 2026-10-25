### Fixed - a sweep never puts back an older ask, and a retiring server finishes its expiry announcements

A pending-invitation sweep no longer replaces a person's newer ask announced while it read, and a replica retired during the expiry cron finishes its announcements before it exits ([mls-protocol](docs/wiki/protocols/mls-protocol.md#who-admits-a-new-person-2026-10-23), [chat-delivery](docs/wiki/services/chat-delivery.md)).
