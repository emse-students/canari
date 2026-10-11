### Changed - the PIN screen appears ~0.45 s sooner on a cold start

A device that already enrolled the account draws the PIN gate at once instead of first asking the server whether this is a first setup, a question that waited for the token refresh ([notification-to-conversation-latency](docs/wiki/frontend/notification-to-conversation-latency.md#f3---the-pin-gate-is-drawn-on-the-local-fact-measured)).
