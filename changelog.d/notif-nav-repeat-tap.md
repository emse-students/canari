### Fixed - a second tap on the same conversation's notification, from another page, now opens it

The landing remembered the target id it had routed for and never forgot it, so a repeat tap (same id) did nothing on Android and iOS; each tap is now its own landing. See [chat](docs/wiki/frontend/modules/chat.md#a-repeat-tap-on-the-same-conversation-is-a-new-landing-2026-10-06).
