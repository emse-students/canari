### Fixed - the iPhone share sheet forgets the previous account's senders after a sign-out

The notification extension now erases its own message donations on its next run once their account is no longer signed in (the app's delete cannot reach another bundle's donations), and the share extension ignores a picked suggestion while they still name another account ([mobile](docs/wiki/frontend/mobile.md#communication-notifications-owner-2026-11-21)).
