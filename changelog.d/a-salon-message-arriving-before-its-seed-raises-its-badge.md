### Fixed - a salon message that arrives before its seed raises its badge

A private salon granted, or a community joined, a moment ago showed no badge for the messages sent
before its key landed, until it was opened once. Such a message now takes its badge from the
server's count ([chat](docs/wiki/frontend/modules/chat.md#a-salon-message-that-arrives-before-its-seed-still-raises-its-badge-2026-11-16)).
