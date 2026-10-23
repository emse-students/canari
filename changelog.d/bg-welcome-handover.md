### Fixed - an accepted background Welcome reaches the app opened during its round trip

An app load now waits for a background Welcome awaiting the server's answer, and an accepted one that finds the app active is handed over and installed before the load reads, instead of being dropped ([chat-delivery](docs/wiki/services/chat-delivery.md#the-background-welcome-answers-what-happened-and-the-phone-installs-only-an-acceptance-2026-10-22)).
