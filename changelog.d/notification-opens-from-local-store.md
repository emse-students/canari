### Changed - a tapped notification opens its conversation from the local store before the session is up

The thread is drawn from the device's own store while the session is verified, a reply typed meanwhile is held until it is, and a revoked device removes what was drawn. Behind a PIN nothing is drawn before the PIN is accepted. [Measured](docs/wiki/frontend/notification-to-conversation-latency.md#f1---the-conversation-is-drawn-from-the-local-store-before-the-session-is-up).
