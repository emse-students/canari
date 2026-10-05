### Fixed - a salon member is no longer offered "Pin" on other members' messages

The menus, the pinned banner and the send path now share one rule with the server (own message, or `channel.moderate`); a refused pin is reverted with a toast, the refusal carries `PIN_REQUIRES_MODERATION`, and a demoted moderator loses the action live ([social-service](docs/wiki/services/social-service.md#who-may-pin-and-what-the-client-offers-2026-10-05)).
