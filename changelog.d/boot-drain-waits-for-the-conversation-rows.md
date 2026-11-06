### Fixed - a cold start no longer refuses its queued frames before the conversation rows exist

The login now holds every socket frame and every mailbox pull (its own, an outbox flush's, a reconnect's) until the restore has seeded the conversation rows, so frames of conversations the device already had are no longer refused `absent-conversation` and fetched a second time ([auth](docs/wiki/frontend/modules/auth.md#and-since-2026-11-06-nothing-is-handled-before-the-conversation-rows-exist)).
