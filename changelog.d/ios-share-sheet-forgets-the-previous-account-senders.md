### Fixed - the iPhone share sheet forgets the previous account's senders after a sign-out

The notification extension now erases its own message donations on its next run once their account is no longer signed in, and once on an install from before this change (the app's delete cannot reach another bundle's donations) ([mobile](docs/wiki/frontend/mobile.md#communication-notifications-owner-2026-11-21)).
