### Fixed - iOS: a tap on a push banner opens its conversation from a backgrounded or killed app

On every launch the notification plugin took over the iOS notification delegate and dropped every push tap. Canari now takes the delegate back at launch. A tap waits for the page in durable state and is routed once the router is mounted. A reply typed in a notification over an open app is now handed to the page and is no longer lost ([mobile](docs/wiki/frontend/mobile.md#one-notification-delegate-and-a-tap-that-waits-for-the-page-2026-11-01)).
