### Fixed - iOS: a tap on a push banner opens its conversation from a backgrounded or killed app

The notification plugin took over the iOS notification delegate on every launch and dropped every push tap. Canari's delegate now owns the slot, and the tap waits for the page in durable state ([mobile](docs/wiki/frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
