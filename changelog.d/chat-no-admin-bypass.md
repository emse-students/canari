### Security - a platform admin no longer bypasses membership on conversation data

In chat-delivery, a global admin is now refused another person's groups, rosters, roster changes,
invitations, history, queued messages, devices and PIN like anyone else; only the storage
aggregates still read the admin header, an asserted allowlist ([chat-delivery](docs/wiki/services/chat-delivery.md#no-platform-admin-bypass-on-conversation-data-owner-2026-11-02)).
