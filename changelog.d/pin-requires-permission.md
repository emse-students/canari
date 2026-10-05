### Fixed - pinning in a salon is moderation, the author's own message included

A plain member is no longer offered "Pin" and the server refuses them with `PIN_REQUIRES_MODERATION` (user, 2026-10-05; DMs and groups unchanged); a refused pin is reverted with a toast, and a demoted moderator loses the action live ([social-service](docs/wiki/services/social-service.md#who-may-pin-and-what-the-client-offers-2026-10-05)).
