### Fixed - a call ring drops a dead push token, read from the FCM error code

The ring path decided on the error's text, which a real Firebase error never carries, and dropped a token on any `invalid-argument`; one classifier now reads the structured code for every push ([chat-delivery](docs/wiki/services/chat-delivery.md#priority-notifications---calls--mentions-wp-xp-5)).
