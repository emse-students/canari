### Fixed - a shut Android phone answering a re-add from an old epoch no longer forks itself

The background Welcome is now staged and installed only once the server accepts its commit, the route answers a typed `201 accepted` or `409 rejected`, and a stale refusal is not repeated from the same state ([chat-delivery](docs/wiki/services/chat-delivery.md#the-background-welcome-answers-what-happened-and-the-phone-installs-only-an-acceptance-2026-10-22)).
