### Fixed - a message answered from the notification shade no longer comes back as a new notification

A paused connection is now closed instead of left to a zombie watchdog that reconnected in the
background, and both notification builders skip a message the shade already read
([mobile](docs/wiki/frontend/mobile.md#a-message-the-shade-already-answered-is-never-announced-again-2026-10-01)).
