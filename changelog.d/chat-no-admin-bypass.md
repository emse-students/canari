### Security - a platform admin no longer bypasses membership on conversation data

In chat-delivery, a global admin is now refused another person's groups, rosters, roster changes,
invitations, history, queued messages and device enrolment like any non-member; the handlers that
still read the admin header are an asserted allowlist ([chat-delivery](docs/wiki/services/chat-delivery.md#no-platform-admin-bypass-on-conversation-data-owner-2026-11-02)).
