### Fixed - the push registration no longer retries a refused token

Each attempt reads the session's current token; a 401 is renewed once, a second 401 or any other 4xx
ends the ladder, and only a 5xx or a transport failure is retried
([chat-delivery](docs/wiki/services/chat-delivery.md#a-device-that-cannot-get-a-push-token-at-all)).
